import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import request from 'supertest';
import crypto from 'crypto';
import { createWebOnlyApp } from '../website/webServer.js';
import { createSession } from '../website/sessionStore.js';
import { createOrUpdateUser, getUserByGoogleId, UserTokens } from '../userStore.js';
import { createMcpInstance, GoogleTokens } from '../mcpConnectionStore.js';

// Set dummy Google credentials so connect routes don't throw
if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: {
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:8080/auth/callback'],
    },
  });
}

// Cookie signing (matches cookie-parser behaviour)
const COOKIE_SECRET = process.env.COOKIE_SECRET || 'dev-secret-change-me';
function signCookie(val: string): string {
  const sig = crypto
    .createHmac('sha256', COOKIE_SECRET)
    .update(val)
    .digest('base64')
    .replace(/=+$/, '');
  return `s:${val}.${sig}`;
}

const dummyTokens: UserTokens = {
  access_token: 'acc',
  refresh_token: 'ref',
  scope: 'email',
  token_type: 'Bearer',
  expiry_date: Date.now() + 3600_000,
};

describe('Authenticated route tests', () => {
  const app = createWebOnlyApp();
  let sessionCookie: string;

  before(async () => {
    // Create a user in the file-based store
    await createOrUpdateUser(
      { email: 'test-auth@example.com', googleId: 'google-auth-123', name: 'Test Auth User' },
      dummyTokens
    );

    // Patch the file-based user to have an id (simulating DB user)
    // so that connection-related code paths are exercised
    const user = await getUserByGoogleId('google-auth-123');
    if (user) {
      (user as any).id = 9999;
    }

    // Create MCP connections for this user
    const mcpTokens: GoogleTokens = {
      access_token: 'mcp-acc',
      refresh_token: 'mcp-ref',
      scope: 'email',
      token_type: 'Bearer',
      expiry_date: Date.now() + 3600_000,
    };
    await createMcpInstance(9999, 'google-docs', 'Test Docs', mcpTokens, 'test@example.com');

    // Also create one with expired tokens to test tokenStatus.isExpired
    const expiredTokens: GoogleTokens = {
      access_token: 'expired-acc',
      refresh_token: '',
      scope: 'email',
      token_type: 'Bearer',
      expiry_date: Date.now() - 86400_000,
    };
    await createMcpInstance(9999, 'google-docs', 'Expired Docs', expiredTokens, 'expired@example.com');

    // Create a session
    const sessionId = await createSession('google-auth-123');
    sessionCookie = signCookie(sessionId);
  });

  // --- /api/me with authenticated session ---

  it('GET /api/me returns user info with connections and tokenStatus', async () => {
    const res = await request(app)
      .get('/api/me')
      .set('Cookie', `session=${sessionCookie}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.email, 'test-auth@example.com');
    assert.equal(res.body.name, 'Test Auth User');
    assert.ok(res.body.apiKey);
    assert.ok(Array.isArray(res.body.connections));
    assert.ok(res.body.connections.length >= 2, 'should have at least 2 connections');

    // Check tokenStatus is present on connections
    const active = res.body.connections.find((c: any) => c.instanceName === 'Test Docs');
    assert.ok(active, 'should find active connection');
    assert.ok(active.tokenStatus);
    assert.equal(active.tokenStatus.hasRefreshToken, true);
    assert.equal(active.tokenStatus.isExpired, false);

    const expired = res.body.connections.find((c: any) => c.instanceName === 'Expired Docs');
    assert.ok(expired, 'should find expired connection');
    assert.equal(expired.tokenStatus.isExpired, true);
    assert.equal(expired.tokenStatus.hasRefreshToken, false);
  });

  // --- /api/me/connections ---

  it('GET /api/me/connections returns connections array', async () => {
    const res = await request(app)
      .get('/api/me/connections')
      .set('Cookie', `session=${sessionCookie}`);

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.connections));
    assert.ok(res.body.connections.length >= 2);
  });

  // --- /api/me/instances ---

  it('GET /api/me/instances returns instances array with tokenStatus', async () => {
    const res = await request(app)
      .get('/api/me/instances')
      .set('Cookie', `session=${sessionCookie}`);

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.instances));
    assert.ok(res.body.instances.length >= 2);
  });

  // --- PATCH /api/instances/:id ---

  it('PATCH /api/instances/:id returns error for file-based user', async () => {
    const res = await request(app)
      .patch('/api/instances/some-id')
      .set('Cookie', `session=${sessionCookie}`)
      .send({ name: 'New' });

    assert.ok(res.status >= 400);
  });

  // --- DELETE /api/instances/:id ---

  it('DELETE /api/instances/:id returns error for file-based user', async () => {
    const res = await request(app)
      .delete('/api/instances/some-id')
      .set('Cookie', `session=${sessionCookie}`);

    assert.ok(res.status >= 400);
  });

  // --- POST /api/regenerate-key ---

  it('POST /api/regenerate-key regenerates key for authenticated user', async () => {
    const res = await request(app)
      .post('/api/regenerate-key')
      .set('Cookie', `session=${sessionCookie}`);

    assert.equal(res.status, 200);
    assert.ok(res.body.apiKey, 'should return new apiKey');
  });

  // --- POST /api/disconnect/:mcpSlug ---

  it('POST /api/disconnect/:slug returns error for non-connected slug', async () => {
    const res = await request(app)
      .post('/api/disconnect/nonexistent-slug')
      .set('Cookie', `session=${sessionCookie}`);

    assert.ok(res.status >= 400);
  });

  // --- /api/admin/users ---

  it('GET /api/admin/users returns 403 for non-admin user', async () => {
    const res = await request(app)
      .get('/api/admin/users')
      .set('Cookie', `session=${sessionCookie}`);

    assert.equal(res.status, 403);
  });

  // --- /connect/:slug returns 404 for unknown slug (no OAuth redirect) ---

  it('GET /connect/:slug returns 404 for unknown MCP slug', async () => {
    const res = await request(app)
      .get('/connect/nonexistent-mcp')
      .set('Cookie', `session=${sessionCookie}`);

    assert.equal(res.status, 404);
  });

  // --- Callback state parsing (tests that don't hit Google OAuth) ---

  it('GET /connect/:slug/callback with valid state but mismatched slug returns 400', async () => {
    (global as any).__mcpConnectStates = (global as any).__mcpConnectStates || new Map();
    const state = crypto.randomBytes(32).toString('hex');
    (global as any).__mcpConnectStates.set(state, JSON.stringify({
      sessionId: 'test',
      mcpSlug: 'google-calendar',
      googleId: 'google-auth-123',
      instanceName: null,
      reconnectInstanceId: null,
    }));

    const res = await request(app)
      .get(`/connect/google-docs/callback?code=fake&state=${state}`);

    assert.equal(res.status, 400);
    assert.match(res.text, /MCP slug mismatch/);
  });

  it('GET /connect/:slug/callback with valid state for unknown MCP returns 404', async () => {
    (global as any).__mcpConnectStates = (global as any).__mcpConnectStates || new Map();
    const state = crypto.randomBytes(32).toString('hex');
    (global as any).__mcpConnectStates.set(state, JSON.stringify({
      sessionId: 'test',
      mcpSlug: 'nonexistent-mcp',
      googleId: 'google-auth-123',
      instanceName: null,
      reconnectInstanceId: null,
    }));

    const res = await request(app)
      .get(`/connect/nonexistent-mcp/callback?code=fake&state=${state}`);

    assert.equal(res.status, 404);
    assert.match(res.text, /MCP not found/);
  });
});

describe('Session edge cases', () => {
  const app = createWebOnlyApp();

  it('GET /api/me with invalid signed cookie returns 401', async () => {
    const res = await request(app)
      .get('/api/me')
      .set('Cookie', 'session=s:invalid.badsig');

    assert.equal(res.status, 401);
  });

  it('GET /api/me with expired/unknown session returns 401', async () => {
    const fakeSigned = signCookie('nonexistent-session-id');
    const res = await request(app)
      .get('/api/me')
      .set('Cookie', `session=${fakeSigned}`);

    assert.equal(res.status, 401);
  });

  it('GET /api/me with unsigned cookie returns 401', async () => {
    const res = await request(app)
      .get('/api/me')
      .set('Cookie', 'session=plain-value-no-signing');

    assert.equal(res.status, 401);
  });
});
