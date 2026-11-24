import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ClickUpClient } from '../clickup/apiHelpers.js';
import { performSubscribeToTaskEvents, subscribeToTaskEventsRestSchema, type SubscriptionStore } from '../clickup/restWrites.js';
import type { ClickUpWebhookSubscription } from '../clickup/taskEventStore.js';

// performSubscribeToTaskEvents is the op both the subscribeToTaskEvents tool
// and POST /api/v1/clickup/workspaces/{id}/subscription run. Driven here with a
// real ClickUpClient over a stubbed fetch (so a ClickUp refusal is tagged the
// way the client tags it) and an injected store (no database).

const realFetch = globalThis.fetch;
const savedBase = process.env.BASE_URL;
let posted: Array<{ url: string; body: any }> = [];

function stubClickUp(status: number, json: unknown): void {
  globalThis.fetch = (async (url: any, init: any = {}) => {
    posted.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

function sub(overrides: Partial<ClickUpWebhookSubscription> = {}): ClickUpWebhookSubscription {
  return {
    id: 7, userId: 5, workspaceId: 'W1', clickupWebhookId: 'wh-1', sharedSecret: 'TOP-SECRET',
    events: ['taskCreated'], status: 'active', failCount: 0,
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...overrides,
  };
}

function store(existing: ClickUpWebhookSubscription | null = null): SubscriptionStore & { created: any[] } {
  const created: any[] = [];
  return {
    created,
    findSubscription: async () => existing,
    createSubscription: async (input: any) => { created.push(input); return sub({ ...input }); },
  } as any;
}

describe('performSubscribeToTaskEvents', () => {
  beforeEach(() => { posted = []; process.env.BASE_URL = 'https://mcp.example.test/'; });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = savedBase;
  });

  it('creates the webhook with the default bundle and never returns the shared secret', async () => {
    stubClickUp(200, { id: 'wh-9', webhook: { id: 'wh-9', secret: 'sec-9' } });
    const s = store();
    const r = await performSubscribeToTaskEvents(new ClickUpClient('tok'), 5, 'W1', {}, s);
    assert.equal(r.kind, 'created');
    assert.equal(r.callbackUrl, 'https://mcp.example.test/webhooks/clickup/inbound');
    assert.equal('sharedSecret' in r.subscription, false);
    assert.equal(JSON.stringify(r).includes('sec-9'), false);
    assert.equal(s.created[0].sharedSecret, 'sec-9', 'stored server-side');
    assert.deepEqual(posted[0].body.events, ['taskCreated', 'taskStatusUpdated', 'taskAssigneeUpdated', 'taskMoved', 'taskDeleted']);
    assert.equal(posted[0].body.endpoint, r.callbackUrl);
  });

  it('passes the chosen events through', async () => {
    stubClickUp(200, { id: 'wh-9', webhook: { secret: 'sec-9' } });
    await performSubscribeToTaskEvents(new ClickUpClient('tok'), 5, 'W1', { events: ['taskMoved'] }, store());
    assert.deepEqual(posted[0].body.events, ['taskMoved']);
  });

  it('returns an existing subscription without calling ClickUp, secret redacted', async () => {
    stubClickUp(500, {});
    const r = await performSubscribeToTaskEvents(new ClickUpClient('tok'), 5, 'W1', {}, store(sub()));
    assert.equal(r.kind, 'existing');
    assert.equal(posted.length, 0);
    assert.equal(JSON.stringify(r).includes('TOP-SECRET'), false);
  });

  it('keeps a ClickUp refusal status on .code so the route can answer 404', async () => {
    stubClickUp(404, { err: 'Team not found' });
    await assert.rejects(
      performSubscribeToTaskEvents(new ClickUpClient('tok'), 5, 'W-missing', {}, store()),
      (err: any) => err.code === 404 && /Failed to create ClickUp webhook/.test(err.message),
    );
  });

  it('is ServiceNotConfiguredError (503) without BASE_URL', async () => {
    delete process.env.BASE_URL;
    await assert.rejects(
      performSubscribeToTaskEvents(new ClickUpClient('tok'), 5, 'W1', {}, store()),
      (err: any) => err.name === 'ServiceNotConfiguredError' && err.status === 503,
    );
  });

  it('REST body is strict and limited to the five captured events', () => {
    assert.equal(subscribeToTaskEventsRestSchema.safeParse({}).success, true);
    assert.equal(subscribeToTaskEventsRestSchema.safeParse({ events: ['taskUpdated'] }).success, false);
    assert.equal(subscribeToTaskEventsRestSchema.safeParse({ workspaceId: 'W1' }).success, false);
  });
});
