// src/slack-user/orgDiscovery.ts
// Discovers every Slack org (team) this connection can reach, for the
// dashboard's "Organizations" allowlist.
//
// This list is not cosmetic: `allowedOrgs` gates shared channels (assertAccess,
// filterChannelList) and Slack Connect DMs (assertDmMemberAccess,
// filterDmsByOrg). An org missing here has no checkbox, so it can never be
// allowed, so its conversations stay invisible with no way for the user to say
// otherwise. Under-reporting is therefore a silent access failure, which is why
// every cap below is reported back rather than applied quietly.
//
// The previous implementation looked in exactly one place — `shared_team_ids`
// on the first 10 externally-shared channels — and missed orgs reachable only
// through channel 11+, through a DM, or through Slack's other team-ID fields.
//
// A later gap: the workspace-wide channel sweep is paged, so a workspace with
// more channels than the page budget covers exhausted it on internal channels
// and never reached the shared ones. The member-scoped sweep (1b) exists so
// that the channels the user is actually in are always swept, whatever the
// size of the workspace around them.
//
// That fixed the *listing* and left the same starvation one step downstream:
// the shared channels whose list payload names no partner go into one queue for
// `conversations.info`, and the workspace-wide sweep fills it first — so in a
// workspace with hundreds of shared channels the budget was spent on channels
// the user is not in, and the private Slack Connect channel they *are* in fell
// off the end. The queue is ranked by `infoPriority` now, not by discovery
// order, and a lookup that fails is counted rather than silently skipped.
import {
  channelSharedTeamIds,
  channelTeamIds,
  isSharedChannel,
  type SlackChannelTeamFields,
} from '../slack/apiHelpers.js';
import { resolveTeamNames } from './teamNames.js';

/** An org offered to the user as an allowlist checkbox. */
export interface DiscoveredOrg {
  id: string;
  /** Human name when Slack would give us one, else the raw team ID. */
  name: string;
  /** False when `name` is just the ID — the UI labels those differently. */
  nameResolved: boolean;
  /** How this org was found. Purely diagnostic. */
  sources: OrgSource[];
  /** True when the org is in the saved allowlist but nothing rediscovered it. */
  saved: boolean;
}

export type OrgSource = 'current' | 'channel' | 'channel-info' | 'user' | 'dm' | 'saved';

export interface OrgDiscoveryResult {
  orgs: DiscoveredOrg[];
  /** True when any cap below was hit, i.e. the list may still be short. */
  truncated: boolean;
  /** Human-readable reasons the list may be incomplete. Rendered in the UI. */
  notes: string[];
}

/**
 * Caps. Each sweep is sequential — Slack's per-method rate limits are low
 * (conversations.info and users.list are tier 3/2) and SlackClient only retries
 * a 429 once — so these bound how long opening the modal can take. Hitting one
 * sets `truncated` and adds a note; it never silently shortens the list.
 */
export const LIST_MAX_PAGES = 25;          // 25 × 1000 channels, workspace-wide
export const MEMBER_LIST_MAX_PAGES = 15;   // 15 × 200 of the user's own channels
export const DM_LIST_MAX_PAGES = 15;       // 15 × 200 DMs
export const USER_LIST_MAX_PAGES = 10;     // 10 × 1000 users
export const CHANNEL_INFO_MAX = 100;       // was 10 — the original bug
export const USER_INFO_MAX = 50;
export const TEAM_INFO_MAX = 40;
export const USER_LIST_PAGE_SIZE = 1000;

/**
 * The slice of SlackClient this needs. Structural so tests can pass a stub and
 * so a caller can hand in either the bot or the user client.
 */
export interface OrgDiscoveryClient {
  conversationsListAll(cursor?: string, types?: string): Promise<{
    channels: Array<SlackChannelTeamFields & {
      id: string; is_shared?: boolean; is_ext_shared?: boolean;
      is_org_shared?: boolean; is_pending_ext_shared?: boolean;
    }>;
    response_metadata?: { next_cursor?: string };
  }>;
  // Carries the same shared flags as conversationsListAll: sweep 1b asks this
  // method for public/private channels too, and has to tell a shared channel
  // from an internal one to decide whether a conversations.info is worth it.
  conversationsList(cursor?: string, types?: string): Promise<{
    channels: Array<SlackChannelTeamFields & {
      id: string; is_im?: boolean; is_mpim?: boolean; user?: string;
      is_shared?: boolean; is_ext_shared?: boolean;
      is_org_shared?: boolean; is_pending_ext_shared?: boolean;
    }>;
    response_metadata?: { next_cursor?: string };
  }>;
  conversationsInfo(channel: string): Promise<{ channel: SlackChannelTeamFields & { id: string } }>;
  usersList(cursor?: string, limit?: number): Promise<{
    members: Array<{ id: string; team_id: string; deleted?: boolean }>;
    response_metadata?: { next_cursor?: string };
  }>;
  usersInfo(userId: string): Promise<{ user: { id: string; team_id?: string } }>;
  teamInfo(teamId?: string): Promise<{ team: { id: string; name: string } }>;
}

export interface OrgDiscoveryOptions {
  /** The connection's own workspace. Reported separately by the caller. */
  currentOrgId?: string;
  /** Orgs already in `allowedOrgs`. Always returned, discovered or not. */
  savedOrgIds?: string[];
  /**
   * Scopes the shared team-name cache. Pass the same key the MCP server uses
   * (see `getTokenKey`) so a name resolved here is reusable when an access
   * denial has to name an org, and vice versa. Omit it to bypass the cache —
   * which is what tests do, and what keeps names from crossing tenants.
   */
  tokenKey?: string;
}

interface Accumulator {
  ids: Map<string, Set<OrgSource>>;
  notes: string[];
  truncated: boolean;
}

function add(acc: Accumulator, teamId: string | undefined, source: OrgSource): void {
  if (!teamId) return;
  const existing = acc.ids.get(teamId);
  if (existing) existing.add(source);
  else acc.ids.set(teamId, new Set([source]));
}

function cap(acc: Accumulator, note: string): void {
  acc.truncated = true;
  acc.notes.push(note);
}

/**
 * A shared channel whose list payload named no partner org, queued for a
 * `conversations.info` lookup in sweep 4.
 */
interface InfoTarget {
  /**
   * The user is a member. These are the channels they can actually read, so
   * they are the ones whose org they need a checkbox for — which is why the
   * budget is spent on them first.
   */
  member: boolean;
  /**
   * Shared *outside* this workspace (or invited to be), rather than merely
   * `is_shared`, which an Enterprise Grid also sets for internal sharing.
   */
  external: boolean;
}

/**
 * Queue a shared channel for enrichment, if the list payload left it blank.
 *
 * Gate enrichment on the shared team lists alone. `context_team_id` is the
 * *viewing* workspace, so a payload carrying only that names no partner —
 * counting it as resolved is what silently dropped the external org.
 */
function queueInfo(
  queue: Map<string, InfoTarget>,
  channel: SlackChannelTeamFields & {
    id: string; is_shared?: boolean; is_ext_shared?: boolean;
    is_org_shared?: boolean; is_pending_ext_shared?: boolean;
  },
  flags: { member: boolean },
): void {
  if (!isSharedChannel(channel)) return;
  if (channelSharedTeamIds(channel, { includePending: true }).length > 0) return;
  const external = !!(channel.is_ext_shared || channel.is_pending_ext_shared);
  const existing = queue.get(channel.id);
  if (existing) {
    existing.member = existing.member || flags.member;
    existing.external = existing.external || external;
    return;
  }
  queue.set(channel.id, { member: flags.member, external });
}

/**
 * Lower sorts first. The workspace-wide sweep runs before the member-scoped one
 * and in a big workspace queues thousands of channels, so insertion order spends
 * the whole `conversations.info` budget on channels the user is not even in and
 * truncates away the private shared channel they are — the reported bug. Rank by
 * usefulness instead: a channel the user is a member of is one they can read, and
 * an externally-shared channel is the only kind that can name a *foreign* org.
 */
function infoPriority(target: InfoTarget): number {
  if (target.member && target.external) return 0;
  if (target.member) return 1;
  if (target.external) return 2;
  return 3;
}

/**
 * Sweep every source of org identity this token can see.
 *
 * Ordering matters only for cost: the cheap bulk sweeps (channel list, DM list,
 * user list) run first, and the per-item lookups afterwards only cover what the
 * bulk passes could not resolve.
 */
export async function discoverConnectedOrgs(
  client: OrgDiscoveryClient,
  options: OrgDiscoveryOptions = {},
): Promise<OrgDiscoveryResult> {
  const acc: Accumulator = { ids: new Map(), notes: [], truncated: false };
  const { currentOrgId, savedOrgIds = [] } = options;

  add(acc, currentOrgId, 'current');

  // --- 1. Channels ---------------------------------------------------------
  // conversations.list already carries team IDs on many payloads; harvest those
  // for free and only queue a conversations.info call for shared channels that
  // came back without any.
  const needsInfo = new Map<string, InfoTarget>();
  try {
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = await client.conversationsListAll(cursor, 'public_channel,private_channel');
      for (const ch of result.channels) {
        for (const tid of channelTeamIds(ch, { includePending: true })) add(acc, tid, 'channel');
        // Gate enrichment on the shared lists alone. `context_team_id` is the
        // viewing workspace, so a payload carrying only that names no partner —
        // counting it as resolved silently dropped the external org.
        queueInfo(needsInfo, ch, { member: false });
      }
      cursor = result.response_metadata?.next_cursor || undefined;
      pages++;
      if (cursor && pages >= LIST_MAX_PAGES) {
        cap(acc, `Stopped after ${LIST_MAX_PAGES} pages of channels; orgs reachable only through channels beyond that are not listed.`);
        break;
      }
    } while (cursor);
  } catch (err) {
    cap(acc, `Could not list channels (${errText(err)}); orgs reachable only through channels may be missing.`);
  }

  // --- 1b. Channels the user is actually a member of ------------------------
  // The sweep above walks the *whole workspace*, so in a big one it can spend
  // its entire page budget on internal channels and stop before reaching the
  // externally-shared ones — which is precisely how an org the user shares a
  // private channel with ended up with no checkbox.
  //
  // users.conversations is member-scoped, so this set is bounded by how many
  // channels the human is in rather than by workspace size, and it is where a
  // *private* shared channel necessarily lives (membership is the only way to
  // see one). Running it makes the common case independent of the cap above.
  // Overlap with the pass above is free: `add` is idempotent per (id, source).
  try {
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = await client.conversationsList(cursor, 'public_channel,private_channel');
      for (const ch of result.channels) {
        // Classify by the row's own flags, not by the `types` we asked for:
        // a DM counted here as a 'channel' would misreport how the org was
        // found, and the DM pass below is what collects counterpart user IDs.
        if (ch.is_im || ch.is_mpim) continue;
        for (const tid of channelTeamIds(ch, { includePending: true })) add(acc, tid, 'channel');
        queueInfo(needsInfo, ch, { member: true });
      }
      cursor = result.response_metadata?.next_cursor || undefined;
      pages++;
      if (cursor && pages >= MEMBER_LIST_MAX_PAGES) {
        cap(acc, `Stopped after ${MEMBER_LIST_MAX_PAGES} pages of your own channels; orgs reachable only through channels beyond that are not listed.`);
        break;
      }
    } while (cursor);
  } catch (err) {
    cap(acc, `Could not list your channels (${errText(err)}); orgs reachable only through a channel you are a member of may be missing.`);
  }

  // --- 2. DMs and group DMs ------------------------------------------------
  // conversations.list does not return im/mpim, so the old discovery pass could
  // not see a Slack Connect DM at all — yet allowedOrgs is enforced on DMs. Use
  // users.conversations, which is member-scoped and does return them.
  const dmUserIds: string[] = [];
  try {
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = await client.conversationsList(cursor, 'im,mpim');
      for (const ch of result.channels) {
        for (const tid of channelTeamIds(ch, { includePending: true })) add(acc, tid, 'dm');
        if (ch.is_im && ch.user) dmUserIds.push(ch.user);
      }
      cursor = result.response_metadata?.next_cursor || undefined;
      pages++;
      if (cursor && pages >= DM_LIST_MAX_PAGES) {
        cap(acc, `Stopped after ${DM_LIST_MAX_PAGES} pages of DMs; orgs reachable only through a DM beyond that are not listed.`);
        break;
      }
    } while (cursor);
  } catch (err) {
    cap(acc, `Could not list DMs (${errText(err)}); orgs you only have direct messages with may be missing.`);
  }

  // --- 3. Users ------------------------------------------------------------
  // Every user visible to the token carries its own team_id, including Slack
  // Connect counterparts. One paged sweep resolves most external orgs and the
  // DM counterparts collected above without a lookup each.
  const userTeams = new Map<string, string>();
  try {
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = await client.usersList(cursor, USER_LIST_PAGE_SIZE);
      for (const member of result.members) {
        if (member.deleted) continue;
        if (member.team_id) userTeams.set(member.id, member.team_id);
      }
      cursor = result.response_metadata?.next_cursor || undefined;
      pages++;
      if (cursor && pages >= USER_LIST_MAX_PAGES) {
        cap(acc, `Stopped after ${USER_LIST_MAX_PAGES} pages of users; orgs represented only by users beyond that are not listed.`);
        break;
      }
    } while (cursor);
  } catch (err) {
    cap(acc, `Could not list users (${errText(err)}); orgs represented only by an external user may be missing.`);
  }
  for (const teamId of userTeams.values()) add(acc, teamId, 'user');

  // --- 4. conversations.info for shared channels the list pass left blank ---
  // Array.prototype.sort is stable, so equal-priority channels keep the order
  // they were discovered in.
  const infoTargets = [...needsInfo.entries()]
    .sort(([, a], [, b]) => infoPriority(a) - infoPriority(b));
  const skipped = infoTargets.slice(CHANNEL_INFO_MAX);
  if (skipped.length > 0) {
    const skippedMember = skipped.filter(([, t]) => t.member).length;
    cap(acc, skippedMember > 0
      ? `${skipped.length} shared channel(s) beyond the first ${CHANNEL_INFO_MAX} were not inspected, including ${skippedMember} you are a member of; an org shared only through those is not listed.`
      : `${skipped.length} shared channel(s) you are not a member of were not inspected (the budget of ${CHANNEL_INFO_MAX} went to your own channels first); an org shared only through those is not listed.`);
  }
  let infoFailures = 0;
  for (const [channelId] of infoTargets.slice(0, CHANNEL_INFO_MAX)) {
    try {
      const { channel } = await client.conversationsInfo(channelId);
      for (const tid of channelTeamIds(channel, { includePending: true })) add(acc, tid, 'channel-info');
    } catch {
      // Rate limit, or a channel this token cannot inspect. Counted rather than
      // swallowed: 100 sequential tier-3 calls routinely hit a 429, and a lookup
      // that never happened is indistinguishable from an org that is not there.
      infoFailures++;
    }
  }
  if (infoFailures > 0) {
    cap(acc, `${infoFailures} shared channel(s) could not be inspected (Slack rate limit, or no access); an org shared only through those is not listed. Reopening this dialog in a minute may find more.`);
  }

  // --- 5. users.info for DM counterparts users.list did not cover ----------
  const unresolvedDmUsers = [...new Set(dmUserIds)].filter(uid => !userTeams.has(uid));
  if (unresolvedDmUsers.length > USER_INFO_MAX) {
    cap(acc, `${unresolvedDmUsers.length - USER_INFO_MAX} DM counterpart(s) were not resolved; an org you only DM may be missing.`);
  }
  for (const userId of unresolvedDmUsers.slice(0, USER_INFO_MAX)) {
    try {
      const { user } = await client.usersInfo(userId);
      add(acc, user.team_id, 'dm');
    } catch { /* skip */ }
  }

  // --- 6. Saved orgs -------------------------------------------------------
  // A saved org that nothing rediscovered still gets a row. Without it the
  // dashboard renders no checkbox for it and saving drops it from the allowlist.
  for (const id of savedOrgIds) add(acc, id, 'saved');

  // --- 7. Names ------------------------------------------------------------
  const orgIds = [...acc.ids.keys()].filter(id => id && id !== currentOrgId);
  const names = await resolveOrgNames(client, orgIds, acc, options.tokenKey);

  const orgs: DiscoveredOrg[] = orgIds.map(id => {
    const sources = [...(acc.ids.get(id) || [])];
    const name = names.get(id);
    return {
      id,
      name: name || id,
      nameResolved: !!name,
      sources,
      saved: sources.length === 1 && sources[0] === 'saved',
    };
  });

  orgs.sort((a, b) => a.name.localeCompare(b.name));
  return { orgs, truncated: acc.truncated, notes: acc.notes };
}

/**
 * Best-effort names. `team.info` on a *foreign* team usually fails even with
 * `team:read`, which is why a raw `T0…` ID showing in the UI is expected rather
 * than a bug — `nameResolved: false` lets the UI say so instead of printing an
 * ID as if it were a name.
 */
async function resolveOrgNames(
  client: OrgDiscoveryClient,
  orgIds: string[],
  acc: Accumulator,
  tokenKey?: string,
): Promise<Map<string, string>> {
  const { names, truncated, note } = await resolveTeamNames(client, orgIds, {
    tokenKey,
    max: TEAM_INFO_MAX,
  });
  if (truncated && note) cap(acc, note);
  return names;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
