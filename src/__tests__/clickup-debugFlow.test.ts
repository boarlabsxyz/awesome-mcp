import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { debugTaskEventSubscriptionFlow, type DebugDeps } from '../clickup/webhookHelpers.js';
import type { ClickUpWebhookSubscription, StoredTaskEvent } from '../clickup/taskEventStore.js';

const OLD_ENOUGH_CREATED = '2026-01-01T00:00:00.000Z';

function fakeSub(overrides: Partial<ClickUpWebhookSubscription> = {}): ClickUpWebhookSubscription {
  return {
    id: 42,
    userId: 100,
    workspaceId: 'W1',
    clickupWebhookId: 'wh-abc',
    sharedSecret: 'sh',
    events: ['taskCreated', 'taskStatusUpdated'],
    status: 'active',
    failCount: 0,
    createdAt: OLD_ENOUGH_CREATED,
    updatedAt: OLD_ENOUGH_CREATED,
    ...overrides,
  };
}

// Prebaked "ClickUp says the webhook is fine" shape.
function healthyClickUpWebhook(overrides: any = {}) {
  return {
    id: 'wh-abc',
    endpoint: 'https://foo.example/webhooks/clickup/inbound',
    events: ['taskCreated', 'taskStatusUpdated'],
    health: { status: 'active', fail_count: 0 },
    ...overrides,
  };
}

function fakeEvent(overrides: Partial<StoredTaskEvent> = {}): StoredTaskEvent {
  return {
    id: 1,
    subscriptionId: 42,
    workspaceId: 'W1',
    taskId: 'T1',
    eventType: 'taskStatusUpdated',
    field: 'status',
    fromVal: 'open',
    toVal: 'closed',
    actorId: '7',
    actorUsername: 'alice',
    occurredAt: Date.parse('2026-07-08T12:00:00.000Z'),
    receivedAt: '2026-07-08T12:00:00.100Z',
    rawPayload: {},
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<DebugDeps> = {}): { deps: DebugDeps } {
  const deps: DebugDeps = {
    findSubscription: async () => fakeSub(),
    listWebhooks: async () => ({ webhooks: [healthyClickUpWebhook()] }),
    countTaskEventsForSubscription: async () => 0,
    queryTaskEvents: async () => [],
    ...overrides,
  };
  return { deps };
}

const EXPECTED_ENDPOINT = 'https://foo.example/webhooks/clickup/inbound';

describe('debugTaskEventSubscriptionFlow', () => {
  it('happy but empty-store case: flags "zero events, zero failures" pattern', async () => {
    const { deps } = fakeDeps();
    const report = await debugTaskEventSubscriptionFlow(deps, {
      userId: 100, workspaceId: 'W1', expectedEndpoint: EXPECTED_ENDPOINT,
    });
    assert.equal(report.kind, 'ok');
    assert.ok(report.local);
    assert.ok(report.clickup);
    assert.equal(report.eventStore?.count, 0);
    // The "silent 200" fingerprint: no events + no failures + subscription is old.
    assert.ok(
      report.findings.some(f => f.includes('Zero events stored') && f.includes('zero delivery failures')),
      'expected the silent-200 finding',
    );
  });

  it('reports no-local-subscription and still calls ClickUp for orphan detection', async () => {
    let listWebhooksCalled = false;
    const { deps } = fakeDeps({
      findSubscription: async () => null,
      listWebhooks: async () => { listWebhooksCalled = true; return { webhooks: [] }; },
    });
    const report = await debugTaskEventSubscriptionFlow(deps, {
      userId: 100, workspaceId: 'W1', expectedEndpoint: EXPECTED_ENDPOINT,
    });
    assert.equal(report.kind, 'no-local-subscription');
    assert.equal(listWebhooksCalled, true);
    assert.ok(report.findings.some(f => f.includes('No local subscription')));
  });

  it('detects an orphan on ClickUp\'s side when local matches endpoint but not id', async () => {
    // Local has a stale webhook id, but ClickUp has a live webhook at the
    // same endpoint URL. Match by endpoint so the report still shows both
    // sides — that helps the operator see the id divergence.
    const { deps } = fakeDeps({
      findSubscription: async () => fakeSub({ clickupWebhookId: 'wh-old' }),
      listWebhooks: async () => ({ webhooks: [healthyClickUpWebhook({ id: 'wh-new' })] }),
    });
    const report = await debugTaskEventSubscriptionFlow(deps, {
      userId: 100, workspaceId: 'W1', expectedEndpoint: EXPECTED_ENDPOINT,
    });
    assert.equal(report.clickup?.id, 'wh-new');
  });

  it('flags no-clickup-webhook when local record has an id ClickUp doesn\'t know', async () => {
    const { deps } = fakeDeps({
      findSubscription: async () => fakeSub({ clickupWebhookId: 'wh-gone' }),
      listWebhooks: async () => ({ webhooks: [] }),
    });
    const report = await debugTaskEventSubscriptionFlow(deps, {
      userId: 100, workspaceId: 'W1', expectedEndpoint: EXPECTED_ENDPOINT,
    });
    assert.equal(report.kind, 'no-clickup-webhook');
    assert.ok(report.findings.some(f => f.includes('no such webhook')));
  });

  it('flags endpoint mismatch — the highest-priority root cause', async () => {
    const { deps } = fakeDeps({
      listWebhooks: async () => ({ webhooks: [healthyClickUpWebhook({ endpoint: 'https://old.example/webhooks/clickup/inbound' })] }),
    });
    const report = await debugTaskEventSubscriptionFlow(deps, {
      userId: 100, workspaceId: 'W1', expectedEndpoint: EXPECTED_ENDPOINT,
    });
    assert.ok(
      report.findings.some(f => f.includes('Endpoint mismatch') && f.includes('old.example')),
      'expected an Endpoint mismatch finding naming the wrong URL',
    );
  });

  it('flags events-bundle mismatch when the two sides disagree', async () => {
    const { deps } = fakeDeps({
      listWebhooks: async () => ({ webhooks: [healthyClickUpWebhook({ events: ['taskCreated'] })] }),
    });
    const report = await debugTaskEventSubscriptionFlow(deps, {
      userId: 100, workspaceId: 'W1', expectedEndpoint: EXPECTED_ENDPOINT,
    });
    assert.ok(report.findings.some(f => f.includes('Event bundle differs')));
  });

  it('flags fail_count divergence WITHOUT calling it a silent-200 (ClickUp counter moved, so it was not a 200)', async () => {
    const { deps } = fakeDeps({
      listWebhooks: async () => ({ webhooks: [healthyClickUpWebhook({ health: { status: 'active', fail_count: 3 } })] }),
    });
    const report = await debugTaskEventSubscriptionFlow(deps, {
      userId: 100, workspaceId: 'W1', expectedEndpoint: EXPECTED_ENDPOINT,
    });
    const finding = report.findings.find(f => f.includes('ClickUp fail_count (3)'));
    assert.ok(finding, 'expected fail_count divergence finding');
    // Regression guard: the previous message asserted "outer catch is
    // returning 200 on a thrown error" — but if ClickUp incremented
    // fail_count, ingestion did NOT return 200. The finding must not
    // contradict itself by pointing at the silent-200 pattern here.
    assert.doesNotMatch(finding!, /returning 200/);
    assert.match(finding!, /non-2xx|timeout/);
    assert.match(finding!, /NOT the "silent 200"/);
  });

  it('flags a disabled webhook when ClickUp reports non-active health.status', async () => {
    const { deps } = fakeDeps({
      listWebhooks: async () => ({ webhooks: [healthyClickUpWebhook({ health: { status: 'disabled', fail_count: 5 } })] }),
    });
    const report = await debugTaskEventSubscriptionFlow(deps, {
      userId: 100, workspaceId: 'W1', expectedEndpoint: EXPECTED_ENDPOINT,
    });
    assert.ok(report.findings.some(f => f.includes('disabled by ClickUp')));
  });

  it('degrades gracefully when listWebhooks fails', async () => {
    const { deps } = fakeDeps({
      listWebhooks: async () => { throw new Error('clickup 500'); },
    });
    const report = await debugTaskEventSubscriptionFlow(deps, {
      userId: 100, workspaceId: 'W1', expectedEndpoint: EXPECTED_ENDPOINT,
    });
    // No throw — the report still includes local info + a finding pointing
    // at the ClickUp API failure.
    assert.ok(report.local);
    assert.ok(report.findings.some(f => f.includes('Failed to fetch ClickUp')));
  });

  it('populates eventStore.count and mostRecent when events exist', async () => {
    const evt = fakeEvent();
    const { deps } = fakeDeps({
      countTaskEventsForSubscription: async () => 17,
      queryTaskEvents: async () => [evt],
    });
    const report = await debugTaskEventSubscriptionFlow(deps, {
      userId: 100, workspaceId: 'W1', expectedEndpoint: EXPECTED_ENDPOINT,
    });
    assert.equal(report.eventStore?.count, 17);
    assert.equal(report.eventStore?.mostRecentOccurredAt, evt.occurredAt);
    assert.equal(report.eventStore?.mostRecentReceivedAt, evt.receivedAt);
    // With events present, the silent-200 finding should NOT fire.
    assert.ok(!report.findings.some(f => f.includes('Zero events stored')));
  });

  it('returns a healthy "no anomalies detected" message when everything lines up', async () => {
    // Non-zero events → silent-200 finding won't fire; matching bundle,
    // matching endpoint, matching fail_count, active status.
    const { deps } = fakeDeps({
      countTaskEventsForSubscription: async () => 5,
      queryTaskEvents: async () => [fakeEvent()],
    });
    const report = await debugTaskEventSubscriptionFlow(deps, {
      userId: 100, workspaceId: 'W1', expectedEndpoint: EXPECTED_ENDPOINT,
    });
    assert.equal(report.kind, 'ok');
    assert.deepEqual(report.findings, ['No anomalies detected. Local record, ClickUp record, and event store are consistent.']);
  });
});
