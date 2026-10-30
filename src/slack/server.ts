// src/slack/server.ts
import { FastMCP, UserError } from 'fastmcp';
import { instrumentServer } from '../usage/instrumentServer.js';
import { z } from 'zod';
import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import { SlackClient } from './apiHelpers.js';
import { resolveUsers, handleReadChannelHistory, handleReadThreadReplies, handleDownloadFile, handlePostMessage, handleReplyInThread, handleEditMessage, postMessageFields, replyInThreadFields, editMessageFields, messageFormatParam } from './helpers.js';
import { registerMintRestBearerForCurl } from '../sharedTools/mintRestBearerForCurl.js';
import { registerListRestEndpoints } from '../sharedTools/listRestEndpoints.js';

export const slackBotServer = instrumentServer(new FastMCP<UserSession>({
  name: 'Slack Bot MCP Server',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'slack-bot'),
}), 'slack-bot');

registerMintRestBearerForCurl(slackBotServer);
registerListRestEndpoints(slackBotServer);

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
  annotations: { readOnlyHint: true },
  description: 'List Slack channels and DMs the bot is a member of. Includes public/private channels and 1-on-1 DMs. The bot only sees channels where it has been /invited.',
  parameters: z.object({
    cursor: z.string().optional().describe('Pagination cursor from a previous response.'),
  }),
  execute: async (args, { session }) => {
    const client = getSlackClient(session);
    const tokenKey = getTokenKey(session!);
    const result = await client.conversationsList(args.cursor);
    const channels = result.channels;

    if (channels.length === 0) return 'No channels found. The bot must be /invited to channels to see them.';

    // Resolve user names for DM channels
    const dmUserIds = channels.filter(ch => ch.is_im && ch.user).map(ch => ch.user!);
    const userNames = dmUserIds.length > 0 ? await resolveUsers(client, dmUserIds, tokenKey) : new Map<string, string>();

    const lines = channels.map(ch => {
      if (ch.is_im) {
        const userName = ch.user ? (userNames.get(ch.user) || ch.user) : 'unknown';
        return `DM with ${userName} (${ch.id})\n  Type: im\n  User ID: ${ch.user || 'unknown'}`;
      }
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
  annotations: { readOnlyHint: true },
  description: 'Read recent messages from a Slack channel. Returns messages in chronological order. Pass format: "json" to read what Slack stored for each message (its blocks, the author user or bot id, and whether it was edited).',
  parameters: z.object({
    channelId: z.string().describe('The Slack channel ID (e.g., C01234ABCDE).'),
    limit: z.number().optional().default(20).describe('Number of messages to return (1-100, default 20).'),
    oldest: z.string().optional().describe('Only messages after this Unix timestamp.'),
    latest: z.string().optional().describe('Only messages before this Unix timestamp.'),
    cursor: z.string().optional().describe('Pagination cursor from a previous response.'),
    ...messageFormatParam,
  }),
  execute: async (args, { session }) => {
    return handleReadChannelHistory(getSlackClient(session), getTokenKey(session!), args.channelId, args);
  },
});

slackBotServer.addTool({
  name: 'readThreadReplies',
  annotations: { readOnlyHint: true },
  description: 'Read replies in a Slack thread. The first message is the thread parent. Pass format: "json" to read what Slack stored for each message (its blocks, the author user or bot id, and whether it was edited).',
  parameters: z.object({
    channelId: z.string().describe('The Slack channel ID containing the thread.'),
    threadTs: z.string().describe('The timestamp of the parent message (thread_ts).'),
    limit: z.number().optional().default(50).describe('Number of replies to return (1-200, default 50).'),
    cursor: z.string().optional().describe('Pagination cursor from a previous response.'),
    ...messageFormatParam,
  }),
  execute: async (args, { session }) => {
    return handleReadThreadReplies(getSlackClient(session), getTokenKey(session!), args.channelId, args.threadTs, args);
  },
});

slackBotServer.addTool({
  name: 'downloadFile',
  // readOnlyHint describes Slack, which this never modifies. The "url" format
  // does write the bytes into our own image blob store.
  annotations: { readOnlyHint: true },
  description: 'Download a file attached to a Slack message. Get the fileId from the 📎 lines in readChannelHistory or readThreadReplies output, and pass the channel you read it from. Images: format "url" (default) re-hosts the image at a public URL suitable for tools that take an image URL (e.g. insertImageFromUrl), format "inline" returns the image itself so you can look at it. Text files are returned as text; other file types return metadata only.',
  parameters: z.object({
    fileId: z.string().describe('The Slack file ID (e.g., F01234ABCDE).'),
    channelId: z.string().describe('The channel or DM the file was shared in — the one you read the message from.'),
    format: z.enum(['url', 'inline']).optional().default('url').describe('"url" re-hosts an image and returns a public link; "inline" returns the image directly (max 1.5 MB). Ignored for text files.'),
  }),
  execute: async (args, { session }) => {
    return handleDownloadFile(getSlackClient(session), args);
  },
});

slackBotServer.addTool({
  name: 'postMessage',
  annotations: { readOnlyHint: false },
  description: 'Post a message to a Slack channel. For a bulleted or numbered list use markdownText, not text — Slack mrkdwn has no list syntax, so "- item" in text renders as a literal hyphen. Slack renders a preview card for links in the message; pass unfurlLinks: false and/or unfurlMedia: false to suppress it for this message. Previews can only be suppressed when posting, not removed afterwards.',
  parameters: z.object({
    channelId: z.string().describe('The Slack channel ID to post to.'),
    ...postMessageFields,
  }),
  execute: async (args, { session }) => {
    return handlePostMessage(getSlackClient(session), args.channelId, args.text, args);
  },
});

slackBotServer.addTool({
  name: 'replyInThread',
  annotations: { readOnlyHint: false },
  description: 'Reply to a thread in a Slack channel. For a bulleted or numbered list use markdownText, not text — Slack mrkdwn has no list syntax. Pass broadcast: true to also send the reply to the channel ("Also send to channel"), which Slack only accepts as the reply is posted. Slack renders a preview card for links in the reply; pass unfurlLinks: false and/or unfurlMedia: false to suppress it for this message. Previews can only be suppressed when posting, not removed afterwards.',
  parameters: z.object({
    channelId: z.string().describe('The Slack channel ID containing the thread.'),
    threadTs: z.string().describe('The timestamp of the parent message to reply to.'),
    ...replyInThreadFields,
  }),
  execute: async (args, { session }) => {
    return handleReplyInThread(getSlackClient(session), args.channelId, args.threadTs, args.text, args);
  },
});

// `editMessage` on the bot server.
//
// The handler has always lived in the shared `helpers.ts` so this server could
// register it in one block; it was left unregistered because "a bot editing
// its own status message is a separate workflow nobody has asked for". It has
// now been asked for — as the way to fix a message's formatting after posting,
// which is what the content parameters below make possible.
//
// No `enforceAccess`: access rules are a slack-user mechanism and no tool on
// this server has one.
slackBotServer.addTool({
  name: 'editMessage',
  annotations: { readOnlyHint: false },
  description: 'Edit a message this bot posted, replacing its content. A bot token can only edit the bot\'s own messages — Slack refuses anything else. Pass markdownText or blocks to convert a message that was posted as plain text into one with real bullet or numbered lists. WARNING: passing only text on a message that currently has blocks REMOVES those blocks (Slack\'s own replacement rule), so to keep rendered content re-send it. Get the ts from readChannelHistory or readThreadReplies.',
  parameters: z.object({
    channelId: z.string().describe('The Slack channel ID containing the message.'),
    ts: z.string().describe('Timestamp of the message to edit, from readChannelHistory or readThreadReplies. Timestamps are per-channel.'),
    ...editMessageFields,
  }),
  execute: async (args, { log, session }) => {
    log.info(`Editing message ${args.ts} in ${args.channelId}`);
    return handleEditMessage(getSlackClient(session), args.channelId, args.ts, args.text, args);
  },
});

slackBotServer.addTool({
  name: 'listUsers',
  annotations: { readOnlyHint: true },
  description: 'List workspace members. Use this to find a user by name and get their user ID for opening a DM.',
  parameters: z.object({
    cursor: z.string().optional().describe('Pagination cursor from a previous response.'),
  }),
  execute: async (args, { session }) => {
    const client = getSlackClient(session);
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

slackBotServer.addTool({
  name: 'openDm',
  annotations: { readOnlyHint: false },
  description: 'Open (or retrieve) a 1-on-1 DM channel with a user. Returns the DM channel ID that can be used with postMessage.',
  parameters: z.object({
    userId: z.string().describe('The Slack user ID to open a DM with (e.g., U01234ABCDE).'),
  }),
  execute: async (args, { session }) => {
    const client = getSlackClient(session);
    const result = await client.conversationsOpen(args.userId);
    return `DM channel opened: ${result.channel.id}\n\nYou can now use postMessage with channelId "${result.channel.id}" to send a direct message.`;
  },
});
