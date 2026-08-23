import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  debugChannelEventSubscriptionFlow,
  querySlackEventsFlow,
  subscribeToChannelEventsFlow,
  type SlackDebugDeps,
  type SlackQueryDeps,
  type SlackSubscribeDeps,
} from '../slack/eventHelpers.js';
import type { SlackEventSubscription, StoredSlackEvent } from '../slack/eventStore.js';

const CREATED_AT = '2026-08-01T00:00:00.000Z';

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
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function storedEvent(overrides: Partial<StoredSlackEvent> = {}): StoredSlackEvent {
  return {
    id: 1,
    subscriptionId: 1,
    teamId: 'T1',
    channelId: 'C1',
    eventId: 'Ev1',
    eventType: 'message',
    messageTs: '1760000000.000100',
    threadTs: null,
    actorId: 'U1',
    text: 'hello',
    occurredAt: 1760000000000,
    receivedAt: '2026-08-02T00:00:00.000Z',
    rawPayload: {},
    ...overrides,
  };
}

describe('subscribeToChannelEventsFlow', () => {
  function deps(existing: SlackEventSubscription | null) {
    const created: any[] = [];
    const impl: SlackSubscribeDeps = {
      findSubscription: async () => existing,
      createSubscription: async (input) => {
        created.push(input);
        return subscription({ id: 42, ...input, matchPattern: input.matchPattern ?? null });
      },
    };
    return { impl, created };
  }

  it('creates a subscription when none exists', async () => {
    const { impl, created } = deps(null);
    const result = await subscribeToChannelEventsFlow(impl, {
      userId: 100, teamId: 'T1', channelId: 'C1', events: ['message'], matchPattern: 'linkedin',
    });

    assert.equal(result.kind, 'created');
    assert.equal(result.subscription.id, 42);
    assert.equal(created.length, 1);
    assert.equal(created[0].matchPattern, 'linkedin');
  });

  it('is idempotent: an existing subscription is returned without a second insert', async () => {
    const existing = subscription({ id: 7 });
    const { impl, created } = deps(existing);
    const result = await subscribeToChannelEventsFlow(impl, {
      userId: 100, teamId: 'T1', channelId: 'C1', events: ['message'],
    });

    assert.equal(result.kind, 'existing');
    assert.equal(result.subscription.id, 7);
    assert.equal(created.length, 0);
  });

  it('normalises an omitted matchPattern to null', async () => {
    const { impl, created } = deps(null);
    await subscribeToChannelEventsFlow(impl, {
      userId: 100, teamId: 'T1', channelId: 'C1', events: ['message'],
    });
    assert.equal(created[0].matchPattern, undefined);
  });
});

describe('querySlackEventsFlow', () => {
  function deps(sub: SlackEventSubscription | null, events: StoredSlackEvent[] = []) {
    const queries: any[] = [];
    const impl: SlackQueryDeps = {
      findSubscription: async () => sub,
      querySlackEvents: async (input) => { queries.push(input); return events; },
    };
    return { impl, queries };
  }

  it('reports no-subscription as a warning, not an error, so a routine can fall back', async () => {
    const { impl, queries } = deps(null);
    const result = await querySlackEventsFlow(impl, { userId: 100, teamId: 'T1', channelId: 'C1' });

    assert.equal(result.kind, 'no-subscription');
    assert.deepEqual(result.events, []);
    assert.match(result.warning!, /subscribeToChannelEvents first/);
    assert.match(result.warning!, /readChannelHistory/);
    assert.equal(queries.length, 0);
  });

  it('returns events and the store-start boundary', async () => {
    const { impl } = deps(subscription(), [storedEvent()]);
    const result = await querySlackEventsFlow(impl, { userId: 100, teamId: 'T1', channelId: 'C1' });

    assert.equal(result.kind, 'ok');
    assert.equal(result.events.length, 1);
    assert.equal(result.eventStoreStartedAt, CREATED_AT);
    assert.equal(result.warning, undefined);
  });

  it('warns when `since` predates the subscription, and still runs the query', async () => {
    const { impl, queries } = deps(subscription(), [storedEvent()]);
    const since = Date.parse(CREATED_AT) - 86_400_000;
    const result = await querySlackEventsFlow(impl, { userId: 100, teamId: 'T1', channelId: 'C1', since });

    assert.equal(result.kind, 'ok');
    assert.match(result.warning!, /predates subscription creation/);
    assert.match(result.warning!, /readChannelHistory/);
    assert.equal(queries.length, 1, 'the query still runs — the warning is advisory');
  });

  it('does not warn when `since` is after the subscription', async () => {
    const { impl } = deps(subscription(), []);
    const since = Date.parse(CREATED_AT) + 1000;
    const result = await querySlackEventsFlow(impl, { userId: 100, teamId: 'T1', channelId: 'C1', since });
    assert.equal(result.warning, undefined);
  });

  it('passes filters through to the store, scoped by subscription id', async () => {
    const { impl, queries } = deps(subscription({ id: 9 }), []);
    await querySlackEventsFlow(impl, {
      userId: 100, teamId: 'T1', channelId: 'C1',
      since: 1, until: 2, eventTypes: ['reaction_added'], limit: 50,
    });

    assert.deepEqual(queries[0], {
      subscriptionId: 9, since: 1, until: 2, eventTypes: ['reaction_added'], limit: 50,
    });
  });
});

describe('debugChannelEventSubscriptionFlow', () => {
  const HEALTHY = {
    userId: 100, teamId: 'T1', channelId: 'C1',
    expectedRequestUrl: 'https://example.test/webhooks/slack/inbound',
    signingSecretConfigured: true,
  };

  function deps(overrides: Partial<SlackDebugDeps> = {}, sub: SlackEventSubscription | null = subscription()): SlackDebugDeps {
    return {
      findSubscription: async () => sub,
      countChannelEventsForSubscription: async () => 5,
      querySlackEvents: async () => [storedEvent()],
      getChannelInfo: async () => ({ name: 'general', is_member: true }),
      ...overrides,
    };
  }

  const findingsText = (r: { findings: string[] }) => r.findings.join('\n');

  it('reports no-local-subscription and hints at the user mismatch', async () => {
    const report = await debugChannelEventSubscriptionFlow(deps({}, null), HEALTHY);
    assert.equal(report.kind, 'no-local-subscription');
    assert.equal(report.local, undefined);
    assert.match(findingsText(report), /No local subscription/);
    assert.match(findingsText(report), /same user who subscribed/);
  });

  it('flags a missing signing secret, which silences every subscription at once', async () => {
    const report = await debugChannelEventSubscriptionFlow(deps(), { ...HEALTHY, signingSecretConfigured: false });
    assert.equal(report.signingSecretConfigured, false);
    assert.match(findingsText(report), /SLACK_SIGNING_SECRET is not set/);
    assert.match(findingsText(report), /401/);
  });

  it('flags an unset BASE_URL', async () => {
    const report = await debugChannelEventSubscriptionFlow(deps(), { ...HEALTHY, expectedRequestUrl: '' });
    assert.match(findingsText(report), /BASE_URL is not set/);
  });

  it('always surfaces the Request URL to compare against the Slack app by hand', async () => {
    const report = await debugChannelEventSubscriptionFlow(deps(), HEALTHY);
    assert.match(findingsText(report), /https:\/\/example\.test\/webhooks\/slack\/inbound/);
  });

  it('flags not being a member of the channel', async () => {
    const report = await debugChannelEventSubscriptionFlow(
      deps({ getChannelInfo: async () => ({ name: 'general', is_member: false }) }), HEALTHY,
    );
    assert.equal(report.channel?.isMember, false);
    assert.match(findingsText(report), /Not a member of #general/);
  });

  it('degrades gracefully when conversations.info fails', async () => {
    const report = await debugChannelEventSubscriptionFlow(
      deps({ getChannelInfo: async () => { throw new Error('channel_not_found'); } }), HEALTHY,
    );
    assert.match(findingsText(report), /Failed to fetch channel info: channel_not_found/);
  });

  it('skips the membership check when no lookup is available', async () => {
    const report = await debugChannelEventSubscriptionFlow(deps({ getChannelInfo: undefined }), HEALTHY);
    assert.equal(report.channel, undefined);
  });

  it('flags the zero-events-zero-failures pattern with the subscription age', async () => {
    const report = await debugChannelEventSubscriptionFlow(
      deps({ countChannelEventsForSubscription: async () => 0, querySlackEvents: async () => [] }), HEALTHY,
    );
    assert.equal(report.eventStore?.count, 0);
    assert.match(findingsText(report), /Zero events stored and zero local failures/);
    assert.match(findingsText(report), /subscription age: \d+m/);
  });

  it('mentions the matchPattern as a suspect when nothing has been captured', async () => {
    const report = await debugChannelEventSubscriptionFlow(
      deps(
        { countChannelEventsForSubscription: async () => 0, querySlackEvents: async () => [] },
        subscription({ matchPattern: 'linkedin' }),
      ),
      HEALTHY,
    );
    assert.match(findingsText(report), /matchPattern \("linkedin"\)/);
  });

  it('does not flag zero events when local failures explain it', async () => {
    const report = await debugChannelEventSubscriptionFlow(
      deps(
        { countChannelEventsForSubscription: async () => 0, querySlackEvents: async () => [] },
        subscription({ failCount: 3 }),
      ),
      HEALTHY,
    );
    assert.ok(!findingsText(report).includes('Zero events stored and zero local failures'));
    assert.match(findingsText(report), /Local fail_count is 3/);
    assert.match(findingsText(report), /\[slack-ingest\]/);
  });

  it('flags a non-active subscription', async () => {
    const report = await debugChannelEventSubscriptionFlow(deps({}, subscription({ status: 'paused' })), HEALTHY);
    assert.match(findingsText(report), /status is "paused"/);
  });

  it('reports the most recent event timestamps', async () => {
    const report = await debugChannelEventSubscriptionFlow(deps(), HEALTHY);
    assert.equal(report.eventStore?.count, 5);
    assert.equal(report.eventStore?.mostRecentOccurredAt, 1760000000000);
    assert.equal(report.eventStore?.mostRecentReceivedAt, '2026-08-02T00:00:00.000Z');
  });

  it('surfaces store failures rather than reporting a healthy zero', async () => {
    const report = await debugChannelEventSubscriptionFlow(
      deps({
        countChannelEventsForSubscription: async () => { throw new Error('db down'); },
        querySlackEvents: async () => { throw new Error('db down'); },
      }),
      HEALTHY,
    );
    assert.match(findingsText(report), /Failed to count events: db down/);
    assert.match(findingsText(report), /Failed to fetch most recent event: db down/);
  });
});
