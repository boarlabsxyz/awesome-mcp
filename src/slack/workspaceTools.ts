// Channels, reactions, profiles, membership, file upload, scheduled messages,
// canvases and lists — registered on BOTH Slack servers from here, so the bot
// and user registrations cannot drift.
//
// The servers differ only in what they pass as guards. slack-bot passes none:
// it has no access rules (src/slack/CLAUDE.md). slack-user passes its
// `enforceAccess` for a channel, and a file guard for canvases and lists, which
// are files: a canvas shared only into a denied channel would otherwise be
// readable by ID, the same laundering `downloadFile` is guarded against.
//
// Every write goes through `assertWritesEnabled` (SLACK_WRITES_ENABLED), the
// gate the existing post and edit tools use.

import { z } from 'zod';
import type { FastMCP } from 'fastmcp';
import type { UserSession } from '../userSession.js';
import { fileShareTargets, plainRichText, type SlackClient } from './apiHelpers.js';
import { assertWritesEnabled, refusal, resolveMessageBody, richTextParams } from './helpers.js';

export interface SlackWorkspaceToolOptions {
  getClient: (session?: UserSession) => SlackClient;
  /** Refuse a channel the caller's access rules deny. No-op on slack-bot. */
  guardChannel?: (client: SlackClient, session: UserSession, channelId: string) => Promise<void>;
  /** Refuse a canvas or list shared only into denied channels. No-op on slack-bot. */
  guardFile?: (client: SlackClient, session: UserSession, fileId: string) => Promise<void>;
}

/** The longest Slack lets a message be scheduled ahead. */
export const MAX_SCHEDULE_DAYS = 120;
/** Upload cap. Slack takes up to 1 GB; this travels through the model as base64. */
export const MAX_SLACK_UPLOAD_BYTES = 20 * 1024 * 1024;

// === Pure helpers (exported for tests) ===

/** Seconds since the epoch for an ISO time or a Unix timestamp, refusing the past and >120 days out. */
export function resolvePostAt(postAt: string, now: number = Date.now()): number {
  const seconds = /^\d+(\.\d+)?$/.test(postAt) ? Math.floor(Number(postAt)) : Math.floor(Date.parse(postAt) / 1000);
  if (!Number.isFinite(seconds)) {
    throw refusal(400, `postAt "${postAt}" is neither an ISO 8601 time nor a Unix timestamp.`);
  }
  const nowSeconds = Math.floor(now / 1000);
  if (seconds <= nowSeconds) throw refusal(400, `postAt ${new Date(seconds * 1000).toISOString()} is in the past.`);
  if (seconds > nowSeconds + MAX_SCHEDULE_DAYS * 86400) {
    throw refusal(400, `postAt ${new Date(seconds * 1000).toISOString()} is more than ${MAX_SCHEDULE_DAYS} days ahead, which Slack does not allow.`);
  }
  return seconds;
}

/** Slack's naming rule for channels, checked so the refusal names the rule rather than `invalid_name_specials`. */
export function normalizeChannelName(name: string): string {
  const normalized = name.trim().replace(/^#/, '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(normalized)) {
    throw refusal(400, `"${name}" is not a valid Slack channel name: use up to 80 lowercase letters, digits, hyphens and underscores, with no spaces or periods.`);
  }
  return normalized;
}

const listFieldSchema = z.object({
  columnId: z.string().describe('The column ID (from getListItems with includeList, under list_metadata.schema).'),
  text: z.string().optional().describe('Text column value.'),
  select: z.array(z.string()).optional().describe('Select column: option IDs.'),
  date: z.array(z.string()).optional().describe('Date column: YYYY-MM-DD values.'),
  user: z.array(z.string()).optional().describe('People column: user IDs.'),
  number: z.array(z.number()).optional().describe('Number column.'),
  checkbox: z.boolean().optional().describe('Checkbox column (also the todo "completed" column).'),
  link: z.array(z.string().url()).optional().describe('Link column: URLs.'),
});
export type ListField = z.infer<typeof listFieldSchema>;

/** A typed cell for slackLists.items.create/update: exactly one value per column. */
export function toListCell(field: ListField): Record<string, unknown> {
  const values: Array<[string, unknown]> = [];
  if (field.text !== undefined) values.push(['rich_text', plainRichText(field.text)]);
  if (field.select !== undefined) values.push(['select', field.select]);
  if (field.date !== undefined) values.push(['date', field.date]);
  if (field.user !== undefined) values.push(['user', field.user]);
  if (field.number !== undefined) values.push(['number', field.number]);
  if (field.checkbox !== undefined) values.push(['checkbox', field.checkbox]);
  if (field.link !== undefined) values.push(['link', field.link.map((original_url) => ({ original_url }))]);
  if (values.length !== 1) {
    throw refusal(400, `Column ${field.columnId}: give exactly one value (text, select, date, user, number, checkbox or link); got ${values.length}.`);
  }
  return { column_id: field.columnId, [values[0][0]]: values[0][1] };
}

/** The bytes to upload, from exactly one of base64 or text. */
export function uploadBytes(args: { contentBase64?: string; textContent?: string }): Buffer {
  if ((args.contentBase64 === undefined) === (args.textContent === undefined)) {
    throw refusal(400, 'Give exactly one of contentBase64 or textContent.');
  }
  // Buffer.from skips characters that are not base64, so corrupt input would
  // upload a different file and report success.
  if (args.contentBase64 !== undefined && !/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(args.contentBase64)) {
    throw refusal(400, 'contentBase64 is not valid base64.');
  }
  const bytes = args.contentBase64 !== undefined ? Buffer.from(args.contentBase64, 'base64') : Buffer.from(args.textContent!, 'utf8');
  if (bytes.length === 0) throw refusal(400, 'The file is empty.');
  if (bytes.length > MAX_SLACK_UPLOAD_BYTES) {
    throw refusal(400, `The file is ${bytes.length} bytes; the limit here is ${MAX_SLACK_UPLOAD_BYTES} (20 MB).`);
  }
  return bytes;
}

/** Slack's presigned upload host. Anything else is refused rather than sent the bytes. */
export function assertSlackUploadUrl(uploadUrl: string): URL {
  const url = new URL(uploadUrl);
  if (url.protocol !== 'https:' || !(url.hostname === 'files.slack.com' || url.hostname.endsWith('.slack.com'))) {
    throw new Error(`Slack returned an upload URL on an unexpected host (${url.hostname}); nothing was uploaded.`);
  }
  return url;
}

/**
 * Whether a re-read record holds the value that was sent: true, false, or null
 * when the stored shape cannot be compared (links, or a text column read back
 * without its plain `text`).
 */
export function storedValueMatches(fields: Array<Record<string, any>>, sent: ListField): boolean | null {
  const stored = fields.find((f) => f.column_id === sent.columnId);
  if (!stored) return false;
  const sameSet = (a: unknown[] | undefined, b: unknown[]) =>
    Array.isArray(a) && a.length === b.length && [...a].map(String).sort().join('\u0000') === [...b].map(String).sort().join('\u0000');
  if (sent.checkbox !== undefined) return stored.checkbox === undefined ? null : stored.checkbox === sent.checkbox;
  if (sent.select !== undefined) return sameSet(stored.select, sent.select);
  if (sent.user !== undefined) return sameSet(stored.user, sent.user);
  if (sent.date !== undefined) return sameSet(stored.date, sent.date);
  if (sent.number !== undefined) return sameSet(stored.number, sent.number);
  if (sent.text !== undefined) return typeof stored.text === 'string' ? stored.text.trim() === sent.text.trim() : null;
  return null;
}

/**
 * Canvases and lists are files, so on slack-user they are checked by where
 * they are shared: allowed if ANY share target passes `enforce` (search's
 * posture). A file with no share Slack reports is allowed only when the caller
 * created it, and withheld otherwise: files.info may omit shares, and failing
 * open would let a denied channel's canvas be read by ID.
 */
export async function guardFileByShares(
  client: SlackClient,
  fileId: string,
  enforce: (channelId: string) => Promise<void>,
): Promise<void> {
  const { file } = await client.filesInfo(fileId);
  const targets = [...fileShareTargets(file)];
  if (targets.length === 0) {
    const { user_id } = await client.authTest();
    if (file.user && file.user === user_id) return;
    throw refusal(403, `File ${fileId} is not reported as shared in any channel, so the access rules cannot be checked; it is withheld.`);
  }
  let lastDenial: unknown;
  for (const channelId of targets) {
    try {
      await enforce(channelId);
      return;
    } catch (err) {
      lastDenial = err;
    }
  }
  throw lastDenial;
}

// === Ops shared by both servers ===

export async function performUploadFile(
  client: SlackClient,
  args: { filename: string; title?: string; contentBase64?: string; textContent?: string; channelId?: string; threadTs?: string; initialComment?: string },
  fetchImpl: typeof fetch = fetch,
) {
  assertWritesEnabled();
  if (args.threadTs && !args.channelId) throw refusal(400, 'threadTs needs channelId.');
  const bytes = uploadBytes(args);
  const { upload_url, file_id } = await client.filesGetUploadUrlExternal(args.filename, bytes.length);
  const target = assertSlackUploadUrl(upload_url);
  // No redirects: the host check covers only this URL. And a timeout, which
  // request() has and a raw fetch does not.
  const put = await fetchImpl(target, { method: 'POST', body: bytes, redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (!put.ok) throw refusal(502, `Uploading the bytes to Slack failed (HTTP ${put.status}); the file was not created.`);
  let done: Awaited<ReturnType<SlackClient['filesCompleteUploadExternal']>>;
  try {
    done = await client.filesCompleteUploadExternal([{ id: file_id, ...(args.title ? { title: args.title } : {}) }], {
      channelId: args.channelId, threadTs: args.threadTs, initialComment: args.initialComment,
    });
  } catch (error: any) {
    // The bytes are already on Slack under file_id; say so rather than leave
    // an orphan nobody knows about.
    error.message = `${error.message} (the bytes were uploaded as file ${file_id}, which was not completed or shared)`;
    throw error;
  }
  const file = done.files?.[0];
  // Sharing completes asynchronously, so an empty share list right after the
  // call is "not yet confirmed", not "not shared".
  const sharedTo = file ? [...new Set([...(file.channels ?? []), ...(file.groups ?? []), ...(file.ims ?? [])])] : [];
  return {
    fileId: file?.id ?? file_id,
    permalink: file?.permalink ?? null,
    bytes: bytes.length,
    requestedChannel: args.channelId ?? null,
    sharedConfirmed: args.channelId ? sharedTo.includes(args.channelId) || null : null,
  };
}

// === Schemas (fields) and ops — one per tool, shared by the MCP tools and the
// slack-bot REST routes. Ops return data; the tools render it.

export const createChannelFields = {
  name: z.string().describe('Channel name: lowercase letters, digits, hyphens, underscores; max 80.'),
  isPrivate: z.boolean().optional().default(false).describe('Create a private channel.'),
};
export const addReactionFields = {
  timestamp: z.string().describe('The message ts, from readChannelHistory or readThreadReplies.'),
  emoji: z.string().describe('Emoji name without colons, e.g. "white_check_mark" or "thumbsup".'),
};
export const uploadFileFields = {
  filename: z.string().min(1).describe('File name, e.g. "report.pdf".'),
  title: z.string().optional().describe('Title shown in Slack.'),
  contentBase64: z.string().optional().describe('File bytes, base64. Give this or textContent.'),
  textContent: z.string().optional().describe('File content as UTF-8 text. Give this or contentBase64.'),
  channelId: z.string().optional().describe('Share into this channel. Omit to keep the file private.'),
  threadTs: z.string().optional().describe('Share as a reply in this thread (needs channelId).'),
  initialComment: z.string().optional().describe('Message posted with the file.'),
};
export const scheduleMessageFields = {
  postAt: z.string().describe('When to post: ISO 8601 with offset (e.g. "2026-11-12T09:00:00+02:00") or a Unix timestamp.'),
  threadTs: z.string().optional().describe('Post as a reply in this thread.'),
  text: z.string().optional().describe('Message as Slack mrkdwn (no lists — use markdownText). Exactly one of text or markdownText.'),
  ...richTextParams,
};
export const createCanvasFields = {
  title: z.string().optional().describe('Canvas title (standalone canvases only).'),
  markdown: z.string().max(1_048_576).optional().describe('Canvas content as markdown.'),
  channelId: z.string().optional().describe('Create it as this channel\'s canvas (a channel has at most one).'),
};
export const editCanvasFields = {
  operation: z.enum(['insert_at_start', 'insert_at_end', 'insert_before', 'insert_after', 'replace_section', 'rename'])
    .describe('What to do. replace_section replaces one section (never the whole canvas); rename sets the title from markdown.'),
  markdown: z.string().max(1_048_576).optional().describe('Content to insert or the replacement section (markdown). For rename: the new title.'),
  sectionId: z.string().optional().describe('Section ID from findCanvasSections. Required for insert_before, insert_after and replace_section.'),
};
export const createListFields = {
  name: z.string().min(1).describe('List name.'),
  description: z.string().optional().describe('Plain-text description.'),
  todoMode: z.boolean().optional().describe('Add task-tracking columns.'),
};
export const createListItemFields = {
  fields: z.array(listFieldSchema).min(1).max(100).describe('One entry per column to fill.'),
  parentItemId: z.string().optional().describe('Create it as a subtask of this record.'),
};
export const updateListItemFields = {
  fields: z.array(listFieldSchema).min(1).max(100).describe('Columns to change, one typed value each.'),
};

/**
 * REST bodies, `.strict()` like postMessageRestSchema: an unknown key (a
 * Slack-native snake_case name) is a 400 naming it, not a silent drop. Ids
 * come from the path.
 */
export const createChannelRestSchema = z.object(createChannelFields).strict();
export const addReactionRestSchema = z.object({ emoji: addReactionFields.emoji }).strict();
export const scheduleMessageRestSchema = z.object(scheduleMessageFields).strict();
export const uploadFileRestSchema = z.object(uploadFileFields).strict();
export const createCanvasRestSchema = z.object(createCanvasFields).strict();
export const editCanvasRestSchema = z.object(editCanvasFields).strict();
export const createListRestSchema = z.object(createListFields).strict();
export const createListItemRestSchema = z.object(createListItemFields).strict();
export const updateListItemRestSchema = z.object(updateListItemFields).strict();

type Args<T extends z.ZodRawShape> = z.infer<z.ZodObject<T>>;

export async function performCreateChannel(client: SlackClient, args: Args<typeof createChannelFields>) {
  assertWritesEnabled();
  const { channel } = await client.conversationsCreate(normalizeChannelName(args.name), args.isPrivate ?? false);
  return { channelId: channel.id, name: channel.name, isPrivate: channel.is_private };
}

export async function performAddReaction(client: SlackClient, channelId: string, args: Args<typeof addReactionFields>) {
  assertWritesEnabled();
  const emoji = args.emoji.replace(/^:|:$/g, '');
  try {
    await client.reactionsAdd(channelId, args.timestamp, emoji);
  } catch (error: any) {
    // Already there is the state that was asked for.
    if (/already_reacted/.test(String(error?.message))) return { emoji, added: false, alreadyPresent: true };
    throw error;
  }
  return { emoji, added: true, alreadyPresent: false };
}

export async function performScheduleMessage(client: SlackClient, channelId: string, args: Args<typeof scheduleMessageFields>) {
  assertWritesEnabled();
  const postAt = resolvePostAt(args.postAt);
  const body = resolveMessageBody({ text: args.text, markdownText: args.markdownText, blocks: args.blocks });
  const r = await client.chatScheduleMessage(channelId, postAt, body.text, args.threadTs, {
    blocks: body.blocks, markdownText: body.markdownText,
  });
  return { scheduledMessageId: r.scheduled_message_id, postAt: new Date(r.post_at * 1000).toISOString(), channel: r.channel };
}

export async function performCreateCanvas(client: SlackClient, args: Args<typeof createCanvasFields>) {
  assertWritesEnabled();
  const r = args.channelId
    ? await client.conversationsCanvasesCreate(args.channelId, args.markdown)
    : await client.canvasesCreate(args.title, args.markdown);
  return { canvasId: r.canvas_id, channelId: args.channelId ?? null };
}

export async function performEditCanvas(client: SlackClient, canvasId: string, args: Args<typeof editCanvasFields>) {
  assertWritesEnabled();
  if (args.markdown === undefined) throw refusal(400, `${args.operation} needs markdown.`);
  const needsSection = args.operation === 'insert_before' || args.operation === 'insert_after' || args.operation === 'replace_section';
  // A replace without a section replaces the WHOLE canvas in Slack, which is a
  // destructive edit this tool does not offer.
  if (needsSection && !args.sectionId) throw refusal(400, `${args.operation} needs sectionId (from findCanvasSections).`);
  const content = { type: 'markdown', markdown: args.markdown };
  const change = args.operation === 'rename'
    ? { operation: 'rename', title_content: content }
    : {
      operation: args.operation === 'replace_section' ? 'replace' : args.operation,
      document_content: content,
      ...(needsSection ? { section_id: args.sectionId } : {}),
    };
  await client.canvasesEdit(canvasId, change);
  return { canvasId, operation: args.operation };
}

export async function performCreateList(client: SlackClient, args: Args<typeof createListFields>) {
  assertWritesEnabled();
  const r = await client.slackListsCreate(args);
  return { listId: r.list_id, name: args.name, listMetadata: r.list_metadata ?? null };
}

export async function performCreateListItem(client: SlackClient, listId: string, args: Args<typeof createListItemFields>) {
  assertWritesEnabled();
  const cells = args.fields.map(toListCell);
  const { item } = await client.slackListsItemsCreate(listId, cells, args.parentItemId);
  return { listId, item };
}

export async function performUpdateListItem(client: SlackClient, listId: string, itemId: string, args: Args<typeof updateListItemFields>) {
  assertWritesEnabled();
  const cells = args.fields.map((f) => ({ row_id: itemId, ...toListCell(f) }));
  await client.slackListsItemsUpdate(listId, cells);
  // slackLists.items.update answers only {ok: true}; re-read and compare the
  // stored VALUES, since a column that already had a value is present either way.
  const { record } = await client.slackListsItemsInfo(listId, itemId);
  const verdicts = args.fields.map((f) => ({ columnId: f.columnId, matches: storedValueMatches(record.fields ?? [], f) }));
  const notReadBack = verdicts.filter((v) => v.matches === false).map((v) => v.columnId);
  const unverifiable = verdicts.filter((v) => v.matches === null).map((v) => v.columnId);
  const confirmed = notReadBack.length ? false : unverifiable.length ? null : true;
  return { listId, itemId, updated: args.fields.length, confirmed, notReadBack, unverifiable, record };
}

export function registerSlackWorkspaceTools(server: FastMCP<UserSession>, opts: SlackWorkspaceToolOptions): void {
  const guardChannel = opts.guardChannel ?? (async () => {});
  const guardFile = opts.guardFile ?? (async () => {});

  server.addTool({
    name: 'createChannel',
    annotations: { readOnlyHint: false },
    description: 'Creates a public or private Slack channel. Returns its ID.',
    parameters: z.object(createChannelFields),
    execute: async (args, { session }) => {
      const r = await performCreateChannel(opts.getClient(session), args);
      return `Created ${r.isPrivate ? 'private' : 'public'} channel #${r.name} (${r.channelId}).`;
    },
  });

  server.addTool({
    name: 'addReaction',
    annotations: { readOnlyHint: false },
    description: 'Adds an emoji reaction to a message.',
    parameters: z.object({ channelId: z.string().describe('Channel ID containing the message.'), ...addReactionFields }),
    execute: async (args, { session }) => {
      const client = opts.getClient(session);
      await guardChannel(client, session!, args.channelId);
      const r = await performAddReaction(client, args.channelId, args);
      return r.alreadyPresent
        ? `:${r.emoji}: was already on message ${args.timestamp}.`
        : `Added :${r.emoji}: to message ${args.timestamp} in ${args.channelId}.`;
    },
  });

  server.addTool({
    name: 'getUserProfile',
    annotations: { readOnlyHint: true },
    description: 'Gets a Slack user\'s full profile: name, title, status, time zone, email (with users:read.email) and custom fields.',
    parameters: z.object({ userId: z.string().describe('Slack user ID (e.g. U01234ABCDE), from listUsers.') }),
    execute: async (args, { session }) => {
      const { user, profile, customFieldsError } = await performGetUserProfile(opts.getClient(session), args.userId);
      const fields = Object.values(profile.fields ?? {}) as Array<{ label?: string; value?: string }>;
      const lines = [
        `**${profile.real_name || user.real_name || user.name}** (@${user.name}) — ${user.id}`,
        profile.title ? `Title: ${profile.title}` : '',
        profile.email ? `Email: ${profile.email}` : 'Email: not visible (needs users:read.email)',
        profile.status_text ? `Status: ${profile.status_emoji ?? ''} ${profile.status_text}` : '',
        user.tz ? `Time zone: ${user.tz}` : '',
        user.is_admin ? 'Workspace admin' : '',
        user.deleted ? 'DEACTIVATED' : '',
        ...fields.filter((f) => f?.value).map((f) => `${f.label ?? 'Field'}: ${f.value}`),
      ].filter(Boolean);
      return lines.join('\n') + (customFieldsError ? `\n(Custom profile fields not read: ${customFieldsError})` : '');
    },
  });

  server.addTool({
    name: 'listChannelMembers',
    annotations: { readOnlyHint: true },
    description: 'Lists the user IDs in a channel, paginated. Resolve names with getUserProfile or listUsers.',
    parameters: z.object({
      channelId: z.string().describe('Channel ID.'),
      cursor: z.string().optional().describe('Cursor from a previous call.'),
      limit: z.number().int().min(1).max(1000).optional().default(200).describe('Members per page (1-1000).'),
    }),
    execute: async (args, { session }) => {
      const client = opts.getClient(session);
      await guardChannel(client, session!, args.channelId);
      const page = await client.conversationsMembersPage(args.channelId, args.cursor, args.limit);
      const next = page.response_metadata?.next_cursor;
      return `${page.members.length} member(s) in ${args.channelId}${next ? ' (more remain)' : ''}:\n${page.members.join(', ')}`
        + (next ? `\n\n---\nMore members available. Use cursor: "${next}"` : '');
    },
  });

  server.addTool({
    name: 'uploadFile',
    annotations: { readOnlyHint: false },
    description: 'Uploads a file (base64 or text, up to 20 MB) and optionally shares it in a channel or thread. Without channelId the file stays private.',
    parameters: z.object(uploadFileFields),
    execute: async (args, { session }) => {
      const client = opts.getClient(session);
      if (args.channelId) await guardChannel(client, session!, args.channelId);
      const r = await performUploadFile(client, args);
      const where = !r.requestedChannel ? 'Not shared anywhere (private to the uploader).'
        : r.sharedConfirmed ? `Shared in ${r.requestedChannel}.`
        : `Sharing in ${r.requestedChannel} was requested; Slack completes sharing asynchronously, so it is not confirmed yet.`;
      return `Uploaded ${args.filename} (${r.bytes} bytes) — file ID ${r.fileId}. ${where}${r.permalink ? `\n${r.permalink}` : ''}`;
    },
  });

  server.addTool({
    name: 'scheduleMessage',
    annotations: { readOnlyHint: false },
    description: 'Schedules a message (or thread reply) for later delivery, up to 120 days ahead. Returns the scheduled message ID.',
    parameters: z.object({ channelId: z.string().describe('Channel or DM ID.'), ...scheduleMessageFields }),
    execute: async (args, { session }) => {
      const client = opts.getClient(session);
      await guardChannel(client, session!, args.channelId);
      const r = await performScheduleMessage(client, args.channelId, args);
      return `Scheduled message ${r.scheduledMessageId} for ${r.postAt} in ${r.channel}.`;
    },
  });

  // --- Canvases ---

  server.addTool({
    name: 'createCanvas',
    annotations: { readOnlyHint: false },
    description: 'Creates a Slack canvas from markdown: standalone, or as a channel\'s canvas when channelId is given.',
    parameters: z.object(createCanvasFields),
    execute: async (args, { session }) => {
      const client = opts.getClient(session);
      if (args.channelId) await guardChannel(client, session!, args.channelId);
      const r = await performCreateCanvas(client, args);
      return r.channelId
        ? `Created the channel canvas ${r.canvasId} in ${r.channelId}.`
        : `Created canvas ${r.canvasId}${args.title ? ` "${args.title}"` : ''}. It is private to its creator until shared.`;
    },
  });

  server.addTool({
    name: 'getCanvasContent',
    annotations: { readOnlyHint: true },
    description: 'Reads a whole canvas as markdown (default) or HTML.',
    parameters: z.object({
      canvasId: z.string().describe('Canvas ID (F…).'),
      contentType: z.enum(['markdown', 'html']).optional().default('markdown').describe('Return markdown (default) or HTML.'),
    }),
    execute: async (args, { session }) => {
      const client = opts.getClient(session);
      await guardFile(client, session!, args.canvasId);
      const { content } = await client.canvasesGetContent(args.canvasId, args.contentType);
      return content || '(The canvas is empty.)';
    },
  });

  server.addTool({
    name: 'findCanvasSections',
    annotations: { readOnlyHint: true },
    description: 'Finds section IDs in a canvas (by text or header type), for editCanvas insert_before/insert_after/replace_section.',
    parameters: z.object({
      canvasId: z.string().describe('Canvas ID.'),
      containsText: z.string().optional().describe('Sections containing this text.'),
      sectionTypes: z.array(z.enum(['h1', 'h2', 'h3', 'any_header'])).optional().describe('Only these header types.'),
    }),
    execute: async (args, { session }) => {
      if (!args.containsText && !args.sectionTypes?.length) throw refusal(400, 'Give containsText and/or sectionTypes.');
      const client = opts.getClient(session);
      await guardFile(client, session!, args.canvasId);
      const { sections } = await client.canvasesSectionsLookup(args.canvasId, {
        ...(args.containsText ? { contains_text: args.containsText } : {}),
        ...(args.sectionTypes?.length ? { section_types: args.sectionTypes } : {}),
      });
      if (!sections?.length) return 'No matching sections.';
      return `${sections.length} section(s): ${sections.map((sct) => sct.id).join(', ')}`;
    },
  });

  server.addTool({
    name: 'editCanvas',
    annotations: { readOnlyHint: false },
    description: 'Edits a canvas: insert markdown at the start/end or around a section, replace one section, or rename it. Deleting is not offered.',
    parameters: z.object({ canvasId: z.string().describe('Canvas ID.'), ...editCanvasFields }),
    execute: async (args, { session }) => {
      const client = opts.getClient(session);
      await guardFile(client, session!, args.canvasId);
      await performEditCanvas(client, args.canvasId, args);
      return `Applied ${args.operation} to canvas ${args.canvasId}.`;
    },
  });

  // --- Lists ---

  server.addTool({
    name: 'createList',
    annotations: { readOnlyHint: false },
    description: 'Creates a Slack List (paid workspaces). todoMode adds completed/assignee/due-date columns.',
    parameters: z.object(createListFields),
    execute: async (args, { session }) => {
      const r = await performCreateList(opts.getClient(session), args);
      return `Created list ${r.listId} "${r.name}". Read its columns with getListItems (includeList: true).`;
    },
  });

  server.addTool({
    name: 'getListItems',
    annotations: { readOnlyHint: true },
    description: 'Reads the records of a Slack List, with its column schema when includeList is true. Paginated.',
    parameters: z.object({
      listId: z.string().describe('List ID (F…).'),
      includeList: z.boolean().optional().default(true).describe('Also return the list title, columns and row count.'),
      limit: z.number().int().min(1).max(1000).optional().default(100).describe('Records per page.'),
      cursor: z.string().optional().describe('Cursor from a previous call.'),
      archived: z.boolean().optional().describe('Return archived records instead.'),
    }),
    execute: async (args, { session }) => {
      const client = opts.getClient(session);
      await guardFile(client, session!, args.listId);
      const r = await client.slackListsItemsList(args.listId, args);
      const next = r.response_metadata?.next_cursor;
      return JSON.stringify({ list: r.list ?? null, items: r.items, nextCursor: next || null }, null, 2);
    },
  });

  server.addTool({
    name: 'getListItem',
    annotations: { readOnlyHint: true },
    description: 'Reads one record of a Slack List with all its fields.',
    parameters: z.object({ listId: z.string().describe('List ID.'), itemId: z.string().describe('Record ID (Rec…).') }),
    execute: async (args, { session }) => {
      const client = opts.getClient(session);
      await guardFile(client, session!, args.listId);
      const r = await client.slackListsItemsInfo(args.listId, args.itemId);
      return JSON.stringify(r.record, null, 2);
    },
  });

  server.addTool({
    name: 'createListItem',
    annotations: { readOnlyHint: false },
    description: 'Adds a record to a Slack List. Each field names its column and one typed value.',
    parameters: z.object({ listId: z.string().describe('List ID.'), ...createListItemFields }),
    execute: async (args, { session }) => {
      const client = opts.getClient(session);
      await guardFile(client, session!, args.listId);
      const r = await performCreateListItem(client, args.listId, args);
      return `Created record ${r.item.id} in list ${args.listId}.`;
    },
  });

  server.addTool({
    name: 'updateListItem',
    annotations: { readOnlyHint: false },
    description: 'Updates fields of a record in a Slack List. Only the columns named change.',
    parameters: z.object({
      listId: z.string().describe('List ID.'),
      itemId: z.string().describe('Record ID (Rec…).'),
      ...updateListItemFields,
    }),
    execute: async (args, { session }) => {
      const client = opts.getClient(session);
      await guardFile(client, session!, args.listId);
      const r = await performUpdateListItem(client, args.listId, args.itemId, args);
      if (r.confirmed === true) return `Updated ${r.updated} field(s) on record ${args.itemId}; the record reads back as sent.`;
      if (r.confirmed === false) {
        return `Slack accepted the update to ${args.itemId}, but these columns do not read back as sent: ${r.notReadBack.join(', ')}.`;
      }
      return `Slack accepted the update to ${args.itemId}; these columns could not be compared on re-read: ${r.unverifiable.join(', ')}.`;
    },
  });
}

/** users.info plus users.profile.get; custom fields degrade, with the reason, when the scope is missing. */
export async function performGetUserProfile(client: SlackClient, userId: string) {
  const { user } = await client.usersInfoFull(userId);
  let profile: Record<string, any> = user.profile ?? {};
  let customFieldsError: string | null = null;
  try {
    profile = { ...profile, ...(await client.usersProfileGet(userId)).profile };
  } catch (error: any) {
    customFieldsError = String(error?.message || error);
  }
  return { user, profile, customFieldsError };
}
