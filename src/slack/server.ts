// src/slack/server.ts
import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';
import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import { SlackClient } from './apiHelpers.js';

export const slackServer = new FastMCP<UserSession>({
  name: 'Slack MCP Server',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'slack'),
});

function getSlackClient(session?: UserSession): SlackClient {
  if (!session?.slackBotToken) {
    throw new UserError('Slack not connected. Visit the dashboard to connect your Slack bot token.');
  }
  return new SlackClient(session.slackBotToken as string);
}

function assertWritesEnabled(): void {
  if (process.env.SLACK_WRITES_ENABLED !== 'true') {
    throw new UserError('Slack writes are disabled. Set SLACK_WRITES_ENABLED=true to enable posting messages.');
  }
}

/** Resolve Slack user IDs to display names, with per-call caching. */
async function resolveUsers(client: SlackClient, userIds: string[]): Promise<Map<string, string>> {
  const cache = new Map<string, string>();
  const unique = [...new Set(userIds.filter(Boolean))];
  await Promise.all(unique.map(async (uid) => {
    try {
      const { user } = await client.usersInfo(uid);
      cache.set(uid, user.profile?.display_name || user.real_name || user.name);
    } catch {
      cache.set(uid, uid); // fall back to raw ID
    }
  }));
  return cache;
}

function formatTimestamp(ts: string): string {
  const date = new Date(parseFloat(ts) * 1000);
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function formatMessage(msg: any, userNames: Map<string, string>): string {
  const who = msg.user ? (userNames.get(msg.user) || msg.user) : 'unknown';
  const time = formatTimestamp(msg.ts);
  const thread = msg.reply_count ? ` [${msg.reply_count} replies]` : '';
  return `[${time}] ${who}: ${msg.text}${thread}`;
}

// === Tools ===

slackServer.addTool({
  name: 'listChannels',
  description: 'List Slack channels the bot is a member of. The bot only sees channels where it has been /invited.',
  parameters: z.object({
    cursor: z.string().optional().describe('Pagination cursor from a previous response.'),
  }),
  execute: async (args, { session }) => {
    const client = getSlackClient(session);
    const result = await client.conversationsList(args.cursor);
    const channels = result.channels;

    if (channels.length === 0) return 'No channels found. The bot must be /invited to channels to see them.';

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

slackServer.addTool({
  name: 'readChannelHistory',
  description: 'Read recent messages from a Slack channel. Returns messages in chronological order.',
  parameters: z.object({
    channelId: z.string().describe('The Slack channel ID (e.g., C01234ABCDE).'),
    limit: z.number().optional().default(20).describe('Number of messages to return (1-100, default 20).'),
    oldest: z.string().optional().describe('Only messages after this Unix timestamp.'),
    latest: z.string().optional().describe('Only messages before this Unix timestamp.'),
    cursor: z.string().optional().describe('Pagination cursor from a previous response.'),
  }),
  execute: async (args, { session }) => {
    const client = getSlackClient(session);
    const limit = Math.min(Math.max(args.limit, 1), 100);
    const result = await client.conversationsHistory(args.channelId, {
      limit,
      oldest: args.oldest,
      latest: args.latest,
      cursor: args.cursor,
    });

    const messages = result.messages;
    if (messages.length === 0) return 'No messages found in this channel.';

    // Resolve user IDs to names
    const userIds = messages.map(m => m.user).filter(Boolean) as string[];
    const userNames = await resolveUsers(client, userIds);

    // Messages come newest-first from Slack; reverse for chronological order
    const lines = messages.reverse().map(msg => formatMessage(msg, userNames));

    let output = lines.join('\n');
    const nextCursor = result.response_metadata?.next_cursor;
    if (nextCursor) {
      output += `\n\n---\nMore messages available. Use cursor: "${nextCursor}"`;
    }
    return output;
  },
});

slackServer.addTool({
  name: 'readThreadReplies',
  description: 'Read replies in a Slack thread. The first message is the thread parent.',
  parameters: z.object({
    channelId: z.string().describe('The Slack channel ID containing the thread.'),
    threadTs: z.string().describe('The timestamp of the parent message (thread_ts).'),
    limit: z.number().optional().default(50).describe('Number of replies to return (1-200, default 50).'),
    cursor: z.string().optional().describe('Pagination cursor from a previous response.'),
  }),
  execute: async (args, { session }) => {
    const client = getSlackClient(session);
    const limit = Math.min(Math.max(args.limit, 1), 200);
    const result = await client.conversationsReplies(args.channelId, args.threadTs, {
      limit,
      cursor: args.cursor,
    });

    const messages = result.messages;
    if (messages.length === 0) return 'No replies found in this thread.';

    const userIds = messages.map(m => m.user).filter(Boolean) as string[];
    const userNames = await resolveUsers(client, userIds);

    const lines = messages.map(msg => formatMessage(msg, userNames));

    let output = lines.join('\n');
    const nextCursor = result.response_metadata?.next_cursor;
    if (nextCursor) {
      output += `\n\n---\nMore replies available. Use cursor: "${nextCursor}"`;
    }
    return output;
  },
});

slackServer.addTool({
  name: 'postMessage',
  description: 'Post a message to a Slack channel. Requires SLACK_WRITES_ENABLED=true.',
  parameters: z.object({
    channelId: z.string().describe('The Slack channel ID to post to.'),
    text: z.string().describe('Message text (supports Slack markdown/mrkdwn).'),
  }),
  execute: async (args, { session }) => {
    assertWritesEnabled();
    const client = getSlackClient(session);
    const result = await client.chatPostMessage(args.channelId, args.text);
    return `Message posted to ${result.channel} (ts: ${result.ts})`;
  },
});

slackServer.addTool({
  name: 'replyInThread',
  description: 'Reply to a thread in a Slack channel. Requires SLACK_WRITES_ENABLED=true.',
  parameters: z.object({
    channelId: z.string().describe('The Slack channel ID containing the thread.'),
    threadTs: z.string().describe('The timestamp of the parent message to reply to.'),
    text: z.string().describe('Reply text (supports Slack markdown/mrkdwn).'),
  }),
  execute: async (args, { session }) => {
    assertWritesEnabled();
    const client = getSlackClient(session);
    const result = await client.chatPostMessage(args.channelId, args.text, args.threadTs);
    return `Reply posted to thread ${args.threadTs} in ${result.channel} (ts: ${result.ts})`;
  },
});
