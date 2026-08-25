// Regression cover for the two things that made "subscribed, but nothing
// arrives" undiagnosable (ticket 86cb58ehh):
//
//   1. `message` is one event type here but FOUR separately-toggled
//      subscriptions on the Slack app. A DM delivers only on message.im, so a
//      workspace with message.channels enabled records nothing for a DM and
//      looks exactly like a broken deployment.
//   2. Nothing durable recorded whether Slack had ever POSTed to this
//      deployment at all, so "Request URL never configured", "signing secret
//      mismatch" and "delivered but unmatched" were indistinguishable from an
//      MCP tool.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import {
  debugChannelEventSubscriptionFlow,
  handleSlackEventIngest,
  requiredMessageEventSubscription,
  type SlackDebugDeps,
  type SlackIngestHealthSummary,
  type SlackIngestionStore,
} from '../slack/eventHelpers.js';
import type { SlackChannelEvent, SlackEventSubscription } from '../slack/eventStore.js';

const SECRET = 'sl4ck-signing-secret';
const NOW_MS = 1_760_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

function headersFor(body: string, opts: { secret?: string } = {}) {
  const timestamp = String(NOW_SEC);
  const signature = 'v0=' + crypto
    .createHmac('sha256', opts.secret ?? SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest('hex');
  return { signature, timestamp };
}

function subscription(overrides: Partial<SlackEventSubscription> = {}): SlackEventSubscription {
  return {
    id: 1, userId: 100, teamId: 'T1', channelId: 'C1',
    events: ['message', 'reaction_added'], matchPattern: null,
    status: 'active', failCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function messageEnvelope(channel = 'C1') {
  return JSON.stringify({
    type: 'event_callback', team_id: 'T1', event_id: 'Ev123', event_time: NOW_SEC,
    event: { type: 'message', channel, user: 'U1', text: 'hello', ts: '1760000000.000100' },
  });
}

class RecordingStore implements SlackIngestionStore {
  subs: SlackEventSubscription[] = [];
  recorded: Array<{ branch: string; teamId?: string | null; channelId?: string | null; eventType?: string | null }> = [];
  recordThrows = false;

  async findSubscriptionsForChannel(teamId: string, channelId: string) {
    return this.subs.filter(s => s.teamId === teamId && s.channelId === channelId && s.status === 'active');
  }
  async insertChannelEvents(events: SlackChannelEvent[]) { return events.length; }
  async incrementFailCount() { /* unused here */ }
  async recordIngestDelivery(input: { branch: string; teamId?: string | null; channelId?: string | null; eventType?: string | null }) {
    if (this.recordThrows) throw new Error('health write boom');
    this.recorded.push(input);
  }
}

describe('requiredMessageEventSubscription', () => {
  it('maps conversations.info flags to the toggle Slack actually gates on', () => {
    assert.equal(requiredMessageEventSubscription('D1', { isIm: true }).event, 'message.im');
    assert.equal(requiredMessageEventSubscription('G1', { isMpim: true }).event, 'message.mpim');
    assert.equal(requiredMessageEventSubscription('C1', { isPrivate: true }).event, 'message.groups');
    assert.equal(requiredMessageEventSubscription('C1', { isPrivate: false }).event, 'message.channels');
  });

  it('is certain about a D-prefixed DM without conversations.info, and honest otherwise', () => {
    const dm = requiredMessageEventSubscription('D0999');
    assert.equal(dm.event, 'message.im');
    assert.equal(dm.certain, true);
    // A modern private channel can carry a C prefix, so the prefix alone
    // cannot separate message.channels from message.groups.
    assert.equal(requiredMessageEventSubscription('C0999').certain, false);
    assert.equal(requiredMessageEventSubscription('G0999').event, 'message.groups');
  });

  it('prefers the flags over the prefix when they disagree', () => {
    // Slack hands out C-prefixed IDs for private channels in newer workspaces.
    assert.equal(requiredMessageEventSubscription('C1', { isPrivate: true }).event, 'message.groups');
  });
});

describe('handleSlackEventIngest — delivery breadcrumbs', () => {
  it('records the branch for a stored event, with the channel it arrived for', async () => {
    const store = new RecordingStore();
    store.subs.push(subscription());
    const body = messageEnvelope();
    const result = await handleSlackEventIngest(body, headersFor(body), store, SECRET, NOW_MS);
    assert.equal(result.status, 200);
    assert.deepEqual(store.recorded, [{ branch: 'ok', teamId: 'T1', channelId: 'C1', eventType: 'message' }]);
  });

  it('records rejected deliveries too — a signature mismatch is the evidence that matters most', async () => {
    const store = new RecordingStore();
    const body = messageEnvelope();
    const result = await handleSlackEventIngest(body, headersFor(body, { secret: 'wrong' }), store, SECRET, NOW_MS);
    assert.equal(result.status, 401);
    assert.equal(store.recorded[0].branch, 'bad-signature');
  });

  it('records the url_verification handshake, which proves the Request URL points here', async () => {
    const store = new RecordingStore();
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc' });
    const result = await handleSlackEventIngest(body, headersFor(body), store, SECRET, NOW_MS);
    assert.deepEqual(result.body, { challenge: 'abc' });
    assert.equal(store.recorded[0].branch, 'url-verification');
  });

  it('records an event nobody is subscribed to, so "arriving but unmatched" is visible', async () => {
    const store = new RecordingStore();
    const body = messageEnvelope('D999');
    await handleSlackEventIngest(body, headersFor(body), store, SECRET, NOW_MS);
    assert.equal(store.recorded[0].branch, 'no-subscription');
    assert.equal(store.recorded[0].channelId, 'D999');
  });

  it('never lets a failed health write change the status Slack sees', async () => {
    const store = new RecordingStore();
    store.subs.push(subscription());
    store.recordThrows = true;
    const body = messageEnvelope();
    const result = await handleSlackEventIngest(body, headersFor(body), store, SECRET, NOW_MS);
    // A non-2xx would make Slack disable the Request URL for the whole
    // workspace — losing delivery to protect a counter is backwards.
    assert.equal(result.status, 200);
    assert.equal(result.logContext.branch, 'ok');
  });

  it('works against a store that has no recorder at all', async () => {
    const store = new RecordingStore();
    store.subs.push(subscription());
    const { recordIngestDelivery: _omitted, ...withoutRecorder } = store as any;
    const bare: SlackIngestionStore = {
      findSubscriptionsForChannel: store.findSubscriptionsForChannel.bind(store),
      insertChannelEvents: store.insertChannelEvents.bind(store),
      incrementFailCount: store.incrementFailCount.bind(store),
    };
    void withoutRecorder;
    const body = messageEnvelope();
    const result = await handleSlackEventIngest(body, headersFor(body), bare, SECRET, NOW_MS);
    assert.equal(result.status, 200);
  });
});

describe('debugChannelEventSubscriptionFlow — delivery evidence', () => {
  const BASE = {
    userId: 100, teamId: 'T1', channelId: 'D1',
    expectedRequestUrl: 'https://example.test/webhooks/slack/inbound',
    signingSecretConfigured: true,
  };

  function deps(health: SlackIngestHealthSummary[] | null, info: Record<string, any> = { name: null, is_member: false, is_im: true }): SlackDebugDeps {
    return {
      findSubscription: async () => subscription({ channelId: 'D1' }),
      countChannelEventsForSubscription: async () => 0,
      querySlackEvents: async () => [],
      getChannelInfo: async () => info,
      ...(health ? { readIngestHealth: async () => health } : {}),
    };
  }
  const text = (r: { findings: string[] }) => r.findings.join('\n');

  it('names message.im for a DM, and says message.channels does not cover it', async () => {
    const report = await debugChannelEventSubscriptionFlow(deps([]), BASE);
    assert.equal(report.requiredEventSubscription, 'message.im');
    assert.match(text(report), /message\.im/);
    assert.match(text(report), /does NOT cover DMs/);
  });

  it('does not cry "not a member" about a DM — membership is meaningless there', async () => {
    const report = await debugChannelEventSubscriptionFlow(deps([]), BASE);
    assert.doesNotMatch(text(report), /Not a member/);
  });

  it('says outright when Slack has never POSTed to this deployment', async () => {
    const report = await debugChannelEventSubscriptionFlow(deps([]), BASE);
    assert.match(text(report), /never received a single POST/);
  });

  it('distinguishes a verified URL with no event types subscribed', async () => {
    const health: SlackIngestHealthSummary[] = [
      { branch: 'url-verification', deliveryCount: 2, lastAt: '2026-08-25T10:00:00.000Z' },
    ];
    const report = await debugChannelEventSubscriptionFlow(deps(health), BASE);
    assert.match(text(report), /only ever sent the url_verification handshake/);
    assert.match(text(report), /message\.im/);
  });

  it('flags rejected deliveries as a signing-secret mismatch rather than a missing URL', async () => {
    const health: SlackIngestHealthSummary[] = [
      { branch: 'bad-signature', deliveryCount: 9, lastAt: '2026-08-25T10:00:00.000Z' },
    ];
    const report = await debugChannelEventSubscriptionFlow(deps(health), BASE);
    assert.match(text(report), /REJECTED before storage/);
    assert.match(text(report), /Signing Secret/);
  });

  it('says the transport works when other channels are storing events', async () => {
    const health: SlackIngestHealthSummary[] = [
      { branch: 'ok', deliveryCount: 41, lastAt: '2026-08-25T10:00:00.000Z', lastChannelId: 'C777' },
    ];
    const report = await debugChannelEventSubscriptionFlow(deps(health), BASE);
    assert.match(text(report), /Events from other channels ARE being stored/);
    assert.match(text(report), /C777/);
  });

  it('reports events arriving with no subscriber separately from none arriving', async () => {
    const health: SlackIngestHealthSummary[] = [
      { branch: 'no-subscription', deliveryCount: 3, lastAt: '2026-08-25T10:00:00.000Z', lastChannelId: 'C5' },
    ];
    const report = await debugChannelEventSubscriptionFlow(deps(health), BASE);
    assert.match(text(report), /Events ARE arriving but none has ever been stored/);
  });

  it('degrades cleanly when no health source is wired', async () => {
    const report = await debugChannelEventSubscriptionFlow(deps(null), BASE);
    assert.equal(report.ingestHealth, undefined);
    assert.match(text(report), /Delivery evidence was unavailable/);
  });
});
