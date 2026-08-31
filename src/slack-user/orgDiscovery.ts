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
import {
  channelTeamIds,
  isSharedChannel,
  type SlackChannelTeamFields,
} from '../slack/apiHelpers.js';

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
export const LIST_MAX_PAGES = 25;          // 25 × 200 channels
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
  conversationsList(cursor?: string, types?: string): Promise<{
    channels: Array<SlackChannelTeamFields & {
      id: string; is_im?: boolean; is_mpim?: boolean; user?: string;
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
  const needsInfo: string[] = [];
  try {
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = await client.conversationsListAll(cursor, 'public_channel,private_channel');
      for (const ch of result.channels) {
        const teamIds = channelTeamIds(ch, { includePending: true });
        for (const tid of teamIds) add(acc, tid, 'channel');
        if (isSharedChannel(ch) && teamIds.length === 0) needsInfo.push(ch.id);
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
  const infoTargets = [...new Set(needsInfo)];
  if (infoTargets.length > CHANNEL_INFO_MAX) {
    cap(acc, `${infoTargets.length - CHANNEL_INFO_MAX} shared channel(s) beyond the first ${CHANNEL_INFO_MAX} were not inspected; an org shared only through those is not listed.`);
  }
  for (const channelId of infoTargets.slice(0, CHANNEL_INFO_MAX)) {
    try {
      const { channel } = await client.conversationsInfo(channelId);
      for (const tid of channelTeamIds(channel, { includePending: true })) add(acc, tid, 'channel-info');
    } catch { /* skip — rate limit or a channel this token cannot inspect */ }
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
  const names = await resolveOrgNames(client, orgIds, acc);

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
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (orgIds.length > TEAM_INFO_MAX) {
    cap(acc, `Only the first ${TEAM_INFO_MAX} organisations were named; the rest are shown by ID.`);
  }
  for (const id of orgIds.slice(0, TEAM_INFO_MAX)) {
    try {
      const { team } = await client.teamInfo(id);
      if (team?.name) names.set(id, team.name);
    } catch { /* external org — the ID is the fallback label */ }
  }
  return names;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
