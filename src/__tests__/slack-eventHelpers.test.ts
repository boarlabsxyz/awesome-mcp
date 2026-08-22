import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import {
  CAPTURED_SLACK_EVENTS,
  matchesSubscription,
  parseSlackEventPayload,
  parseTimestampInput,
  verifySlackSignature,
} from '../slack/eventHelpers.js';
import type { SlackEventSubscription } from '../slack/eventStore.js';

const SECRET = 'sl4ck-signing-secret';
const NOW_MS = 1_760_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

function signature(body: string, timestampSec: number = NOW_SEC, secret: string = SECRET): string {
  return 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${timestampSec}:${body}`).digest('hex');
}

describe('CAPTURED_SLACK_EVENTS', () => {
  it('captures messages and reactions, and deliberately omits app_mention', () => {
    assert.deepEqual([...CAPTURED_SLACK_EVENTS], ['message', 'reaction_added']);
    // app_mentions:read is a bot-token scope; this feature is user-OAuth only.
    assert.ok(!CAPTURED_SLACK_EVENTS.includes('app_mention' as any));
  });
});

describe('verifySlackSignature', () => {
  const body = '{"type":"event_callback"}';

  it('accepts a correctly signed request', () => {
    assert.deepEqual(
      verifySlackSignature(SECRET, body, signature(body), String(NOW_SEC), NOW_MS),
      { ok: true },
    );
  });

  it('signs over the v0 basestring, not the bare body', () => {
    // A bare-body HMAC (the ClickUp scheme) must not validate here.
    const bareBody = 'v0=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    assert.deepEqual(
      verifySlackSignature(SECRET, body, bareBody, String(NOW_SEC), NOW_MS),
      { ok: false, reason: 'mismatch' },
    );
  });

  it('reports a missing secret distinctly from a mismatch', () => {
    assert.deepEqual(
      verifySlackSignature(undefined, body, signature(body), String(NOW_SEC), NOW_MS),
      { ok: false, reason: 'no-secret' },
    );
    assert.deepEqual(
      verifySlackSignature('', body, signature(body), String(NOW_SEC), NOW_MS),
      { ok: false, reason: 'no-secret' },
    );
  });

  it('reports missing headers distinctly', () => {
    assert.deepEqual(
      verifySlackSignature(SECRET, body, undefined, String(NOW_SEC), NOW_MS),
      { ok: false, reason: 'missing-headers' },
    );
    assert.deepEqual(
      verifySlackSignature(SECRET, body, signature(body), undefined, NOW_MS),
      { ok: false, reason: 'missing-headers' },
    );
    assert.deepEqual(
      verifySlackSignature(SECRET, body, signature(body), 'not-a-number', NOW_MS),
      { ok: false, reason: 'missing-headers' },
    );
  });

  it('enforces the five-minute replay window in both directions', () => {
    const past = NOW_SEC - 6 * 60;
    assert.deepEqual(
      verifySlackSignature(SECRET, body, signature(body, past), String(past), NOW_MS),
      { ok: false, reason: 'stale-timestamp' },
    );
    const future = NOW_SEC + 6 * 60;
    assert.deepEqual(
      verifySlackSignature(SECRET, body, signature(body, future), String(future), NOW_MS),
      { ok: false, reason: 'stale-timestamp' },
    );
  });

  it('accepts the edges of the window', () => {
    for (const offset of [-5 * 60, 5 * 60]) {
      const ts = NOW_SEC + offset;
      assert.deepEqual(
        verifySlackSignature(SECRET, body, signature(body, ts), String(ts), NOW_MS),
        { ok: true },
        `offset ${offset} should be inside the window`,
      );
    }
  });

  it('rejects a wrong secret', () => {
    assert.deepEqual(
      verifySlackSignature(SECRET, body, signature(body, NOW_SEC, 'other'), String(NOW_SEC), NOW_MS),
      { ok: false, reason: 'mismatch' },
    );
  });

  it('rejects a signature of the wrong length without throwing', () => {
    assert.deepEqual(
      verifySlackSignature(SECRET, body, 'v0=short', String(NOW_SEC), NOW_MS),
      { ok: false, reason: 'mismatch' },
    );
  });

  it('accepts a Buffer body identically to a string', () => {
    assert.deepEqual(
      verifySlackSignature(SECRET, Buffer.from(body, 'utf8'), signature(body), String(NOW_SEC), NOW_MS),
      { ok: true },
    );
  });
});

describe('parseSlackEventPayload', () => {
  const base = {
    type: 'event_callback',
    team_id: 'T1',
    event_id: 'Ev1',
    event_time: NOW_SEC,
  };

  it('normalises a channel message', () => {
    const result = parseSlackEventPayload({
      ...base,
      event: { type: 'message', channel: 'C1', user: 'U1', text: 'hello', ts: '1760000000.000100' },
    });
    assert.ok(result.ok);
    assert.equal(result.event.eventType, 'message');
    assert.equal(result.event.teamId, 'T1');
    assert.equal(result.event.channelId, 'C1');
    assert.equal(result.event.actorId, 'U1');
    assert.equal(result.event.text, 'hello');
    assert.equal(result.event.messageTs, '1760000000.000100');
    assert.equal(result.event.threadTs, null);
    assert.equal(result.event.occurredAt, 1760000000000);
  });

  it('reads channel and message ts from event.item for a reaction', () => {
    const result = parseSlackEventPayload({
      ...base,
      event: {
        type: 'reaction_added', user: 'U2', reaction: 'tada',
        item: { type: 'message', channel: 'C9', ts: '1759999999.000200' },
        event_ts: '1760000000.000300',
      },
    });
    assert.ok(result.ok);
    assert.equal(result.event.channelId, 'C9');
    assert.equal(result.event.messageTs, '1759999999.000200');
    assert.equal(result.event.text, ':tada:');
  });

  it('prefers event_ts over ts for occurredAt', () => {
    const result = parseSlackEventPayload({
      ...base,
      event: { type: 'message', channel: 'C1', ts: '1700000000.000000', event_ts: '1760000000.000000' },
    });
    assert.ok(result.ok);
    assert.equal(result.event.occurredAt, 1760000000000);
  });

  it('falls back to the envelope event_time when the event carries no timestamp', () => {
    const result = parseSlackEventPayload({
      ...base,
      event: { type: 'message', channel: 'C1', text: 'hi' },
    });
    assert.ok(result.ok);
    assert.equal(result.event.occurredAt, NOW_SEC * 1000);
  });

  it('keeps the raw event for anything the columns do not cover', () => {
    const result = parseSlackEventPayload({
      ...base,
      event: { type: 'message', channel: 'C1', ts: '1760000000.000100', blocks: [{ type: 'rich_text' }] },
    });
    assert.ok(result.ok);
    assert.deepEqual(result.event.raw.blocks, [{ type: 'rich_text' }]);
  });

  it('rejects an envelope with no event object', () => {
    const result = parseSlackEventPayload({ ...base });
    assert.ok(!result.ok);
    assert.match(result.reason, /no event object/);
  });

  it('rejects an event with no event_id, because retries could not be deduplicated', () => {
    const result = parseSlackEventPayload({
      type: 'event_callback', team_id: 'T1',
      event: { type: 'message', channel: 'C1', ts: '1760000000.000100' },
    });
    assert.ok(!result.ok);
    assert.match(result.reason, /event_id/);
  });

  it('rejects an event with no team_id', () => {
    const result = parseSlackEventPayload({
      type: 'event_callback', event_id: 'Ev1',
      event: { type: 'message', channel: 'C1', ts: '1760000000.000100' },
    });
    assert.ok(!result.ok);
    assert.match(result.reason, /team_id/);
  });

  it('falls back to event.team when the envelope omits team_id', () => {
    const result = parseSlackEventPayload({
      type: 'event_callback', event_id: 'Ev1',
      event: { type: 'message', team: 'T7', channel: 'C1', ts: '1760000000.000100' },
    });
    assert.ok(result.ok);
    assert.equal(result.event.teamId, 'T7');
  });

  it('rejects a channel-less event', () => {
    const result = parseSlackEventPayload({
      ...base,
      event: { type: 'team_join', user: 'U1', ts: '1760000000.000100' },
    });
    assert.ok(!result.ok);
    assert.match(result.reason, /no channel/);
  });

  it('rejects membership and metadata churn subtypes', () => {
    for (const subtype of ['channel_join', 'channel_leave', 'channel_topic', 'channel_name']) {
      const result = parseSlackEventPayload({
        ...base,
        event: { type: 'message', subtype, channel: 'C1', ts: '1760000000.000100' },
      });
      assert.ok(!result.ok, `${subtype} should be ignored`);
      assert.match(result.reason, /ignored message subtype/);
    }
  });

  it('keeps content-bearing subtypes such as bot_message', () => {
    const result = parseSlackEventPayload({
      ...base,
      event: { type: 'message', subtype: 'bot_message', channel: 'C1', text: 'alert fired', ts: '1760000000.000100' },
    });
    assert.ok(result.ok, 'bot messages are often exactly what a watcher wants');
    assert.equal(result.event.text, 'alert fired');
  });
});

describe('matchesSubscription', () => {
  function sub(overrides: Partial<SlackEventSubscription> = {}): SlackEventSubscription {
    return {
      id: 1, userId: 1, teamId: 'T1', channelId: 'C1',
      events: ['message'], matchPattern: null, status: 'active', failCount: 0,
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
      ...overrides,
    };
  }
  const event = {
    eventId: 'Ev1', eventType: 'message', teamId: 'T1', channelId: 'C1',
    messageTs: '1.0', threadTs: null, actorId: 'U1',
    text: 'Check this LinkedIn post', occurredAt: 1, raw: {},
  };

  it('matches on event type', () => {
    assert.equal(matchesSubscription(sub(), event), true);
    assert.equal(matchesSubscription(sub({ events: ['reaction_added'] }), event), false);
  });

  it('matches matchPattern case-insensitively as a substring', () => {
    assert.equal(matchesSubscription(sub({ matchPattern: 'linkedin' }), event), true);
    assert.equal(matchesSubscription(sub({ matchPattern: 'LINKEDIN' }), event), true);
    assert.equal(matchesSubscription(sub({ matchPattern: 'grafana' }), event), false);
  });

  it('treats matchPattern as a literal, not a regex', () => {
    // An LLM-supplied pattern must not be able to match everything with ".*"
    // or blow up on an invalid expression.
    assert.equal(matchesSubscription(sub({ matchPattern: '.*' }), event), false);
    assert.equal(matchesSubscription(sub({ matchPattern: '[' }), event), false);
  });

  it('does not match a pattern against an event with no text', () => {
    assert.equal(matchesSubscription(sub({ matchPattern: 'x' }), { ...event, text: null }), false);
  });

  it('matches a textless event when no pattern is set', () => {
    assert.equal(matchesSubscription(sub(), { ...event, text: null }), true);
  });
});

describe('parseTimestampInput', () => {
  it('accepts a digit-only Unix-ms string, which the Date constructor rejects', () => {
    assert.equal(parseTimestampInput('1760000000000'), 1760000000000);
  });

  it('accepts an ISO string', () => {
    assert.equal(parseTimestampInput('2026-08-01T00:00:00.000Z'), Date.parse('2026-08-01T00:00:00.000Z'));
  });

  it('returns NaN for junk', () => {
    assert.ok(Number.isNaN(parseTimestampInput('yesterday')));
  });
});
