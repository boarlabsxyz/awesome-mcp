// src/slack-user/readState.ts
// Unread state for the user-token Slack server. Slack keeps one read cursor
// (`last_read`) per conversation; a message is unread when its ts is later.
// There is no per-message read flag, and thread read state is not exposed by
// the public API at all, so everything here is channel-level.
import { UserError } from 'fastmcp';
import type { SlackClient, SlackHistoryMessage } from '../slack/apiHelpers.js';
import { assertWritesEnabled } from '../slack/helpers.js';
import { channelMetaFromInfo, type ChannelMeta } from './accessControl.js';

/** Slack's cursor for a conversation nothing has been read in. */
export const NEVER_READ = '0000000000.000000';

/**
 * Messages fetched to decide whether a conversation has unreads. 15 is what
 * Slack allows per conversations.history call for non-Marketplace apps under
 * its 2025 limits, so the probe means the same thing under either regime.
 */
export const UNREAD_PROBE_LIMIT = 15;

/** History pages getFirstUnreadMessage walks before reporting a partial scan. */
export const FIRST_UNREAD_MAX_PAGES = 5;
export const FIRST_UNREAD_PAGE_SIZE = 200;

/** A Slack ts as integer microseconds, so cursors compare and step exactly. */
export function tsToMicros(ts: string): bigint {
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(ts.trim());
  if (!m) throw new UserError(`"${ts}" is not a Slack message timestamp (expected e.g. 1700000000.123456).`);
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
}

export function microsToTs(micros: bigint): string {
  return `${(micros / 1_000_000n).toString().padStart(10, '0')}.${(micros % 1_000_000n).toString().padStart(6, '0')}`;
}

export function compareTs(a: string, b: string): number {
  const d = tsToMicros(a) - tsToMicros(b);
  return d === 0n ? 0 : d < 0n ? -1 : 1;
}

const byTs = (a: SlackHistoryMessage, b: SlackHistoryMessage) => compareTs(a.ts, b.ts);

/** The caller's own messages never count as unread, as in Slack's own client. */
function unreadFor(messages: SlackHistoryMessage[], selfUserId: string): SlackHistoryMessage[] {
  return messages.filter(m => m.user !== selfUserId).sort(byTs);
}

/** SlackClient turns a second 429 into this message; a scan stops on it rather than marking the rest unknown. */
export function isRateLimited(err: unknown): boolean {
  return /rate limit/i.test(String((err as any)?.message ?? err));
}

export interface UnreadProbe {
  /** Unread messages in the probe page, oldest first. */
  unread: SlackHistoryMessage[];
  /** More history lies past the probe, so `unread.length` is a floor. */
  more: boolean;
}

/** One history call: the unreads after `lastRead` that fit in a probe page. */
export async function probeUnread(
  client: SlackClient, channelId: string, lastRead: string, selfUserId: string,
): Promise<UnreadProbe> {
  const page = await client.conversationsHistory(channelId, { limit: UNREAD_PROBE_LIMIT, oldest: lastRead });
  return { unread: unreadFor(page.messages, selfUserId), more: page.has_more };
}

/**
 * Whether a probe proves the conversation has unreads: `null` when the page
 * held only the caller's own messages and more history remains, which proves
 * neither.
 */
export function probeVerdict(probe: UnreadProbe): boolean | null {
  if (probe.unread.length > 0) return true;
  return probe.more ? null : false;
}

export interface FirstUnreadScan {
  /** The earliest `count` unread messages found, oldest first. */
  messages: SlackHistoryMessage[];
  /** Unread messages seen in total (a floor when `complete` is false). */
  unreadSeen: number;
  /** Every message after the cursor was scanned, so `messages` really are the first. */
  complete: boolean;
  /** The scan stopped on Slack's rate limit after at least one page (so `complete` is false). */
  rateLimited: boolean;
  /** Messages fetched after the cursor, own ones included. */
  scanned: number;
}

/**
 * Walk the history after `lastRead` and keep the earliest unreads.
 *
 * The minimum is taken over everything scanned rather than read off the first
 * or last page, so the answer does not depend on which end Slack starts from
 * when only `oldest` is given. A capped scan says so: past the cap, an earlier
 * unread may exist that was never fetched. A rate limit after the first page
 * keeps what was collected and reports the scan as partial — under Slack's
 * restricted history regime (15 messages, 1 call a minute) the second page is
 * where it hits. There is no resume cursor: the answer is a minimum over the
 * whole scan, so a resumed call could not combine with this one.
 */
export async function findFirstUnread(
  client: SlackClient, channelId: string, lastRead: string, selfUserId: string, count: number,
): Promise<FirstUnreadScan> {
  const seen: SlackHistoryMessage[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let rateLimited = false;
  do {
    let page;
    try {
      page = await client.conversationsHistory(channelId, { limit: FIRST_UNREAD_PAGE_SIZE, oldest: lastRead, cursor });
    } catch (err) {
      if (pages === 0 || !isRateLimited(err)) throw err;
      rateLimited = true;
      break;
    }
    seen.push(...page.messages);
    cursor = page.has_more ? page.response_metadata?.next_cursor || undefined : undefined;
    pages++;
  } while (cursor && pages < FIRST_UNREAD_MAX_PAGES);
  const unread = unreadFor(seen, selfUserId);
  return { messages: unread.slice(0, count), unreadSeen: unread.length, complete: !cursor && !rateLimited, rateLimited, scanned: seen.length };
}

/** A fresh (uncached) read cursor plus the metadata the access rules judge. */
export async function readCursor(client: SlackClient, channelId: string): Promise<{ meta: ChannelMeta; lastRead: string | null }> {
  const { channel } = await client.conversationsInfo(channelId);
  return { meta: channelMetaFromInfo(channel), lastRead: channel.last_read ?? null };
}

export interface MarkOutcome {
  /** The cursor Slack was asked to move to; `null` when no call was needed. */
  requested: string | null;
  before: string | null;
  after: string | null;
  /** `true` re-read and confirmed, `false` re-read and not moved, `null` could not re-read. */
  confirmed: boolean | null;
  /** The cursor already satisfied the request, so Slack was not called. */
  alreadyDone: boolean;
}

/**
 * The cursor after a mark Slack has already accepted. A failed re-read must
 * not throw: the write happened, so the caller is owed an unconfirmed outcome
 * rather than an error that reads as "nothing changed".
 */
async function rereadCursor(client: SlackClient, channelId: string): Promise<string | null> {
  try {
    return (await readCursor(client, channelId)).lastRead;
  } catch {
    return null;
  }
}

const markQueues = new Map<string, Promise<unknown>>();

/**
 * Run marks on the same key one at a time, so each decides from the cursor the
 * previous one left — otherwise a mark that read the cursor before another
 * moved it can drag it back and still confirm. Per process only: another
 * replica, or the user's own Slack app, can still move the cursor in between,
 * which the re-read then reports.
 */
export async function serializeMark<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = markQueues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  markQueues.set(key, run);
  try {
    return await run;
  } finally {
    if (markQueues.get(key) === run) markQueues.delete(key);
  }
}

/**
 * Mark everything up to and including `ts` read (default: the newest message).
 *
 * Never moves the cursor backwards: conversations.mark to an earlier ts would
 * quietly turn already-read messages unread, which is markUnreadFrom's job.
 */
export async function markRead(client: SlackClient, channelId: string, ts?: string): Promise<MarkOutcome> {
  assertWritesEnabled();
  let target = ts;
  if (target === undefined) {
    const newest = await client.conversationsHistory(channelId, { limit: 1 });
    target = newest.messages[0]?.ts;
    if (!target) throw new UserError(`${channelId} has no messages to mark read.`);
  }
  tsToMicros(target);
  const { lastRead: before } = await readCursor(client, channelId);
  if (before && compareTs(before, target) >= 0) {
    return { requested: null, before, after: before, confirmed: true, alreadyDone: true };
  }
  await client.conversationsMark(channelId, target);
  const after = await rereadCursor(client, channelId);
  return { requested: target, before, after, confirmed: after === null ? null : compareTs(after, target) >= 0, alreadyDone: false };
}

/**
 * Make `ts` and everything after it unread, by moving the cursor to one
 * microsecond before it — Slack's own "Mark unread" has the same reach.
 *
 * Never moves the cursor forwards: if `ts` is already unread, a cursor just
 * before it would mark the unread messages between the two read.
 */
export async function markUnreadFrom(client: SlackClient, channelId: string, ts: string): Promise<MarkOutcome> {
  assertWritesEnabled();
  const target = microsToTs(tsToMicros(ts) - 1n);
  const { lastRead: before } = await readCursor(client, channelId);
  if (before && compareTs(before, ts) < 0) {
    return { requested: null, before, after: before, confirmed: true, alreadyDone: true };
  }
  await client.conversationsMark(channelId, target);
  const after = await rereadCursor(client, channelId);
  return { requested: target, before, after, confirmed: after === null ? null : compareTs(after, ts) < 0, alreadyDone: false };
}

// === listUnreadConversations scan ===

/** Which conversations a scan covers; `types` are users.conversations kinds. */
export type ScanSource = { kind: 'member'; types: string } | { kind: 'ids'; ids: string[] };

/** Where a scan resumes: a users.conversations page cursor (or none) and an offset into that page or id list. */
interface ScanPosition { c?: string; o: number }

export function encodeScanCursor(pos: ScanPosition): string {
  return Buffer.from(JSON.stringify(pos)).toString('base64url');
}

export function decodeScanCursor(cursor: string | undefined): ScanPosition {
  if (!cursor) return { o: 0 };
  try {
    const pos = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Number.isInteger(pos?.o) && pos.o >= 0 && (pos.c === undefined || typeof pos.c === 'string')) return pos;
  } catch { /* fall through */ }
  throw new UserError('Invalid cursor. Pass the cursor exactly as a previous listUnreadConversations response gave it, with the same channelIds/types.');
}

export interface UnreadRow {
  meta: ChannelMeta;
  lastRead: string;
  unreadCount: number;
  /** More history lay past the probe, so `unreadCount` is a floor. */
  countIsFloor: boolean;
  /** Earliest unread in the probe. When `countIsFloor`, an earlier one may exist. */
  first?: SlackHistoryMessage;
}

export interface UnreadScan {
  rows: UnreadRow[];
  checked: number;
  read: number;
  unknown: Array<{ id: string; reason: string }>;
  hidden: number;
  /** Set when conversations remain unchecked; resumes exactly where this scan stopped. */
  nextCursor?: string;
  /** The scan stopped early on Slack's rate limit; `nextCursor` resumes at the conversation it hit. */
  rateLimited: boolean;
}

/**
 * Check up to `max` conversations for unreads: one conversations.info for the
 * cursor and the rule metadata, then — only if the rules allow the
 * conversation — one history probe. A denied conversation is never read and
 * only counted. `allow` must fail closed, except that it rethrows a rate
 * limit: that stops the scan with a cursor at this conversation instead of
 * counting it hidden and skipping it for good.
 */
export async function scanUnread(
  client: SlackClient,
  opts: {
    source: ScanSource;
    cursor?: string;
    max: number;
    selfUserId: string;
    allow: (meta: ChannelMeta) => Promise<boolean>;
  },
): Promise<UnreadScan> {
  const scan: UnreadScan = { rows: [], checked: 0, read: 0, unknown: [], hidden: 0, rateLimited: false };
  let pos = decodeScanCursor(opts.cursor);

  while (true) {
    let ids: string[];
    let nextPage: string | undefined;
    if (opts.source.kind === 'ids') {
      ids = opts.source.ids;
    } else {
      let page;
      try {
        page = await client.conversationsList(pos.c, opts.source.types);
      } catch (err) {
        if (!isRateLimited(err)) throw err;
        scan.rateLimited = true;
        scan.nextCursor = encodeScanCursor(pos);
        return scan;
      }
      ids = page.channels.map(ch => ch.id);
      nextPage = page.response_metadata?.next_cursor || undefined;
    }

    for (let i = pos.o; i < ids.length; i++) {
      if (scan.checked >= opts.max) {
        scan.nextCursor = encodeScanCursor({ c: pos.c, o: i });
        return scan;
      }
      try {
        await checkOne(client, ids[i], opts, scan);
      } catch (err) {
        if (!isRateLimited(err)) throw err;
        scan.rateLimited = true;
        scan.nextCursor = encodeScanCursor({ c: pos.c, o: i });
        return scan;
      }
      scan.checked++;
    }

    if (!nextPage) return scan;
    pos = { c: nextPage, o: 0 };
    if (scan.checked >= opts.max) {
      scan.nextCursor = encodeScanCursor(pos);
      return scan;
    }
  }
}

/** Classify one conversation into `scan`. Throws only on a rate limit, which stops the scan. */
async function checkOne(
  client: SlackClient,
  id: string,
  opts: { selfUserId: string; allow: (meta: ChannelMeta) => Promise<boolean> },
  scan: UnreadScan,
): Promise<void> {
  let meta: ChannelMeta;
  let lastRead: string | null;
  try {
    ({ meta, lastRead } = await readCursor(client, id));
  } catch (err) {
    if (isRateLimited(err)) throw err;
    // Not leaked as a name: conversations.info failed, so all we have is the
    // ID the caller (or users.conversations) supplied.
    scan.unknown.push({ id, reason: String((err as any)?.message ?? err) });
    return;
  }
  if (!(await opts.allow(meta))) {
    scan.hidden++;
    return;
  }
  if (!lastRead) {
    scan.unknown.push({ id, reason: 'Slack returned no read cursor (are you a member of this conversation?)' });
    return;
  }

  let probe: UnreadProbe;
  try {
    probe = await probeUnread(client, id, lastRead, opts.selfUserId);
  } catch (err) {
    if (isRateLimited(err)) throw err;
    scan.unknown.push({ id, reason: String((err as any)?.message ?? err) });
    return;
  }
  const verdict = probeVerdict(probe);
  if (verdict === false) {
    scan.read++;
  } else if (verdict === null) {
    scan.unknown.push({ id, reason: `the ${UNREAD_PROBE_LIMIT} messages after your read cursor are all your own and more follow` });
  } else {
    scan.rows.push({
      meta, lastRead,
      unreadCount: probe.unread.length,
      countIsFloor: probe.more,
      first: probe.unread[0],
    });
  }
}
