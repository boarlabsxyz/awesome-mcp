// src/slack-user/server.ts
// Slack MCP using user OAuth tokens (xoxp-) with rule-based access control.
import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';
import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import { SlackClient } from '../slack/apiHelpers.js';
import { resolveUsers, handleReadChannelHistory, handleReadThreadReplies, handlePostMessage, handleReplyInThread } from '../slack/helpers.js';
import { assertAccess, fetchChannelMeta, filterChannelList, filterDmsByOrg, filterGroupDmsByRules } from './accessControl.js';
import type { SlackAccessRules } from '../mcpConnectionStore.js';

export const slackUserServer = new FastMCP<UserSession>({
  name: 'Slack MCP Server',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'slack'),
});

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

// === Tools ===

slackUserServer.addTool({
  name: 'listChannels',
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
  name: 'postMessage',
  description: 'Post a message to a Slack channel. Requires SLACK_WRITES_ENABLED=true. Access rules enforced.',
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
  description: 'Reply to a thread in a Slack channel. Requires SLACK_WRITES_ENABLED=true. Access rules enforced.',
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
