import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import express from 'express';
import request from 'supertest';
import {
  restUsageMiddleware,
  restServiceSlug,
} from '../../usage/restUsageMiddleware.js';
import {
  __setUsagePoolForTests,
  __pendingUsageEvents,
  __resetUsageBufferForTests,
} from '../../usage/usageStore.js';

function makeApp(session?: Record<string, unknown>) {
  const app = express();
  app.use('/api/v1', restUsageMiddleware);
  const auth = (req: any, res: any, next: any) => {
    if (!session) return res.status(401).json({ error: 'no' });
    req.userSession = session;
    next();
  };
  app.get('/api/v1/clickup/tasks/:taskId', auth, (_req, res) => { res.json({ ok: true }); });
  app.get('/api/v1/docs/:documentId', auth, (_req, res) => { res.status(404).json({ error: 'missing' }); });
  // A streamed download whose upstream fails mid-body: headers sent, then destroyed.
  app.get('/api/v1/drive/files/:fileId/download', auth, (_req, res) => {
    res.status(200).setHeader('Content-Type', 'application/octet-stream');
    res.write('partial');
    setImmediate(() => res.destroy());
  });
  return app;
}

// supertest resolves when the response arrives; 'finish' has fired by then,
// but give the event loop one turn so the listener has certainly run.
const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  __resetUsageBufferForTests();
  __setUsagePoolForTests({ query: () => new Promise(() => {}) });
});

afterEach(() => {
  __setUsagePoolForTests(null);
  __resetUsageBufferForTests();
});

describe('restUsageMiddleware', () => {
  it('records an authenticated call under the route TEMPLATE, with query keys only', async () => {
    const app = makeApp({ userId: 7, instanceId: 'i-1', mcpSlug: 'clickup' });
    await request(app).get('/api/v1/clickup/tasks/abc123?include=subtasks').set('User-Agent', 'curl/8.0');
    await settle();

    const events = __pendingUsageEvents();
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.surface, 'rest');
    assert.equal(e.tool, 'GET /api/v1/clickup/tasks/:taskId');
    assert.equal(e.mcpSlug, 'clickup');
    assert.equal(e.userId, 7);
    assert.equal(e.instanceId, 'i-1');
    assert.equal(e.ok, true);
    assert.equal(e.clientName, 'curl/8.0');
    assert.deepEqual(e.argKeys, ['include']);
    assert.equal(e.argPreview, undefined);
  });

  it('records a 4xx as a failure with the status as the kind', async () => {
    const app = makeApp({ userId: 7 });
    await request(app).get('/api/v1/docs/doc-1');
    await settle();
    const e = __pendingUsageEvents()[0];
    assert.equal(e.ok, false);
    assert.equal(e.errorKind, '404');
    assert.equal(e.mcpSlug, 'google-docs');
  });

  it('records a response destroyed mid-stream as aborted, exactly once', async () => {
    const app = makeApp({ userId: 7 });
    await request(app).get('/api/v1/drive/files/f1/download').catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    const events = __pendingUsageEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].ok, false);
    assert.equal(events[0].errorKind, 'aborted');
    assert.equal(events[0].tool, 'GET /api/v1/drive/files/:fileId/download');
  });

  it('records a completed response exactly once', async () => {
    const app = makeApp({ userId: 7, mcpSlug: 'clickup' });
    await request(app).get('/api/v1/clickup/tasks/abc');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(__pendingUsageEvents().length, 1);
  });

  it('records nothing for an unauthenticated call', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/v1/clickup/tasks/abc');
    assert.equal(res.status, 401);
    await settle();
    assert.equal(__pendingUsageEvents().length, 0);
  });
});

describe('restServiceSlug', () => {
  it('prefers the session slug', () => {
    assert.equal(restServiceSlug('/api/v1/docs/x', 'google-docs'), 'google-docs');
  });
  it('maps Google path segments to catalog slugs', () => {
    assert.equal(restServiceSlug('/api/v1/sheets/abc/values?range=A1'), 'google-sheets');
    assert.equal(restServiceSlug('/api/v1/calendars'), 'google-calendar');
  });
  it('falls back to the raw segment', () => {
    assert.equal(restServiceSlug('/api/v1/hubspot/companies'), 'hubspot');
  });
});
