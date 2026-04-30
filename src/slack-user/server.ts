// src/slack-user/server.ts
// Slack MCP using user OAuth tokens (xoxp-) with rule-based access control.
import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';
import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import { SlackClient } from '../slack/apiHelpers.js';
import { resolveUsers, getWorkspaceUrl, formatMessage, assertWritesEnabled } from '../slack/helpers.js';
import { assertAccess, fetchChannelMeta, filterChannelList, filterDmsByOrg } from './accessControl.js';
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

function getRules(session: UserSession): SlackAccessRules {
  const rules = session.slackAccessRules as SlackAccessRules | undefined;
  if (!rules) {
    throw new UserError('No access rules configured. Visit the dashboard to configure access rules.');
  }
  return rules;
}

/** Enforce access rules for a channel, fetching metadata as needed. */
async function enforceAccess(client: SlackClient, session: UserSession, channelId: string): Promise<void> {
  const rules = getRules(session);
  const meta = await fetchChannelMeta(client, channelId, session.slackUserToken as string);
  assertAccess(rules, meta);

  // Additional org check for DMs (assertAccess can't do this without user lookup)
  if ((meta.is_im || meta.is_mpim) && meta.user && rules.allowedOrgs.length > 0) {
    try {
      const { user } = await client.usersInfo(meta.user);
      if (user.team_id && !rules.allowedOrgs.includes(user.team_id)) {
        throw new UserError('Access denied: this user belongs to an organisation not in your allowed list.');
      }
    } catch (err) {
      if (err instanceof UserError) throw err;
      // If we can't resolve the user, allow through
    }
  }
}

// === Tools ===

slackUserServer.addTool({
  name: 'listChannels',
  description: 'List Slack channels and DMs you have access to, filtered by your access rules.',
  parameters: z.object({
    cursor: z.string().optional().describe('Pagination cursor from a previous response.'),
  }),
  execute: async (args, { session }) => {
    const client = getSlackUserClient(session);
    const rules = getRules(session!);

    const result = await client.conversationsList(args.cursor, 'public_channel,private_channel,im,mpim');
    let channels = filterChannelList(rules, result.channels) as typeof result.channels;
    // Filter DMs from non-allowed orgs (requires async user lookups)
    channels = await filterDmsByOrg(client, rules, channels) as typeof result.channels;

    if (channels.length === 0) return 'No channels match your access rules. Check your configuration in the dashboard.';

    // Resolve DM user names
    const dmUserIds = channels.filter(ch => (ch as any).is_im && ch.user).map(ch => ch.user!);
    const userNames = dmUserIds.length > 0 ? await resolveUsers(client, dmUserIds, session!.slackUserToken as string) : new Map<string, string>();

    const lines = channels.map(ch => {
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
    const nextCursor = result.response_metadata?.next_cursor;
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
    const limit = Math.min(Math.max(args.limit, 1), 100);
    const wsUrl = await getWorkspaceUrl(client, session!.slackUserToken as string);
    const result = await client.conversationsHistory(args.channelId, {
      limit,
      oldest: args.oldest,
      latest: args.latest,
      cursor: args.cursor,
    });

    const messages = result.messages;
    if (messages.length === 0) return 'No messages found in this channel.';

    const userIds = messages.map(m => m.user).filter(Boolean) as string[];
    const userNames = await resolveUsers(client, userIds, session!.slackUserToken as string);

    const lines = messages.reverse().map(msg => formatMessage(msg, userNames, args.channelId, wsUrl));

    let output = lines.join('\n');
    const nextCursor = result.response_metadata?.next_cursor;
    if (nextCursor) {
      output += `\n\n---\nMore messages available. Use cursor: "${nextCursor}"`;
    }
    return output;
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
    const limit = Math.min(Math.max(args.limit, 1), 200);
    const wsUrl = await getWorkspaceUrl(client, session!.slackUserToken as string);
    const result = await client.conversationsReplies(args.channelId, args.threadTs, {
      limit,
      cursor: args.cursor,
    });

    const messages = result.messages;
    if (messages.length === 0) return 'No replies found in this thread.';

    const userIds = messages.map(m => m.user).filter(Boolean) as string[];
    const userNames = await resolveUsers(client, userIds, session!.slackUserToken as string);

    const lines = messages.map(msg => formatMessage(msg, userNames, args.channelId, wsUrl));

    let output = lines.join('\n');
    const nextCursor = result.response_metadata?.next_cursor;
    if (nextCursor) {
      output += `\n\n---\nMore replies available. Use cursor: "${nextCursor}"`;
    }
    return output;
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
    assertWritesEnabled();
    const client = getSlackUserClient(session);
    await enforceAccess(client, session!, args.channelId);
    const result = await client.chatPostMessage(args.channelId, args.text);
    return `Message posted to ${result.channel} (ts: ${result.ts})`;
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
    assertWritesEnabled();
    const client = getSlackUserClient(session);
    await enforceAccess(client, session!, args.channelId);
    const result = await client.chatPostMessage(args.channelId, args.text, args.threadTs);
    return `Reply posted to thread ${args.threadTs} in ${result.channel} (ts: ${result.ts})`;
  },
});
