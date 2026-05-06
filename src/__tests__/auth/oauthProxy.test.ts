import assert from 'node:assert/strict';
import { describe, it, before, afterEach, mock } from 'node:test';
import request from 'supertest';
import crypto from 'crypto';
import { createMcpOnlyApp } from '../../website/webServer.js';
import { storeClient, storeAuthCode, getClient } from '../../website/oauthServer.js';
import { createOrUpdateUser, UserTokens } from '../../userStore.js';

// --- Environment setup ---
// Set required env vars before the app is created
const originalEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string) {
  if (!(key in originalEnv)) originalEnv[key] = process.env[key];
  process.env[key] = value;
}

function restoreEnv() {
  for (const [key, val] of Object.entries(originalEnv)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
}

// Set env before importing / creating the app
setEnv('AUTH0_DOMAIN', 'https://test.auth0.com');
setEnv('AUTH0_CLIENT_ID', 'test-auth0-client');
setEnv('AUTH0_CLIENT_SECRET', 'test-auth0-secret');
setEnv('AUTH0_AUDIENCE', 'https://test.example.com');
setEnv('BASE_URL', 'https://test.example.com');
setEnv('MCP_SLUG', 'slack');
setEnv('MCP_BASE_URL', 'https://test.example.com');
setEnv('DUAL_AUTH_MODE', 'false');

// Set dummy Google credentials so imports don't throw
if (!process.env.GOOGLE_CREDENTIALS) {
  setEnv('GOOGLE_CREDENTIALS', JSON.stringify({
    web: {
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:8080/auth/callback'],
    },
  }));
}

// Create test user in the store
const dummyTokens: UserTokens = {
  access_token: 'acc',
  refresh_token: 'ref',
  scope: 'email',
  token_type: 'Bearer',
  expiry_date: Date.now() + 3600_000,
};

// Helper: PKCE pair
function makePKCE(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// Helper: mock global.fetch for Auth0 calls
function mockFetch(responses: Record<string, { status: number; body: any }>) {
  const originalFetch = globalThis.fetch;
  const mockFn = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const [pattern, resp] of Object.entries(responses)) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(resp.body), {
          status: resp.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    // Fall through to real fetch for non-mocked URLs
    return originalFetch(input, init);
  });
  globalThis.fetch = mockFn as any;
  return () => { globalThis.fetch = originalFetch; };
}

// The real app — created once, uses actual registerOAuthProxy routes
const app = createMcpOnlyApp(39999); // port doesn't matter for OAuth tests

describe('OAuth proxy routes (real app)', () => {
  let testUser: any;

  before(async () => {
    testUser = await createOrUpdateUser(
      { email: 'oauth-test@example.com', googleId: 'google-oauth-test', name: 'OAuth Test' },
      dummyTokens,
    );
  });

  afterEach(() => {
    // Env is restored at the end of the whole file
  });

  // --- /oauth/register ---

  describe('POST /oauth/register', () => {
    it('registers a client with valid redirect_uris', async () => {
      const res = await request(app)
        .post('/oauth/register')
        .send({
          client_name: 'ChatGPT Test',
          redirect_uris: ['https://chatgpt.com/callback'],
        });
      assert.equal(res.status, 201);
      assert.ok(res.body.client_id);
      assert.ok(res.body.client_secret);
      assert.equal(res.body.client_name, 'ChatGPT Test');
      assert.deepEqual(res.body.redirect_uris, ['https://chatgpt.com/callback']);
      assert.equal(res.body.token_endpoint_auth_method, 'none');

      // Verify client was actually stored
      const stored = await getClient(res.body.client_id);
      assert.ok(stored);
      assert.equal(stored!.clientName, 'ChatGPT Test');
    });

    it('rejects registration without redirect_uris', async () => {
      const res = await request(app)
        .post('/oauth/register')
        .send({ client_name: 'Bad Client' });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'invalid_client_metadata');
    });

    it('rejects registration with empty redirect_uris array', async () => {
      const res = await request(app)
        .post('/oauth/register')
        .send({ client_name: 'Bad Client', redirect_uris: [] });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'invalid_client_metadata');
    });

    it('defaults client_name to MCP Client', async () => {
      const res = await request(app)
        .post('/oauth/register')
        .send({ redirect_uris: ['https://example.com/cb'] });
      assert.equal(res.status, 201);
      assert.equal(res.body.client_name, 'MCP Client');
    });
  });

  // --- /oauth/authorize ---

  describe('GET /oauth/authorize', () => {
    it('rejects request with missing parameters', async () => {
      const res = await request(app).get('/oauth/authorize');
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'invalid_request');
    });

    it('rejects unknown client_id', async () => {
      const res = await request(app)
        .get('/oauth/authorize')
        .query({
          client_id: 'nonexistent-id',
          redirect_uri: 'https://example.com/cb',
          code_challenge: 'abc',
          state: 'xyz',
        });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'invalid_client');
    });

    it('rejects unregistered redirect_uri', async () => {
      // First register a client
      const regRes = await request(app)
        .post('/oauth/register')
        .send({ client_name: 'Test', redirect_uris: ['https://allowed.com/cb'] });
      const clientId = regRes.body.client_id;

      const res = await request(app)
        .get('/oauth/authorize')
        .query({
          client_id: clientId,
          redirect_uri: 'https://evil.com/cb',
          code_challenge: 'abc',
          state: 'xyz',
        });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'invalid_request');
      assert.ok(res.body.error_description.includes('redirect_uri'));
    });

    it('redirects to Auth0 with our own callback URL', async () => {
      const regRes = await request(app)
        .post('/oauth/register')
        .send({ redirect_uris: ['https://chatgpt.com/callback'] });
      const clientId = regRes.body.client_id;

      const res = await request(app)
        .get('/oauth/authorize')
        .query({
          client_id: clientId,
          redirect_uri: 'https://chatgpt.com/callback',
          code_challenge: 'test-challenge',
          code_challenge_method: 'S256',
          state: 'client-state-123',
          scope: 'mcp:slack',
        });

      assert.equal(res.status, 302);
      const location = res.headers.location;
      // Should redirect to Auth0
      assert.ok(location.startsWith('https://test.auth0.com/authorize'));
      // Should use OUR callback, not the client's
      assert.ok(location.includes(encodeURIComponent('https://test.example.com/oauth/callback')));
      assert.ok(!location.includes(encodeURIComponent('https://chatgpt.com/callback')));
      // Should include our Auth0 client ID
      assert.ok(location.includes('client_id=test-auth0-client'));
    });
  });

  // --- /oauth/callback ---

  describe('GET /oauth/callback', () => {
    it('rejects missing code or state', async () => {
      const res = await request(app).get('/oauth/callback');
      assert.equal(res.status, 400);
      assert.ok(res.text.includes('Missing'));
    });

    it('rejects invalid/expired state', async () => {
      const res = await request(app)
        .get('/oauth/callback')
        .query({ code: 'auth0-code', state: 'nonexistent-state' });
      assert.equal(res.status, 400);
      assert.ok(res.text.includes('expired'));
    });

    it('handles Auth0 token exchange failure', async () => {
      // Register a client and trigger /authorize to store state
      const regRes = await request(app)
        .post('/oauth/register')
        .send({ redirect_uris: ['https://chatgpt.com/cb'] });
      const clientId = regRes.body.client_id;

      const authRes = await request(app)
        .get('/oauth/authorize')
        .query({
          client_id: clientId,
          redirect_uri: 'https://chatgpt.com/cb',
          code_challenge: 'challenge',
          state: 'st',
        });

      // Extract the internal state from the Auth0 redirect URL
      const auth0Url = new URL(authRes.headers.location);
      const internalState = auth0Url.searchParams.get('state')!;

      // Mock Auth0 token exchange to fail
      const restore = mockFetch({
        '/oauth/token': { status: 400, body: { error: 'invalid_grant' } },
      });

      const res = await request(app)
        .get('/oauth/callback')
        .query({ code: 'bad-auth0-code', state: internalState });
      assert.equal(res.status, 502);
      assert.ok(res.text.includes('Authentication failed'));

      restore();
    });

    it('handles Auth0 /userinfo failure', async () => {
      const regRes = await request(app)
        .post('/oauth/register')
        .send({ redirect_uris: ['https://chatgpt.com/cb2'] });
      const clientId = regRes.body.client_id;

      const authRes = await request(app)
        .get('/oauth/authorize')
        .query({
          client_id: clientId,
          redirect_uri: 'https://chatgpt.com/cb2',
          code_challenge: 'ch',
          state: 'st2',
        });
      const internalState = new URL(authRes.headers.location).searchParams.get('state')!;

      const restore = mockFetch({
        '/oauth/token': { status: 200, body: { access_token: 'auth0-token' } },
        '/userinfo': { status: 401, body: { error: 'unauthorized' } },
      });

      const res = await request(app)
        .get('/oauth/callback')
        .query({ code: 'good-code', state: internalState });
      assert.equal(res.status, 502);
      assert.ok(res.text.includes('identify user'));

      restore();
    });

    it('rejects user not in database', async () => {
      const regRes = await request(app)
        .post('/oauth/register')
        .send({ redirect_uris: ['https://chatgpt.com/cb3'] });
      const clientId = regRes.body.client_id;

      const authRes = await request(app)
        .get('/oauth/authorize')
        .query({
          client_id: clientId,
          redirect_uri: 'https://chatgpt.com/cb3',
          code_challenge: 'ch',
          state: 'st3',
        });
      const internalState = new URL(authRes.headers.location).searchParams.get('state')!;

      const restore = mockFetch({
        '/oauth/token': { status: 200, body: { access_token: 'tok' } },
        '/userinfo': { status: 200, body: { email: 'unknown@nowhere.com', sub: 'auth0|999' } },
      });

      const res = await request(app)
        .get('/oauth/callback')
        .query({ code: 'code', state: internalState });
      assert.equal(res.status, 403);
      assert.ok(res.text.includes('Account Not Found'));
      assert.ok(res.text.includes('unknown@nowhere.com'));

      restore();
    });

    it('issues auth code and redirects to client on success', async () => {
      const regRes = await request(app)
        .post('/oauth/register')
        .send({ redirect_uris: ['https://chatgpt.com/success-cb'] });
      const clientId = regRes.body.client_id;

      const authRes = await request(app)
        .get('/oauth/authorize')
        .query({
          client_id: clientId,
          redirect_uri: 'https://chatgpt.com/success-cb',
          code_challenge: 'ch',
          state: 'original-state',
          scope: 'mcp:slack',
        });
      const internalState = new URL(authRes.headers.location).searchParams.get('state')!;

      const restore = mockFetch({
        '/oauth/token': { status: 200, body: { access_token: 'auth0-access-tok' } },
        '/userinfo': { status: 200, body: { email: 'oauth-test@example.com', sub: 'auth0|test' } },
      });

      const res = await request(app)
        .get('/oauth/callback')
        .query({ code: 'valid-auth0-code', state: internalState });

      assert.equal(res.status, 302);
      const location = new URL(res.headers.location);
      assert.equal(location.origin, 'https://chatgpt.com');
      assert.equal(location.pathname, '/success-cb');
      // Should have our auth code and the original client state
      assert.ok(location.searchParams.get('code'));
      assert.equal(location.searchParams.get('state'), 'original-state');

      restore();
    });
  });

  // --- /oauth/token ---

  describe('POST /oauth/token', () => {
    it('exchanges valid auth code for apiKey', async () => {
      const { verifier, challenge } = makePKCE();
      const code = crypto.randomBytes(16).toString('hex');
      await storeAuthCode(code, {
        apiKey: testUser.apiKey,
        clientId: 'client-1',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        redirectUri: 'https://chatgpt.com/callback',
        expiresAt: Date.now() + 600_000,
        scope: 'mcp:slack',
      });

      const res = await request(app)
        .post('/oauth/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id: 'client-1',
          redirect_uri: 'https://chatgpt.com/callback',
        });

      assert.equal(res.status, 200);
      assert.equal(res.body.access_token, testUser.apiKey);
      assert.equal(res.body.token_type, 'Bearer');
      assert.equal(res.body.scope, 'mcp:slack');
    });

    it('rejects invalid grant_type', async () => {
      const res = await request(app)
        .post('/oauth/token')
        .type('form')
        .send({ grant_type: 'client_credentials', code: 'x', code_verifier: 'x' });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'unsupported_grant_type');
    });

    it('rejects expired/invalid auth code', async () => {
      const res = await request(app)
        .post('/oauth/token')
        .type('form')
        .send({ grant_type: 'authorization_code', code: 'nonexistent', code_verifier: 'x' });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'invalid_grant');
    });

    it('rejects wrong PKCE verifier', async () => {
      const { challenge } = makePKCE();
      const code = crypto.randomBytes(16).toString('hex');
      await storeAuthCode(code, {
        apiKey: 'key',
        clientId: 'c1',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        redirectUri: 'https://example.com/cb',
        expiresAt: Date.now() + 600_000,
      });

      const res = await request(app)
        .post('/oauth/token')
        .type('form')
        .send({ grant_type: 'authorization_code', code, code_verifier: 'wrong' });
      assert.equal(res.status, 400);
      assert.ok(res.body.error_description.includes('PKCE'));
    });

    it('prevents auth code reuse', async () => {
      const { verifier, challenge } = makePKCE();
      const code = crypto.randomBytes(16).toString('hex');
      await storeAuthCode(code, {
        apiKey: 'key',
        clientId: 'c1',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        redirectUri: 'https://example.com/cb',
        expiresAt: Date.now() + 600_000,
      });

      const first = await request(app)
        .post('/oauth/token')
        .type('form')
        .send({ grant_type: 'authorization_code', code, code_verifier: verifier });
      assert.equal(first.status, 200);

      const second = await request(app)
        .post('/oauth/token')
        .type('form')
        .send({ grant_type: 'authorization_code', code, code_verifier: verifier });
      assert.equal(second.status, 400);
    });

    it('accepts JSON content type', async () => {
      const { verifier, challenge } = makePKCE();
      const code = crypto.randomBytes(16).toString('hex');
      await storeAuthCode(code, {
        apiKey: 'json-key',
        clientId: 'c1',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        redirectUri: 'https://example.com/cb',
        expiresAt: Date.now() + 600_000,
        scope: 'mcp',
      });

      const res = await request(app)
        .post('/oauth/token')
        .send({ grant_type: 'authorization_code', code, code_verifier: verifier });
      assert.equal(res.status, 200);
      assert.equal(res.body.access_token, 'json-key');
    });
  });

  // --- Metadata endpoints ---

  describe('GET /.well-known/oauth-protected-resource', () => {
    it('returns resource metadata', async () => {
      const res = await request(app).get('/.well-known/oauth-protected-resource');
      assert.equal(res.status, 200);
      assert.equal(res.body.resource, 'https://test.example.com');
      assert.deepEqual(res.body.authorization_servers, ['https://test.example.com']);
      assert.ok(Array.isArray(res.body.scopes_supported));
      assert.deepEqual(res.body.bearer_methods_supported, ['header']);
    });
  });

  describe('GET /.well-known/oauth-authorization-server', () => {
    it('returns authorization server metadata with rewritten endpoints', async () => {
      const restore = mockFetch({
        '/.well-known/oauth-authorization-server': {
          status: 200,
          body: {
            issuer: 'https://test.auth0.com',
            authorization_endpoint: 'https://test.auth0.com/authorize',
            token_endpoint: 'https://test.auth0.com/oauth/token',
            scopes_supported: ['openid', 'email'],
          },
        },
      });

      const res = await request(app).get('/.well-known/oauth-authorization-server');
      assert.equal(res.status, 200);
      // Endpoints should be rewritten to point to our server
      assert.equal(res.body.authorization_endpoint, 'https://test.example.com/oauth/authorize');
      assert.equal(res.body.token_endpoint, 'https://test.example.com/oauth/token');
      assert.equal(res.body.registration_endpoint, 'https://test.example.com/oauth/register');
      assert.ok(Array.isArray(res.body.scopes_supported));

      restore();
    });
  });

  // --- Health check ---

  describe('GET /health', () => {
    it('returns 200', async () => {
      const res = await request(app).get('/health');
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { status: 'ok' });
    });
  });

  // --- MCP-only apiKey middleware ---

  describe('MCP-only auth middleware (POST /mcp)', () => {
    it('rejects request without Authorization header', async () => {
      const res = await request(app).post('/mcp');
      assert.equal(res.status, 401);
    });

    it('authenticates valid apiKey via Bearer header', async () => {
      // The request will hit the middleware which should resolve the user,
      // then proxy to the internal MCP port (which won't be running).
      // We expect either a proxy error (502/503) or success — NOT 401.
      const res = await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${testUser.apiKey}`);
      // Should NOT be 401 — the middleware accepted the apiKey
      assert.notEqual(res.status, 401, 'Expected apiKey to be accepted by middleware');
    });

    it('rejects invalid apiKey', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Authorization', 'Bearer totally-invalid-key');
      assert.equal(res.status, 401);
    });

    it('handles compound apiKey.instanceId format', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${testUser.apiKey}.someInstanceId`);
      // Should NOT be 401 — the apiKey part is valid
      assert.notEqual(res.status, 401, 'Expected compound apiKey to be accepted');
    });
  });
});
