// src/slack-user/accessControl.ts
// Rule-based access control engine for Slack user OAuth MCP.
import { UserError } from 'fastmcp';
import { SlackClient, channelTeamIds, isSharedChannel } from '../slack/apiHelpers.js';
import type { SlackChannelTeamFields } from '../slack/apiHelpers.js';
import type { SlackAccessRules } from '../mcpConnectionStore.js';

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
      throw new UserError('Access denied: this user is in your blacklist.');
    }
    // DMs pass through (no channel pattern matching)
    return;
  }

  // Channel access check
  // 1. Public-only check
  if (rules.allowPublicOnly && meta.is_private) {
    throw new UserError('Access denied: only public channels are allowed (allowPublicOnly is enabled).');
  }

  // 2. Org check for shared/external channels — every org on the channel must be
  //    allowed. `some` was the old test, which let a channel through as soon as
  //    *one* of its orgs was ticked: a channel shared with your own workspace
  //    (always in allowedOrgs) plus an unapproved partner passed every time.
  if (meta.is_shared && rules.allowedOrgs.length > 0) {
    if (!meta.shared_team_ids || meta.shared_team_ids.length === 0) {
      throw new UserError('Access denied: this shared channel\'s organisation could not be verified.');
    }
    const disallowed = meta.shared_team_ids.filter(tid => !rules.allowedOrgs.includes(tid));
    if (disallowed.length > 0) {
      throw new UserError(`Access denied: this shared channel belongs to an organisation not in your allowed list (${disallowed.join(', ')}). Tick it under Access Rules → Organizations if it should be readable.`);
    }
  }

  // 3. Whitelist check (empty whitelist = nothing allowed)
  if (rules.whitelistChannels.length === 0) {
    throw new UserError('Access denied: no channel whitelist patterns configured. Visit the dashboard to configure access rules.');
  }
  if (!matchesAnyPattern(rules.whitelistChannels, meta.name)) {
    throw new UserError(`Access denied: channel #${meta.name} does not match any whitelist pattern.`);
  }

  // 4. Blacklist check
  if (rules.blacklistChannels.length > 0 && matchesAnyPattern(rules.blacklistChannels, meta.name)) {
    throw new UserError(`Access denied: channel #${meta.name} matches a blacklist pattern.`);
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
  // Sequential to avoid Slack rate limits
  for (const ch of mpimChannels) {
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
 * Filter a list of channels from conversations.list based on access rules.
 * Synchronous — uses only fields already present in the API response.
 */
export function filterChannelList(
  rules: SlackAccessRules,
  channels: Array<SlackChannelTeamFields & {
    id: string; name: string; is_private: boolean;
    is_shared?: boolean; is_ext_shared?: boolean; is_org_shared?: boolean;
    is_pending_ext_shared?: boolean;
    is_im?: boolean; is_mpim?: boolean;
    user?: string;
  }>,
): typeof channels {
  return channels.filter(ch => {
    const isDm = !!(ch.is_im || ch.is_mpim);

    if (isDm) {
      // DM: check user blacklist
      if (ch.user && rules.blacklistUsers.includes(ch.user)) return false;
      // Note: org check for DM counterparts requires async user lookup,
      // done in filterDmsByOrg() after this synchronous filter.
      return true;
    }

    // Channel checks
    if (rules.allowPublicOnly && ch.is_private) return false;

    // Org filter: external/shared channels — check if org is allowed when data available.
    // Same all-orgs-must-be-allowed rule as assertAccess, over the same union of
    // team-ID fields, so the list and a direct read cannot disagree.
    const isShared = isSharedChannel(ch);
    const teamIds = channelTeamIds(ch);
    if (isShared && rules.allowedOrgs.length > 0 && teamIds.length > 0) {
      // We have org data — enforce it
      if (teamIds.some(tid => !rules.allowedOrgs.includes(tid))) return false;
    }
    // If shared but no shared_team_ids available (conversations.list limitation),
    // let it through to whitelist/blacklist check. Org is enforced at read time
    // via assertAccess which uses conversations.info (has shared_team_ids).

    // Whitelist/blacklist pattern matching on name
    if (rules.whitelistChannels.length === 0) return false;
    if (!matchesAnyPattern(rules.whitelistChannels, ch.name)) return false;
    if (rules.blacklistChannels.length > 0 && matchesAnyPattern(rules.blacklistChannels, ch.name)) return false;

    return true;
  });
}
