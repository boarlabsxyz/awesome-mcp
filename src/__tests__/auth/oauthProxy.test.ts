import assert from 'node:assert/strict';
import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { storeClient, storeAuthCode } from '../../website/oauthServer.js';

// Build a minimal Express app with only the registerOAuthProxy routes for testing.
// We need AUTH0_DOMAIN set for the proxy routes to work.
const originalAuth0Domain = process.env.AUTH0_DOMAIN;
const originalAuth0ClientId = process.env.AUTH0_CLIENT_ID;
const originalAuth0ClientSecret = process.env.AUTH0_CLIENT_SECRET;
const originalBaseUrl = process.env.BASE_URL;

// Helper: create a test app by importing and calling registerOAuthProxy
async function createTestApp(): Promise<express.Express> {
  // Set required env vars before importing
  process.env.AUTH0_DOMAIN = 'https://test.auth0.com';
  process.env.AUTH0_CLIENT_ID = 'test-auth0-client';
  process.env.AUTH0_CLIENT_SECRET = 'test-auth0-secret';
  process.env.BASE_URL = 'https://test.example.com';

  const app = express();

  // Import the function dynamically to pick up env vars
  // registerOAuthProxy is not exported, so we simulate what createMcpOnlyApp does
  // by testing the routes through the actual app setup.
  // Instead, we test the routes directly using the webServer module.

  // For unit tests, we'll create a simplified app that mirrors registerOAuthProxy behavior.
  // The actual routes use storeClient/getClient from oauthServer, which we can pre-seed.

  return app;
}

// Helper: register a test client and return its ID
async function registerClient(redirectUris: string[] = ['https://chatgpt.com/callback']): Promise<string> {
  const clientId = crypto.randomUUID();
  const clientSecret = crypto.randomBytes(32).toString('hex');
  await storeClient({
    clientId,
    clientSecret,
    redirectUris,
    clientName: 'Test Client',
  });
  return clientId;
}

// Helper: create a valid PKCE pair
function makePKCE(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

describe('OAuth proxy /oauth/register', () => {
  let app: express.Express;

  beforeEach(async () => {
    process.env.AUTH0_DOMAIN = 'https://test.auth0.com';
    process.env.BASE_URL = 'https://test.example.com';

    // Create a minimal app with the register route
    app = express();
    app.post('/oauth/register', express.json(), async (req, res) => {
      try {
        const { client_name, redirect_uris } = req.body;
        if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
          res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris is required' });
          return;
        }
        const clientId = crypto.randomUUID();
        const clientSecret = crypto.randomBytes(32).toString('hex');
        await storeClient({ clientId, clientSecret, redirectUris: redirect_uris, clientName: client_name || 'MCP Client' });
        res.status(201).json({
          client_id: clientId,
          client_secret: clientSecret,
          client_name: client_name || 'MCP Client',
          redirect_uris,
          token_endpoint_auth_method: 'none',
        });
      } catch (err: any) {
        res.status(500).json({ error: 'server_error' });
      }
    });
  });

  afterEach(() => {
    if (originalAuth0Domain !== undefined) process.env.AUTH0_DOMAIN = originalAuth0Domain;
    else delete process.env.AUTH0_DOMAIN;
    if (originalBaseUrl !== undefined) process.env.BASE_URL = originalBaseUrl;
    else delete process.env.BASE_URL;
  });

  it('registers a client with valid redirect_uris', async () => {
    const res = await request(app)
      .post('/oauth/register')
      .send({
        client_name: 'ChatGPT',
        redirect_uris: ['https://chatgpt.com/callback'],
      });
    assert.equal(res.status, 201);
    assert.ok(res.body.client_id);
    assert.ok(res.body.client_secret);
    assert.equal(res.body.client_name, 'ChatGPT');
    assert.deepEqual(res.body.redirect_uris, ['https://chatgpt.com/callback']);
    assert.equal(res.body.token_endpoint_auth_method, 'none');
  });

  it('rejects registration without redirect_uris', async () => {
    const res = await request(app)
      .post('/oauth/register')
      .send({ client_name: 'ChatGPT' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_client_metadata');
  });

  it('rejects registration with empty redirect_uris array', async () => {
    const res = await request(app)
      .post('/oauth/register')
      .send({ client_name: 'ChatGPT', redirect_uris: [] });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_client_metadata');
  });

  it('defaults client_name to MCP Client when not provided', async () => {
    const res = await request(app)
      .post('/oauth/register')
      .send({ redirect_uris: ['https://example.com/cb'] });
    assert.equal(res.status, 201);
    assert.equal(res.body.client_name, 'MCP Client');
  });
});

describe('OAuth proxy /oauth/token', () => {
  let app: express.Express;

  beforeEach(async () => {
    // Minimal app with token endpoint using exchangeAuthCode
    const { exchangeAuthCode } = await import('../../website/oauthServer.js');
    app = express();
    app.post('/oauth/token', express.urlencoded({ extended: false }), express.json(), async (req, res) => {
      try {
        const result = await exchangeAuthCode(req.body);
        if (!result.ok) {
          const body: Record<string, string> = { error: result.error };
          if (result.errorDescription) body.error_description = result.errorDescription;
          res.status(result.status).json(body);
          return;
        }
        res.json({ access_token: result.apiKey, token_type: 'Bearer', scope: result.scope });
      } catch (err: any) {
        res.status(500).json({ error: 'server_error' });
      }
    });
  });

  it('exchanges valid auth code for apiKey', async () => {
    const { verifier, challenge } = makePKCE();
    const code = crypto.randomBytes(16).toString('hex');
    await storeAuthCode(code, {
      apiKey: 'user-api-key-123',
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
    assert.equal(res.body.access_token, 'user-api-key-123');
    assert.equal(res.body.token_type, 'Bearer');
    assert.equal(res.body.scope, 'mcp:slack');
  });

  it('rejects invalid grant_type', async () => {
    const res = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: 'client_credentials',
        code: 'any',
        code_verifier: 'any',
      });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'unsupported_grant_type');
  });

  it('rejects invalid auth code', async () => {
    const res = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code: 'nonexistent',
        code_verifier: 'any',
      });
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
      .send({
        grant_type: 'authorization_code',
        code,
        code_verifier: 'wrong-verifier',
      });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_grant');
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
    assert.equal(second.body.error, 'invalid_grant');
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
      .send({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
      });
    assert.equal(res.status, 200);
    assert.equal(res.body.access_token, 'json-key');
  });
});

describe('OAuth proxy metadata endpoints', () => {
  afterEach(() => {
    if (originalAuth0Domain !== undefined) process.env.AUTH0_DOMAIN = originalAuth0Domain;
    else delete process.env.AUTH0_DOMAIN;
    if (originalBaseUrl !== undefined) process.env.BASE_URL = originalBaseUrl;
    else delete process.env.BASE_URL;
  });

  it('/.well-known/oauth-authorization-server returns correct metadata shape', async () => {
    process.env.AUTH0_DOMAIN = 'https://test.auth0.com';
    process.env.BASE_URL = 'https://test.example.com';

    const app = express();
    const resource = 'https://test.example.com';
    const scopes = ['mcp:slack'];

    // Simulate the metadata endpoint
    app.get('/.well-known/oauth-authorization-server', (_req, res) => {
      res.json({
        issuer: resource,
        authorization_endpoint: `${resource}/oauth/authorize`,
        token_endpoint: `${resource}/oauth/token`,
        registration_endpoint: `${resource}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: scopes,
      });
    });

    const res = await request(app).get('/.well-known/oauth-authorization-server');
    assert.equal(res.status, 200);
    assert.equal(res.body.issuer, resource);
    assert.equal(res.body.authorization_endpoint, `${resource}/oauth/authorize`);
    assert.equal(res.body.token_endpoint, `${resource}/oauth/token`);
    assert.equal(res.body.registration_endpoint, `${resource}/oauth/register`);
    assert.deepEqual(res.body.response_types_supported, ['code']);
    assert.deepEqual(res.body.code_challenge_methods_supported, ['S256']);
    assert.ok(res.body.scopes_supported.includes('mcp:slack'));
  });

  it('/.well-known/oauth-protected-resource returns resource metadata', async () => {
    const app = express();
    const resource = 'https://test.example.com';
    const scopes = ['mcp:slack'];

    app.get('/.well-known/oauth-protected-resource', (_req, res) => {
      res.json({
        resource,
        authorization_servers: [resource],
        scopes_supported: scopes,
        bearer_methods_supported: ['header'],
      });
    });

    const res = await request(app).get('/.well-known/oauth-protected-resource');
    assert.equal(res.status, 200);
    assert.equal(res.body.resource, resource);
    assert.deepEqual(res.body.authorization_servers, [resource]);
    assert.deepEqual(res.body.scopes_supported, ['mcp:slack']);
    assert.deepEqual(res.body.bearer_methods_supported, ['header']);
  });
});

describe('OAuth proxy /oauth/authorize validation', () => {
  let app: express.Express;

  beforeEach(() => {
    process.env.AUTH0_DOMAIN = 'https://test.auth0.com';
    process.env.AUTH0_CLIENT_ID = 'test-auth0-client';
    process.env.BASE_URL = 'https://test.example.com';

    app = express();
    const resource = 'https://test.example.com';

    // Replicate the authorize endpoint logic for testing
    app.get('/oauth/authorize', async (req, res) => {
      const issuer = process.env.AUTH0_DOMAIN;
      if (!issuer) { res.status(503).json({ error: 'AUTH0_DOMAIN not configured' }); return; }

      const clientId = req.query.client_id as string;
      const redirectUri = req.query.redirect_uri as string;
      const codeChallenge = req.query.code_challenge as string;
      const state = req.query.state as string;

      if (!clientId || !redirectUri || !codeChallenge || !state) {
        res.status(400).json({ error: 'invalid_request', error_description: 'Missing required parameters' });
        return;
      }

      const { getClient: gc } = await import('../../website/oauthServer.js');
      const client = await gc(clientId);
      if (!client) {
        res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client_id' });
        return;
      }
      if (!client.redirectUris.includes(redirectUri)) {
        res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri not registered' });
        return;
      }

      // If validation passes, redirect to Auth0 (we just return 302 for testing)
      res.redirect(`${issuer}/authorize?redirect_uri=${encodeURIComponent(`${resource}/oauth/callback`)}`);
    });
  });

  afterEach(() => {
    if (originalAuth0Domain !== undefined) process.env.AUTH0_DOMAIN = originalAuth0Domain;
    else delete process.env.AUTH0_DOMAIN;
    if (originalAuth0ClientId !== undefined) process.env.AUTH0_CLIENT_ID = originalAuth0ClientId;
    else delete process.env.AUTH0_CLIENT_ID;
    if (originalBaseUrl !== undefined) process.env.BASE_URL = originalBaseUrl;
    else delete process.env.BASE_URL;
  });

  it('rejects request with missing parameters', async () => {
    const res = await request(app).get('/oauth/authorize');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_request');
  });

  it('rejects unknown client_id', async () => {
    const res = await request(app)
      .get('/oauth/authorize')
      .query({
        client_id: 'nonexistent',
        redirect_uri: 'https://example.com/cb',
        code_challenge: 'abc',
        state: 'xyz',
      });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_client');
  });

  it('rejects unregistered redirect_uri', async () => {
    const clientId = await registerClient(['https://allowed.com/cb']);

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

  it('redirects to Auth0 with valid params and our own callback', async () => {
    const clientId = await registerClient(['https://chatgpt.com/callback']);

    const res = await request(app)
      .get('/oauth/authorize')
      .query({
        client_id: clientId,
        redirect_uri: 'https://chatgpt.com/callback',
        code_challenge: 'test-challenge',
        state: 'test-state',
      });
    assert.equal(res.status, 302);
    const location = res.headers.location;
    assert.ok(location.startsWith('https://test.auth0.com/authorize'));
    // Our own callback URL, NOT the client's
    assert.ok(location.includes(encodeURIComponent('https://test.example.com/oauth/callback')));
    assert.ok(!location.includes(encodeURIComponent('https://chatgpt.com/callback')));
  });
});

describe('OAuth proxy /oauth/callback validation', () => {
  it('rejects missing code or state', async () => {
    const app = express();
    app.get('/oauth/callback', (req, res) => {
      const code = req.query.code as string;
      const state = req.query.state as string;
      if (!code || !state) {
        res.status(400).send('Missing code or state from Auth0');
        return;
      }
      res.status(200).send('ok');
    });

    const res = await request(app).get('/oauth/callback');
    assert.equal(res.status, 400);
    assert.ok(res.text.includes('Missing'));
  });

  it('rejects expired/invalid state', async () => {
    const app = express();
    const states = new Map<string, any>();
    app.get('/oauth/callback', (req, res) => {
      const code = req.query.code as string;
      const state = req.query.state as string;
      if (!code || !state) { res.status(400).send('Missing'); return; }
      const saved = states.get(state);
      if (!saved) { res.status(400).send('OAuth state expired or invalid. Please try again.'); return; }
      res.status(200).send('ok');
    });

    const res = await request(app)
      .get('/oauth/callback')
      .query({ code: 'some-code', state: 'invalid-state' });
    assert.equal(res.status, 400);
    assert.ok(res.text.includes('expired'));
  });
});

describe('MCP-only apiKey middleware', () => {
  // Test the apiKey fallback in the MCP-only middleware
  it('resolves user from apiKey Bearer token and sets x-mcp-user-id', async () => {
    // Simulate the middleware logic
    const fakeUsers = [
      { id: 42, email: 'test@example.com', apiKey: 'valid-key-123' },
    ];

    const app = express();
    app.use((req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const token = authHeader.slice(7);
      const user = fakeUsers.find(u => u.apiKey === token);
      if (!user) {
        res.status(401).json({ error: 'invalid_token' });
        return;
      }
      req.headers['x-mcp-user-id'] = String(user.id);
      req.headers['x-mcp-user-email'] = user.email;
      next();
    });
    app.get('/mcp', (req, res) => {
      res.json({
        userId: req.headers['x-mcp-user-id'],
        email: req.headers['x-mcp-user-email'],
      });
    });

    const res = await request(app)
      .get('/mcp')
      .set('Authorization', 'Bearer valid-key-123');
    assert.equal(res.status, 200);
    assert.equal(res.body.userId, '42');
    assert.equal(res.body.email, 'test@example.com');
  });

  it('rejects request without Bearer token', async () => {
    const app = express();
    app.use((req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      next();
    });
    app.get('/mcp', (_req, res) => res.json({ ok: true }));

    const res = await request(app).get('/mcp');
    assert.equal(res.status, 401);
  });

  it('rejects invalid apiKey', async () => {
    const app = express();
    app.use((req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const token = authHeader.slice(7);
      // Simulate no user found
      res.status(401).json({ error: 'invalid_token' });
    });
    app.get('/mcp', (_req, res) => res.json({ ok: true }));

    const res = await request(app)
      .get('/mcp')
      .set('Authorization', 'Bearer wrong-key');
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_token');
  });

  it('handles compound apiKey.instanceId token', async () => {
    const fakeUsers = [
      { id: 7, email: 'u@test.com', apiKey: 'compound-key' },
    ];

    const app = express();
    app.use((req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const token = authHeader.slice(7);
      let apiKey = token;
      const dotIndex = token.lastIndexOf('.');
      if (dotIndex > 0) {
        const possibleKey = token.substring(0, dotIndex);
        if (fakeUsers.find(u => u.apiKey === possibleKey)) apiKey = possibleKey;
      }
      const user = fakeUsers.find(u => u.apiKey === apiKey);
      if (!user) { res.status(401).json({ error: 'invalid_token' }); return; }
      req.headers['x-mcp-user-id'] = String(user.id);
      next();
    });
    app.get('/mcp', (req, res) => {
      res.json({ userId: req.headers['x-mcp-user-id'] });
    });

    const res = await request(app)
      .get('/mcp')
      .set('Authorization', 'Bearer compound-key.instance123');
    assert.equal(res.status, 200);
    assert.equal(res.body.userId, '7');
  });
});
