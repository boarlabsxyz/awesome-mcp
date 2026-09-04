// src/slack-user/accessControl.ts
// Rule-based access control engine for Slack user OAuth MCP.
import { UserError } from 'fastmcp';
import {
  SlackClient, channelTeamIds, isSharedChannel,
  type SlackChannelSharedFlags, type SlackChannelTeamFields,
} from '../slack/apiHelpers.js';
import type { SlackAccessRules } from '../mcpConnectionStore.js';

// --- Typed denials ---

/**
 * Why a channel was refused, as data rather than prose.
 *
 * `assertAccess` used to throw a bare `UserError`, which meant every consumer
 * that wanted to do more than print it — name the offending org, annotate a
 * list row, explain the fix — had to pattern-match English. The `message` is
 * still the same sentence it always was (so callers that only print it are
 * unaffected), but the structured fields are what `listChannels`,
 * `enforceAccess` and `diagnoseChannelAccess` actually branch on.
 */
export type SlackDenialReason =
  | 'org-not-allowed'
  | 'org-unverified'
  | 'whitelist-empty'
  | 'whitelist-miss'
  | 'blacklist-channel'
  | 'blacklist-user'
  | 'public-only';

export class SlackAccessDenied extends UserError {
  readonly reason: SlackDenialReason;
  /** The disallowed team IDs, for name enrichment. Only on the org reasons. */
  readonly orgIds?: string[];
  readonly channelName?: string;
  /** The user's own patterns, so a message can say what to edit. */
  readonly patterns?: string[];

  constructor(
    message: string,
    detail: { reason: SlackDenialReason; orgIds?: string[]; channelName?: string; patterns?: string[] },
  ) {
    super(message);
    this.name = 'SlackAccessDenied';
    this.reason = detail.reason;
    this.orgIds = detail.orgIds;
    this.channelName = detail.channelName;
    this.patterns = detail.patterns;
  }
}

// --- Glob matching ---

/** Convert a simple glob pattern to a RegExp. Supports * (any chars) and ? (single char). */
export function matchGlob(pattern: string, name: string): boolean {
  const regex = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
    'i'
  );
  return regex.test(name);
}

// --- Channel metadata cache ---

export interface ChannelMeta {
  id: string;
  name: string;
  is_private: boolean;
  is_shared: boolean;
  is_im: boolean;
  is_mpim: boolean;
  user?: string;              // DM counterpart user ID
  /**
   * Every org this channel touches — the union of Slack's `shared_team_ids`,
   * `internal_team_ids`, `connected_team_ids` and `context_team_id`, via
   * `channelTeamIds`. It is deliberately not the raw `shared_team_ids` field:
   * a Slack Connect channel routinely reports its external orgs in
   * `connected_team_ids` and leaves `shared_team_ids` internal-only, which used
   * to read here as "organisation could not be verified".
   */
  shared_team_ids?: string[];
}

const channelMetaCache = new Map<string, { meta: ChannelMeta; expiresAt: number }>();
const CHANNEL_META_TTL_MS = 5 * 60 * 1000; // 5 minutes
/**
 * Entries were previously only ever overwritten, never removed. That was a slow
 * leak while the only writer was a one-channel-at-a-time read path; listChannels
 * now backfills in bulk, which would turn it into a real one.
 */
const CHANNEL_META_CACHE_MAX = 1000;

/** Drop expired entries, then oldest-inserted ones if still oversized. */
function pruneChannelMetaCache(now: number): void {
  for (const [key, entry] of channelMetaCache) {
    if (entry.expiresAt <= now) channelMetaCache.delete(key);
  }
  if (channelMetaCache.size > CHANNEL_META_CACHE_MAX) {
    let excess = channelMetaCache.size - CHANNEL_META_CACHE_MAX;
    for (const key of channelMetaCache.keys()) {
      channelMetaCache.delete(key);
      if (--excess <= 0) break;
    }
  }
}

/** Test seam. Nothing in the request path calls this. */
export function clearChannelMetaCache(): void {
  channelMetaCache.clear();
}

/** Fetch channel metadata with caching. */
export async function fetchChannelMeta(
  client: SlackClient,
  channelId: string,
  tokenKey: string,
): Promise<ChannelMeta> {
  const cacheKey = `${tokenKey}:${channelId}`;
  const cached = channelMetaCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.meta;

  const { channel } = await client.conversationsInfo(channelId);
  const meta: ChannelMeta = {
    id: channel.id,
    name: channel.name,
    is_private: channel.is_private,
    is_shared: isSharedChannel(channel),
    is_im: channel.is_im,
    is_mpim: channel.is_mpim,
    user: channel.user,
    shared_team_ids: channelTeamIds(channel),
  };
  channelMetaCache.set(cacheKey, { meta, expiresAt: Date.now() + CHANNEL_META_TTL_MS });
  pruneChannelMetaCache(Date.now());
  return meta;
}

// --- Access enforcement ---

/** Check if a channel name matches any pattern in a list. */
function matchesAnyPattern(patterns: string[], name: string): boolean {
  return patterns.some(p => matchGlob(p, name));
}

/**
 * Assert that access to a channel/DM is allowed under the given rules.
 * Throws UserError if access is denied.
 */
export function assertAccess(rules: SlackAccessRules, meta: ChannelMeta): void {
  if (meta.is_im || meta.is_mpim) {
    // DM/MPIM access check
    // 1. Check org allowlist (if configured)
    // Note: org check for DM counterpart requires additional user info lookup
    // which is handled at the tool level if needed.

    // 2. Check user blacklist
    if (meta.user && rules.blacklistUsers.includes(meta.user)) {
      throw new SlackAccessDenied('Access denied: this user is in your blacklist.', {
        reason: 'blacklist-user',
      });
    }
    // DMs pass through (no channel pattern matching)
    return;
  }

  // Channel access check
  // 1. Public-only check
  if (rules.allowPublicOnly && meta.is_private) {
    throw new SlackAccessDenied(
      'Access denied: only public channels are allowed (allowPublicOnly is enabled).',
      { reason: 'public-only', channelName: meta.name },
    );
  }

  // 2. Org check for shared/external channels — every org on the channel must be
  //    allowed. `some` was the old test, which let a channel through as soon as
  //    *one* of its orgs was ticked: a channel shared with your own workspace
  //    (always in allowedOrgs) plus an unapproved partner passed every time.
  if (meta.is_shared && rules.allowedOrgs.length > 0) {
    if (!meta.shared_team_ids || meta.shared_team_ids.length === 0) {
      throw new SlackAccessDenied(
        'Access denied: this shared channel\'s organisation could not be verified.',
        { reason: 'org-unverified', channelName: meta.name },
      );
    }
    const disallowed = meta.shared_team_ids.filter(tid => !rules.allowedOrgs.includes(tid));
    if (disallowed.length > 0) {
      throw new SlackAccessDenied(
        `Access denied: this shared channel belongs to an organisation not in your allowed list (${disallowed.join(', ')}). Tick it under Access Rules → Organizations if it should be readable.`,
        { reason: 'org-not-allowed', orgIds: disallowed, channelName: meta.name },
      );
    }
  }

  // 3. Whitelist check (empty whitelist = nothing allowed)
  if (rules.whitelistChannels.length === 0) {
    throw new SlackAccessDenied(
      'Access denied: no channel whitelist patterns configured. Visit the dashboard to configure access rules.',
      { reason: 'whitelist-empty', channelName: meta.name, patterns: [] },
    );
  }
  if (!matchesAnyPattern(rules.whitelistChannels, meta.name)) {
    throw new SlackAccessDenied(
      `Access denied: channel #${meta.name} does not match any whitelist pattern.`,
      { reason: 'whitelist-miss', channelName: meta.name, patterns: [...rules.whitelistChannels] },
    );
  }

  // 4. Blacklist check
  if (rules.blacklistChannels.length > 0 && matchesAnyPattern(rules.blacklistChannels, meta.name)) {
    throw new SlackAccessDenied(
      `Access denied: channel #${meta.name} matches a blacklist pattern.`,
      { reason: 'blacklist-channel', channelName: meta.name, patterns: [...rules.blacklistChannels] },
    );
  }
}

/**
 * The DM and group-DM checks assertAccess cannot make on its own, because they
 * need API lookups.
 *
 * assertAccess only compares a 1-on-1 DM's counterpart against blacklistUsers —
 * it cannot resolve that user's org, and for a group DM `meta.user` is normally
 * unset, so even that comparison is a no-op there. Both gaps are covered here.
 *
 * Shared by enforceAccess (direct reads) and buildChannelFilter (search
 * results). It used to live inline in enforceAccess only, which meant search
 * was filtered by a weaker rule than a direct read of the same conversation.
 * Keep it shared so the two cannot drift apart again.
 *
 * Throws UserError when access is denied. Lookup failures propagate as-is, so
 * each caller picks its own posture: enforceAccess lets a failed lookup through,
 * buildChannelFilter treats it as a denial.
 */
export async function assertDmMemberAccess(
  client: SlackClient,
  rules: SlackAccessRules,
  meta: { is_im?: boolean; is_mpim?: boolean; user?: string },
  channelId: string,
): Promise<void> {
  // 1-on-1 DM: the counterpart's org must be allowed.
  if (meta.is_im && meta.user && rules.allowedOrgs.length > 0) {
    const { user } = await client.usersInfo(meta.user);
    if (user.team_id && !rules.allowedOrgs.includes(user.team_id)) {
      throw new UserError('Access denied: this user belongs to an organisation not in your allowed list.');
    }
  }

  // Group DM: no member may be blacklisted or from a non-allowed org.
  if (meta.is_mpim && (rules.blacklistUsers.length > 0 || rules.allowedOrgs.length > 0)) {
    const { members } = await client.conversationsMembers(channelId);
    if (rules.blacklistUsers.length > 0 && members.some(uid => rules.blacklistUsers.includes(uid))) {
      throw new UserError('Access denied: this group DM contains a blacklisted user.');
    }
    if (rules.allowedOrgs.length > 0) {
      for (const uid of members) {
        const { user } = await client.usersInfo(uid);
        if (user.team_id && !rules.allowedOrgs.includes(user.team_id)) {
          throw new UserError('Access denied: this group DM contains a user from a non-allowed organisation.');
        }
      }
    }
  }
}

/**
 * Filter DMs by org membership. Requires async user lookups.
 * Call after filterChannelList to remove DMs with users from non-allowed orgs.
 */
export async function filterDmsByOrg(
  client: SlackClient,
  rules: SlackAccessRules,
  channels: Array<{ is_im?: boolean; is_mpim?: boolean; user?: string; [key: string]: any }>,
): Promise<typeof channels> {
  if (rules.allowedOrgs.length === 0) return channels; // no org restriction

  const dmChannels = channels.filter(ch => !!(ch.is_im) && ch.user);
  if (dmChannels.length === 0) return channels;

  // Lookup team_ids for DM counterparts (sequential to avoid rate limits)
  const userIds = [...new Set(dmChannels.map(ch => ch.user!))];
  const userTeamMap = new Map<string, string>();
  for (const uid of userIds.slice(0, 50)) {
    try {
      const { user } = await client.usersInfo(uid);
      if (user.team_id) userTeamMap.set(uid, user.team_id);
    } catch { /* skip */ }
  }

  return channels.filter(ch => {
    if (!(ch.is_im) || !ch.user) return true; // non-DMs pass through
    const teamId = userTeamMap.get(ch.user);
    if (!teamId) return true; // couldn't resolve, allow through
    return rules.allowedOrgs.includes(teamId);
  });
}

/**
 * How many group DMs `filterGroupDmsByRules` will inspect in one call. See the
 * comment on the loop for why leaving the remainder visible is the safe side.
 */
export const GROUP_DM_CHECK_MAX = 30;

/**
 * Filter group DMs (mpim) that contain any blacklisted user or user from non-allowed org.
 * Requires async member lookups via conversations.members and users.info.
 */
export async function filterGroupDmsByRules(
  client: SlackClient,
  rules: SlackAccessRules,
  channels: Array<{ is_mpim?: boolean; id: string; [key: string]: any }>,
): Promise<typeof channels> {
  const hasBlacklist = rules.blacklistUsers.length > 0;
  const hasOrgFilter = rules.allowedOrgs.length > 0;
  if (!hasBlacklist && !hasOrgFilter) return channels;

  const mpimChannels = channels.filter(ch => !!ch.is_mpim);
  if (mpimChannels.length === 0) return channels;

  const blockedMpimIds = new Set<string>();
  // Sequential to avoid Slack rate limits. Capped because this runs inside
  // listChannels alongside other per-item lookups, and each group DM costs one
  // conversations.members plus one users.info *per member* — uncapped, a
  // workspace with many group DMs exhausts the tier-3 budget mid-call and the
  // whole tool fails. Group DMs past the cap are left visible rather than
  // hidden: the read path still applies the full check via assertDmMemberAccess,
  // so this trades a possibly-optimistic list row for a reliable one, never a
  // relaxed read.
  for (const ch of mpimChannels.slice(0, GROUP_DM_CHECK_MAX)) {
    try {
      const { members } = await client.conversationsMembers(ch.id);

      // Check blacklist
      if (hasBlacklist && members.some(uid => rules.blacklistUsers.includes(uid))) {
        blockedMpimIds.add(ch.id);
        continue;
      }

      // Check org: if any member is from a non-allowed org, block
      if (hasOrgFilter) {
        for (const uid of members) {
          try {
            const { user } = await client.usersInfo(uid);
            if (user.team_id && !rules.allowedOrgs.includes(user.team_id)) {
              blockedMpimIds.add(ch.id);
              break;
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* skip — can't check members, allow through */ }
  }

  return channels.filter(ch => !blockedMpimIds.has(ch.id));
}

/**
 * The shape `conversations.list` / `users.conversations` hand back. Names are
 * optional because DM payloads genuinely omit them, despite the client typing
 * them as `string`.
 */
export type ListedChannel = SlackChannelTeamFields & SlackChannelSharedFlags & {
  id: string; name?: string; is_private?: boolean;
  is_im?: boolean; is_mpim?: boolean;
  user?: string;
};

export interface ChannelClassification<T> {
  ch: T;
  allowed: boolean;
  denial?: SlackAccessDenied;
  /**
   * True when this is a shared channel whose list payload named no org at all.
   * `conversations.list` routinely omits team IDs that `conversations.info`
   * carries, so this means "unknown", not "denied" — the caller decides whether
   * to spend an info call resolving it. Such a row is still `allowed: true`,
   * preserving the long-standing behaviour of deferring to read-time.
   */
  needsOrgBackfill: boolean;
}

/** Normalise a raw list row into the shape `assertAccess` evaluates. */
export function toChannelMeta(ch: ListedChannel): ChannelMeta {
  return {
    id: ch.id,
    name: ch.name ?? '',
    is_private: !!ch.is_private,
    is_shared: isSharedChannel(ch),
    is_im: !!ch.is_im,
    is_mpim: !!ch.is_mpim,
    user: ch.user,
    shared_team_ids: channelTeamIds(ch),
  };
}

/**
 * The rules a channel must pass *ignoring* the org allowlist.
 *
 * `assertAccess` evaluates orgs before channel patterns, so as soon as a
 * channel is org-denied its whitelist status is simply unknown. Anything that
 * wants to treat an org denial specially — surfacing the row so the user can
 * see which org to tick, or deferring the check until an org can be resolved —
 * must confirm the *other* rules pass first. Otherwise a channel the user's
 * whitelist excludes outright leaks into the output on an org technicality.
 */
export function assertNonOrgAccess(rules: SlackAccessRules, meta: ChannelMeta): void {
  assertAccess({ ...rules, allowedOrgs: [] }, meta);
}

/**
 * Run the *same* rule engine a direct read runs over a page of listed channels.
 *
 * This exists so `filterChannelList` and `assertAccess` cannot drift: there
 * used to be two hand-written copies of the rules, and the list copy was the
 * permissive one, so a channel could be advertised by `listChannels` and then
 * rejected by every read of it.
 *
 * It does not make the two identical — one difference is deliberate and
 * remains. A shared channel whose list payload carries no team IDs is reported
 * `needsOrgBackfill` and left allowed here, whereas `assertAccess` on the
 * richer `conversations.info` payload would deny it as `org-unverified`. That
 * is the "unknown vs denied" distinction; resolving it costs an API call, so
 * the caller chooses.
 */
export function classifyChannelList<T extends ListedChannel>(
  rules: SlackAccessRules,
  channels: T[],
): Array<ChannelClassification<T>> {
  return channels.map(ch => {
    const meta = toChannelMeta(ch);
    const isSharedWithoutOrg = meta.is_shared && (meta.shared_team_ids?.length ?? 0) === 0;
    try {
      assertAccess(rules, meta);
      return { ch, allowed: true, needsOrgBackfill: isSharedWithoutOrg };
    } catch (err) {
      if (err instanceof SlackAccessDenied && err.reason === 'org-unverified') {
        // Not a denial at this layer — see the doc comment above. The remaining
        // rules still have to pass, though: assertAccess bailed before reaching
        // the whitelist, so without this a channel excluded by the user's own
        // patterns would ride through on an unresolved org.
        try {
          assertNonOrgAccess(rules, meta);
          return { ch, allowed: true, needsOrgBackfill: true };
        } catch (error_) {
          return {
            ch,
            allowed: false,
            denial: error_ instanceof SlackAccessDenied ? error_ : undefined,
            needsOrgBackfill: false,
          };
        }
      }
      // Fail closed: anything unexpected excludes the row.
      return {
        ch,
        allowed: false,
        denial: err instanceof SlackAccessDenied ? err : undefined,
        needsOrgBackfill: false,
      };
    }
  });
}

/**
 * Filter a list of channels from conversations.list based on access rules.
 * Synchronous — uses only fields already present in the API response.
 *
 * Thin wrapper over `classifyChannelList`. Callers that need to explain *why*
 * a channel was dropped should use that directly; this keeps the plain
 * "give me the readable ones" contract that search-result filtering depends on.
 */
export function filterChannelList<T extends ListedChannel>(
  rules: SlackAccessRules,
  channels: T[],
): T[] {
  return classifyChannelList(rules, channels).filter(r => r.allowed).map(r => r.ch);
}
