// src/slack/helpers.ts
// Shared helpers for Slack MCP servers (bot and user OAuth).
import { UserError, imageContent, type ImageContent } from 'fastmcp';
import { z } from 'zod';
import {
  SlackClient, fileShareTargets,
  type SlackFileRef, type SlackFileInfo,
  type SlackFileMatch, type SlackMessageMatch, type SlackSearchPage,
  type SlackUnfurlOptions, type SlackMessageContent,
  type SlackPostOptions, type SlackUpdateOptions, type SlackPostedMessage,
  type SlackHistoryMessage, type SlackMessagePage,
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

/**
 * A refusal that also says which HTTP status it means on the REST plane.
 *
 * The MCP tools only read the message. The REST write routes read `status`
 * (see `slackWriteErrorStatus` in `src/website/slackErrorMapper.ts`), because
 * the rewritten messages below no longer contain Slack's error code — so
 * matching the text, as the read routes do, would turn every one into a 500.
 */
function refusal(status: number, message: string): UserError {
  const err = new UserError(message);
  (err as UserError & { status: number }).status = status;
  return err;
}

export function assertWritesEnabled(): void {
  if (process.env.SLACK_WRITES_ENABLED !== 'true') {
    // 503, not 403: the caller is allowed, the deployment has not turned it on.
    throw refusal(503, 'Slack posting is disabled for this deployment. The operator must enable Slack writes before this tool can be used.');
  }
}

/**
 * `format` on the two read tools, defined once so both servers describe it the
 * same way.
 *
 * The text format shows a message's `text`, which once a message has blocks is
 * only the notification fallback: it cannot show whether a block edit landed,
 * who (user or app) wrote the message, or whether it was edited. `json` returns
 * what Slack stored for each message.
 */
export const messageFormatParam = {
  format: z.enum(['text', 'json']).optional().default('text').describe(
    '"text" (default): one readable line per message. "json": each message as Slack stores it — ' +
    'ts, thread_ts, user (a person) or bot_id/app_id (an app), subtype, text, blocks, attachments, ' +
    'files, edited (set once a message was edited), reactions, reply_count and metadata. Use json ' +
    'to check that a Block Kit message you posted or edited holds the blocks you sent; its text is ' +
    'only the notification fallback.',
  ),
};

export type MessageFormat = 'text' | 'json';

/** File fields worth returning; the rest of Slack's file object is thumbnail URLs. */
function projectFile(f: SlackFileRef) {
  return {
    id: f.id, name: f.name, title: f.title, mimetype: f.mimetype, filetype: f.filetype,
    size: f.size, mode: f.mode, file_access: f.file_access, is_external: f.is_external,
  };
}

/**
 * One message in the `json` format: the documented subset of Slack's object,
 * plus the resolved author name and a permalink, which the text format shows.
 * Absent fields are left `undefined` so `JSON.stringify` drops them.
 */
export function projectMessage(
  msg: SlackHistoryMessage, userNames: Map<string, string>, channelId: string, workspaceUrl?: string,
): Record<string, unknown> {
  return {
    ts: msg.ts,
    thread_ts: msg.thread_ts,
    user: msg.user,
    userName: msg.user ? userNames.get(msg.user) : undefined,
    bot_id: msg.bot_id,
    app_id: msg.app_id,
    username: msg.username,
    subtype: msg.subtype,
    text: msg.text,
    blocks: msg.blocks,
    attachments: msg.attachments,
    files: msg.files?.map(projectFile),
    edited: msg.edited,
    reactions: msg.reactions,
    reply_count: msg.reply_count,
    latest_reply: msg.latest_reply,
    metadata: msg.metadata,
    permalink: workspaceUrl ? buildPermalink(workspaceUrl, channelId, msg.ts) : undefined,
  };
}

/** Render one page of messages (already in display order) in the requested format. */
async function renderMessagePage(
  client: SlackClient, tokenKey: string, page: SlackMessagePage, messages: SlackHistoryMessage[],
  where: { channelId: string; threadTs?: string }, format: MessageFormat, empty: string, more: string,
): Promise<string> {
  const nextCursor = page.response_metadata?.next_cursor || null;
  // Text mode answers an empty page with a sentence; json keeps the shape, so
  // a script reads `messages: []` rather than having to parse prose.
  if (messages.length === 0 && format === 'text') return empty;

  const wsUrl = await getWorkspaceUrl(client, tokenKey);
  const userIds = messages.map(m => m.user).filter(Boolean) as string[];
  const userNames = await resolveUsers(client, userIds, tokenKey);

  if (format === 'json') {
    return JSON.stringify({
      channelId: where.channelId,
      ...(where.threadTs ? { threadTs: where.threadTs } : {}),
      messages: messages.map(msg => projectMessage(msg, userNames, where.channelId, wsUrl)),
      hasMore: !!page.has_more,
      nextCursor,
    });
  }

  let output = messages.map(msg => formatMessage(msg, userNames, where.channelId, wsUrl)).join('\n');
  if (nextCursor) output += `\n\n---\nMore ${more} available. Use cursor: "${nextCursor}"`;
  return output;
}

// === Shared tool handlers ===

export async function handleReadChannelHistory(
  client: SlackClient, tokenKey: string, channelId: string,
  opts: { limit: number; oldest?: string; latest?: string; cursor?: string; format?: MessageFormat },
): Promise<string> {
  const limit = Math.min(Math.max(opts.limit, 1), 100);
  const result = await client.conversationsHistory(channelId, { limit, oldest: opts.oldest, latest: opts.latest, cursor: opts.cursor });
  // Slack returns newest first; both formats show them oldest first.
  const messages = [...result.messages].reverse();
  return renderMessagePage(
    client, tokenKey, result, messages, { channelId }, opts.format ?? 'text',
    'No messages found in this channel.', 'messages',
  );
}

export async function handleReadThreadReplies(
  client: SlackClient, tokenKey: string, channelId: string, threadTs: string,
  opts: { limit: number; cursor?: string; format?: MessageFormat },
): Promise<string> {
  const limit = Math.min(Math.max(opts.limit, 1), 200);
  const result = await client.conversationsReplies(channelId, threadTs, { limit, cursor: opts.cursor });
  return renderMessagePage(
    client, tokenKey, result, result.messages, { channelId, threadTs }, opts.format ?? 'text',
    'No replies found in this thread.', 'replies',
  );
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
      // Slack's own `provided` list rides along on the client error (see
      // formatScopeDetail in apiHelpers). Passing it through is the difference
      // between "reconnect" as a guess and as a verified next step: if the list
      // already contains search:read the problem is not consent at all.
      const detail = message.slice(message.indexOf('missing_scope') + 'missing_scope'.length).trim();
      throw new UserError(
        `Slack rejected ${method} for lack of the "search:read" scope. ` +
        'Reconnect Slack from the dashboard to re-consent — the scope is in the catalog, but a token minted before it was added does not carry it.' +
        (detail ? ` Slack reported ${detail.replace(/^\(|\)$/g, '')}.` : ''),
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
      // Ephemeral: this link exists to be handed to a tool that fetches it once
      // (insertImageFromUrl — Google copies the image into the document at
      // insert time), not to back a page that re-renders it. Without this, a
      // screenshot from a private DM would stay publicly fetchable forever.
      hosted = await store(buffer, file.mimetype || '', { ephemeral: true });
    } catch (err: any) {
      if (err instanceof UserError) throw err;
      throw new UserError(
        `Could not host this image: ${err?.message || err}. ` +
        'This deployment may be missing DATABASE_URL or IMAGE_PUBLIC_BASE_URL — ' +
        'retry with format: "inline" to get the image directly instead.',
      );
    }
    const { imageRetentionDays } = await import('../images/imageBlobStore.js');
    const days = imageRetentionDays();
    // Deliberately "eligible for removal", not "expires": blobs are
    // content-addressed, so if these exact bytes are also hosted for a
    // longer-lived use (a ClickUp Doc image), the shared row stays and this URL
    // keeps working past the window. Promising expiry would be a guarantee the
    // store cannot make.
    const lifetime = days > 0
      ? `It becomes eligible for removal after ${days} day(s) — treat it as short-lived and use it now. ` +
        'If this same image is also hosted for a longer-lived use, the URL may remain reachable beyond that.'
      : 'It does not expire (IMAGE_RETENTION_DAYS=0 on this deployment).';
    return `${meta}\n  Hosted at: ${hosted.url}\n\n` +
      'That URL is public and unauthenticated — pass it to any tool that takes an image URL ' +
      `(e.g. insertImageFromUrl). ${lifetime}`;
  }

  if (isTextLike(file)) {
    const { buffer } = await client.downloadFileBytes(downloadUrl, { maxBytes: TEXT_MAX_BYTES });
    return `${meta}\n\n\`\`\`\n${buffer.toString('utf8')}\n\`\`\``;
  }

  return `${meta}\n\nFile type "${file.mimetype || file.filetype || 'unknown'}" is not downloadable through this tool ` +
    '(images and text files are supported). Open it in Slack using the permalink above.';
}

/**
 * The two unfurl parameters, defined once.
 *
 * Both Slack servers register `postMessage` and `replyInThread`, so a
 * description that drifts between the two copies is a description that is
 * wrong on one of them — the same reason the ClickUp and Outline REST writes
 * keep their fields in one object and spread it.
 *
 * Both are `.optional()` with no `.default()`: Slack's own default is not a
 * single value (see `SlackUnfurlOptions`), so a Zod default would quietly pick
 * one for every caller who said nothing.
 */
export const unfurlParams = {
  unfurlLinks: z.boolean().optional().describe(
    'Set false to suppress the preview card for primarily text-based links (articles, docs, ' +
    "issue trackers). Omit to leave Slack's own default, which depends on the token: a bot-token " +
    'post usually does not unfurl these, a user-token post does. Suppressing every preview on a ' +
    'message needs unfurlMedia: false as well.',
  ),
  unfurlMedia: z.boolean().optional().describe(
    'Set false to suppress the inline preview for media links (images, video). Omit to leave ' +
    "Slack's default, which unfurls media on both token types. This applies at post time only — " +
    'there is no way to strip a preview off a message that is already in the channel.',
  ),
};

/**
 * The two ways to send something mrkdwn cannot express, defined once.
 *
 * Slack's mrkdwn has no list syntax, so `- item` and `1. item` in `text`
 * render as a literal hyphen and a literal digit — a message posted through
 * this connector could not contain a real list at all, which is the gap these
 * close. Spread into `postMessage`, `replyInThread` and `editMessage` on both
 * servers, for the reason `unfurlParams` states: six copies of a description
 * is a description that is wrong on five of them.
 *
 * Both `.optional()` with no `.default()`, and which combinations are legal is
 * NOT expressed here — see `resolveMessageBody`.
 */
export const richTextParams = {
  markdownText: z.string().max(12000).optional().describe(
    'Standard markdown, converted by Slack into native message elements. THIS IS THE WAY TO POST ' +
    'A REAL SLACK LIST: "- item" becomes a bullet and "1. item" a numbered entry, which the plain ' +
    'text parameter cannot do (Slack mrkdwn has no list syntax, so there a hyphen stays a hyphen). ' +
    'Also supports headings, bold, italic, strikethrough, blockquote, code blocks and tables. ' +
    'Carries the WHOLE message, so do not also pass text or blocks — Slack rejects that ' +
    'combination. Max 12,000 characters.',
  ),
  blocks: z.array(z.record(z.any())).optional().describe(
    'Block Kit blocks, for layouts markdownText cannot express — use markdownText for ordinary ' +
    'lists and prose. A bulleted or numbered list here is a block of type "rich_text" whose ' +
    'elements contain one {type: "rich_text_list", style: "bullet" | "ordered", elements: [...]} ' +
    'holding rich_text_section entries (optional indent for sub-lists, offset to start an ordered ' +
    'list at another number). Pass text as well: Slack uses it for notifications and screen ' +
    'readers, where blocks are not read.',
  ),
};

/**
 * `reply_broadcast` — its own object because only `replyInThread` takes it.
 *
 * This is the "Also send to channel" checkbox, and it is why a thread reply
 * made through this connector could never also reach the channel.
 */
export const broadcastParam = {
  broadcast: z.boolean().optional().describe(
    'Set true to also send this thread reply to the channel, like the "Also send to channel" ' +
    'checkbox. Slack accepts this only as the reply is posted, so it cannot be turned on for a ' +
    'reply that is already in the thread.',
  ),
};

/**
 * The full parameter set of each write, minus the ids, defined once.
 *
 * Both servers' tools spread these, and the REST write routes build their body
 * schemas from them (the ids come from the path there), so a field added to a
 * tool cannot silently go missing from its REST sibling. Guarded by
 * `src/__tests__/restWriteSchemaSharing.test.ts`.
 */
export const postMessageFields = {
  text: z.string().optional().describe(
    'Message text as Slack mrkdwn. Supports bold, italic, strikethrough, code and blockquote, ' +
    'but NOT lists — use markdownText for those. Optional, but pass it alongside blocks as the ' +
    'notification fallback. Exactly one of text or markdownText.',
  ),
  ...richTextParams,
  ...unfurlParams,
};

export const replyInThreadFields = {
  text: z.string().optional().describe(
    'Reply text as Slack mrkdwn. Supports bold, italic, strikethrough, code and blockquote, but ' +
    'NOT lists — use markdownText for those. Optional, but pass it alongside blocks as the ' +
    'notification fallback. Exactly one of text or markdownText.',
  ),
  ...richTextParams,
  ...broadcastParam,
  ...unfurlParams,
};

export const editMessageFields = {
  text: z.string().optional().describe(
    'The new message text as Slack mrkdwn, replacing the old content entirely. Does not support ' +
    'lists — use markdownText for those. Note that sending this alone strips any blocks the ' +
    'message already had.',
  ),
  ...richTextParams,
};

/**
 * REST bodies. `.strict()` because Zod strips unknown keys: a script sending
 * Slack's own `unfurl_links: false` or `thread_ts` would otherwise get a 201
 * for a message posted without them. An unknown key is a 400 naming it.
 */
export const postMessageRestSchema = z.object(postMessageFields).strict();
export const replyInThreadRestSchema = z.object(replyInThreadFields).strict();
export const editMessageRestSchema = z.object(editMessageFields).strict();

/** What a caller asked the message to contain, before it is checked. */
export interface MessageBodyInput extends SlackMessageContent {
  text?: string;
}

/**
 * Decide — and refuse — how the message body is expressed.
 *
 * Three parameters can carry the content and they do not freely combine, so
 * this is the one place the rules live. Both servers' three write tools call
 * it, which is what stops the refusals diverging between six registrations.
 *
 * It is a plain function rather than a Zod `.refine()`, for two independent
 * reasons:
 *
 *  1. A `.refine()`/`.superRefine()` returns a `ZodEffects`, which has no
 *     `.shape`. `src/__tests__/slack-user/tools.test.ts` walks
 *     `parameters.shape` to assert every parameter carries a `.describe()`,
 *     and that guard would break on every tool covered.
 *  2. A Zod-level rejection surfaces as FastMCP's generic `InvalidParams`,
 *     which is the unexplained failure these messages exist to replace — the
 *     same reasoning as ClickUp's `resolveDueDateUpdate`, which refuses
 *     `dueDate` + `clearDueDate` in the resolution function for this reason.
 *
 * Nothing is written when it throws: every caller runs it before the API call.
 */
export function resolveMessageBody(input: MessageBodyInput): MessageBodyInput {
  const { text, markdownText, blocks } = input;

  // Slack answers this combination with `markdown_text_conflict`, which names
  // neither the offending argument nor which one to drop.
  if (markdownText !== undefined && text !== undefined) {
    throw refusal(400,
      'Pass either markdownText or text, not both — Slack rejects a message that carries both ' +
      '(markdown_text_conflict). markdownText holds the entire message, so move the text into it: ' +
      'it renders the same prose and additionally supports real bullet and numbered lists.',
    );
  }
  if (markdownText !== undefined && blocks !== undefined) {
    throw refusal(400,
      'Pass either markdownText or blocks, not both — Slack rejects a message that carries both ' +
      '(markdown_text_conflict). markdownText is already converted into blocks by Slack; use ' +
      'blocks alone if you need a layout it cannot express.',
    );
  }

  // An empty array is not the same as an omitted one, and the difference is
  // destructive on an edit: `chat.update` reads `blocks: []` as "remove the
  // blocks", which would read back as a successful no-op.
  if (blocks !== undefined && blocks.length === 0) {
    throw refusal(400,
      'blocks is empty. Omit it rather than passing an empty array — on an edit Slack reads an ' +
      'empty array as "remove every block from this message", which would look like a successful ' +
      'no-op. Pass text or markdownText to set the content.',
    );
  }

  // Slack would answer `no_text` here, which does not say that two other
  // parameters would also have satisfied it.
  if (text === undefined && markdownText === undefined && blocks === undefined) {
    throw refusal(400,
      'Nothing to send. Pass one of: text (plain mrkdwn), markdownText (markdown, and the only ' +
      'one of the three that renders real bullet and numbered lists), or blocks (Block Kit).',
    );
  }

  // blocks + text is deliberately allowed: Slack uses `text` as the
  // notification and screen-reader fallback, where blocks are not read.
  return { text, markdownText, blocks };
}

/**
 * Rewrite the content-shape rejections Slack answers with a bare code.
 *
 * Rethrows untouched when the error is something else, so each caller keeps
 * whatever other mapping it has — it is a filter, not a catch-all.
 *
 * These are reachable despite `resolveMessageBody`: that refuses the illegal
 * *combinations*, but a malformed block shape is Slack's to judge, and its
 * codes name neither the parameter nor what is wrong with it. All three writes
 * run this, because a hand-built `blocks` array is most likely to be wrong on
 * the first post rather than on a later edit — mapping it on `editMessage`
 * alone would put the clear message on the rarer path.
 */
export function mapContentError(err: any): void {
  const slackError = String(err?.message || '');

  // `invalid_blocks_format` contains `invalid_blocks`, so this covers both.
  if (slackError.includes('invalid_blocks')) {
    throw refusal(400,
      'Slack rejected the blocks array as malformed. A bulleted or numbered list is one block of ' +
      'type "rich_text" whose elements hold {type: "rich_text_list", style: "bullet" | "ordered", ' +
      'elements: [{type: "rich_text_section", elements: [{type: "text", text: "..."}]}]}. Passing ' +
      'markdownText instead lets Slack build the blocks itself.',
    );
  }
  if (slackError.includes('msg_blocks_too_long')) {
    throw refusal(400,
      'The blocks array is larger than Slack allows for one message (50 blocks, and 3,000 ' +
      'characters per text object). Split it across several messages, or send fewer blocks.',
    );
  }
  if (slackError.includes('markdown_text_conflict')) {
    throw refusal(400,
      'Slack refused the message because markdownText cannot be combined with text or blocks. ' +
      'markdownText carries the whole message on its own.',
    );
  }
}

/**
 * Report what Slack actually stored, for the fields where it tells us.
 *
 * This is the half the unfurl flags could not have. Those are absent from the
 * response, so `unfurlNote` can only report what was *requested*. A posted or
 * edited message, by contrast, comes back with the blocks Slack stored — so
 * "did my list actually become a list?" is answerable here rather than by
 * opening Slack, and that is the exact question that went unanswered while
 * `- item` was silently arriving as a hyphen.
 *
 * Emitted only when one of the new parameters was actually passed, so the
 * confirmation string stays byte-identical for every pre-existing caller
 * (there is a test on that).
 */
export function renderNote(
  message: SlackPostedMessage | undefined, used: { rich: boolean; broadcast?: boolean },
): string {
  const parts: string[] = [];

  if (used.rich) {
    const blocks = message?.blocks;
    if (!blocks?.length) {
      // Reported as "may have", not "was": a response without blocks is an
      // absence of evidence. Asserting the message is plain text on that basis
      // would be the same overreach as reporting a silent no-op as success.
      parts.push(
        "⚠ Slack's response carried no blocks, so this message may have been stored as plain " +
        'text rather than as rendered elements.',
      );
    } else {
      parts.push(`Rendered as: ${describeBlocks(blocks)}.`);
    }
  }

  if (used.broadcast) {
    parts.push(message?.subtype === 'thread_broadcast'
      ? 'Also sent to the channel (Slack recorded it as a thread_broadcast).'
      : "Also sent to the channel: requested, but Slack's response did not confirm it — check the " +
        'channel itself.');
  }

  return parts.length ? `\n${parts.join('\n')}` : '';
}

/**
 * Name the block types Slack returned, and the element types inside a
 * `rich_text` block — the latter being where the answer lives, since a bullet
 * list and a paragraph are both a `rich_text` block and differ only by whether
 * `rich_text_list` is among its elements.
 */
function describeBlocks(blocks: NonNullable<SlackPostedMessage['blocks']>): string {
  return blocks.map(block => {
    const counts = new Map<string, number>();
    for (const el of block.elements || []) {
      const type = el?.type || 'unknown';
      counts.set(type, (counts.get(type) || 0) + 1);
    }
    const inner = [...counts].map(([type, n]) => (n > 1 ? `${type} ×${n}` : type)).join(', ');
    const type = block.type || 'unknown';
    return inner ? `${type} (${inner})` : type;
  }).join(', ');
}

/**
 * Report what was asked of Slack's unfurl flags — and that it is only what was
 * asked.
 *
 * `chat.postMessage` answers with `ts` and `channel` and carries no unfurl
 * state at all, so there is nothing to read back: a caller who passes
 * `unfurlMedia: false` through a bot token and then sees a preview in the
 * channel would otherwise have no way to tell a flag that was ignored from one
 * that was never sent. The note is emitted only when a flag was actually
 * given, so the default confirmation string stays byte-identical for every
 * existing caller.
 */
function unfurlNote(options?: SlackUnfurlOptions): string {
  const parts: string[] = [];
  if (options?.unfurlLinks !== undefined) parts.push(`unfurl_links=${options.unfurlLinks}`);
  if (options?.unfurlMedia !== undefined) parts.push(`unfurl_media=${options.unfurlMedia}`);
  if (parts.length === 0) return '';
  return `\nLink previews: sent ${parts.join(', ')}. Slack's response does not echo these back, ` +
    'so this reports what was requested, not what it rendered.';
}

/** What a post or edit sent, and what Slack answered with. */
export interface SlackWriteOutcome {
  body: MessageBodyInput;
  result: { ts: string; channel: string; text?: string; message?: SlackPostedMessage };
}

/**
 * Post a message or a thread reply: the gate, the content rules and the call.
 *
 * Shared by the MCP tools (which render a sentence from it) and the REST write
 * routes (which return it as JSON), so the two cannot disagree on what is
 * refused or what is sent.
 */
export async function performPostMessage(
  client: SlackClient, channelId: string, text: string | undefined, threadTs?: string,
  options?: SlackPostOptions,
): Promise<SlackWriteOutcome> {
  assertWritesEnabled();
  // Before the API call: a refused combination must leave nothing posted.
  const body = resolveMessageBody({ text, markdownText: options?.markdownText, blocks: options?.blocks });
  const result = await postOrExplain(client, channelId, body.text, threadTs, options);
  return { body, result };
}

export async function handlePostMessage(
  client: SlackClient, channelId: string, text: string | undefined, options?: SlackPostOptions,
): Promise<string> {
  const { body, result } = await performPostMessage(client, channelId, text, undefined, options);
  return `Message posted to ${result.channel} (ts: ${result.ts})` +
    renderNote(result.message, { rich: usedRichContent(body) }) +
    unfurlNote(options);
}

export async function handleReplyInThread(
  client: SlackClient, channelId: string, threadTs: string, text: string | undefined,
  options?: SlackPostOptions,
): Promise<string> {
  const { body, result } = await performPostMessage(client, channelId, text, threadTs, options);
  return `Reply posted to thread ${threadTs} in ${result.channel} (ts: ${result.ts})` +
    renderNote(result.message, { rich: usedRichContent(body), broadcast: options?.broadcast }) +
    unfurlNote(options);
}

/**
 * The JSON a REST write answers with: the message's ts and channel, and the
 * message object Slack echoed — what it stored, not what was asked.
 *
 * The two things Slack does not echo are reported as unconfirmed rather than
 * repeated from the request: `broadcast` is `true` only when Slack recorded a
 * `thread_broadcast` (else `null`), and link-preview flags come back under
 * `requested` with `confirmed: null`. Reading the message back with
 * `format=json` is the proof for everything else.
 */
export function projectWriteOutcome(
  outcome: SlackWriteOutcome,
  requested: { threadTs?: string } & SlackPostOptions = {},
): Record<string, unknown> {
  const { result } = outcome;
  const out: Record<string, unknown> = { channel: result.channel, ts: result.ts };
  if (requested.threadTs) out.threadTs = requested.threadTs;
  if (result.text !== undefined) out.text = result.text;
  out.message = result.message ?? null;
  if (requested.broadcast) out.broadcast = result.message?.subtype === 'thread_broadcast' ? true : null;
  if (requested.unfurlLinks !== undefined || requested.unfurlMedia !== undefined) {
    out.linkPreviews = {
      requested: { unfurlLinks: requested.unfurlLinks, unfurlMedia: requested.unfurlMedia },
      confirmed: null,
    };
  }
  return out;
}

/** Whether the caller asked for anything mrkdwn `text` could not have carried. */
function usedRichContent(body: SlackMessageContent): boolean {
  return body.markdownText !== undefined || body.blocks !== undefined;
}

/** `chat.postMessage` with the content-shape codes turned into instructions. */
async function postOrExplain(
  client: SlackClient, channelId: string, text: string | undefined,
  threadTs: string | undefined, options?: SlackPostOptions,
) {
  try {
    return await client.chatPostMessage(channelId, text, threadTs, options);
  } catch (err: any) {
    mapContentError(err);
    throw err;
  }
}

/**
 * Edit a message in place.
 *
 * `chat.update` replaces the text outright and the API gives no way to read the
 * previous version back, so the old text is gone as far as this server is
 * concerned (Slack still shows humans an "edited" marker). That is why the
 * confirmation echoes what the message now says: it is the only record the
 * caller gets, and an edit that silently targeted the wrong `ts` would
 * otherwise look identical to a successful one.
 *
 * Slack refuses an edit with a bare error code that reads as a bug if passed
 * through — `cant_update_message` in particular is the ordinary "you did not
 * write this message" case, not a malfunction. Each is mapped to what the
 * caller can actually do about it.
 */
export async function performEditMessage(
  client: SlackClient, channelId: string, ts: string, text: string | undefined,
  options?: SlackUpdateOptions,
): Promise<SlackWriteOutcome> {
  assertWritesEnabled();

  const body = resolveMessageBody({ text, markdownText: options?.markdownText, blocks: options?.blocks });

  let result: SlackWriteOutcome['result'];
  try {
    result = await client.chatUpdate(channelId, ts, body.text, body);
  } catch (err: any) {
    const slackError = String(err?.message || '');

    if (slackError.includes('cant_update_message')) {
      throw refusal(403,
        `Slack will not let this connection edit message ${ts}. A message can only be edited by ` +
        'whoever wrote it, so this is expected unless you are the author — check that the ts belongs ' +
        'to one of your own messages rather than a colleague\'s or an app\'s.',
      );
    }
    if (slackError.includes('edit_window_closed')) {
      throw refusal(403,
        `Message ${ts} is older than the edit window this workspace allows. A workspace admin sets ` +
        'that limit and it cannot be bypassed through the API — the message has to be deleted and ' +
        'reposted instead.',
      );
    }
    if (slackError.includes('message_not_found')) {
      throw refusal(404,
        `No message with ts ${ts} in channel ${channelId}. Timestamps are per-channel, so passing a ` +
        'ts from one channel while naming another fails this way — re-read the channel to get the ts.',
      );
    }
    if (slackError.includes('msg_too_long')) {
      throw refusal(400, 'The replacement text is longer than Slack allows for one message (about 40,000 characters).');
    }
    if (slackError.includes('missing_scope')) {
      throw refusal(403,
        'Slack rejected chat.update for lack of the "chat:write" scope. Reconnect Slack from the ' +
        'dashboard to re-consent.',
      );
    }
    mapContentError(err);
    throw err;
  }
  return { body, result };
}

export async function handleEditMessage(
  client: SlackClient, channelId: string, ts: string, text: string | undefined,
  options?: SlackUpdateOptions,
): Promise<string> {
  const { body, result } = await performEditMessage(client, channelId, ts, text, options);
  const note = renderNote(result.message, { rich: usedRichContent(body) });

  // With blocks or markdownText there may be no `text` at all, so printing the
  // old "it now reads" body would show an empty message. The echoed block
  // types are the useful record in that case — and `note` already carries
  // them, so the tail only has to stop claiming to quote text that is absent.
  if (usedRichContent(body)) {
    return `Message ${result.ts} in ${result.channel} edited.${note}` +
      (result.text ? `\nIts fallback text now reads: ${result.text}` : '');
  }

  return `Message ${result.ts} in ${result.channel} edited. It now reads:\n\n${result.text ?? text}`;
}
