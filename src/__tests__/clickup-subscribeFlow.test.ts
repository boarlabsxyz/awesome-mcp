import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractWebhookCreds,
  redactWebhookSecrets,
  subscribeToTaskEventsFlow,
  type SubscribeDeps,
} from '../clickup/webhookHelpers.js';
import { pruneOldTaskEvents, type ClickUpWebhookSubscription } from '../clickup/taskEventStore.js';

function fakeSubscription(overrides: Partial<ClickUpWebhookSubscription> = {}): ClickUpWebhookSubscription {
  return {
    id: 1,
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

// Deps builder — pass callbacks to override, defaults record calls.
function fakeDeps(overrides: Partial<SubscribeDeps> = {}): { deps: SubscribeDeps; calls: any } {
  const calls = {
    createWebhook: [] as Array<{ workspaceId: string; params: any }>,
    deleteWebhook: [] as string[],
    findSubscription: [] as Array<{ userId: number; workspaceId: string }>,
    createSubscription: [] as any[],
  };
  const deps: SubscribeDeps = {
    createWebhook: async (workspaceId, params) => {
      calls.createWebhook.push({ workspaceId, params });
      return { id: 'wh-new', webhook: { secret: 'sec-new' } };
    },
    deleteWebhook: async (id) => { calls.deleteWebhook.push(id); return { ok: true }; },
    findSubscription: async (userId, workspaceId) => {
      calls.findSubscription.push({ userId, workspaceId });
      return null;
    },
    createSubscription: async (input) => {
      calls.createSubscription.push(input);
      return fakeSubscription({
        clickupWebhookId: input.clickupWebhookId,
        sharedSecret: input.sharedSecret,
        events: input.events,
      });
    },
    ...overrides,
  };
  return { deps, calls };
}

describe('redactWebhookSecrets', () => {
  it('replaces top-level secret/token/shared_secret/access_token', () => {
    const out = redactWebhookSecrets({
      id: 'wh-1',
      secret: 'shh',
      shared_secret: 'shh',
      sharedSecret: 'shh',
      token: 'shh',
      access_token: 'shh',
      keep: 'me',
    });
    assert.equal(out.id, 'wh-1');
    assert.equal(out.secret, '[REDACTED]');
    assert.equal(out.shared_secret, '[REDACTED]');
    assert.equal(out.sharedSecret, '[REDACTED]');
    assert.equal(out.token, '[REDACTED]');
    assert.equal(out.access_token, '[REDACTED]');
    assert.equal(out.keep, 'me');
  });

  it('recurses into nested objects', () => {
    const out = redactWebhookSecrets({ webhook: { id: 'w', secret: 'sh' }, other: { token: 't', ok: 1 } });
    assert.equal(out.webhook.secret, '[REDACTED]');
    assert.equal(out.webhook.id, 'w');
    assert.equal(out.other.token, '[REDACTED]');
    assert.equal(out.other.ok, 1);
  });

  it('recurses into arrays', () => {
    const out = redactWebhookSecrets([{ secret: 'a' }, { keep: 'b' }]);
    assert.equal(out[0].secret, '[REDACTED]');
    assert.equal(out[1].keep, 'b');
  });

  it('passes through primitives and nullish', () => {
    assert.equal(redactWebhookSecrets(null), null);
    assert.equal(redactWebhookSecrets(undefined), undefined);
    assert.equal(redactWebhookSecrets(42), 42);
    assert.equal(redactWebhookSecrets('x'), 'x');
  });
});

describe('extractWebhookCreds', () => {
  it('finds id + secret at top level', () => {
    const r = extractWebhookCreds({ id: 'wh-1', secret: 'sh' });
    assert.deepEqual(r, { ok: true, webhookId: 'wh-1', sharedSecret: 'sh' });
  });

  it('finds nested webhook.id + webhook.secret', () => {
    const r = extractWebhookCreds({ webhook: { id: 'wh-2', secret: 'sh2' } });
    assert.deepEqual(r, { ok: true, webhookId: 'wh-2', sharedSecret: 'sh2' });
  });

  it('coerces non-string ids/secrets to string', () => {
    const r = extractWebhookCreds({ id: 12345, secret: 67890 });
    assert.equal((r as any).webhookId, '12345');
    assert.equal((r as any).sharedSecret, '67890');
  });

  it('returns an error result when id is missing', () => {
    const r = extractWebhookCreds({ secret: 'sh' });
    assert.equal(r.ok, false);
    assert.match((r as any).error, /no id\/secret/);
  });

  it('returns an error result when secret is missing', () => {
    const r = extractWebhookCreds({ id: 'wh-3' });
    assert.equal(r.ok, false);
  });

  it('never leaks the secret when both are present but shape is unexpected', () => {
    // A response with secret but no id at all — the error path stringifies
    // via redactWebhookSecrets, so `secret` must be scrubbed.
    const r = extractWebhookCreds({ nested: { secret: 'super-sensitive' } });
    assert.equal(r.ok, false);
    assert.doesNotMatch((r as any).error, /super-sensitive/);
    assert.match((r as any).error, /\[REDACTED\]/);
  });

  it('truncates very long response bodies in the error', () => {
    const big = { padding: 'x'.repeat(1000) };
    const r = extractWebhookCreds(big);
    assert.equal(r.ok, false);
    // Error message ends with the truncated redacted-response chunk (500 char slice).
    assert.ok((r as any).error.length < 700);
  });
});

describe('subscribeToTaskEventsFlow', () => {
  it('short-circuits on an existing subscription (idempotent no-op)', async () => {
    const existing = fakeSubscription();
    const { deps, calls } = fakeDeps({ findSubscription: async () => existing });
    const result = await subscribeToTaskEventsFlow(deps, {
      userId: 100, workspaceId: 'W1', events: ['taskStatusUpdated'], endpoint: 'https://x/cb',
    });
    assert.equal(result.kind, 'existing');
    assert.equal(result.subscription.id, existing.id);
    assert.equal(calls.createWebhook.length, 0);
    assert.equal(calls.createSubscription.length, 0);
    assert.equal(calls.deleteWebhook.length, 0);
  });

  it('creates webhook + persists on happy path', async () => {
    const { deps, calls } = fakeDeps();
    const result = await subscribeToTaskEventsFlow(deps, {
      userId: 100, workspaceId: 'W1', events: ['taskStatusUpdated'], endpoint: 'https://x/cb',
    });
    assert.equal(result.kind, 'created');
    assert.equal(calls.createWebhook.length, 1);
    assert.equal(calls.createWebhook[0].workspaceId, 'W1');
    assert.equal(calls.createWebhook[0].params.endpoint, 'https://x/cb');
    assert.deepEqual(calls.createWebhook[0].params.events, ['taskStatusUpdated']);
    assert.equal(calls.createSubscription.length, 1);
    assert.equal(calls.createSubscription[0].clickupWebhookId, 'wh-new');
    assert.equal(calls.createSubscription[0].sharedSecret, 'sec-new');
    assert.equal(calls.deleteWebhook.length, 0);
  });

  it('wraps ClickUp createWebhook failures', async () => {
    const { deps } = fakeDeps({
      createWebhook: async () => { throw new Error('clickup 500'); },
    });
    await assert.rejects(
      subscribeToTaskEventsFlow(deps, { userId: 100, workspaceId: 'W1', events: ['taskStatusUpdated'], endpoint: 'https://x/cb' }),
      /Failed to create ClickUp webhook: clickup 500/,
    );
  });

  it('surfaces a redacted extractor error when ClickUp returns no id/secret', async () => {
    const { deps } = fakeDeps({
      createWebhook: async () => ({ nested: { secret: 'oops-leak' } }),
    });
    try {
      await subscribeToTaskEventsFlow(deps, { userId: 100, workspaceId: 'W1', events: ['taskStatusUpdated'], endpoint: 'https://x/cb' });
      assert.fail('should have thrown');
    } catch (err: any) {
      assert.match(err.message, /no id\/secret/);
      assert.doesNotMatch(err.message, /oops-leak/);
      assert.match(err.message, /\[REDACTED\]/);
    }
  });

  it('rolls back the ClickUp webhook when persistence fails', async () => {
    const { deps, calls } = fakeDeps({
      createSubscription: async () => { throw new Error('db down'); },
    });
    await assert.rejects(
      subscribeToTaskEventsFlow(deps, { userId: 100, workspaceId: 'W1', events: ['taskStatusUpdated'], endpoint: 'https://x/cb' }),
      /rolled back.*db down/,
    );
    assert.equal(calls.deleteWebhook.length, 1);
    assert.equal(calls.deleteWebhook[0], 'wh-new');
  });

  it('notes cleanup failure when both persist AND rollback fail', async () => {
    const cleanupCalls: string[] = [];
    const { deps } = fakeDeps({
      createSubscription: async () => { throw new Error('db down'); },
      deleteWebhook: async (id) => { cleanupCalls.push(id); throw new Error('clickup 404'); },
    });
    await assert.rejects(
      subscribeToTaskEventsFlow(deps, { userId: 100, workspaceId: 'W1', events: ['taskStatusUpdated'], endpoint: 'https://x/cb' }),
      /cleanup FAILED — orphaned ClickUp webhook wh-new must be deleted manually/,
    );
    assert.deepEqual(cleanupCalls, ['wh-new']);
  });

  it('does not roll back the webhook when the fail_count is bumpable but persist actually succeeds', async () => {
    // Regression guard: happy path must never call deleteWebhook.
    const { deps, calls } = fakeDeps();
    await subscribeToTaskEventsFlow(deps, { userId: 100, workspaceId: 'W1', events: ['taskCreated'], endpoint: 'https://x/cb' });
    assert.equal(calls.deleteWebhook.length, 0);
  });
});

describe('pruneOldTaskEvents (no-op branch)', () => {
  it('returns 0 without touching the DB when retentionDays is 0', async () => {
    // Guard for the readRetentionConfig disabled-mode path — 0 or negative
    // means "don't prune", and the function must skip requireDb() so tests
    // without Postgres don't crash.
    assert.equal(await pruneOldTaskEvents(0), 0);
    assert.equal(await pruneOldTaskEvents(-1), 0);
  });
});
