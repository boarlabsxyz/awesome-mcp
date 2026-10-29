// FastMCP's authenticate trusts `x-mcp-user-id` from loopback, and every
// request reaches it from loopback because this app is the proxy in front of
// it. So the proxy must be the only thing that ever sets that header: a
// client-supplied one forwarded untouched is a sign-in as any user id, on any
// MCP — the Admin MCP included.
//
// These tests stand an echo server in for FastMCP and look at what actually
// arrives behind the real middleware chain.
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';

if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: {
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:8080/auth/callback'],
    },
  });
}

import { createMcpOnlyApp } from '../website/webServer.js';
import { createOrUpdateUser, getUserByGoogleId } from '../userStore.js';

const SPOOFED = {
  'x-mcp-user-id': '1',
  'x-mcp-user-email': 'boss@example.com',
  'x-mcp-user-sub': 'auth0|boss',
};

describe('MCP proxy never forwards client-supplied identity headers', () => {
  let echo: http.Server;
  let received: http.IncomingHttpHeaders[] = [];
  let app: ReturnType<typeof createMcpOnlyApp>;
  let apiKey: string;
  let userId: number;

  before(async () => {
    echo = http.createServer((req, res) => {
      received.push(req.headers);
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
    app = createMcpOnlyApp((echo.address() as AddressInfo).port);

    await createOrUpdateUser(
      { email: 'identity-headers@example.com', googleId: 'google-identity-headers', name: 'Real User' },
      { access_token: 'a', refresh_token: 'r', scope: 'email', token_type: 'Bearer', expiry_date: Date.now() + 3600_000 },
    );
    const user = (await getUserByGoogleId('google-identity-headers'))!;
    apiKey = user.apiKey;
    userId = user.id!;
  });

  after(() => new Promise<void>((r) => echo.close(() => r())));

  const lastForwarded = () => received[received.length - 1];

  it('a query-param apiKey that was never validated does not carry a spoofed identity', async () => {
    received = [];
    await request(app).post('/mcp?apiKey=not-a-real-key').set(SPOOFED).send({});
    for (const h of received) {
      assert.equal(h['x-mcp-user-id'], undefined);
      assert.equal(h['x-mcp-user-email'], undefined);
      assert.equal(h['x-mcp-user-sub'], undefined);
    }
  });

  it('an unvalidated non-JWT bearer does not carry a spoofed identity', async () => {
    received = [];
    await request(app).post('/mcp').set({ ...SPOOFED, authorization: 'Bearer not-a-real-key' }).send({});
    for (const h of received) assert.equal(h['x-mcp-user-id'], undefined);
  });

  it('a JWT-shaped bearer that fails validation does not carry a spoofed identity', async () => {
    received = [];
    const fakeJwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln';
    await request(app).post('/mcp').set({ ...SPOOFED, authorization: `Bearer ${fakeJwt}` }).send({});
    for (const h of received) assert.equal(h['x-mcp-user-id'], undefined);
  });

  it('a valid API key still identifies its own user — and overrides a spoofed id', async () => {
    received = [];
    await request(app).post('/mcp').set({ ...SPOOFED, authorization: `Bearer ${apiKey}` }).send({});
    const h = lastForwarded();
    assert.ok(h, 'the request should reach the MCP server');
    // Either the proxy identified the real user, or it left identification to
    // FastMCP's own API-key check; it must never be the spoofed id.
    assert.notEqual(h['x-mcp-user-id'], SPOOFED['x-mcp-user-id']);
    if (h['x-mcp-user-id'] !== undefined) assert.equal(h['x-mcp-user-id'], String(userId));
    assert.notEqual(h['x-mcp-user-email'], SPOOFED['x-mcp-user-email']);
  });
});
