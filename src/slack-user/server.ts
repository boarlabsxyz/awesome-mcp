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
} from '../slack/eventHelpers.js';
import { assertAccess, fetchChannelMeta, filterChannelList, filterDmsByOrg, filterGroupDmsByRules } from './accessControl.js';
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

/** Enforce access rules for a channel, fetching metadata as needed. */
async function enforceAccess(client: SlackClient, session: UserSession, channelId: string): Promise<void> {
  const rules = await getRules(session);
  const meta = await fetchChannelMeta(client, channelId, getTokenKey(session));
  assertAccess(rules, meta);

  // Additional checks for DMs (assertAccess can't do these without API lookups)
  if (meta.is_im && meta.user && rules.allowedOrgs.length > 0) {
    try {
      const { user } = await client.usersInfo(meta.user);
      if (user.team_id && !rules.allowedOrgs.includes(user.team_id)) {
        throw new UserError('Access denied: this user belongs to an organisation not in your allowed list.');
      }
    } catch (err) {
      if (err instanceof UserError) throw err;
    }
  }

  // Group DM: check blacklist and org membership
  if (meta.is_mpim && (rules.blacklistUsers.length > 0 || rules.allowedOrgs.length > 0)) {
    try {
      const { members } = await client.conversationsMembers(channelId);
      if (rules.blacklistUsers.length > 0 && members.some(uid => rules.blacklistUsers.includes(uid))) {
        throw new UserError('Access denied: this group DM contains a blacklisted user.');
      }
      if (rules.allowedOrgs.length > 0) {
        for (const uid of members) {
          try {
            const { user } = await client.usersInfo(uid);
            if (user.team_id && !rules.allowedOrgs.includes(user.team_id)) {
              throw new UserError('Access denied: this group DM contains a user from a non-allowed organisation.');
            }
          } catch (e) {
            if (e instanceof UserError) throw e;
          }
        }
      }
    } catch (err) {
      if (err instanceof UserError) throw err;
    }
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
      assertAccess(rules, await fetchChannelMeta(client, id, tokenKey));
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

slackUserServer.addTool({
  name: 'listChannels',
  annotations: { readOnlyHint: true },
  description: 'List Slack channels and DMs you have access to, filtered by your access rules. Use the "search" parameter to find a specific channel by name without paginating.',
  parameters: z.object({
    cursor: z.string().optional().describe('Pagination cursor from a previous response.'),
    search: z.string().optional().describe('Search for channels by name (case-insensitive substring match). When provided, paginates through all channels internally and returns only matches.'),
  }),
  execute: async (args, { session }) => {
    const client = getSlackUserClient(session);
    const rules = await getRules(session!);

    let allChannels: any[];
    let nextCursor: string | undefined;

    if (args.search) {
      // Search mode: paginate through all channels internally to find matches
      const searchLower = args.search.toLowerCase();
      const matches: any[] = [];
      let cursor: string | undefined;
      let pages = 0;
      const MAX_PAGES = 30; // safety limit

      do {
        const result = await client.conversationsListAll(cursor, 'public_channel,private_channel');
        const filtered = filterChannelList(rules, result.channels);
        for (const ch of filtered) {
          if (ch.name?.toLowerCase().includes(searchLower)) {
            matches.push(ch);
          }
        }
        cursor = result.response_metadata?.next_cursor || undefined;
        pages++;
      } while (cursor && pages < MAX_PAGES && matches.length < 50);

      allChannels = matches;
      nextCursor = undefined;
    } else {
      // Normal paginated mode
      const result = await client.conversationsListAll(args.cursor, 'public_channel,private_channel');
      const dmResult = !args.cursor ? await client.conversationsList(undefined, 'im,mpim') : { channels: [] };
      const allConvos = [...result.channels, ...dmResult.channels];
      const channels = filterChannelList(rules, allConvos);
      const filteredByOrg = await filterDmsByOrg(client, rules, channels as any);
      const filteredByRules = await filterGroupDmsByRules(client, rules, filteredByOrg as any);
      allChannels = filteredByRules;
      nextCursor = result.response_metadata?.next_cursor || undefined;
    }

    if (allChannels.length === 0) {
      return args.search
        ? `No channels matching "${args.search}" found within your access rules.`
        : 'No channels match your access rules. Check your configuration in the dashboard.';
    }

    // Resolve DM user names
    const dmUserIds = allChannels.filter(ch => (ch as any).is_im && ch.user).map(ch => ch.user!);
    const userNames = dmUserIds.length > 0 ? await resolveUsers(client, dmUserIds, getTokenKey(session!)) : new Map<string, string>();

    const lines = allChannels.map(ch => {
      const isDm = !!(ch as any).is_im;
      const isMpim = !!(ch as any).is_mpim;
      const type = isDm ? 'im' : isMpim ? 'mpim' : ch.is_private ? 'private' : 'public';
      let displayName = ch.name;
      if (isDm && ch.user && userNames.has(ch.user)) {
        displayName = userNames.get(ch.user)!;
      }
      const prefix = isDm || isMpim ? '' : '#';
      const parts = [
        `${prefix}${displayName} (${ch.id})`,
        `  Type: ${type}`,
      ];
      if (ch.topic?.value) parts.push(`  Topic: ${ch.topic.value}`);
      if (ch.purpose?.value) parts.push(`  Purpose: ${ch.purpose.value}`);
      if (ch.num_members !== undefined) parts.push(`  Members: ${ch.num_members}`);
      return parts.join('\n');
    });

    let output = lines.join('\n\n');
    if (nextCursor) {
      output += `\n\n---\nMore channels available. Use cursor: "${nextCursor}"`;
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
  description: 'Record interest in a Slack channel\'s events so they accrue in a durable store you can query later with getChannelEventHistory, instead of re-reading the channel and tracking your own watermark. IDEMPOTENT: re-calling for the same channel returns the existing subscription. Events are "message" (new messages and thread replies in channels and private channels; join/leave noise is excluded) and "reaction_added". Optionally set matchPattern to record only messages whose text contains it (case-insensitive substring). History accrues from this moment forward — for anything earlier use readChannelHistory. Requires the operator to have configured the Slack app\'s Event Subscriptions Request URL and SLACK_SIGNING_SECRET; run debugChannelEventSubscription if events do not arrive. Access rules are enforced.',
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
  description: 'Diagnose a channel-event subscription that reports success but is not accruing events. Reports the local record, whether SLACK_SIGNING_SECRET is configured, the Request URL the Slack app must be pointed at, whether you are actually a member of the channel (Slack does not deliver events for channels the installation is not in), and event-store counts — then lists the anomalies it found. Use when getChannelEventHistory stays empty.',
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
