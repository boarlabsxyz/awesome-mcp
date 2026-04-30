// src/slack/server.ts
import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';
import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import { SlackClient } from './apiHelpers.js';
import { handleReadChannelHistory, handleReadThreadReplies, handlePostMessage, handleReplyInThread } from './helpers.js';

export const slackBotServer = new FastMCP<UserSession>({
  name: 'Slack Bot MCP Server',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'slack-bot'),
});

function getSlackClient(session?: UserSession): SlackClient {
  if (!session?.slackBotToken) {
    throw new UserError('Slack not connected. Visit the dashboard to connect your Slack bot token.');
  }
  return new SlackClient(session.slackBotToken as string);
}

function getTokenKey(session: UserSession): string {
  return session.slackBotToken as string;
}

// === Tools ===

slackBotServer.addTool({
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

slackBotServer.addTool({
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
    return handleReadChannelHistory(getSlackClient(session), getTokenKey(session!), args.channelId, args);
  },
});

slackBotServer.addTool({
  name: 'readThreadReplies',
  description: 'Read replies in a Slack thread. The first message is the thread parent.',
  parameters: z.object({
    channelId: z.string().describe('The Slack channel ID containing the thread.'),
    threadTs: z.string().describe('The timestamp of the parent message (thread_ts).'),
    limit: z.number().optional().default(50).describe('Number of replies to return (1-200, default 50).'),
    cursor: z.string().optional().describe('Pagination cursor from a previous response.'),
  }),
  execute: async (args, { session }) => {
    return handleReadThreadReplies(getSlackClient(session), getTokenKey(session!), args.channelId, args.threadTs, args);
  },
});

slackBotServer.addTool({
  name: 'postMessage',
  description: 'Post a message to a Slack channel. Requires SLACK_WRITES_ENABLED=true.',
  parameters: z.object({
    channelId: z.string().describe('The Slack channel ID to post to.'),
    text: z.string().describe('Message text (supports Slack markdown/mrkdwn).'),
  }),
  execute: async (args, { session }) => {
    return handlePostMessage(getSlackClient(session), args.channelId, args.text);
  },
});

slackBotServer.addTool({
  name: 'replyInThread',
  description: 'Reply to a thread in a Slack channel. Requires SLACK_WRITES_ENABLED=true.',
  parameters: z.object({
    channelId: z.string().describe('The Slack channel ID containing the thread.'),
    threadTs: z.string().describe('The timestamp of the parent message to reply to.'),
    text: z.string().describe('Reply text (supports Slack markdown/mrkdwn).'),
  }),
  execute: async (args, { session }) => {
    return handleReplyInThread(getSlackClient(session), args.channelId, args.threadTs, args.text);
  },
});
