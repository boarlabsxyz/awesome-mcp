// src/slack-user/server.ts
// Slack MCP using user OAuth tokens (xoxp-) with rule-based access control.
import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';
import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import { SlackClient } from '../slack/apiHelpers.js';
import { resolveUsers, getTeamId, handleReadChannelHistory, handleReadThreadReplies, handleDownloadFile, handlePostMessage, handleReplyInThread, handleSearchMessages, handleSearchFiles, type ChannelFilter } from '../slack/helpers.js';
import {
  CAPTURED_SLACK_EVENTS,
  parseTimestampInput,
  subscribeToChannelEventsFlow,
  querySlackEventsFlow,
  debugChannelEventSubscriptionFlow,
  requiredMessageEventSubscription,
  type SlackChannelShape,
} from '../slack/eventHelpers.js';
import {
  assertAccess, assertDmMemberAccess, fetchChannelMeta,
  filterDmsByOrg, filterGroupDmsByRules, classifyChannelList, toChannelMeta, assertNonOrgAccess,
  SlackAccessDenied, type ListedChannel, type ChannelMeta,
} from './accessControl.js';
import { resolveTeamNames, formatTeamLabel } from './teamNames.js';
import type { SlackAccessRules } from '../mcpConnectionStore.js';
import { registerMintRestBearerForCurl } from '../sharedTools/mintRestBearerForCurl.js';
import { registerListRestEndpoints } from '../sharedTools/listRestEndpoints.js';

export const slackUserServer = new FastMCP<UserSession>({
  name: 'Slack MCP Server',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'slack'),
});

registerMintRestBearerForCurl(slackUserServer);
registerListRestEndpoints(slackUserServer);

function getSlackUserClient(session?: UserSession): SlackClient {
  if (!session?.slackUserToken) {
    throw new UserError('Slack not connected. Visit the dashboard to connect your Slack account.');
  }
  return new SlackClient(session.slackUserToken as string);
}

function getTokenKey(session: UserSession): string {
  return session.slackUserToken as string;
}

/** Re-read access rules from the database on each call (SSE sessions are long-lived). */
async function getRules(session: UserSession): Promise<SlackAccessRules> {
  const instanceId = session.slackInstanceId as string | undefined;
  if (instanceId) {
    try {
      const { getMcpConnectionByInstanceId } = await import('../mcpConnectionStore.js');
      const connection = await getMcpConnectionByInstanceId(instanceId);
      if (connection?.providerTokens) {
        const rules = (connection.providerTokens as any).accessRules;
        if (rules) return rules;
      }
    } catch { /* fall back to session */ }
  }
  const rules = session.slackAccessRules as SlackAccessRules | undefined;
  if (!rules) {
    throw new UserError('No access rules configured. Visit the dashboard to configure access rules.');
  }
  return rules;
}

/**
 * How many orgs a denial will spend `team.info` calls naming. A channel shared
 * with more orgs than this is already unusual, and the message stays readable.
 */
const DENIAL_ORG_NAME_MAX = 3;

/**
 * Rewrite an org denial so it names the organisation instead of only its ID.
 *
 * The raw `TBM997HJR` is unresolvable from the Slack UI without digging, which
 * made the error un-actionable. Note that `team.info` on a *foreign* org
 * usually fails even with `team:read`, and every org in a denial is by
 * definition foreign — so the name often cannot be had. The ID is therefore
 * kept in every case, because it is exactly what the dashboard labels the
 * Organizations checkbox with when it could not resolve a name either, and
 * matching the two is how the user actually applies the fix.
 *
 * Best-effort throughout: if enrichment fails we rethrow the original denial
 * rather than degrade it into a lookup error.
 */
async function enrichOrgDenial(
  client: SlackClient,
  session: UserSession,
  denial: SlackAccessDenied,
): Promise<SlackAccessDenied> {
  const orgIds = denial.orgIds ?? [];
  if (denial.reason !== 'org-not-allowed' || orgIds.length === 0) return denial;
  if (orgIds.length > DENIAL_ORG_NAME_MAX) return denial;
  try {
    const { names } = await resolveTeamNames(client, orgIds, { tokenKey: getTokenKey(session) });
    if (names.size === 0) return denial;
    const labels = orgIds.map(id => formatTeamLabel(id, names)).join(', ');
    return new SlackAccessDenied(
      `Access denied: this shared channel belongs to an organisation not in your allowed list (${labels}). Tick it under Access Rules → Organizations if it should be readable.`,
      { reason: denial.reason, orgIds, channelName: denial.channelName },
    );
  } catch {
    return denial;
  }
}

/** Enforce access rules for a channel, fetching metadata as needed. */
async function enforceAccess(client: SlackClient, session: UserSession, channelId: string): Promise<void> {
  const rules = await getRules(session);
  const meta = await fetchChannelMeta(client, channelId, getTokenKey(session));
  try {
    assertAccess(rules, meta);
  } catch (err) {
    if (err instanceof SlackAccessDenied) throw await enrichOrgDenial(client, session, err);
    throw err;
  }

  try {
    await assertDmMemberAccess(client, rules, meta, channelId);
  } catch (err) {
    // Denials always propagate. A failed *lookup* does not block a direct read —
    // preserving this path's long-standing behaviour. buildChannelFilter
    // deliberately takes the opposite posture; see there.
    if (err instanceof UserError) throw err;
  }
}

/**
 * Build the per-channel access filter used by the search tools.
 *
 * enforceAccess can't be used here — it takes one channelId, and a search has
 * none. search.* reaches every channel the human belongs to, so results have
 * to be filtered after the fetch, one distinct channel at a time. Decisions are
 * memoised for the call, and fetchChannelMeta caches for 5 minutes across
 * calls, so a page of results usually costs one conversations.info per channel.
 */
async function buildChannelFilter(client: SlackClient, session: UserSession): Promise<ChannelFilter> {
  const rules = await getRules(session);
  const tokenKey = getTokenKey(session);
  const decided = new Map<string, boolean>();

  return async ({ id }) => {
    const cached = decided.get(id);
    if (cached !== undefined) return cached;
    let allowed: boolean;
    try {
      const meta = await fetchChannelMeta(client, id, tokenKey);
      assertAccess(rules, meta);
      // Same DM/group-DM rules a direct read gets. Without this, search results
      // from a DM with a non-allowed org — or a group DM holding a blacklisted
      // member — pass a filter that a direct read would reject. The extra
      // lookups only fire when allowedOrgs/blacklistUsers are configured, and
      // `decided` keeps it to once per channel per call.
      await assertDmMemberAccess(client, rules, meta, id);
      allowed = true;
    } catch {
      // A UserError means denied; anything else (channel gone, API blip) also
      // fails closed — better a missing result than a leaked one.
      allowed = false;
    }
    decided.set(id, allowed);
    return allowed;
  };
}

// === Tools ===

/**
 * How many shared channels one listChannels call will resolve via
 * conversations.info.
 *
 * conversations.list omits team IDs for many Slack Connect channels, so without
 * this the only way to learn a channel is unreadable is to try reading it.
 * conversations.info is tier-3 (~50/min) and SlackClient retries a 429 once
 * before throwing, and this handler already spends calls on DM and group-DM
 * member lookups — so the budget is deliberately half the per-minute
 * allowance. Channels past the cap are reported, never silently unchecked.
 */
const CHANNEL_INFO_BACKFILL_MAX = 25;

/** Human label for each denial reason, used in the hidden-channel summary. */
const DENIAL_LABELS: Record<string, string> = {
  'whitelist-empty': 'no whitelist configured',
  'whitelist-miss': 'whitelist',
  'blacklist-channel': 'blacklist',
  'blacklist-user': 'blocked user',
  'public-only': 'private (allowPublicOnly)',
  'org-not-allowed': 'organisation',
  'org-unverified': 'organisation unverified',
};

export interface ListRow {
  ch: ListedChannel;
  /** Set when the channel is listed but cannot be read. */
  warning?: string;
}

/**
 * Decide what a page of listed channels looks like to the caller.
 *
 * Rows fall into three buckets, and the split is the whole point of this
 * function: readable rows render normally; rows blocked by an *organisation*
 * are still listed but flagged, because the user cannot fix what they cannot
 * see — the org has to be named for them to tick it; rows blocked by the
 * user's own channel patterns are hidden and only counted, since listing them
 * would dump the names of channels they deliberately excluded.
 */
/**
 * The verdict on one classified channel once its org has been resolved.
 * `hide` carries the reason to count it under; `flag` carries the denial to
 * annotate the row with.
 */
type RowVerdict =
  | { kind: 'show' }
  | { kind: 'flag'; denial: SlackAccessDenied }
  | { kind: 'hide'; reason: string };

/**
 * Re-run the full rules against a channel whose org the list payload did not
 * name, using conversations.info.
 *
 * Only an *organisation* denial earns a visible row: the user has to see which
 * org to tick. Anything else — including a channel their own patterns exclude —
 * is hidden, and anything unexpected fails closed, because a visible row that
 * then refuses to read is the bug this whole path exists to remove.
 */
async function verifyBackfilledChannel(
  client: SlackClient,
  session: UserSession,
  rules: SlackAccessRules,
  ch: ListedChannel,
): Promise<RowVerdict> {
  try {
    const meta = await fetchChannelMeta(client, ch.id, getTokenKey(session));
    assertAccess(rules, meta);
    return { kind: 'show' };
  } catch (err) {
    if (!(err instanceof SlackAccessDenied)) return { kind: 'hide', reason: 'unavailable' };
    if (err.reason !== 'org-not-allowed') return { kind: 'hide', reason: err.reason };
    // Org-blocked. Surface it only if the user's own channel rules would have
    // allowed it; otherwise this leaks a channel their whitelist excludes on an
    // org technicality. Report the rule that actually excluded it.
    try {
      assertNonOrgAccess(rules, toChannelMeta(ch));
      return { kind: 'flag', denial: err };
    } catch (error_) {
      return {
        kind: 'hide',
        reason: error_ instanceof SlackAccessDenied ? error_.reason : 'unknown',
      };
    }
  }
}

export async function buildChannelRows(
  client: SlackClient,
  session: UserSession,
  rules: SlackAccessRules,
  channels: ListedChannel[],
): Promise<{ rows: ListRow[]; hidden: Map<string, number>; notes: string[] }> {
  const classified = classifyChannelList(rules, channels);
  const hidden = new Map<string, number>();
  const notes: string[] = [];
  const bump = (reason: string) => hidden.set(reason, (hidden.get(reason) ?? 0) + 1);

  const backfillQueue = classified.filter(c => c.allowed && c.needsOrgBackfill);
  const resolvable = new Set(backfillQueue.slice(0, CHANNEL_INFO_BACKFILL_MAX).map(c => c.ch.id));
  if (backfillQueue.length > resolvable.size) {
    notes.push(
      `${backfillQueue.length - resolvable.size} shared channel(s) beyond the first ${CHANNEL_INFO_BACKFILL_MAX} were not checked — their organisation is unverified and reading them may still be denied.`,
    );
  }

  const pending: Array<{ ch: ListedChannel; denial?: SlackAccessDenied }> = [];
  const orgIdsToName: string[] = [];

  for (const entry of classified) {
    if (!entry.allowed) {
      bump(entry.denial?.reason ?? 'unknown');
      continue;
    }
    if (!resolvable.has(entry.ch.id)) {
      pending.push({ ch: entry.ch });
      continue;
    }
    // Resolving also warms fetchChannelMeta's cache, so a follow-up read of the
    // same channel costs no extra call.
    const verdict = await verifyBackfilledChannel(client, session, rules, entry.ch);
    if (verdict.kind === 'hide') bump(verdict.reason);
    else if (verdict.kind === 'flag') {
      orgIdsToName.push(...(verdict.denial.orgIds ?? []));
      pending.push({ ch: entry.ch, denial: verdict.denial });
    } else pending.push({ ch: entry.ch });
  }

  const names = orgIdsToName.length > 0
    ? (await resolveTeamNames(client, orgIdsToName, { tokenKey: getTokenKey(session) })).names
    : new Map<string, string>();

  const rows: ListRow[] = pending.map(({ ch, denial }) => {
    if (!denial) return { ch };
    const labels = (denial.orgIds ?? []).map(id => formatTeamLabel(id, names)).join(', ');
    return {
      ch,
      warning: `Not readable: shared with ${labels}, which is not ticked under Access Rules → Organizations.`,
    };
  });

  return { rows, hidden, notes };
}

/** Conversation type label, as listChannels has always reported it. */
function channelTypeLabel(ch: ListedChannel): string {
  if (ch.is_im) return 'im';
  if (ch.is_mpim) return 'mpim';
  return ch.is_private ? 'private' : 'public';
}

/**
 * Render one block per channel.
 *
 * The load-bearing rule: a row carrying a `warning` is a channel the access
 * rules refuse to let us read, so its **free text is withheld** — topic and
 * purpose are dropped while structural facts (type, member count) stay. The
 * row exists so the user can see which organisation to allow, not to hand its
 * contents to the model anyway.
 */
export function renderChannelLines(rows: ListRow[], userNames: Map<string, string>): string[] {
  return rows.map(({ ch, warning }) => {
    const isDm = !!ch.is_im;
    const displayName = isDm && ch.user && userNames.has(ch.user)
      ? userNames.get(ch.user)!
      : ch.name;
    const prefix = isDm || ch.is_mpim ? '' : '#';
    const parts = [`${prefix}${displayName} (${ch.id})`, `  Type: ${channelTypeLabel(ch)}`];

    const anyCh = ch as any;
    if (!warning && anyCh.topic?.value) parts.push(`  Topic: ${anyCh.topic.value}`);
    if (!warning && anyCh.purpose?.value) parts.push(`  Purpose: ${anyCh.purpose.value}`);
    if (anyCh.num_members !== undefined) parts.push(`  Members: ${anyCh.num_members}`);
    if (warning) parts.push(`  ⚠ ${warning}`);
    return parts.join('\n');
  });
}

/** Render the trailing summary. Counts are never omitted — a silently short
 *  list is what made a missing channel look like a channel that doesn't exist. */
export function renderListSummary(rows: ListRow[], hidden: Map<string, number>, notes: string[]): string {
  const readable = rows.filter(r => !r.warning).length;
  const flagged = rows.length - readable;
  const hiddenTotal = [...hidden.values()].reduce((a, b) => a + b, 0);

  const parts = [`${readable} channel(s) shown`];
  if (flagged > 0) parts.push(`${flagged} listed but not readable`);
  if (hiddenTotal > 0) {
    const breakdown = [...hidden.entries()]
      .map(([reason, n]) => `${DENIAL_LABELS[reason] ?? reason}: ${n}`)
      .join(', ');
    parts.push(`${hiddenTotal} hidden by your access rules (${breakdown})`);
  }
  let out = parts.join(', ') + '.';
  if (hiddenTotal > 0 || flagged > 0) {
    out += ' Use diagnoseChannelAccess to see why a specific channel is missing or blocked.';
  }
  for (const note of notes) out += `\nNote: ${note}`;
  return out;
}

slackUserServer.addTool({
  name: 'listChannels',
  annotations: { readOnlyHint: true },
  description: 'List Slack channels and DMs you have access to, filtered by your access rules. Channels blocked by an organisation rule are still listed, marked "Not readable" with the organisation named, so you know not to plan work against them. Channels hidden by your channel patterns are counted in the summary — use diagnoseChannelAccess to find out why a specific one is missing. Use the "search" parameter to find a specific channel by name without paginating.',
  parameters: z.object({
    cursor: z.string().optional().describe('Pagination cursor from a previous response.'),
    search: z.string().optional().describe('Search for channels by name (case-insensitive substring match). When provided, paginates through all channels internally and returns only matches.'),
  }),
  execute: async (args, { session }) => {
    const client = getSlackUserClient(session);
    const rules = await getRules(session!);

    let allChannels: ListedChannel[];
    let nextCursor: string | undefined;

    if (args.search) {
      // Search mode: paginate through all channels internally to find matches
      const searchLower = args.search.toLowerCase();
      const matches: ListedChannel[] = [];
      let cursor: string | undefined;
      let pages = 0;
      const MAX_PAGES = 30; // safety limit

      do {
        const result = await client.conversationsListAll(cursor, 'public_channel,private_channel');
        for (const ch of result.channels as ListedChannel[]) {
          if (ch.name?.toLowerCase().includes(searchLower)) matches.push(ch);
        }
        cursor = result.response_metadata?.next_cursor || undefined;
        pages++;
      } while (cursor && pages < MAX_PAGES && matches.length < 50);

      // Note the ordering: matching happens on the raw page and the access
      // rules are applied afterwards, over the capped match set. Filtering
      // first would mean an org-blocked channel could never be *found* by name,
      // which is exactly the "why is it invisible" complaint this tool answers.
      allChannels = matches;
      nextCursor = undefined;
    } else {
      // Normal paginated mode
      const result = await client.conversationsListAll(args.cursor, 'public_channel,private_channel');
      const dmResult = !args.cursor ? await client.conversationsList(undefined, 'im,mpim') : { channels: [] };
      allChannels = [...result.channels, ...dmResult.channels] as ListedChannel[];
      nextCursor = result.response_metadata?.next_cursor || undefined;
    }

    const { rows, hidden, notes } = await buildChannelRows(client, session!, rules, allChannels);

    // DM/group-DM rules need async lookups, so they run over the survivors.
    const visibleChannels = rows.map(r => r.ch);
    const afterDmOrg = await filterDmsByOrg(client, rules, visibleChannels as any);
    const afterGroupDm = await filterGroupDmsByRules(client, rules, afterDmOrg as any);
    const survivingIds = new Set(afterGroupDm.map((ch: any) => ch.id));
    const dmDropped = rows.length - survivingIds.size;
    if (dmDropped > 0) hidden.set('blacklist-user', (hidden.get('blacklist-user') ?? 0) + dmDropped);
    const finalRows = rows.filter(r => survivingIds.has(r.ch.id));

    if (finalRows.length === 0) {
      const summary = renderListSummary(finalRows, hidden, notes);
      return args.search
        ? `No channels matching "${args.search}" found within your access rules.\n\n${summary}`
        : `No channels match your access rules. Check your configuration in the dashboard.\n\n${summary}`;
    }

    // Resolve DM user names
    const dmUserIds = finalRows.filter(r => r.ch.is_im && r.ch.user).map(r => r.ch.user!);
    const userNames = dmUserIds.length > 0 ? await resolveUsers(client, dmUserIds, getTokenKey(session!)) : new Map<string, string>();

    let output = renderChannelLines(finalRows, userNames).join('\n\n');
    output += `\n\n---\n${renderListSummary(finalRows, hidden, notes)}`;
    if (nextCursor) {
      output += `\nMore channels available. Use cursor: "${nextCursor}"`;
    }
    return output;
  },
});

slackUserServer.addTool({
  name: 'readChannelHistory',
  annotations: { readOnlyHint: true },
  description: 'Read recent messages from a Slack channel. Access rules are enforced.',
  parameters: z.object({
    channelId: z.string().describe('The Slack channel ID (e.g., C01234ABCDE).'),
    limit: z.number().optional().default(20).describe('Number of messages to return (1-100, default 20).'),
    oldest: z.string().optional().describe('Only messages after this Unix timestamp.'),
    latest: z.string().optional().describe('Only messages before this Unix timestamp.'),
    cursor: z.string().optional().describe('Pagination cursor from a previous response.'),
  }),
  execute: async (args, { session }) => {
    const client = getSlackUserClient(session);
    await enforceAccess(client, session!, args.channelId);
    return handleReadChannelHistory(client, getTokenKey(session!), args.channelId, args);
  },
});

slackUserServer.addTool({
  name: 'readThreadReplies',
  annotations: { readOnlyHint: true },
  description: 'Read replies in a Slack thread. Access rules are enforced.',
  parameters: z.object({
    channelId: z.string().describe('The Slack channel ID containing the thread.'),
    threadTs: z.string().describe('The timestamp of the parent message (thread_ts).'),
    limit: z.number().optional().default(50).describe('Number of replies to return (1-200, default 50).'),
    cursor: z.string().optional().describe('Pagination cursor from a previous response.'),
  }),
  execute: async (args, { session }) => {
    const client = getSlackUserClient(session);
    await enforceAccess(client, session!, args.channelId);
    return handleReadThreadReplies(client, getTokenKey(session!), args.channelId, args.threadTs, args);
  },
});

slackUserServer.addTool({
  name: 'downloadFile',
  // readOnlyHint describes Slack, which this never modifies. The "url" format
  // does write the bytes into our own image blob store.
  annotations: { readOnlyHint: true },
  description: 'Download a file attached to a Slack message. Get the fileId from the 📎 lines in readChannelHistory or readThreadReplies output, and pass the channel you read it from. Images: format "url" (default) re-hosts the image at a public URL suitable for tools that take an image URL (e.g. insertImageFromUrl), format "inline" returns the image itself so you can look at it. Text files are returned as text; other file types return metadata only. Access rules are enforced.',
  parameters: z.object({
    fileId: z.string().describe('The Slack file ID (e.g., F01234ABCDE).'),
    channelId: z.string().describe('The channel or DM the file was shared in — the one you read the message from.'),
    format: z.enum(['url', 'inline']).optional().default('url').describe('"url" re-hosts an image and returns a public link; "inline" returns the image directly (max 1.5 MB). Ignored for text files.'),
  }),
  execute: async (args, { session }) => {
    const client = getSlackUserClient(session);
    // Must run before the download: handleDownloadFile then verifies the file
    // is really shared in this (now-authorised) channel.
    await enforceAccess(client, session!, args.channelId);
    return handleDownloadFile(client, args);
  },
});

slackUserServer.addTool({
  name: 'searchMessages',
  annotations: { readOnlyHint: true },
  description: 'Search Slack messages across the workspace by keyword. Use this instead of paging readChannelHistory when looking for a specific message. Supports Slack search operators in the query: in:#channel, from:@user, before:YYYY-MM-DD, after:YYYY-MM-DD, has:link. Access rules are enforced — matches in channels you are not allowed to read are removed from the results.',
  parameters: z.object({
    query: z.string().describe('Search query. Supports Slack operators, e.g. "grafana in:#general from:@peter after:2026-07-01".'),
    count: z.number().optional().default(20).describe('Results per page (1-100, default 20).'),
    page: z.number().optional().describe('1-based page number. search pages by number, not by cursor.'),
    sort: z.enum(['score', 'timestamp']).optional().describe('"score" (relevance, default) or "timestamp" (newest/oldest first).'),
    sortDir: z.enum(['asc', 'desc']).optional().describe('Sort direction. Defaults to desc.'),
  }),
  execute: async (args, { session }) => {
    const client = getSlackUserClient(session);
    const allowChannel = await buildChannelFilter(client, session!);
    return handleSearchMessages(client, getTokenKey(session!), args, allowChannel);
  },
});

slackUserServer.addTool({
  name: 'searchFiles',
  annotations: { readOnlyHint: true },
  description: 'Search files shared in Slack by name or content. Returns each file with its ID and the channels it is shared in — pass one of those channel IDs to downloadFile to fetch the content. Access rules are enforced: a file is shown only if at least one channel it is shared in is one you are allowed to read, and a file Slack reports no channel for is withheld (the response says how many, separately from rules denials).',
  parameters: z.object({
    query: z.string().describe('Search query. Supports Slack operators, e.g. "dashboard in:#general after:2026-07-01".'),
    count: z.number().optional().default(20).describe('Results per page (1-100, default 20).'),
    page: z.number().optional().describe('1-based page number. search pages by number, not by cursor.'),
    sort: z.enum(['score', 'timestamp']).optional().describe('"score" (relevance, default) or "timestamp" (newest/oldest first).'),
    sortDir: z.enum(['asc', 'desc']).optional().describe('Sort direction. Defaults to desc.'),
  }),
  execute: async (args, { session }) => {
    const client = getSlackUserClient(session);
    const allowChannel = await buildChannelFilter(client, session!);
    return handleSearchFiles(client, args, allowChannel);
  },
});

slackUserServer.addTool({
  name: 'postMessage',
  annotations: { readOnlyHint: false },
  description: 'Post a message to a Slack channel.',
  parameters: z.object({
    channelId: z.string().describe('The Slack channel ID to post to.'),
    text: z.string().describe('Message text (supports Slack markdown/mrkdwn).'),
  }),
  execute: async (args, { session }) => {
    const client = getSlackUserClient(session);
    await enforceAccess(client, session!, args.channelId);
    return handlePostMessage(client, args.channelId, args.text);
  },
});

slackUserServer.addTool({
  name: 'replyInThread',
  annotations: { readOnlyHint: false },
  description: 'Reply to a thread in a Slack channel.',
  parameters: z.object({
    channelId: z.string().describe('The Slack channel ID containing the thread.'),
    threadTs: z.string().describe('The timestamp of the parent message to reply to.'),
    text: z.string().describe('Reply text (supports Slack markdown/mrkdwn).'),
  }),
  execute: async (args, { session }) => {
    const client = getSlackUserClient(session);
    await enforceAccess(client, session!, args.channelId);
    return handleReplyInThread(client, args.channelId, args.threadTs, args.text);
  },
});

slackUserServer.addTool({
  name: 'listUsers',
  annotations: { readOnlyHint: true },
  description: 'List workspace members. Use this to find a user by name and get their user ID for opening a DM.',
  parameters: z.object({
    cursor: z.string().optional().describe('Pagination cursor from a previous response.'),
  }),
  execute: async (args, { session }) => {
    const client = getSlackUserClient(session);
    const result = await client.usersList(args.cursor);
    const members = result.members.filter(m => !m.deleted && !m.is_bot);

    if (members.length === 0) return 'No users found.';

    const lines = members.map(m => {
      const displayName = m.profile?.display_name || m.real_name || m.name;
      return `${displayName} (@${m.name}) — ID: ${m.id}`;
    });

    let output = lines.join('\n');
    const nextCursor = result.response_metadata?.next_cursor;
    if (nextCursor) {
      output += `\n\n---\nMore users available. Use cursor: "${nextCursor}"`;
    }
    return output;
  },
});

slackUserServer.addTool({
  name: 'openDm',
  annotations: { readOnlyHint: false },
  description: 'Open (or retrieve) a 1-on-1 DM channel with a user. Returns the DM channel ID that can be used with postMessage.',
  parameters: z.object({
    userId: z.string().describe('The Slack user ID to open a DM with (e.g., U01234ABCDE).'),
  }),
  execute: async (args, { session }) => {
    const client = getSlackUserClient(session);
    const result = await client.conversationsOpen(args.userId);
    return `DM channel opened: ${result.channel.id}\n\nYou can now use postMessage with channelId "${result.channel.id}" to send a direct message.`;
  },
});

// === Channel event subscriptions ===
//
// Mirrors the ClickUp task-event quartet (subscribeToTaskEvents et al.) in both
// naming and delivery model: subscribing records a local interest filter, the
// public /webhooks/slack/inbound route writes matching events to Postgres, and
// getChannelEventHistory reads them back. Nothing is pushed — what this removes
// is paging a channel to exhaustion and keeping your own watermark, not the
// need to ask.
//
// Slack-specific: event subscriptions are configured once on the Slack app by
// the operator (Request URL + SLACK_SIGNING_SECRET), not created per user via
// the API, so subscribing here makes no Slack call at all.

/** Resolve the workspace ID that scopes every subscription, or fail loudly. */
async function requireTeamId(client: SlackClient, session: UserSession): Promise<string> {
  const teamId = await getTeamId(client, getTokenKey(session));
  if (!teamId) {
    throw new UserError('Could not determine the Slack workspace ID (auth.test failed). Reconnect Slack from the dashboard.');
  }
  return teamId;
}

function slackRequestUrl(): string {
  const baseUrl = (process.env.BASE_URL || '').replace(/\/+$/, '');
  return baseUrl ? `${baseUrl}/webhooks/slack/inbound` : '';
}

slackUserServer.addTool({
  name: 'subscribeToChannelEvents',
  annotations: { readOnlyHint: false },
  description: 'Record interest in a Slack channel\'s events so they accrue in a durable store you can query later with getChannelEventHistory, instead of re-reading the channel and tracking your own watermark. IDEMPOTENT: re-calling for the same channel returns the existing subscription. Events are "message" (new messages and thread replies in public channels, private channels, DMs, and group DMs; join/leave noise is excluded) and "reaction_added". Slack delivers each of those channel types through a SEPARATE app-level toggle (message.channels / message.groups / message.im / message.mpim), so a workspace with only message.channels enabled records nothing for a DM — this tool names the one your channel needs. Optionally set matchPattern to record only messages whose text contains it (case-insensitive substring). History accrues from this moment forward — for anything earlier use readChannelHistory. Requires the operator to have configured the Slack app\'s Event Subscriptions Request URL and SLACK_SIGNING_SECRET; run debugChannelEventSubscription if events do not arrive. Access rules are enforced.',
  parameters: z.object({
    channelId: z.string().describe('The Slack channel ID to watch (e.g., C01234ABCDE).'),
    events: z.array(z.enum(['message', 'reaction_added'])).optional().describe('Event types to capture. Defaults to both.'),
    matchPattern: z.string().optional().describe('Only capture events whose text contains this string (case-insensitive). Omit to capture everything.'),
  }),
  execute: async (args, { session }) => {
    if (!session?.userId) {
      throw new UserError('subscribeToChannelEvents requires a logged-in user context.');
    }
    const client = getSlackUserClient(session);
    await enforceAccess(client, session, args.channelId);
    const teamId = await requireTeamId(client, session);
    const store = await import('../slack/eventStore.js');

    // enforceAccess already fetched (and cached) this, so it costs nothing —
    // and it is what turns the generic "configure Event Subscriptions" advice
    // into the one toggle this channel actually needs.
    let channelShape: SlackChannelShape | null = null;
    try {
      const meta = await fetchChannelMeta(client, args.channelId, getTokenKey(session));
      channelShape = { isIm: meta.is_im ?? null, isMpim: meta.is_mpim ?? null, isPrivate: meta.is_private ?? null };
    } catch { /* fall back to the ID-prefix heuristic */ }
    const required = requiredMessageEventSubscription(args.channelId, channelShape);

    const events = (args.events && args.events.length > 0) ? args.events : [...CAPTURED_SLACK_EVENTS];
    const result = await subscribeToChannelEventsFlow(
      { findSubscription: store.findSubscription, createSubscription: store.createSubscription },
      { userId: session.userId, teamId, channelId: args.channelId, events, matchPattern: args.matchPattern ?? null },
    );

    const sub = result.subscription;
    const lines = result.kind === 'existing'
      ? ['Subscription already active (idempotent no-op).']
      : ['Subscription created.'];
    lines.push(
      `  Subscription ID: ${sub.id}`,
      `  Channel: ${sub.channelId} (workspace ${sub.teamId})`,
      `  Events: ${sub.events.join(', ')}`,
      `  Match pattern: ${sub.matchPattern ?? '(none — capturing all)'}`,
      `  Status: ${sub.status} (fail_count: ${sub.failCount})`,
      `  History accrues from: ${sub.createdAt}`,
    );
    if (result.kind === 'created') {
      const url = slackRequestUrl();
      lines.push(
        '',
        `Delivery depends on the Slack app being configured to POST events to ${url || '${BASE_URL}/webhooks/slack/inbound (BASE_URL is not set)'}.`,
        `This channel is a ${required.kind}, so the app must have "${required.event}" enabled under Event Subscriptions — message.channels does not cover DMs, group DMs, or private channels.`,
        'If getChannelEventHistory stays empty, run debugChannelEventSubscription.',
      );
    }
    return lines.join('\n');
  },
});

slackUserServer.addTool({
  name: 'listChannelEventSubscriptions',
  annotations: { readOnlyHint: true },
  description: 'List the Slack channel-event subscriptions you own, with their event types, match patterns and fail counts. Optionally narrow to one channel.',
  parameters: z.object({
    channelId: z.string().optional().describe('Optional channel ID to narrow to a single subscription.'),
  }),
  execute: async (args, { session }) => {
    if (!session?.userId) {
      throw new UserError('listChannelEventSubscriptions requires a logged-in user context.');
    }
    const store = await import('../slack/eventStore.js');
    const subs = await store.listSubscriptionsForUser(session.userId, args.channelId);
    if (subs.length === 0) return 'No channel-event subscriptions.';
    return subs.map(s => [
      `Subscription ${s.id}`,
      `  Channel: ${s.channelId} (workspace ${s.teamId})`,
      `  Events: ${s.events.join(', ')}`,
      `  Match pattern: ${s.matchPattern ?? '(none)'}`,
      `  Status: ${s.status}, fail_count: ${s.failCount}`,
      `  History accrues from: ${s.createdAt}`,
    ].join('\n')).join('\n\n');
  },
});

slackUserServer.addTool({
  name: 'getChannelEventHistory',
  annotations: { readOnlyHint: true },
  description: 'Read the Slack events captured for a channel since you subscribed to it — the exact record of what happened, instead of re-reading the channel and filtering client-side. IMPORTANT: history only accrues from the moment subscribeToChannelEvents was called; the response reports that boundary, and for earlier windows you should fall back to readChannelHistory. If no subscription exists this reports that as a warning rather than an error, so a routine can fall back cleanly. Access rules are enforced on every call, so a channel that has since been denied stops returning history.',
  parameters: z.object({
    channelId: z.string().describe('The Slack channel ID.'),
    since: z.string().optional().describe('Only events at/after this time. ISO string or Unix ms.'),
    until: z.string().optional().describe('Only events at/before this time. ISO string or Unix ms.'),
    eventTypes: z.array(z.enum(['message', 'reaction_added'])).optional().describe('Filter to specific event types. Omit for all captured events.'),
    limit: z.number().int().min(1).max(2000).optional().describe('Row cap (default 500, max 2000). Narrow via `since` if you hit the cap.'),
  }),
  execute: async (args, { session }) => {
    if (!session?.userId) {
      throw new UserError('getChannelEventHistory requires a logged-in user context.');
    }
    const client = getSlackUserClient(session);
    // Re-checked on every read, not just at subscribe: rules are re-read from
    // the database per call and may have tightened since the subscription was
    // created, and stored history must not outlive the access that allowed it.
    await enforceAccess(client, session, args.channelId);
    const teamId = await requireTeamId(client, session);

    const parseTs = (input: string | undefined, field: string): number | undefined => {
      if (!input) return undefined;
      const ts = parseTimestampInput(input);
      if (Number.isNaN(ts)) throw new UserError(`Invalid ${field}: ${input}`);
      return ts;
    };

    const store = await import('../slack/eventStore.js');
    const result = await querySlackEventsFlow(
      { findSubscription: store.findSubscription, querySlackEvents: store.querySlackEvents },
      {
        userId: session.userId, teamId, channelId: args.channelId,
        since: parseTs(args.since, 'since'), until: parseTs(args.until, 'until'),
        eventTypes: args.eventTypes, limit: args.limit,
      },
    );

    if (result.kind === 'no-subscription') {
      return ['No channel-event subscription for this channel.', `  Warning: ${result.warning}`].join('\n');
    }

    const header = [
      `Found ${result.events.length} event(s) in channel ${args.channelId}.`,
      `  Event store started: ${result.eventStoreStartedAt}`,
      `  Subscription: ${result.subscription!.id} (fail_count: ${result.subscription!.failCount})`,
    ];
    if (result.warning) header.push(`  Warning: ${result.warning}`);
    if (result.events.length === 0) return header.join('\n');

    const userNames = await resolveUsers(
      client,
      result.events.map(e => e.actorId).filter(Boolean) as string[],
      getTokenKey(session),
    );
    const rows = result.events.map(e => {
      const who = e.actorId ? (userNames.get(e.actorId) || e.actorId) : 'unknown';
      const thread = e.threadTs && e.threadTs !== e.messageTs ? ` [in thread ${e.threadTs}]` : '';
      const body = e.text ? `: ${e.text}` : '';
      return `- ${new Date(e.occurredAt).toISOString()}  ${e.eventType}  ts=${e.messageTs ?? '?'}${thread}  ${who}${body}`;
    });
    return [...header, '', ...rows].join('\n');
  },
});

slackUserServer.addTool({
  name: 'debugChannelEventSubscription',
  annotations: { readOnlyHint: true },
  description: 'Diagnose a channel-event subscription that reports success but is not accruing events. Reports the local record, whether SLACK_SIGNING_SECRET is configured, the Request URL the Slack app must be pointed at, which per-channel-type event subscription (message.channels / message.groups / message.im / message.mpim) this channel needs enabled on the Slack app, whether you are a member of the channel, event-store counts, and — decisively — whether Slack has ever POSTed to this deployment at all and how those deliveries ended. That last part separates "the Request URL is not configured" from "deliveries arrive but nothing matched". Use when getChannelEventHistory stays empty.',
  parameters: z.object({
    channelId: z.string().describe('The Slack channel ID.'),
  }),
  execute: async (args, { session }) => {
    if (!session?.userId) {
      throw new UserError('debugChannelEventSubscription requires a logged-in user context.');
    }
    const client = getSlackUserClient(session);
    await enforceAccess(client, session, args.channelId);
    const teamId = await requireTeamId(client, session);
    const store = await import('../slack/eventStore.js');

    const report = await debugChannelEventSubscriptionFlow(
      {
        findSubscription: store.findSubscription,
        countChannelEventsForSubscription: store.countChannelEventsForSubscription,
        querySlackEvents: store.querySlackEvents,
        getChannelInfo: async (channelId: string) => (await client.conversationsInfo(channelId)).channel,
        readIngestHealth: store.readIngestHealth,
      },
      {
        userId: session.userId, teamId, channelId: args.channelId,
        expectedRequestUrl: slackRequestUrl(),
        signingSecretConfigured: !!process.env.SLACK_SIGNING_SECRET,
      },
    );

    const lines: string[] = [
      `Channel-Event Subscription Diagnostic — channel ${report.channelId} (workspace ${teamId})`,
      `  Overall: ${report.kind}`,
      `  SLACK_SIGNING_SECRET configured: ${report.signingSecretConfigured ? 'yes' : 'NO'}`,
      `  Expected Request URL: ${report.expectedRequestUrl || '(BASE_URL not set)'}`,
      `  Required Slack event subscription: ${report.requiredEventSubscription}`,
      '',
    ];
    if (report.local) {
      lines.push(
        'Local subscription record:',
        `  Subscription ID: ${report.local.id}`,
        `  Events: [${report.local.events.join(', ')}]`,
        `  Match pattern: ${report.local.matchPattern ?? '(none)'}`,
        `  Status: ${report.local.status}, fail_count: ${report.local.failCount}`,
        `  Created: ${report.local.createdAt}`,
        '',
      );
    } else {
      lines.push('Local subscription record: (none)', '');
    }
    if (report.channel) {
      lines.push(
        'Channel:',
        `  Name: ${report.channel.name ? '#' + report.channel.name : '(unknown)'}`,
        `  Member: ${report.channel.isMember === null ? '(unknown)' : report.channel.isMember ? 'yes' : 'NO'}`,
        '',
      );
    }
    if (report.eventStore) {
      lines.push(
        'Event store:',
        `  Total events for this subscription: ${report.eventStore.count}`,
        `  Most recent occurredAt: ${report.eventStore.mostRecentOccurredAt !== null ? new Date(report.eventStore.mostRecentOccurredAt).toISOString() : '(none)'}`,
        `  Most recent receivedAt: ${report.eventStore.mostRecentReceivedAt ?? '(none)'}`,
        '',
      );
    }
    if (report.ingestHealth) {
      lines.push('Inbound deliveries seen by this deployment (all channels, all users):');
      if (report.ingestHealth.length === 0) {
        lines.push('  (none — Slack has never POSTed to this deployment)');
      } else {
        for (const h of report.ingestHealth) {
          const where = h.lastChannelId ? ` last channel ${h.lastChannelId}` : '';
          lines.push(`  ${h.branch}: ${h.deliveryCount} (last ${h.lastAt})${where}`);
        }
      }
      lines.push('');
    }
    lines.push('Findings:');
    for (const f of report.findings) lines.push(`  - ${f}`);
    return lines.join('\n');
  },
});

slackUserServer.addTool({
  name: 'unsubscribeFromChannelEvents',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Delete your channel-event subscription for a Slack channel. This also deletes the events captured for it, so history cannot be recovered by re-subscribing — a fresh subscription starts accruing from that moment. Nothing changes on Slack\'s side: event delivery is configured on the app, so other subscribers keep receiving events.',
  parameters: z.object({
    channelId: z.string().describe('The Slack channel ID to stop watching.'),
  }),
  execute: async (args, { session }) => {
    if (!session?.userId) {
      throw new UserError('unsubscribeFromChannelEvents requires a logged-in user context.');
    }
    const client = getSlackUserClient(session);
    // Deliberately no enforceAccess: deleting your own subscription reads no
    // channel content, and gating it would trap a user whose access to the
    // channel was revoked after subscribing — they could never clean up.
    const teamId = await requireTeamId(client, session);
    const store = await import('../slack/eventStore.js');

    let sub = await store.findSubscription(session.userId, teamId, args.channelId);
    let staleTeamNote = '';
    if (!sub) {
      // A subscription made while connected to a different workspace is still
      // listed by listChannelEventSubscriptions, so it must be deletable —
      // otherwise the user can see a row they can never clean up. Fall back to
      // their own row for this channel in any workspace.
      const [orphan] = await store.listSubscriptionsForUser(session.userId, args.channelId);
      if (!orphan) {
        return `No channel-event subscription found for ${args.channelId}. Nothing to unsubscribe.`;
      }
      sub = orphan;
      staleTeamNote = `  Note: this subscription belonged to workspace ${orphan.teamId}, not the one you are connected to now (${teamId}).`;
    }
    const eventCount = await store.countChannelEventsForSubscription(sub.id);
    const deleted = await store.deleteSubscription(session.userId, sub.teamId, args.channelId);

    if (staleTeamNote) {
      return [
        'Unsubscribed.',
        staleTeamNote,
        `  Local record: ${deleted ? 'deleted' : 'not found (unexpected)'}`,
        `  Captured events discarded: ${eventCount}`,
      ].join('\n');
    }

    return [
      'Unsubscribed.',
      `  Local record: ${deleted ? 'deleted' : 'not found (unexpected — findSubscription had returned a row)'}`,
      `  Captured events discarded: ${eventCount}`,
      '',
      'Call subscribeToChannelEvents again to start accruing from that moment forward.',
    ].join('\n');
  },
});

/**
 * Slack channel IDs: C (public/private), D (DM), G (legacy group). Used to skip
 * the name scan entirely when the caller already has an ID.
 */
const CHANNEL_ID_RE = /^[CDG][A-Z0-9]{6,}$/i;

/** How many conversations.list pages the name fallback will scan. */
const DIAGNOSE_MAX_PAGES = 10;

/** Outcome of resolving a channel name to an ID. */
export type ChannelLookup =
  | { kind: 'found'; channelId: string }
  | { kind: 'none' }
  | { kind: 'scanBounded'; pages: number }
  | { kind: 'ambiguous'; ids: string[] };

/**
 * Resolve a channel *name* to an ID.
 *
 * Slack has no name-lookup endpoint, so this is a scan. It starts with
 * users.conversations, which is member-scoped and therefore returns tens of
 * rows rather than thousands — and covers essentially every real "why can't I
 * read #x", since you are normally already in the channel. Only on a miss does
 * it fall back to the workspace-wide list, bounded, and it reports hitting that
 * bound rather than claiming the channel does not exist.
 */
export async function lookupChannelByName(
  client: Pick<SlackClient, 'conversationsList' | 'conversationsListAll'>,
  name: string,
): Promise<ChannelLookup> {
  const wanted = name.replace(/^#/, '').toLowerCase();
  const matches = (channels: ListedChannel[]) =>
    channels.filter(ch => ch.name?.toLowerCase() === wanted);

  const mine = await client.conversationsList(undefined, 'public_channel,private_channel,mpim,im');
  let hits = matches(mine.channels as ListedChannel[]);

  let cursor: string | undefined;
  let pages = 0;
  while (hits.length === 0 && pages < DIAGNOSE_MAX_PAGES) {
    const page = await client.conversationsListAll(cursor, 'public_channel,private_channel');
    hits = matches(page.channels as ListedChannel[]);
    cursor = page.response_metadata?.next_cursor || undefined;
    pages++;
    if (!cursor) break;
  }

  if (hits.length === 1) return { kind: 'found', channelId: hits[0].id };
  if (hits.length > 1) return { kind: 'ambiguous', ids: hits.map(h => h.id) };
  // A bounded scan is a floor, not a verdict.
  return cursor ? { kind: 'scanBounded', pages } : { kind: 'none' };
}

/**
 * Turn a denial into the rule that caused it plus the change that fixes it.
 *
 * Pure so it can be tested per reason without a Slack client. Reports the
 * user's own configuration back to them — never channel content.
 */
export function explainDenial(
  denial: SlackAccessDenied,
  rules: SlackAccessRules,
  channelName: string,
  orgNames?: Map<string, string>,
): string[] {
  const out = [`Denied by: ${DENIAL_LABELS[denial.reason] ?? denial.reason}`];
  switch (denial.reason) {
    case 'org-not-allowed': {
      const labels = (denial.orgIds ?? []).map(id => formatTeamLabel(id, orgNames)).join(', ');
      out.push(
        `Organisation(s) not allowed: ${labels}`,
        `Your allowed organisations: ${rules.allowedOrgs.length ? rules.allowedOrgs.join(', ') : '(none)'}`,
        'Fix: tick the organisation under Access Rules → Organizations in the dashboard.',
        'If it has no checkbox there, it was not discovered — reopen the modal to refresh, and note that an organisation Slack will not name is listed by its raw ID.',
      );
      break;
    }
    case 'org-unverified':
      out.push(
        'Slack returned no organisation for this shared channel, so it cannot be checked against your allowlist.',
        'Fix: usually transient. If it persists, the channel is shared with an organisation Slack will not disclose to this token.',
      );
      break;
    case 'whitelist-empty':
      out.push(
        'Your channel whitelist is empty, so no channel is readable.',
        'Fix: add at least one pattern under Access Rules → Channels (use "*" to allow all).',
      );
      break;
    case 'whitelist-miss':
      out.push(
        `Your whitelist patterns: ${JSON.stringify(denial.patterns ?? [])}`,
        `Fix: add "${channelName}" (or a pattern matching it) under Access Rules → Channels.`,
      );
      break;
    case 'blacklist-channel':
      out.push(
        `Your blacklist patterns: ${JSON.stringify(denial.patterns ?? [])}`,
        `Fix: remove the pattern matching "${channelName}" under Access Rules → Channels.`,
      );
      break;
    case 'blacklist-user':
      out.push(
        'The other participant is on your blocked-users list.',
        'Fix: remove them under Access Rules → Blocked users.',
      );
      break;
    case 'public-only':
      out.push(
        'allowPublicOnly is enabled and this channel is private.',
        'Fix: disable "public channels only" under Access Rules.',
      );
      break;
  }
  return out;
}

/** One-line identity header. Structural facts only — no topic, purpose or content. */
export function describeChannel(meta: ChannelMeta, channelId: string): string {
  let kind: string;
  if (meta.is_im) kind = 'DM';
  else if (meta.is_mpim) kind = 'group DM';
  else kind = meta.is_private ? 'private' : 'public';
  const label = meta.is_im || meta.is_mpim ? meta.name || channelId : `#${meta.name}`;
  const shared = meta.is_shared ? ', shared with another organisation' : '';
  return `${label} (${channelId}) — ${kind}${shared}`;
}

slackUserServer.addTool({
  name: 'diagnoseChannelAccess',
  annotations: { readOnlyHint: true },
  description: 'Explain why a Slack channel is or is not readable under your access rules. Use this when a channel you expect is missing from listChannels, or when a read is denied and you want to know which rule caused it and how to fix it. Pass channelId when you have it (fastest); otherwise pass name. Returns the deciding rule and your current configuration — never message content.',
  parameters: z.object({
    channelId: z.string().optional().describe('The Slack channel ID (e.g., C01234ABCDE). Preferred — resolves in a single call.'),
    name: z.string().optional().describe('Channel name to look up when you do not have the ID (e.g., "awesome-mcp-support"). Case-insensitive.'),
  }),
  execute: async (args, { session }) => {
    if (!args.channelId && !args.name) throw new UserError('Pass either channelId or name.');
    const client = getSlackUserClient(session);
    const rules = await getRules(session!);
    const tokenKey = getTokenKey(session!);

    // An ID passed in the name slot is a common caller mistake; treat it as an
    // ID rather than scanning the workspace for a channel literally so named.
    let channelId = args.channelId
      ?? (args.name && CHANNEL_ID_RE.test(args.name) ? args.name : undefined);

    if (!channelId && args.name) {
      const found = await lookupChannelByName(client, args.name);
      switch (found.kind) {
        case 'found': channelId = found.channelId; break;
        case 'ambiguous':
          return [`${found.ids.length} channels are named "${args.name}". Re-run with one of these IDs:`,
            ...found.ids.map(id => `  ${id}`)].join('\n');
        case 'scanBounded':
          return [
            `No channel named "${args.name}" found in the first ${found.pages} page(s) of the workspace channel list.`,
            'The scan stopped at its page limit, so the channel may still exist further in. Pass channelId to check it directly.',
          ].join('\n');
        default:
          return `No channel named "${args.name}" is visible to your Slack account. Slack itself does not return it, so this is not an access-rules problem — you are most likely not a member of it.`;
      }
    }

    const meta = await fetchChannelMeta(client, channelId!, tokenKey);
    const header = describeChannel(meta, channelId!);

    let denial: SlackAccessDenied | undefined;
    try {
      assertAccess(rules, meta);
      await assertDmMemberAccess(client, rules, meta, channelId!);
    } catch (err) {
      if (err instanceof SlackAccessDenied) denial = err;
      else if (err instanceof UserError) return [header, '', `Denied by: ${err.message}`].join('\n');
      else throw err;
    }

    if (!denial) {
      return [header, '', 'Readable: yes. Every access rule passes for this channel.'].join('\n');
    }

    const orgNames = denial.reason === 'org-not-allowed'
      ? (await resolveTeamNames(client, denial.orgIds ?? [], { tokenKey })).names
      : undefined;
    return [header, '', ...explainDenial(denial, rules, meta.name, orgNames)].join('\n');
  },
});
