import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import { createWebOnlyApp, createWebApp } from '../website/webServer.js';

// These tests exercise the route registration in registerSharedRoutes()
// via createWebOnlyApp, covering the new code paths without needing
// module mocking (which requires Node >= 22.3).

describe('createWebOnlyApp routes', () => {
  // Create app once for all tests (stateless routes)
  const app = createWebOnlyApp();

  // --- Health & Config (shared routes) ---

  it('GET /health returns 200 with status ok', async () => {
    const res = await request(app).get('/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'ok' });
  });

  it('GET /api/config returns baseUrl and authMode', async () => {
    const res = await request(app).get('/api/config');
    assert.equal(res.status, 200);
    assert.ok(typeof res.body.baseUrl === 'string');
    assert.ok(['dual', 'jwt'].includes(res.body.authMode));
  });

  // --- Redirects ---

  it('GET / redirects to /dashboard', async () => {
    const res = await request(app).get('/');
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /\/dashboard/);
  });

  it('GET /login redirects to /auth/google', async () => {
    const res = await request(app).get('/login');
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /\/auth\/google/);
  });

  // --- Auth-required endpoints return 401 without session ---

  it('GET /api/me returns 401 without session', async () => {
    const res = await request(app).get('/api/me');
    assert.equal(res.status, 401);
  });

  it('GET /api/me/connections returns 401 without session', async () => {
    const res = await request(app).get('/api/me/connections');
    assert.equal(res.status, 401);
  });

  it('GET /api/me/instances returns 401 without session', async () => {
    const res = await request(app).get('/api/me/instances');
    assert.equal(res.status, 401);
  });

  it('PATCH /api/instances/:id returns 401 without session', async () => {
    const res = await request(app)
      .patch('/api/instances/some-id')
      .send({ name: 'New' });
    assert.equal(res.status, 401);
  });

  it('DELETE /api/instances/:id returns 401 without session', async () => {
    const res = await request(app).delete('/api/instances/some-id');
    assert.equal(res.status, 401);
  });

  it('POST /api/regenerate-key returns 401 without session', async () => {
    const res = await request(app).post('/api/regenerate-key');
    assert.equal(res.status, 401);
  });

  it('GET /api/admin/users returns 401 without session', async () => {
    const res = await request(app).get('/api/admin/users');
    assert.equal(res.status, 401);
  });

  // --- Logout (no session needed) ---

  it('POST /api/logout returns success', async () => {
    const res = await request(app).post('/api/logout');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
  });

  // --- Connect routes (no session → redirect) ---

  it('GET /connect/:slug redirects to login when no session', async () => {
    const res = await request(app).get('/connect/google-docs');
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /redirect/);
  });

  it('GET /connect/:slug with name param redirects with name preserved', async () => {
    const res = await request(app).get('/connect/google-docs?name=Work');
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /name/);
  });

  it('GET /connect/:slug with reconnect param redirects to login', async () => {
    const res = await request(app).get('/connect/google-docs?reconnect=inst-123');
    assert.equal(res.status, 302);
  });

  // --- Callback error paths ---

  it('GET /connect/:slug/callback returns 400 without code or state', async () => {
    const res = await request(app).get('/connect/google-docs/callback');
    assert.equal(res.status, 400);
    assert.match(res.text, /Missing authorization code or state/);
  });

  it('GET /connect/:slug/callback returns 400 with only code', async () => {
    const res = await request(app).get('/connect/google-docs/callback?code=abc');
    assert.equal(res.status, 400);
  });

  it('GET /connect/:slug/callback returns 400 with only state', async () => {
    const res = await request(app).get('/connect/google-docs/callback?state=abc');
    assert.equal(res.status, 400);
  });

  it('GET /connect/:slug/callback returns 400 with invalid state', async () => {
    const res = await request(app).get('/connect/google-docs/callback?code=abc&state=invalid-state');
    assert.equal(res.status, 400);
    assert.match(res.text, /Invalid or expired state/);
  });

  // --- Catalog endpoints ---

  it('GET /api/v1/catalogs returns catalogs array', async () => {
    const res = await request(app).get('/api/v1/catalogs');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.catalogs));
  });

  it('GET /api/v1/catalogs/:slug returns 404 for unknown slug', async () => {
    const res = await request(app).get('/api/v1/catalogs/nonexistent');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Catalog not found');
  });

  // --- POST /api/disconnect without session ---

  it('POST /api/disconnect/:slug returns 401 without session', async () => {
    const res = await request(app).post('/api/disconnect/google-docs');
    assert.equal(res.status, 401);
  });

  // --- Auth callback error path ---

  it('GET /auth/callback returns 400 without code', async () => {
    const res = await request(app).get('/auth/callback');
    assert.equal(res.status, 400);
    assert.match(res.text, /Missing authorization code/);
  });
});

describe('createWebApp routes', () => {
  // Use dummy ports - proxies will fail to connect but app creation and
  // route registration code paths will be exercised
  const app = createWebApp(19901, 19902, 19903);

  it('GET /health returns 200', async () => {
    const res = await request(app).get('/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'ok' });
  });

  it('GET /api/config returns baseUrl and authMode', async () => {
    const res = await request(app).get('/api/config');
    assert.equal(res.status, 200);
    assert.ok(res.body.baseUrl);
    assert.ok(['dual', 'jwt'].includes(res.body.authMode));
  });

  it('GET / redirects to /dashboard', async () => {
    const res = await request(app).get('/');
    assert.equal(res.status, 302);
  });

  it('GET /api/me returns 401 without session', async () => {
    const res = await request(app).get('/api/me');
    assert.equal(res.status, 401);
  });

  it('GET /connect/:slug/callback returns 400 without params', async () => {
    const res = await request(app).get('/connect/google-docs/callback');
    assert.equal(res.status, 400);
  });

  it('GET /api/v1/catalogs returns array', async () => {
    const res = await request(app).get('/api/v1/catalogs');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.catalogs));
  });

  it('POST /api/logout returns success', async () => {
    const res = await request(app).post('/api/logout');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
  });

  // --- REST API routes require auth (401 without token) ---

  // Sheets
  it('GET /api/v1/sheets returns 401 without auth', async () => {
    assert.equal((await request(app).get('/api/v1/sheets')).status, 401);
  });
  it('GET /api/v1/sheets/:id returns 401', async () => {
    assert.equal((await request(app).get('/api/v1/sheets/abc')).status, 401);
  });
  it('POST /api/v1/sheets/:id/read returns 401', async () => {
    assert.equal((await request(app).post('/api/v1/sheets/abc/read')).status, 401);
  });
  it('POST /api/v1/sheets/:id/write returns 401', async () => {
    assert.equal((await request(app).post('/api/v1/sheets/abc/write')).status, 401);
  });
  it('POST /api/v1/sheets/:id/append returns 401', async () => {
    assert.equal((await request(app).post('/api/v1/sheets/abc/append')).status, 401);
  });

  // Drive
  it('GET /api/v1/drive/files/:id returns 401', async () => {
    assert.equal((await request(app).get('/api/v1/drive/files/abc')).status, 401);
  });
  it('GET /api/v1/drive/folders/:id/contents returns 401', async () => {
    assert.equal((await request(app).get('/api/v1/drive/folders/abc/contents')).status, 401);
  });
  it('POST /api/v1/drive/folders returns 401', async () => {
    assert.equal((await request(app).post('/api/v1/drive/folders')).status, 401);
  });
  it('POST /api/v1/drive/files/:id/copy returns 401', async () => {
    assert.equal((await request(app).post('/api/v1/drive/files/abc/copy')).status, 401);
  });
  it('DELETE /api/v1/drive/files/:id returns 401', async () => {
    assert.equal((await request(app).delete('/api/v1/drive/files/abc')).status, 401);
  });

  // Gmail
  it('GET /api/v1/gmail/messages returns 401', async () => {
    assert.equal((await request(app).get('/api/v1/gmail/messages')).status, 401);
  });
  it('GET /api/v1/gmail/messages/:id returns 401', async () => {
    assert.equal((await request(app).get('/api/v1/gmail/messages/abc')).status, 401);
  });
  it('POST /api/v1/gmail/messages/send returns 401', async () => {
    assert.equal((await request(app).post('/api/v1/gmail/messages/send')).status, 401);
  });
  it('POST /api/v1/gmail/drafts returns 401', async () => {
    assert.equal((await request(app).post('/api/v1/gmail/drafts')).status, 401);
  });
  it('PATCH /api/v1/gmail/messages/:id returns 401', async () => {
    assert.equal((await request(app).patch('/api/v1/gmail/messages/abc')).status, 401);
  });
  it('DELETE /api/v1/gmail/messages/:id returns 401', async () => {
    assert.equal((await request(app).delete('/api/v1/gmail/messages/abc')).status, 401);
  });

  // Slides
  it('POST /api/v1/slides returns 401', async () => {
    assert.equal((await request(app).post('/api/v1/slides')).status, 401);
  });
  it('GET /api/v1/slides/:id returns 401', async () => {
    assert.equal((await request(app).get('/api/v1/slides/abc')).status, 401);
  });
  it('GET /api/v1/slides/:id/pages/:pageId returns 401', async () => {
    assert.equal((await request(app).get('/api/v1/slides/abc/pages/def')).status, 401);
  });
  it('POST /api/v1/slides/:id/batchUpdate returns 401', async () => {
    assert.equal((await request(app).post('/api/v1/slides/abc/batchUpdate')).status, 401);
  });

  // ClickUp
  it('GET /api/v1/clickup/user returns 401', async () => {
    assert.equal((await request(app).get('/api/v1/clickup/user')).status, 401);
  });
  it('GET /api/v1/clickup/workspaces returns 401', async () => {
    assert.equal((await request(app).get('/api/v1/clickup/workspaces')).status, 401);
  });
  it('GET /api/v1/clickup/lists/:id/tasks returns 401', async () => {
    assert.equal((await request(app).get('/api/v1/clickup/lists/abc/tasks')).status, 401);
  });
  it('GET /api/v1/clickup/tasks/:id returns 401', async () => {
    assert.equal((await request(app).get('/api/v1/clickup/tasks/abc')).status, 401);
  });
  it('POST /api/v1/clickup/lists/:id/tasks returns 401', async () => {
    assert.equal((await request(app).post('/api/v1/clickup/lists/abc/tasks')).status, 401);
  });
  it('PATCH /api/v1/clickup/tasks/:id returns 401', async () => {
    assert.equal((await request(app).patch('/api/v1/clickup/tasks/abc')).status, 401);
  });
  it('DELETE /api/v1/clickup/tasks/:id returns 401', async () => {
    assert.equal((await request(app).delete('/api/v1/clickup/tasks/abc')).status, 401);
  });
  it('GET /api/v1/clickup/tasks/:id/comments returns 401', async () => {
    assert.equal((await request(app).get('/api/v1/clickup/tasks/abc/comments')).status, 401);
  });
  it('POST /api/v1/clickup/tasks/:id/comments returns 401', async () => {
    assert.equal((await request(app).post('/api/v1/clickup/tasks/abc/comments')).status, 401);
  });
  it('GET /api/v1/clickup/lists/:id/fields returns 401', async () => {
    assert.equal((await request(app).get('/api/v1/clickup/lists/abc/fields')).status, 401);
  });
  it('POST /api/v1/clickup/tasks/:id/fields/:fid returns 401', async () => {
    assert.equal((await request(app).post('/api/v1/clickup/tasks/abc/fields/def')).status, 401);
  });
  it('GET /api/v1/clickup/workspaces/:id/tasks/search returns 401', async () => {
    assert.equal((await request(app).get('/api/v1/clickup/workspaces/abc/tasks/search')).status, 401);
  });
  it('GET /api/v1/clickup/workspaces/:id/docs returns 401', async () => {
    assert.equal((await request(app).get('/api/v1/clickup/workspaces/abc/docs')).status, 401);
  });
  it('GET /api/v1/clickup/workspaces/:id/time returns 401', async () => {
    assert.equal((await request(app).get('/api/v1/clickup/workspaces/abc/time')).status, 401);
  });
  it('POST /api/v1/clickup/workspaces/:id/time/start returns 401', async () => {
    assert.equal((await request(app).post('/api/v1/clickup/workspaces/abc/time/start')).status, 401);
  });
  it('POST /api/v1/clickup/workspaces/:id/time/stop returns 401', async () => {
    assert.equal((await request(app).post('/api/v1/clickup/workspaces/abc/time/stop')).status, 401);
  });

});
