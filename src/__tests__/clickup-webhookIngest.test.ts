import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { handleClickUpWebhookIngest, type IngestionStore } from '../clickup/webhookHelpers.js';
import type { ClickUpTaskEvent, ClickUpWebhookSubscription } from '../clickup/taskEventStore.js';

function sign(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function subscription(overrides: Partial<ClickUpWebhookSubscription> = {}): ClickUpWebhookSubscription {
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

// Minimal in-memory store double. Tracks inserted events + fail-count bumps
// so tests can assert on side effects.
class FakeStore implements IngestionStore {
  subs: ClickUpWebhookSubscription[] = [];
  inserted: ClickUpTaskEvent[][] = [];
  failBumps: number[] = [];
  insertThrows: boolean = false;

  async getSubscriptionByWebhookId(webhookId: string) {
    return this.subs.find(s => s.clickupWebhookId === webhookId) || null;
  }
  async insertTaskEvents(events: ClickUpTaskEvent[]) {
    if (this.insertThrows) throw new Error('insert boom');
    this.inserted.push(events);
    return events.length;
  }
  async incrementFailCount(subscriptionId: number) {
    this.failBumps.push(subscriptionId);
  }
}

describe('handleClickUpWebhookIngest', () => {
  it('rejects malformed JSON with 400', async () => {
    const store = new FakeStore();
    const result = await handleClickUpWebhookIngest(Buffer.from('{not-json'), 'sig', store);
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { error: 'Invalid JSON body' });
    assert.equal(store.inserted.length, 0);
    assert.equal(result.logContext.branch, 'bad-json');
    assert.equal(result.logContext.failCountBumped, false);
  });

  it('rejects a body with no webhook_id with 400', async () => {
    const store = new FakeStore();
    const body = JSON.stringify({ event: 'taskStatusUpdated', task_id: 'T1' });
    const result = await handleClickUpWebhookIngest(body, sign('any', body), store);
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { error: 'Missing webhook_id in body' });
    assert.equal(result.logContext.branch, 'missing-webhook-id');
    assert.equal(result.logContext.webhookId, null);
  });

  it('returns 404 for an unknown webhook_id', async () => {
    const store = new FakeStore();
    const body = JSON.stringify({ webhook_id: 'unknown', event: 'taskStatusUpdated', task_id: 'T1' });
    const result = await handleClickUpWebhookIngest(body, sign('any', body), store);
    assert.equal(result.status, 404);
    assert.deepEqual(result.body, { error: 'Unknown webhook' });
    assert.equal(store.inserted.length, 0);
    assert.equal(result.logContext.branch, 'unknown-webhook');
    assert.equal(result.logContext.webhookId, 'unknown');
    assert.equal(result.logContext.failCountBumped, false); // can't bump — no sub matched
  });

  it('rejects a mismatched signature with 401 AND bumps local fail_count (PR4 fix)', async () => {
    // Regression guard for the exact divergence PR3's debug tool caught in
    // prod (ClickUp fail_count=30, ours=0). PR4 makes 401 bump the local
    // counter so it tracks ClickUp's.
    const store = new FakeStore();
    store.subs.push(subscription());
    const body = JSON.stringify({ webhook_id: 'wh-abc', event: 'taskStatusUpdated', task_id: 'T1' });
    const result = await handleClickUpWebhookIngest(body, sign('wrong-secret', body), store);
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { error: 'Invalid signature' });
    assert.equal(store.inserted.length, 0);
    assert.deepEqual(store.failBumps, [1]);
    assert.equal(result.logContext.branch, 'bad-signature');
    assert.equal(result.logContext.failCountBumped, true);
    assert.equal(result.logContext.subscriptionId, 1);
    assert.equal(result.logContext.storedSecretLen, 'sh4red'.length);
  });

  it('rejects a missing signature header with 401 and bumps fail_count', async () => {
    const store = new FakeStore();
    store.subs.push(subscription());
    const body = JSON.stringify({ webhook_id: 'wh-abc', event: 'taskStatusUpdated', task_id: 'T1' });
    const result = await handleClickUpWebhookIngest(body, undefined, store);
    assert.equal(result.status, 401);
    assert.deepEqual(store.failBumps, [1]);
    assert.equal(result.logContext.sigPresent, false);
    assert.equal(result.logContext.sigLen, 0);
  });

  it('accepts valid signature, inserts one row per history_item, returns 200', async () => {
    const store = new FakeStore();
    store.subs.push(subscription());
    const body = JSON.stringify({
      webhook_id: 'wh-abc',
      event: 'taskStatusUpdated',
      task_id: 'T1',
      history_items: [
        { field: 'status', date: 1700000000000, user: { id: 7, username: 'alice' }, before: { status: 'open' }, after: { status: 'closed' } },
        { field: 'status', date: 1700000000001, user: { id: 8, username: 'bob' }, before: { status: 'closed' }, after: { status: 'reopened' } },
      ],
    });
    const result = await handleClickUpWebhookIngest(body, sign('sh4red', body), store);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true });
    assert.equal(result.insertedEventCount, 2);
    assert.equal(store.inserted.length, 1);
    assert.equal(store.inserted[0].length, 2);
    assert.equal(store.inserted[0][0].taskId, 'T1');
    assert.equal(store.inserted[0][0].subscriptionId, 1);
    assert.equal(store.inserted[0][0].workspaceId, 'W1');
  });

  it('accepts a valid taskDeleted payload with no history_items and inserts a single placeholder row', async () => {
    const store = new FakeStore();
    store.subs.push(subscription());
    const body = JSON.stringify({
      webhook_id: 'wh-abc',
      event: 'taskDeleted',
      task_id: 'T99',
    });
    const result = await handleClickUpWebhookIngest(body, sign('sh4red', body), store);
    assert.equal(result.status, 200);
    assert.equal(result.insertedEventCount, 1);
    assert.equal(store.inserted[0][0].eventType, 'taskDeleted');
    assert.equal(store.inserted[0][0].taskId, 'T99');
  });

  it('returns 200 and bumps fail_count when insert throws (never let ClickUp disable for our own DB blip)', async () => {
    const store = new FakeStore();
    store.subs.push(subscription());
    store.insertThrows = true;
    const body = JSON.stringify({
      webhook_id: 'wh-abc',
      event: 'taskStatusUpdated',
      task_id: 'T1',
      history_items: [{ field: 'status', date: 1700000000000, before: { status: 'a' }, after: { status: 'b' } }],
    });
    const result = await handleClickUpWebhookIngest(body, sign('sh4red', body), store);
    assert.equal(result.status, 200);
    assert.deepEqual(store.failBumps, [1]);
    assert.equal(result.logContext.branch, 'insert-failed');
    assert.equal(result.logContext.failCountBumped, true);
    assert.equal(result.logContext.insertedEventCount, 0);
  });

  it('happy-path logContext carries webhookId, subscriptionId, insertedEventCount, and stored secret len', async () => {
    const store = new FakeStore();
    store.subs.push(subscription());
    const body = JSON.stringify({
      webhook_id: 'wh-abc',
      event: 'taskCreated',
      task_id: 'T1',
      history_items: [{ field: 'status', date: 1700000000000, before: { status: 'a' }, after: { status: 'b' } }],
    });
    const result = await handleClickUpWebhookIngest(body, sign('sh4red', body), store);
    assert.equal(result.logContext.branch, 'ok');
    assert.equal(result.logContext.webhookId, 'wh-abc');
    assert.equal(result.logContext.subscriptionId, 1);
    assert.equal(result.logContext.insertedEventCount, 1);
    assert.equal(result.logContext.failCountBumped, false);
    assert.equal(result.logContext.storedSecretLen, 'sh4red'.length);
    // bodyPrefix is truncated at 200 and MUST NOT contain the stored secret.
    assert.ok(!result.logContext.bodyPrefix.includes('sh4red'));
  });

  it('unknown-webhook logContext preserves the webhookId that missed', async () => {
    const store = new FakeStore();
    const body = JSON.stringify({ webhook_id: 'wh-typo', event: 'taskCreated', task_id: 'T1' });
    const result = await handleClickUpWebhookIngest(body, 'sig', store);
    assert.equal(result.logContext.branch, 'unknown-webhook');
    assert.equal(result.logContext.webhookId, 'wh-typo');
    assert.equal(result.logContext.subscriptionId, null);
    assert.equal(result.logContext.storedSecretLen, null);
  });

  it('bad-json logContext still carries body prefix so operators can see what came in', async () => {
    const store = new FakeStore();
    const body = Buffer.from('not-actually-json-{{{');
    const result = await handleClickUpWebhookIngest(body, 'sig', store);
    assert.equal(result.status, 400);
    assert.equal(result.logContext.branch, 'bad-json');
    assert.equal(result.logContext.bodyLen, body.length);
    assert.match(result.logContext.bodyPrefix, /not-actually-json/);
  });

  it('body prefix is capped at 200 bytes even for very large bodies', async () => {
    const store = new FakeStore();
    // Build a payload > 200 bytes; still valid JSON so we exit via
    // missing-webhook-id (not bad-json) — the length-cap applies either way.
    const bigString = 'x'.repeat(1000);
    const body = JSON.stringify({ padding: bigString });
    const result = await handleClickUpWebhookIngest(body, 'sig', store);
    assert.equal(result.status, 400);
    assert.equal(result.logContext.bodyLen, body.length);
    assert.ok(result.logContext.bodyPrefix.length <= 200);
  });

  it('verifies signature over the exact bytes, not a re-stringified body', async () => {
    // Whitespace matters. If the handler stringifies parsed then verifies, it
    // would drift; verifying over the raw buffer prevents that.
    const store = new FakeStore();
    store.subs.push(subscription());
    const bodyWithWhitespace = '{\n  "webhook_id": "wh-abc",\n  "event": "taskCreated",\n  "task_id": "T1"\n}';
    const goodSig = sign('sh4red', bodyWithWhitespace);
    const okRes = await handleClickUpWebhookIngest(bodyWithWhitespace, goodSig, store);
    assert.equal(okRes.status, 200);

    // Same JSON but re-compacted — signature no longer matches.
    const compact = JSON.stringify(JSON.parse(bodyWithWhitespace));
    const wrongSig = sign('sh4red', compact);
    const badRes = await handleClickUpWebhookIngest(bodyWithWhitespace, wrongSig, store);
    assert.equal(badRes.status, 401);
  });
});
