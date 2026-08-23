import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { queryTaskEventsFlow, type QueryDeps } from '../clickup/webhookHelpers.js';
import type { ClickUpWebhookSubscription, StoredTaskEvent } from '../clickup/taskEventStore.js';

function fakeSubscription(overrides: Partial<ClickUpWebhookSubscription> = {}): ClickUpWebhookSubscription {
  return {
    id: 42,
    userId: 100,
    workspaceId: 'W1',
    clickupWebhookId: 'wh-abc',
    sharedSecret: 'sh4red',
    events: ['taskStatusUpdated'],
    status: 'active',
    failCount: 0,
    createdAt: '2026-07-08T00:00:00.000Z',
    updatedAt: '2026-07-08T00:00:00.000Z',
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

function fakeDeps(overrides: Partial<QueryDeps> = {}): { deps: QueryDeps; calls: any } {
  const calls = {
    findSubscription: [] as Array<{ userId: number; workspaceId: string }>,
    queryTaskEvents: [] as any[],
  };
  const deps: QueryDeps = {
    findSubscription: async (userId, workspaceId) => {
      calls.findSubscription.push({ userId, workspaceId });
      return fakeSubscription();
    },
    queryTaskEvents: async (input) => {
      calls.queryTaskEvents.push(input);
      return [fakeEvent()];
    },
    ...overrides,
  };
  return { deps, calls };
}

describe('queryTaskEventsFlow', () => {
  it('returns no-subscription with a self-heal warning when no sub exists', async () => {
    const { deps, calls } = fakeDeps({ findSubscription: async () => null });
    const result = await queryTaskEventsFlow(deps, { userId: 100, workspaceId: 'W1' });
    assert.equal(result.kind, 'no-subscription');
    assert.equal(result.events.length, 0);
    assert.match(result.warning!, /subscribeToTaskEvents first/);
    assert.match(result.warning!, /filterTeamTasks with dateUpdatedGt/);
    assert.equal(calls.queryTaskEvents.length, 0);
  });

  it('happy path: returns events with eventStoreStartedAt boundary and no warning', async () => {
    const { deps, calls } = fakeDeps();
    const result = await queryTaskEventsFlow(deps, {
      userId: 100,
      workspaceId: 'W1',
      since: Date.parse('2026-07-08T06:00:00.000Z'),
    });
    assert.equal(result.kind, 'ok');
    assert.equal(result.events.length, 1);
    assert.equal(result.eventStoreStartedAt, '2026-07-08T00:00:00.000Z');
    assert.equal(result.warning, undefined);
    assert.equal(calls.queryTaskEvents.length, 1);
  });

  it('attaches a "history starts now" warning when since predates the subscription', async () => {
    const { deps } = fakeDeps();
    const result = await queryTaskEventsFlow(deps, {
      userId: 100,
      workspaceId: 'W1',
      since: Date.parse('2026-06-01T00:00:00.000Z'), // way before sub.createdAt
    });
    assert.equal(result.kind, 'ok');
    assert.match(result.warning!, /predates subscription creation/);
    assert.match(result.warning!, /fall back to filterTeamTasks with dateUpdatedGt/);
  });

  it('does not warn when since matches subscription creation exactly', async () => {
    const { deps } = fakeDeps();
    const subCreatedMs = Date.parse('2026-07-08T00:00:00.000Z');
    const result = await queryTaskEventsFlow(deps, {
      userId: 100,
      workspaceId: 'W1',
      since: subCreatedMs,
    });
    assert.equal(result.warning, undefined);
  });

  it('does not warn when since is undefined', async () => {
    const { deps } = fakeDeps();
    const result = await queryTaskEventsFlow(deps, { userId: 100, workspaceId: 'W1' });
    assert.equal(result.warning, undefined);
  });

  it('forwards all filter parameters to the store', async () => {
    const { deps, calls } = fakeDeps();
    await queryTaskEventsFlow(deps, {
      userId: 100,
      workspaceId: 'W1',
      since: 1700000000000,
      until: 1800000000000,
      eventTypes: ['taskStatusUpdated'],
      toStatus: 'In Review',
      taskId: 'T99',
      limit: 250,
    });
    const call = calls.queryTaskEvents[0];
    assert.equal(call.subscriptionId, 42);
    assert.equal(call.since, 1700000000000);
    assert.equal(call.until, 1800000000000);
    assert.deepEqual(call.eventTypes, ['taskStatusUpdated']);
    assert.equal(call.toStatus, 'In Review');
    assert.equal(call.taskId, 'T99');
    assert.equal(call.limit, 250);
  });

  it('scopes to the specific subscription, not to the workspace at large', async () => {
    // A shared workspace could have multiple subscriptions (one per user).
    // The flow must pass subscription_id, not workspace_id, so query results
    // are isolated per user's own store.
    const { deps, calls } = fakeDeps({
      findSubscription: async () => fakeSubscription({ id: 999 }),
    });
    await queryTaskEventsFlow(deps, { userId: 100, workspaceId: 'W1' });
    assert.equal(calls.queryTaskEvents[0].subscriptionId, 999);
  });

  it('handles a subscription with an unparseable createdAt without throwing', async () => {
    // Regression guard: if the DB row's created_at came back in an unexpected
    // shape, the flow should still return events, just without the warning.
    const { deps } = fakeDeps({
      findSubscription: async () => fakeSubscription({ createdAt: 'not-a-date' as any }),
    });
    const result = await queryTaskEventsFlow(deps, {
      userId: 100, workspaceId: 'W1', since: 1000,
    });
    assert.equal(result.kind, 'ok');
    assert.equal(result.warning, undefined);
  });
});
