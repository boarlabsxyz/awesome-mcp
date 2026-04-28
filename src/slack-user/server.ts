// src/slack-user/server.ts
// Slack MCP using user OAuth tokens (xoxp-) with channel allowlist enforcement.
import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';
import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import { SlackClient } from '../slack/apiHelpers.js';
import { resolveUsers, getWorkspaceUrl, formatMessage, assertWritesEnabled } from '../slack/helpers.js';

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

function assertChannelAllowed(session: UserSession, channelId: string): void {
  const allowed = session.slackAllowedChannels as string[] | undefined;
  if (!allowed || allowed.length === 0) {
    throw new UserError('No channels configured. Visit the dashboard to select allowed channels.');
  }
  if (!allowed.includes(channelId)) {
    throw new UserError(`Channel ${channelId} is not in your allowed list. Update channel permissions in the dashboard.`);
  }
}

// === Tools ===

slackUserServer.addTool({
  name: 'listChannels',
  description: 'List Slack channels you have access to. Only channels selected in the dashboard are shown.',
  parameters: z.object({
    cursor: z.string().optional().describe('Pagination cursor from a previous response.'),
  }),
  execute: async (args, { session }) => {
    const client = getSlackUserClient(session);
    const allowed = (session!.slackAllowedChannels as string[]) || [];
    if (allowed.length === 0) return 'No channels configured. Visit the dashboard to select allowed channels.';

    const result = await client.conversationsList(args.cursor);
    // Filter to only allowed channels
    const channels = result.channels.filter(ch => allowed.includes(ch.id));

    if (channels.length === 0) return 'No allowed channels found in this page. Try the next cursor or check your channel configuration.';

    const lines = channels.map(ch => {
      const parts = [
        `#${ch.name} (${ch.id})`,
        ch.is_private ? '  Type: private' : '  Type: public',
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
  description: 'Read recent messages from a Slack channel. Only allowed channels can be read.',
  parameters: z.object({
    channelId: z.string().describe('The Slack channel ID (e.g., C01234ABCDE).'),
    limit: z.number().optional().default(20).describe('Number of messages to return (1-100, default 20).'),
    oldest: z.string().optional().describe('Only messages after this Unix timestamp.'),
    latest: z.string().optional().describe('Only messages before this Unix timestamp.'),
    cursor: z.string().optional().describe('Pagination cursor from a previous response.'),
  }),
  execute: async (args, { session }) => {
    assertChannelAllowed(session!, args.channelId);
    const client = getSlackUserClient(session);
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
  description: 'Read replies in a Slack thread. Only allowed channels can be read.',
  parameters: z.object({
    channelId: z.string().describe('The Slack channel ID containing the thread.'),
    threadTs: z.string().describe('The timestamp of the parent message (thread_ts).'),
    limit: z.number().optional().default(50).describe('Number of replies to return (1-200, default 50).'),
    cursor: z.string().optional().describe('Pagination cursor from a previous response.'),
  }),
  execute: async (args, { session }) => {
    assertChannelAllowed(session!, args.channelId);
    const client = getSlackUserClient(session);
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
  description: 'Post a message to a Slack channel. Requires SLACK_WRITES_ENABLED=true. Only allowed channels.',
  parameters: z.object({
    channelId: z.string().describe('The Slack channel ID to post to.'),
    text: z.string().describe('Message text (supports Slack markdown/mrkdwn).'),
  }),
  execute: async (args, { session }) => {
    assertWritesEnabled();
    assertChannelAllowed(session!, args.channelId);
    const client = getSlackUserClient(session);
    const result = await client.chatPostMessage(args.channelId, args.text);
    return `Message posted to ${result.channel} (ts: ${result.ts})`;
  },
});

slackUserServer.addTool({
  name: 'replyInThread',
  description: 'Reply to a thread in a Slack channel. Requires SLACK_WRITES_ENABLED=true. Only allowed channels.',
  parameters: z.object({
    channelId: z.string().describe('The Slack channel ID containing the thread.'),
    threadTs: z.string().describe('The timestamp of the parent message to reply to.'),
    text: z.string().describe('Reply text (supports Slack markdown/mrkdwn).'),
  }),
  execute: async (args, { session }) => {
    assertWritesEnabled();
    assertChannelAllowed(session!, args.channelId);
    const client = getSlackUserClient(session);
    const result = await client.chatPostMessage(args.channelId, args.text, args.threadTs);
    return `Reply posted to thread ${args.threadTs} in ${result.channel} (ts: ${result.ts})`;
  },
});
