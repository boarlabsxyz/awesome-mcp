// src/slack/helpers.ts
// Shared helpers for Slack MCP servers (bot and user OAuth).
import { UserError, imageContent, type ImageContent } from 'fastmcp';
import {
  SlackClient, fileShareTargets,
  type SlackFileRef, type SlackFileInfo,
  type SlackFileMatch, type SlackMessageMatch, type SlackSearchPage,
} from './apiHelpers.js';

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

/**
 * Cache auth.test per token. Both the workspace URL (for permalinks) and the
 * team ID (which keys event subscriptions) come from the same call, so they
 * share one cache entry rather than costing two round-trips. Failures are not
 * cached, so a transient error doesn't stick for the life of the process.
 */
const authInfoCache = new Map<string, { url: string; teamId: string }>();

async function getAuthInfo(client: SlackClient, token: string): Promise<{ url: string; teamId: string }> {
  const cached = authInfoCache.get(token);
  if (cached) return cached;
  try {
    const result = await client.authTest();
    const info = { url: result.url || '', teamId: result.team_id || '' };
    authInfoCache.set(token, info);
    return info;
  } catch {
    return { url: '', teamId: '' };
  }
}

export async function getWorkspaceUrl(client: SlackClient, token: string): Promise<string> {
  return (await getAuthInfo(client, token)).url;
}

/** The workspace (team) ID. Empty string when auth.test fails. */
export async function getTeamId(client: SlackClient, token: string): Promise<string> {
  return (await getAuthInfo(client, token)).teamId;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Files rendered per message before the list is truncated. */
const MAX_FILES_RENDERED = 10;

/**
 * One line per attachment. Slack sends heavily reduced file objects for deleted
 * and withheld files, so every branch here corresponds to a shape that really
 * occurs — never assume name/mimetype/size are present.
 */
export function formatFileRef(f: SlackFileRef): string {
  if (f.mode === 'tombstone') return '  📎 (deleted file)';

  if (f.file_access === 'access_denied' || f.file_access === 'check_file_info') {
    const id = f.id ? ` — file ID: ${f.id}` : '';
    return `  📎 (file hidden — reconnect Slack with the "files:read" scope)${id}`;
  }

  const name = f.name || f.title || '(unnamed file)';
  const type = f.mimetype || f.filetype || 'unknown type';

  if (f.mode === 'external' || f.is_external) {
    const link = f.url_private || f.permalink;
    return `  🔗 ${name} — ${type}, external link (not downloadable)${link ? ` — ${link}` : ''}`;
  }

  const size = typeof f.size === 'number' ? `, ${formatBytes(f.size)}` : '';
  return `  📎 ${name} — ${type}${size} — file ID: ${f.id}`;
}

/** Render a message's attachments, truncating bulk uploads. */
export function formatFiles(files: SlackFileRef[]): string[] {
  const lines = files.slice(0, MAX_FILES_RENDERED).map(formatFileRef);
  if (files.length > MAX_FILES_RENDERED) {
    lines.push(`  … and ${files.length - MAX_FILES_RENDERED} more file(s)`);
  }
  return lines;
}

export function formatMessage(msg: any, userNames: Map<string, string>, channelId?: string, workspaceUrl?: string): string {
  const who = msg.user ? (userNames.get(msg.user) || msg.user) : 'unknown';
  const time = formatTimestamp(msg.ts);
  const thread = msg.reply_count ? ` [${msg.reply_count} replies]` : '';
  const link = workspaceUrl && channelId ? ` ${buildPermalink(workspaceUrl, channelId, msg.ts)}` : '';
  const line = `[${time}] (ts: ${msg.ts}) ${who}: ${msg.text}${thread}${link}`;

  // A file-only upload has empty text, so without these lines the message
  // renders as "alice: " and the attachment is invisible to the model.
  const files: SlackFileRef[] | undefined = msg.files;
  if (!files?.length) return line;
  return [line, ...formatFiles(files)].join('\n');
}

export function assertWritesEnabled(): void {
  if (process.env.SLACK_WRITES_ENABLED !== 'true') {
    throw new UserError('Slack posting is disabled for this deployment. The operator must enable Slack writes before this tool can be used.');
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

// === Search ===

/**
 * Decides whether results from one channel may be shown.
 *
 * Injected rather than imported so this module stays session- and rule-free
 * (the bot server imports it too), and so the access filter can be unit-tested
 * without a session or a database. The user server builds one from its access
 * rules; the bot server has none and passes nothing.
 */
export type ChannelFilter = (channel: { id: string }) => Promise<boolean>;

export interface SearchOptions {
  query: string;
  count: number;
  page?: number;
  sort?: 'score' | 'timestamp';
  sortDir?: 'asc' | 'desc';
}

/**
 * search.* is the one place a token's reach exceeds the caller's access rules:
 * it returns hits from every channel the human belongs to, including ones the
 * whitelist denies, and Slack's query DSL has no channel deny-list to push the
 * filter server-side. So we over-fetch and drop here — and say how many were
 * dropped, because a silent drop reads as "Slack found nothing".
 */
async function callSearch<T>(method: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err: any) {
    const message = String(err?.message || '');
    if (message.includes('missing_scope')) {
      throw new UserError(
        `Slack rejected ${method} for lack of the "search:read" scope. Reconnect Slack from the dashboard to re-consent.`,
      );
    }
    if (message.includes('not_allowed_token_type')) {
      throw new UserError(
        `${method} requires a Slack user token (xoxp-). Bot tokens cannot search — use the Slack (user) connector.`,
      );
    }
    throw err;
  }
}

/** Tail line describing Slack's paging, plus what the access filter removed. */
function formatSearchTail(
  page: SlackSearchPage<unknown>, shown: number, hidden: number, unverifiable = 0,
): string {
  const pageNum = page.paging?.page ?? page.pagination?.page ?? 1;
  const pageCount = page.paging?.pages ?? page.pagination?.page_count ?? 1;
  const lines = [`Page ${pageNum} of ${pageCount} — ${shown} shown of ${page.total} total match(es).`];
  if (hidden > 0) {
    lines.push(
      `${hidden} result(s) on this page hidden by your access rules.`,
      'Page numbers are Slack\'s, applied before filtering — a page can come back empty even when more matches exist.',
    );
  }
  // Distinguished from a rules denial on purpose: "Slack didn't tell us where
  // this lives" and "you may not read where this lives" have different fixes,
  // and a silent merge of the two would make an empty result inexplicable.
  if (unverifiable > 0) {
    lines.push(
      `${unverifiable} result(s) withheld because Slack returned no channel for them, so access could not be checked.`,
    );
  }
  if (pageNum < pageCount) lines.push(`Use page: ${pageNum + 1} for more.`);
  return lines.join('\n');
}

function formatSearchMatch(match: SlackMessageMatch, userNames: Map<string, string>): string {
  const who = match.user ? (userNames.get(match.user) || match.user) : (match.username || 'unknown');
  const where = match.channel?.name ? `#${match.channel.name}` : (match.channel?.id || 'unknown channel');
  const link = match.permalink ? ` ${match.permalink}` : '';
  const line = `[${formatTimestamp(match.ts)}] ${where} (ts: ${match.ts}) ${who}: ${match.text}${link}`;
  const files = match.files;
  if (!files?.length) return line;
  return [line, ...formatFiles(files)].join('\n');
}

/** Share targets are listed because downloadFile needs one of them as channelId. */
function formatFileMatch(file: SlackFileMatch): string {
  const targets = [...fileShareTargets(file)];
  const lines = [formatFileRef(file).trimStart()];
  if (targets.length > 0) lines.push(`  Shared in: ${targets.join(', ')}`);
  if (file.permalink) lines.push(`  Permalink: ${file.permalink}`);
  return lines.join('\n');
}

export async function handleSearchMessages(
  client: SlackClient, tokenKey: string, opts: SearchOptions, allowChannel?: ChannelFilter,
): Promise<string> {
  // No getWorkspaceUrl call here: search.* returns a permalink per match, so
  // there is nothing to build and no reason to pay for auth.test.
  const count = Math.min(Math.max(opts.count, 1), 100);
  const result = await callSearch('search.messages', () =>
    client.searchMessages(opts.query, { count, page: opts.page, sort: opts.sort, sortDir: opts.sortDir }),
  );

  const all = result.messages?.matches || [];
  if (all.length === 0) return `No messages found for "${opts.query}".`;

  let visible = all;
  let hidden = 0;
  if (allowChannel) {
    visible = [];
    for (const match of all) {
      // A match with no channel can't be checked, so it can't be cleared.
      const ok = match.channel?.id ? await allowChannel({ id: match.channel.id }) : false;
      if (ok) visible.push(match); else hidden++;
    }
  }

  const tail = formatSearchTail(result.messages, visible.length, hidden);
  if (visible.length === 0) {
    return [`No messages you can access match "${opts.query}".`, '', tail].join('\n');
  }

  const userIds = visible.map(m => m.user).filter(Boolean) as string[];
  const userNames = await resolveUsers(client, userIds, tokenKey);
  return [
    `Found ${visible.length} message(s) for "${opts.query}":`,
    '',
    ...visible.map(m => formatSearchMatch(m, userNames)),
    '',
    '---',
    tail,
  ].join('\n');
}

export async function handleSearchFiles(
  client: SlackClient, opts: SearchOptions, allowChannel?: ChannelFilter,
): Promise<string> {
  const count = Math.min(Math.max(opts.count, 1), 100);
  const result = await callSearch('search.files', () =>
    client.searchFiles(opts.query, { count, page: opts.page, sort: opts.sort, sortDir: opts.sortDir }),
  );

  const all = result.files?.matches || [];
  if (all.length === 0) return `No files found for "${opts.query}".`;

  let visible = all;
  let hidden = 0;
  let unverifiable = 0;
  if (allowChannel) {
    visible = [];
    for (const file of all) {
      // Visible if ANY channel it's shared into is allowed — the user can
      // legitimately reach it through that one. A file with no share targets at
      // all fails closed, but is counted separately so the tail can explain
      // why it vanished rather than implying the rules denied it.
      const targets = [...fileShareTargets(file)];
      if (targets.length === 0) { unverifiable++; continue; }
      let ok = false;
      for (const channelId of targets) {
        if (await allowChannel({ id: channelId })) { ok = true; break; }
      }
      if (ok) visible.push(file); else hidden++;
    }
  }

  const tail = formatSearchTail(result.files, visible.length, hidden, unverifiable);
  if (visible.length === 0) {
    return [`No files you can access match "${opts.query}".`, '', tail].join('\n');
  }

  return [
    `Found ${visible.length} file(s) for "${opts.query}":`,
    '',
    ...visible.map(formatFileMatch),
    '',
    '---',
    tail,
  ].join('\n');
}

// Inline payloads ride in the model's context window, so they get a much
// tighter cap than the 20 MB transport limit. Same reasoning (and value) as
// MAX_BASE64_DECODED_BYTES in src/clickup/server.ts.
const INLINE_MAX_BYTES = 1.5 * 1024 * 1024;
const TEXT_MAX_BYTES = 256 * 1024;

/** Text-ish files are returned as-is rather than hosted. */
function isTextLike(file: SlackFileInfo): boolean {
  const mime = (file.mimetype || '').toLowerCase();
  if (mime.startsWith('text/')) return true;
  if (mime === 'application/json' || mime === 'application/xml') return true;
  return file.mode === 'snippet';
}

function describeFile(file: SlackFileInfo): string {
  const name = file.name || file.title || '(unnamed file)';
  const parts = [
    `Slack file ${file.id} — ${name}`,
    `  Type: ${file.mimetype || file.filetype || 'unknown'}`,
  ];
  if (typeof file.size === 'number') parts.push(`  Size: ${formatBytes(file.size)}`);
  if (file.permalink) parts.push(`  Permalink: ${file.permalink}`);
  return parts.join('\n');
}

/**
 * Download one file's content.
 *
 * `channelId` is required and verified against the file's share list. On the
 * user-OAuth server the caller has already run enforceAccess() on that channel,
 * so without this check a file living in a denied channel could be laundered
 * through an allowed one.
 */
export async function handleDownloadFile(
  client: SlackClient,
  args: { fileId: string; channelId: string; format: 'url' | 'inline' },
): Promise<string | ImageContent> {
  let file: SlackFileInfo;
  try {
    ({ file } = await client.filesInfo(args.fileId));
  } catch (err: any) {
    if (String(err?.message || '').includes('missing_scope')) {
      throw new UserError(
        'Slack rejected files.info for lack of the "files:read" scope. Reconnect Slack from the dashboard to re-consent.',
      );
    }
    throw err;
  }

  const targets = fileShareTargets(file);
  if (!targets.has(args.channelId)) {
    throw new UserError(
      `File ${args.fileId} is not shared in channel ${args.channelId}. ` +
      'Pass the channel or DM you read the file from.',
    );
  }

  const meta = describeFile(file);

  if (file.mode === 'external' || file.is_external) {
    const link = file.url_private ? `\nExternal link: ${file.url_private}` : '';
    return `${meta}\n\nThis file is hosted outside Slack, so its bytes cannot be downloaded through the Slack API.${link}`;
  }

  const downloadUrl = file.url_private_download || file.url_private;
  if (!downloadUrl) {
    return `${meta}\n\nSlack did not return a download URL for this file — it may be deleted or restricted.`;
  }

  const mime = (file.mimetype || '').toLowerCase();

  if (mime.startsWith('image/')) {
    if (args.format === 'inline') {
      if (typeof file.size === 'number' && file.size > INLINE_MAX_BYTES) {
        throw new UserError(
          `${file.name || file.id} is ${formatBytes(file.size)} — too large to return inline ` +
          `(max ${formatBytes(INLINE_MAX_BYTES)}). Use format: "url" instead.`,
        );
      }
      let buffer: Buffer;
      try {
        ({ buffer } = await client.downloadFileBytes(downloadUrl, { maxBytes: INLINE_MAX_BYTES }));
      } catch (err: any) {
        // Slack omits content-length on some files, so the cap can also trip
        // mid-stream — point at the same escape hatch either way.
        if (/too large|exceeds the maximum size/i.test(String(err?.message || ''))) {
          throw new UserError(
            `${file.name || file.id} is too large to return inline ` +
            `(max ${formatBytes(INLINE_MAX_BYTES)}). Use format: "url" instead.`,
          );
        }
        throw err;
      }
      return imageContent({ buffer });
    }

    const { buffer } = await client.downloadFileBytes(downloadUrl);
    // Dynamic import keeps sharp and the Postgres pool off the Slack server's
    // boot path — only a download in "url" mode pays for them.
    const { store } = await import('../images/imageBlobStore.js');
    let hosted: { url: string; bytes: number };
    try {
      hosted = await store(buffer, file.mimetype || '');
    } catch (err: any) {
      if (err instanceof UserError) throw err;
      throw new UserError(
        `Could not host this image: ${err?.message || err}. ` +
        'This deployment may be missing DATABASE_URL or IMAGE_PUBLIC_BASE_URL — ' +
        'retry with format: "inline" to get the image directly instead.',
      );
    }
    return `${meta}\n  Hosted at: ${hosted.url}\n\n` +
      'That URL is public and immutable — pass it to any tool that takes an image URL (e.g. insertImageFromUrl).';
  }

  if (isTextLike(file)) {
    const { buffer } = await client.downloadFileBytes(downloadUrl, { maxBytes: TEXT_MAX_BYTES });
    return `${meta}\n\n\`\`\`\n${buffer.toString('utf8')}\n\`\`\``;
  }

  return `${meta}\n\nFile type "${file.mimetype || file.filetype || 'unknown'}" is not downloadable through this tool ` +
    '(images and text files are supported). Open it in Slack using the permalink above.';
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
