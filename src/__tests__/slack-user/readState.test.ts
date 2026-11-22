import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { SlackClient } from '../../slack/apiHelpers.js';
import {
  tsToMicros, microsToTs, compareTs, probeVerdict, findFirstUnread, markRead, markUnreadFrom,
  scanUnread, encodeScanCursor, decodeScanCursor, serializeMark, NEVER_READ, UNREAD_PROBE_LIMIT, FIRST_UNREAD_MAX_PAGES,
} from '../../slack-user/readState.js';
import { renderMarkOutcome } from '../../slack-user/server.js';

// A stateful fake of the Slack methods the read-state code calls. History is
// served newest first, as conversations.history does without `oldest`; the
// scans must not depend on that order (see findFirstUnread).

interface FakeChannel {
  name: string;
  is_im?: boolean;
  lastRead?: string;
  messages: Array<{ ts: string; user: string; text: string }>;
}

const SELF = 'UME';

let channels: Record<string, FakeChannel>;
let calls: Array<{ method: string; body: Record<string, string> }>;
/** When set, conversations.mark answers ok without moving the cursor. */
let markIsNoop: boolean;
/** Methods that answer 429 twice (SlackClient retries once). */
let rateLimited: Set<string>;
let originalFetch: typeof globalThis.fetch;

function respond(data: unknown, status = 200) {
  return { ok: status < 400, status, headers: { get: () => '0' }, json: async () => data, text: async () => JSON.stringify(data) };
}

function fakeSlack(method: string, b: Record<string, string>): unknown {
  const ch = channels[b.channel];
  switch (method) {
    case 'auth.test':
      return { ok: true, user_id: SELF, team_id: 'T1', url: 'https://acme.slack.com/' };
    case 'users.conversations': {
      const ids = Object.keys(channels);
      const start = b.cursor ? Number(b.cursor) : 0;
      const pageSize = 3;
      const next = start + pageSize < ids.length ? String(start + pageSize) : '';
      return {
        ok: true,
        channels: ids.slice(start, start + pageSize).map(id => ({ id, name: channels[id].name, is_private: false })),
        response_metadata: { next_cursor: next },
      };
    }
    case 'conversations.info':
      if (!ch) return { ok: false, error: 'channel_not_found' };
      return {
        ok: true,
        channel: {
          id: b.channel, name: ch.name, is_private: false, is_shared: false, is_ext_shared: false,
          is_org_shared: false, is_im: !!ch.is_im, is_mpim: false, ...(ch.lastRead ? { last_read: ch.lastRead } : {}),
        },
      };
    case 'conversations.history': {
      const after = ch.messages
        .filter(m => !b.oldest || compareTs(m.ts, b.oldest) > 0)
        .sort((x, y) => compareTs(y.ts, x.ts));
      const start = b.cursor ? Number(b.cursor) : 0;
      const limit = Number(b.limit);
      const page = after.slice(start, start + limit);
      const more = start + limit < after.length;
      return { ok: true, messages: page, has_more: more, response_metadata: { next_cursor: more ? String(start + limit) : '' } };
    }
    case 'conversations.mark':
      if (!markIsNoop) ch.lastRead = b.ts;
      return { ok: true };
    case 'users.info':
      return { ok: true, user: { id: b.user, name: b.user, profile: {} } };
    default:
      throw new Error(`unexpected Slack call ${method}`);
  }
}

beforeEach(() => {
  channels = {};
  calls = [];
  markIsNoop = false;
  rateLimited = new Set();
  originalFetch = globalThis.fetch;
  process.env.SLACK_WRITES_ENABLED = 'true';
  globalThis.fetch = (async (url: string, init: any) => {
    const method = String(url).split('/api/')[1];
    const body = Object.fromEntries(new URLSearchParams(init.body ?? ''));
    calls.push({ method, body });
    if (rateLimited.has(method)) return respond({}, 429);
    return respond(fakeSlack(method, body));
  }) as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.SLACK_WRITES_ENABLED;
});

const client = () => new SlackClient('xoxp-test');
const msgs = (...spec: Array<[string, string]>) => spec.map(([ts, user]) => ({ ts, user, text: `m${ts}` }));
const callsTo = (method: string) => calls.filter(c => c.method === method);

describe('Slack timestamps', () => {
  it('compare exactly, including fractions of unequal length', () => {
    assert.equal(compareTs('1700000000.1', '1700000000.099999'), 1);
    assert.equal(compareTs('1700000000.000100', '1700000000.0001'), 0);
    assert.equal(compareTs(NEVER_READ, '1.000001'), -1);
  });

  it('step back one microsecond across a second boundary', () => {
    assert.equal(microsToTs(tsToMicros('1700000001.000000') - 1n), '1700000000.999999');
  });

  it('refuse anything that is not a ts', () => {
    assert.throws(() => tsToMicros('p1700000000123456'), /not a Slack message timestamp/);
    assert.throws(() => tsToMicros('1700000000.1234567'), /not a Slack message timestamp/);
  });
});

describe('probeVerdict', () => {
  const m = { type: 'message', ts: '1.0', text: '' };
  it('is three-valued: own-only page with more history proves nothing', () => {
    assert.equal(probeVerdict({ unread: [m], more: false }), true);
    assert.equal(probeVerdict({ unread: [], more: false }), false);
    assert.equal(probeVerdict({ unread: [], more: true }), null);
  });
});

describe('findFirstUnread', () => {
  it('returns the earliest unread from others, oldest first, whatever order Slack pages in', async () => {
    channels.C1 = { name: 'general', lastRead: '100.000000', messages: msgs(['99.0', 'UA'], ['101.0', SELF], ['102.0', 'UA'], ['103.0', 'UB']) };
    const scan = await findFirstUnread(client(), 'C1', '100.000000', SELF, 2);
    assert.deepEqual(scan.messages.map(m => m.ts), ['102.0', '103.0']);
    assert.equal(scan.unreadSeen, 2);
    assert.equal(scan.complete, true);
  });

  it('reports a capped scan as incomplete instead of claiming the first', async () => {
    const many = Array.from({ length: FIRST_UNREAD_MAX_PAGES * 200 + 5 }, (_, i) => [`${1000 + i}.0`, 'UA'] as [string, string]);
    channels.C1 = { name: 'busy', lastRead: NEVER_READ, messages: msgs(...many) };
    const scan = await findFirstUnread(client(), 'C1', NEVER_READ, SELF, 1);
    assert.equal(scan.complete, false);
    assert.equal(callsTo('conversations.history').length, FIRST_UNREAD_MAX_PAGES);
  });

  it('keeps what it collected when a later page is rate-limited, and says the scan was partial', async () => {
    const many = Array.from({ length: 205 }, (_, i) => [`${1000 + i}.0`, 'UA'] as [string, string]);
    channels.C1 = { name: 'busy', lastRead: NEVER_READ, messages: msgs(...many) };
    const realFetch = globalThis.fetch;
    let historyCalls = 0;
    globalThis.fetch = (async (url: string, init: any) => {
      if (String(url).endsWith('conversations.history') && ++historyCalls > 1) return respond({}, 429);
      return realFetch(url, init);
    }) as any;
    const scan = await findFirstUnread(client(), 'C1', NEVER_READ, SELF, 1);
    assert.equal(scan.rateLimited, true);
    assert.equal(scan.complete, false);
    assert.equal(scan.scanned, 200);
    assert.equal(scan.messages.length, 1);
  });

  it('still fails when the very first page is rate-limited, since nothing was scanned', async () => {
    channels.C1 = { name: 'general', lastRead: NEVER_READ, messages: msgs(['101.0', 'UA']) };
    rateLimited.add('conversations.history');
    await assert.rejects(() => findFirstUnread(client(), 'C1', NEVER_READ, SELF, 1), /rate limit/);
  });
});

describe('markRead', () => {
  it('marks up to the newest message by default and confirms by re-reading', async () => {
    channels.C1 = { name: 'general', lastRead: '100.000000', messages: msgs(['101.0', 'UA'], ['105.0', 'UA']) };
    const out = await markRead(client(), 'C1');
    assert.equal(out.requested, '105.0');
    assert.equal(out.confirmed, true);
    assert.deepEqual(callsTo('conversations.mark')[0].body, { channel: 'C1', ts: '105.0' });
  });

  it('never moves the cursor backwards', async () => {
    channels.C1 = { name: 'general', lastRead: '200.000000', messages: msgs(['101.0', 'UA']) };
    const out = await markRead(client(), 'C1', '101.0');
    assert.equal(out.alreadyDone, true);
    assert.equal(callsTo('conversations.mark').length, 0);
    assert.equal(channels.C1.lastRead, '200.000000');
  });

  it('reports a mark Slack ignored as not confirmed, not as success', async () => {
    markIsNoop = true;
    channels.C1 = { name: 'general', lastRead: '100.000000', messages: msgs(['105.0', 'UA']) };
    const out = await markRead(client(), 'C1');
    assert.equal(out.confirmed, false);
  });

  it('reports confirmation as unknown when the cursor cannot be re-read', async () => {
    channels.C1 = { name: 'general', messages: msgs(['105.0', 'UA']) };
    markIsNoop = true;
    const out = await markRead(client(), 'C1');
    assert.equal(out.confirmed, null);
  });

  it('reports a failed re-read after an accepted mark as unconfirmed instead of throwing', async () => {
    channels.C1 = { name: 'general', lastRead: '100.000000', messages: msgs(['105.0', 'UA']) };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: any) => {
      if (String(url).endsWith('conversations.info') && callsTo('conversations.mark').length > 0) {
        return respond({ ok: false, error: 'internal_error' });
      }
      return realFetch(url, init);
    }) as any;
    const out = await markRead(client(), 'C1');
    assert.equal(channels.C1.lastRead, '105.0', 'the mark itself went through');
    assert.equal(out.after, null);
    assert.equal(out.confirmed, null);
  });

  it('runs concurrent marks on one conversation in turn, so none drags the cursor back', async () => {
    channels.C1 = { name: 'general', lastRead: '100.000000', messages: msgs(['200.0', 'UA'], ['300.0', 'UA']) };
    const key = 'xoxp-test:C1';
    const [later, earlier] = await Promise.all([
      serializeMark(key, () => markRead(client(), 'C1', '300.0')),
      serializeMark(key, () => markRead(client(), 'C1', '200.0')),
    ]);
    assert.equal(later.confirmed, true);
    assert.equal(earlier.alreadyDone, true, 'the second mark saw the cursor the first one left');
    assert.equal(channels.C1.lastRead, '300.0');
  });

  it('keeps serializing after a mark on the same key fails', async () => {
    const order: string[] = [];
    const failing = serializeMark('k', async () => { order.push('a'); throw new Error('boom'); });
    const next = serializeMark('k', async () => { order.push('b'); return 'ok'; });
    await assert.rejects(failing, /boom/);
    assert.equal(await next, 'ok');
    assert.deepEqual(order, ['a', 'b']);
  });

  it('refuses when Slack writes are disabled, before calling Slack', async () => {
    delete process.env.SLACK_WRITES_ENABLED;
    channels.C1 = { name: 'general', lastRead: '100.000000', messages: msgs(['105.0', 'UA']) };
    await assert.rejects(() => markRead(client(), 'C1'), /disabled/);
    assert.equal(calls.length, 0);
  });
});

describe('markUnreadFrom', () => {
  it('moves the cursor to just before the message', async () => {
    channels.C1 = { name: 'general', lastRead: '300.000000', messages: msgs(['200.0', 'UA']) };
    const out = await markUnreadFrom(client(), 'C1', '200.000000');
    assert.equal(out.requested, '0000000199.999999');
    assert.equal(out.confirmed, true);
  });

  it('does not mark later messages read when the target is already unread', async () => {
    channels.C1 = { name: 'general', lastRead: '100.000000', messages: msgs(['200.0', 'UA']) };
    const out = await markUnreadFrom(client(), 'C1', '200.0');
    assert.equal(out.alreadyDone, true);
    assert.equal(callsTo('conversations.mark').length, 0);
  });
});

describe('scanUnread', () => {
  const allowAll = async () => true;

  it('classifies unread, read and own-only conversations and counts a capped probe as a floor', async () => {
    channels.C1 = { name: 'unread', lastRead: '100.0', messages: msgs(['101.0', 'UA']) };
    channels.C2 = { name: 'read', lastRead: '200.0', messages: msgs(['150.0', 'UA']) };
    const lots = Array.from({ length: UNREAD_PROBE_LIMIT + 2 }, (_, i) => [`${300 + i}.0`, 'UA'] as [string, string]);
    channels.C3 = { name: 'busy', lastRead: '1.0', messages: msgs(...lots) };
    const scan = await scanUnread(client(), { source: { kind: 'member', types: 'public_channel' }, max: 10, selfUserId: SELF, allow: allowAll });
    assert.deepEqual(scan.rows.map(r => [r.meta.id, r.unreadCount, r.countIsFloor]), [['C1', 1, false], ['C3', UNREAD_PROBE_LIMIT, true]]);
    assert.equal(scan.read, 1);
    assert.equal(scan.nextCursor, undefined);
  });

  it('never reads history of a conversation the rules deny, and only counts it', async () => {
    channels.C1 = { name: 'secret', lastRead: '100.0', messages: msgs(['101.0', 'UA']) };
    const scan = await scanUnread(client(), { source: { kind: 'ids', ids: ['C1'] }, max: 10, selfUserId: SELF, allow: async () => false });
    assert.equal(scan.hidden, 1);
    assert.equal(scan.rows.length, 0);
    assert.equal(callsTo('conversations.history').length, 0);
  });

  it('pages across users.conversations and resumes exactly where the cap stopped it', async () => {
    for (let i = 1; i <= 5; i++) channels[`C${i}`] = { name: `c${i}`, lastRead: '100.0', messages: msgs(['101.0', 'UA']) };
    const opts = { source: { kind: 'member', types: 'public_channel' } as const, max: 4, selfUserId: SELF, allow: allowAll };
    const first = await scanUnread(client(), opts);
    assert.deepEqual(first.rows.map(r => r.meta.id), ['C1', 'C2', 'C3', 'C4']);
    assert.ok(first.nextCursor);
    const second = await scanUnread(client(), { ...opts, cursor: first.nextCursor });
    assert.deepEqual(second.rows.map(r => r.meta.id), ['C5']);
    assert.equal(second.nextCursor, undefined);
  });

  it('does not fetch a page only to stop on it', async () => {
    for (let i = 1; i <= 4; i++) channels[`C${i}`] = { name: `c${i}`, lastRead: '100.0', messages: [] };
    const scan = await scanUnread(client(), { source: { kind: 'member', types: 'public_channel' }, max: 3, selfUserId: SELF, allow: allowAll });
    assert.equal(callsTo('users.conversations').length, 1);
    assert.deepEqual(decodeScanCursor(scan.nextCursor), { c: '3', o: 0 });
  });

  it('stops on a rate limit and hands back a cursor at the conversation it hit', async () => {
    channels.C1 = { name: 'c1', lastRead: '100.0', messages: msgs(['101.0', 'UA']) };
    channels.C2 = { name: 'c2', lastRead: '100.0', messages: msgs(['101.0', 'UA']) };
    let infoCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: any) => {
      if (String(url).endsWith('conversations.info') && ++infoCalls > 1) return respond({}, 429);
      return realFetch(url, init);
    }) as any;
    const scan = await scanUnread(client(), { source: { kind: 'ids', ids: ['C1', 'C2'] }, max: 10, selfUserId: SELF, allow: allowAll });
    assert.equal(scan.rateLimited, true);
    assert.equal(scan.checked, 1);
    assert.deepEqual(decodeScanCursor(scan.nextCursor), { o: 1 });
  });

  it('stops, rather than hiding the conversation, when the rules check is rate-limited', async () => {
    channels.C1 = { name: 'c1', lastRead: '100.0', messages: msgs(['101.0', 'UA']) };
    channels.C2 = { name: 'c2', lastRead: '100.0', messages: msgs(['101.0', 'UA']) };
    const allow = async (meta: { id: string }) => {
      if (meta.id === 'C2') throw new Error('Slack rate limit exceeded. Try again in a moment.');
      return true;
    };
    const scan = await scanUnread(client(), { source: { kind: 'ids', ids: ['C1', 'C2'] }, max: 10, selfUserId: SELF, allow });
    assert.equal(scan.hidden, 0);
    assert.equal(scan.rateLimited, true);
    assert.deepEqual(decodeScanCursor(scan.nextCursor), { o: 1 });
  });

  it('reports a conversation without a read cursor as unknown, not as read', async () => {
    channels.C1 = { name: 'notmember', messages: msgs(['101.0', 'UA']) };
    const scan = await scanUnread(client(), { source: { kind: 'ids', ids: ['C1'] }, max: 10, selfUserId: SELF, allow: allowAll });
    assert.equal(scan.read, 0);
    assert.equal(scan.unknown.length, 1);
  });

  it('rejects a cursor it did not issue', () => {
    assert.throws(() => decodeScanCursor('not-a-cursor'), /Invalid cursor/);
    assert.throws(() => decodeScanCursor(encodeScanCursor({ o: -1 })), /Invalid cursor/);
  });
});

describe('renderMarkOutcome', () => {
  // Marks are channel-level; a bare "Done" would read as covering threads too.
  const base = { requested: '2.0', before: '1.0', after: '2.0', alreadyDone: false };
  for (const [label, outcome] of [
    ['done', { ...base, confirmed: true }],
    ['not done', { ...base, confirmed: false }],
    ['unconfirmed', { ...base, after: null, confirmed: null }],
    ['already done', { ...base, requested: null, confirmed: true, alreadyDone: true }],
  ] as const) {
    it(`says threads are not covered when ${label}`, () => {
      assert.match(renderMarkOutcome('C1', outcome, 'read'), /Thread replies are not covered/);
    });
  }

  it('tells the caller an ignored mark is NOT done and an unreadable one is unconfirmed', () => {
    assert.match(renderMarkOutcome('C1', { ...base, confirmed: false }, 'read'), /NOT done/);
    assert.match(renderMarkOutcome('C1', { ...base, after: null, confirmed: null }, 'read'), /unconfirmed/);
  });
});
