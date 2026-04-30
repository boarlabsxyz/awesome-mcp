// src/slack/helpers.ts
// Shared helpers for Slack MCP servers (bot and user OAuth).
import { UserError } from 'fastmcp';
import { SlackClient } from './apiHelpers.js';

/** Module-level user name cache: key = "token:userId", value = { name, expiresAt }. */
const userNameCache = new Map<string, { name: string; expiresAt: number }>();
const USER_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const USER_LOOKUP_CONCURRENCY = 5;

/** Resolve Slack user IDs to display names with cross-request caching and bounded concurrency. */
export async function resolveUsers(client: SlackClient, userIds: string[], tokenKey?: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const tokenPrefix = tokenKey || 'default';
  const now = Date.now();
  const toFetch: string[] = [];

  // Check cache first
  for (const uid of new Set(userIds.filter(Boolean))) {
    const cached = userNameCache.get(`${tokenPrefix}:${uid}`);
    if (cached && cached.expiresAt > now) {
      result.set(uid, cached.name);
    } else {
      toFetch.push(uid);
    }
  }

  // Fetch missing/expired entries with bounded concurrency
  if (toFetch.length > 0) {
    let i = 0;
    while (i < toFetch.length) {
      const batch = toFetch.slice(i, i + USER_LOOKUP_CONCURRENCY);
      await Promise.all(batch.map(async (uid) => {
        const cacheKey = `${tokenPrefix}:${uid}`;
        try {
          const { user } = await client.usersInfo(uid);
          const name = user.profile?.display_name || user.real_name || user.name;
          result.set(uid, name);
          userNameCache.set(cacheKey, { name, expiresAt: now + USER_CACHE_TTL_MS });
        } catch {
          result.set(uid, uid);
          userNameCache.set(cacheKey, { name: uid, expiresAt: now + 60_000 });
        }
      }));
      i += USER_LOOKUP_CONCURRENCY;
    }
  }

  return result;
}

export function formatTimestamp(ts: string): string {
  const date = new Date(parseFloat(ts) * 1000);
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/** Build a Slack message permalink from workspace URL, channel ID, and ts. */
export function buildPermalink(workspaceUrl: string, channelId: string, ts: string): string {
  const pTs = 'p' + ts.replace('.', '');
  return `${workspaceUrl.replace(/\/$/, '')}/archives/${channelId}/${pTs}`;
}

/** Cache workspace URL per token to avoid repeated auth.test calls. */
const workspaceUrlCache = new Map<string, string>();

export async function getWorkspaceUrl(client: SlackClient, token: string): Promise<string> {
  const cached = workspaceUrlCache.get(token);
  if (cached) return cached;
  try {
    const { url } = await client.authTest();
    workspaceUrlCache.set(token, url);
    return url;
  } catch {
    return '';
  }
}

export function formatMessage(msg: any, userNames: Map<string, string>, channelId?: string, workspaceUrl?: string): string {
  const who = msg.user ? (userNames.get(msg.user) || msg.user) : 'unknown';
  const time = formatTimestamp(msg.ts);
  const thread = msg.reply_count ? ` [${msg.reply_count} replies]` : '';
  const link = workspaceUrl && channelId ? ` ${buildPermalink(workspaceUrl, channelId, msg.ts)}` : '';
  return `[${time}] (ts: ${msg.ts}) ${who}: ${msg.text}${thread}${link}`;
}

export function assertWritesEnabled(): void {
  if (process.env.SLACK_WRITES_ENABLED !== 'true') {
    throw new UserError('Slack writes are disabled. Set SLACK_WRITES_ENABLED=true to enable posting messages.');
  }
}

// === Shared tool handlers ===

export async function handleReadChannelHistory(
  client: SlackClient, tokenKey: string, channelId: string,
  opts: { limit: number; oldest?: string; latest?: string; cursor?: string },
): Promise<string> {
  const limit = Math.min(Math.max(opts.limit, 1), 100);
  const wsUrl = await getWorkspaceUrl(client, tokenKey);
  const result = await client.conversationsHistory(channelId, { limit, oldest: opts.oldest, latest: opts.latest, cursor: opts.cursor });
  const messages = result.messages;
  if (messages.length === 0) return 'No messages found in this channel.';
  const userIds = messages.map(m => m.user).filter(Boolean) as string[];
  const userNames = await resolveUsers(client, userIds, tokenKey);
  const lines = messages.reverse().map(msg => formatMessage(msg, userNames, channelId, wsUrl));
  let output = lines.join('\n');
  const nextCursor = result.response_metadata?.next_cursor;
  if (nextCursor) output += `\n\n---\nMore messages available. Use cursor: "${nextCursor}"`;
  return output;
}

export async function handleReadThreadReplies(
  client: SlackClient, tokenKey: string, channelId: string, threadTs: string,
  opts: { limit: number; cursor?: string },
): Promise<string> {
  const limit = Math.min(Math.max(opts.limit, 1), 200);
  const wsUrl = await getWorkspaceUrl(client, tokenKey);
  const result = await client.conversationsReplies(channelId, threadTs, { limit, cursor: opts.cursor });
  const messages = result.messages;
  if (messages.length === 0) return 'No replies found in this thread.';
  const userIds = messages.map(m => m.user).filter(Boolean) as string[];
  const userNames = await resolveUsers(client, userIds, tokenKey);
  const lines = messages.map(msg => formatMessage(msg, userNames, channelId, wsUrl));
  let output = lines.join('\n');
  const nextCursor = result.response_metadata?.next_cursor;
  if (nextCursor) output += `\n\n---\nMore replies available. Use cursor: "${nextCursor}"`;
  return output;
}

export async function handlePostMessage(
  client: SlackClient, channelId: string, text: string,
): Promise<string> {
  assertWritesEnabled();
  const result = await client.chatPostMessage(channelId, text);
  return `Message posted to ${result.channel} (ts: ${result.ts})`;
}

export async function handleReplyInThread(
  client: SlackClient, channelId: string, threadTs: string, text: string,
): Promise<string> {
  assertWritesEnabled();
  const result = await client.chatPostMessage(channelId, text, threadTs);
  return `Reply posted to thread ${threadTs} in ${result.channel} (ts: ${result.ts})`;
}
