import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { handleSlackEventIngest, type SlackIngestionStore } from '../slack/eventHelpers.js';
import type { SlackChannelEvent, SlackEventSubscription } from '../slack/eventStore.js';

const SECRET = 'sl4ck-signing-secret';
const NOW_MS = 1_760_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

/** Produce the headers Slack would send for a body, at a given timestamp. */
function headersFor(body: string, opts: { secret?: string; timestampSec?: number; retryNum?: string } = {}) {
  const timestamp = String(opts.timestampSec ?? NOW_SEC);
  const signature = 'v0=' + crypto
    .createHmac('sha256', opts.secret ?? SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest('hex');
  return { signature, timestamp, retryNum: opts.retryNum };
}

function subscription(overrides: Partial<SlackEventSubscription> = {}): SlackEventSubscription {
  return {
    id: 1,
    userId: 100,
    teamId: 'T1',
    channelId: 'C1',
    events: ['message', 'reaction_added'],
    matchPattern: null,
    status: 'active',
    failCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function messageEnvelope(overrides: Record<string, any> = {}, eventOverrides: Record<string, any> = {}) {
  return JSON.stringify({
    type: 'event_callback',
    team_id: 'T1',
    event_id: 'Ev123',
    event_time: NOW_SEC,
    event: {
      type: 'message',
      channel: 'C1',
      channel_type: 'channel',
      user: 'U1',
      text: 'https://www.linkedin.com/posts/abc',
      ts: '1760000000.000100',
      ...eventOverrides,
    },
    ...overrides,
  });
}

/** In-memory store double tracking inserts, dedup and fail-count bumps. */
class FakeStore implements SlackIngestionStore {
  subs: SlackEventSubscription[] = [];
  inserted: SlackChannelEvent[][] = [];
  failBumps: number[] = [];
  insertThrows = false;
  /** Keys already stored, so a retry can be deduplicated like Postgres would. */
  private seen = new Set<string>();

  async findSubscriptionsForChannel(teamId: string, channelId: string) {
    return this.subs.filter(s => s.teamId === teamId && s.channelId === channelId && s.status === 'active');
  }
  async insertChannelEvents(events: SlackChannelEvent[]) {
    if (this.insertThrows) throw new Error('insert boom');
    this.inserted.push(events);
    let written = 0;
    for (const e of events) {
      const key = `${e.subscriptionId}:${e.eventId}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      written++;
    }
    return written;
  }
  async incrementFailCount(subscriptionId: number) {
    this.failBumps.push(subscriptionId);
  }
}

describe('handleSlackEventIngest — signature and handshake', () => {
  it('rejects malformed JSON with 400 before any lookup', async () => {
    const store = new FakeStore();
    const body = '{not-json';
    const result = await handleSlackEventIngest(body, headersFor(body), store, SECRET, NOW_MS);
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { error: 'Invalid JSON body' });
    assert.equal(result.logContext.branch, 'bad-json');
    assert.equal(store.inserted.length, 0);
  });

  it('rejects a bad signature with 401', async () => {
    const store = new FakeStore();
    store.subs.push(subscription());
    const body = messageEnvelope();
    const result = await handleSlackEventIngest(
      body, headersFor(body, { secret: 'wrong-secret' }), store, SECRET, NOW_MS,
    );
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { error: 'Invalid signature' });
    assert.equal(result.logContext.branch, 'bad-signature');
    assert.equal(store.inserted.length, 0);
  });

  it('rejects a replay outside the five-minute window as stale, not as a mismatch', async () => {
    const store = new FakeStore();
    const body = messageEnvelope();
    const staleSec = NOW_SEC - 6 * 60;
    const result = await handleSlackEventIngest(
      body, headersFor(body, { timestampSec: staleSec }), store, SECRET, NOW_MS,
    );
    assert.equal(result.status, 401);
    assert.equal(result.logContext.branch, 'stale-timestamp');
    assert.match((result.body as any).error, /timestamp/i);
  });

  it('accepts a timestamp just inside the window', async () => {
    const store = new FakeStore();
    store.subs.push(subscription());
    const body = messageEnvelope();
    const result = await handleSlackEventIngest(
      body, headersFor(body, { timestampSec: NOW_SEC - 4 * 60 }), store, SECRET, NOW_MS,
    );
    assert.equal(result.status, 200);
    assert.equal(result.logContext.branch, 'ok');
  });

  it('rejects everything with 401 when no signing secret is configured', async () => {
    const store = new FakeStore();
    store.subs.push(subscription());
    const body = messageEnvelope();
    const result = await handleSlackEventIngest(body, headersFor(body), store, undefined, NOW_MS);
    assert.equal(result.status, 401);
    assert.equal(result.logContext.branch, 'no-secret');
    assert.match((result.body as any).error, /SLACK_SIGNING_SECRET/);
    assert.equal(store.inserted.length, 0);
  });

  it('rejects a request with no signature headers at all', async () => {
    const store = new FakeStore();
    const body = messageEnvelope();
    const result = await handleSlackEventIngest(body, {}, store, SECRET, NOW_MS);
    assert.equal(result.status, 401);
    assert.equal(result.logContext.branch, 'bad-signature');
    assert.equal(result.logContext.sigPresent, false);
  });

  it('echoes the url_verification challenge', async () => {
    const store = new FakeStore();
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123challenge' });
    const result = await handleSlackEventIngest(body, headersFor(body), store, SECRET, NOW_MS);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { challenge: 'abc123challenge' });
    assert.equal(result.logContext.branch, 'url-verification');
  });

  it('does not echo an unsigned challenge', async () => {
    const store = new FakeStore();
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123challenge' });
    const result = await handleSlackEventIngest(
      body, headersFor(body, { secret: 'attacker' }), store, SECRET, NOW_MS,
    );
    assert.equal(result.status, 401);
    assert.ok(!('challenge' in result.body));
  });

  it('ignores an envelope type it does not handle', async () => {
    const store = new FakeStore();
    const body = JSON.stringify({ type: 'something_new' });
    const result = await handleSlackEventIngest(body, headersFor(body), store, SECRET, NOW_MS);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true });
    assert.equal(result.logContext.branch, 'unsupported-envelope');
  });
});

describe('handleSlackEventIngest — storage and fan-out', () => {
  it('stores a message event for the subscribed channel', async () => {
    const store = new FakeStore();
    store.subs.push(subscription());
    const body = messageEnvelope();
    const result = await handleSlackEventIngest(body, headersFor(body), store, SECRET, NOW_MS);

    assert.equal(result.status, 200);
    assert.equal(result.logContext.branch, 'ok');
    assert.equal(result.insertedEventCount, 1);
    assert.equal(store.inserted.length, 1);

    const row = store.inserted[0][0];
    assert.equal(row.subscriptionId, 1);
    assert.equal(row.teamId, 'T1');
    assert.equal(row.channelId, 'C1');
    assert.equal(row.eventId, 'Ev123');
    assert.equal(row.eventType, 'message');
    assert.equal(row.actorId, 'U1');
    assert.equal(row.messageTs, '1760000000.000100');
    assert.equal(row.occurredAt, 1760000000000);
    assert.match(row.text!, /linkedin/);
  });

  it('fans one delivery out to every subscriber of the channel', async () => {
    const store = new FakeStore();
    store.subs.push(subscription({ id: 1, userId: 100 }));
    store.subs.push(subscription({ id: 2, userId: 200 }));
    const body = messageEnvelope();
    const result = await handleSlackEventIngest(body, headersFor(body), store, SECRET, NOW_MS);

    assert.equal(result.logContext.matchedSubscriptions, 2);
    assert.equal(result.insertedEventCount, 2);
    assert.deepEqual(store.inserted[0].map(r => r.subscriptionId), [1, 2]);
  });

  it('deduplicates a retried delivery by event_id', async () => {
    const store = new FakeStore();
    store.subs.push(subscription());
    const body = messageEnvelope();

    const first = await handleSlackEventIngest(body, headersFor(body), store, SECRET, NOW_MS);
    assert.equal(first.insertedEventCount, 1);

    const retry = await handleSlackEventIngest(
      body, headersFor(body, { retryNum: '1' }), store, SECRET, NOW_MS,
    );
    assert.equal(retry.status, 200);
    assert.equal(retry.insertedEventCount, 0, 'a retried event must not be stored twice');
    assert.equal(retry.logContext.isRetry, true);
  });

  it('returns 200 when nobody is subscribed to the channel', async () => {
    const store = new FakeStore();
    store.subs.push(subscription({ channelId: 'C_OTHER' }));
    const body = messageEnvelope();
    const result = await handleSlackEventIngest(body, headersFor(body), store, SECRET, NOW_MS);

    // 200, not 404: one Request URL serves the whole workspace, so a non-2xx
    // here risks Slack disabling delivery for every subscriber.
    assert.equal(result.status, 200);
    assert.equal(result.logContext.branch, 'no-subscription');
    assert.equal(store.inserted.length, 0);
    assert.equal(store.failBumps.length, 0);
  });

  it('scopes lookups by team as well as channel', async () => {
    const store = new FakeStore();
    store.subs.push(subscription({ teamId: 'T_OTHER' }));
    const body = messageEnvelope();
    const result = await handleSlackEventIngest(body, headersFor(body), store, SECRET, NOW_MS);
    assert.equal(result.logContext.branch, 'no-subscription');
  });

  it('skips a subscription that is not active', async () => {
    const store = new FakeStore();
    store.subs.push(subscription({ status: 'paused' }));
    const body = messageEnvelope();
    const result = await handleSlackEventIngest(body, headersFor(body), store, SECRET, NOW_MS);
    assert.equal(result.logContext.branch, 'no-subscription');
  });

  it('honours a subscription event-type filter', async () => {
    const store = new FakeStore();
    store.subs.push(subscription({ events: ['reaction_added'] }));
    const body = messageEnvelope();
    const result = await handleSlackEventIngest(body, headersFor(body), store, SECRET, NOW_MS);
    assert.equal(result.logContext.branch, 'no-match');
    assert.equal(store.inserted.length, 0);
  });

  it('honours matchPattern case-insensitively, per subscriber', async () => {
    const store = new FakeStore();
    store.subs.push(subscription({ id: 1, matchPattern: 'LINKEDIN' }));
    store.subs.push(subscription({ id: 2, matchPattern: 'grafana' }));
    const body = messageEnvelope();
    const result = await handleSlackEventIngest(body, headersFor(body), store, SECRET, NOW_MS);

    assert.equal(result.logContext.matchedSubscriptions, 1);
    assert.deepEqual(store.inserted[0].map(r => r.subscriptionId), [1]);
  });

  it('stores a reaction_added event, reading channel and ts from event.item', async () => {
    const store = new FakeStore();
    store.subs.push(subscription());
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'EvReact',
      event_time: NOW_SEC,
      event: {
        type: 'reaction_added',
        user: 'U9',
        reaction: 'thumbsup',
        item: { type: 'message', channel: 'C1', ts: '1759999999.000200' },
        event_ts: '1760000000.000300',
      },
    });
    const result = await handleSlackEventIngest(body, headersFor(body), store, SECRET, NOW_MS);

    assert.equal(result.status, 200, 'a reaction must not be dropped for lack of event.channel');
    const row = store.inserted[0][0];
    assert.equal(row.channelId, 'C1');
    assert.equal(row.eventType, 'reaction_added');
    assert.equal(row.messageTs, '1759999999.000200');
    assert.equal(row.text, ':thumbsup:');
    assert.equal(row.occurredAt, 1760000000000);
  });

  it('records a thread reply with its thread_ts', async () => {
    const store = new FakeStore();
    store.subs.push(subscription());
    const body = messageEnvelope({}, { thread_ts: '1759999000.000100', ts: '1760000000.000100' });
    await handleSlackEventIngest(body, headersFor(body), store, SECRET, NOW_MS);
    assert.equal(store.inserted[0][0].threadTs, '1759999000.000100');
  });

  it('ignores join/leave churn rather than storing it as a message', async () => {
    const store = new FakeStore();
    store.subs.push(subscription());
    const body = messageEnvelope({}, { subtype: 'channel_join', text: 'U1 has joined the channel' });
    const result = await handleSlackEventIngest(body, headersFor(body), store, SECRET, NOW_MS);

    assert.equal(result.status, 200);
    assert.equal(result.logContext.branch, 'unparseable-event');
    assert.equal(store.inserted.length, 0);
  });

  it('ignores an event with no event_id, since retries could not be deduplicated', async () => {
    const store = new FakeStore();
    store.subs.push(subscription());
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event: { type: 'message', channel: 'C1', user: 'U1', text: 'hi', ts: '1760000000.000100' },
    });
    const result = await handleSlackEventIngest(body, headersFor(body), store, SECRET, NOW_MS);
    assert.equal(result.status, 200);
    assert.equal(result.logContext.branch, 'unparseable-event');
    assert.equal(store.inserted.length, 0);
  });

  it('returns 200 and bumps fail_count for every affected subscriber when the insert throws', async () => {
    const store = new FakeStore();
    store.subs.push(subscription({ id: 1 }));
    store.subs.push(subscription({ id: 2 }));
    store.insertThrows = true;
    const body = messageEnvelope();
    const result = await handleSlackEventIngest(body, headersFor(body), store, SECRET, NOW_MS);

    // 200 on a DB blip so Slack doesn't disable the Request URL for everyone.
    assert.equal(result.status, 200);
    assert.equal(result.logContext.branch, 'insert-failed');
    assert.equal(result.logContext.failCountBumped, true);
    assert.equal(result.insertedEventCount, 0);
    assert.deepEqual(store.failBumps, [1, 2]);
  });

  it('never puts message text in the log context', async () => {
    const store = new FakeStore();
    store.subs.push(subscription());
    const body = messageEnvelope({}, { text: 'salary is 100k, do not log me' });
    const result = await handleSlackEventIngest(body, headersFor(body), store, SECRET, NOW_MS);

    const serialized = JSON.stringify(result.logContext);
    assert.ok(!serialized.includes('salary'), 'log context must not carry message text');
    assert.ok(!serialized.includes('do not log me'));
    // ...but it must still carry enough to diagnose the delivery.
    assert.equal(result.logContext.eventId, 'Ev123');
    assert.equal(result.logContext.channelId, 'C1');
    assert.equal(result.logContext.eventType, 'message');
  });
});
