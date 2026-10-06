// src/__tests__/restRoutes.browserbase.test.ts
// Drives the Browserbase REST handlers with a real bearer, which is the only
// way to show the parts the auth-gate test cannot: that the path's sessionId
// reaches the right upstream, that domain rules are enforced on navigate, that
// an upstream 404 comes back as a 404 rather than a flat 500, and that
// ?format=text renders the same thing the MCP tool does.
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import request from 'supertest';

import { createWebOnlyApp } from '../website/webServer.js';
import { createOrUpdateUser, getUserByGoogleId, UserTokens } from '../userStore.js';
import { createMcpInstance, GoogleTokens } from '../mcpConnectionStore.js';
import { createMcpCatalog } from '../mcpCatalogStore.js';

if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: {
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:8080/auth/callback'],
    },
  });
}

const dummyTokens: UserTokens = {
  access_token: 'acc', refresh_token: 'ref', scope: 'email',
  token_type: 'Bearer', expiry_date: Date.now() + 3600_000,
};
const emptyGoogleTokens: GoogleTokens = {
  access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0,
};

function jsonRes(body: unknown, status = 200): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** Routes the MCP handshake to the hosted stub and everything else to REST. */
function mockUpstreams(opts: { toolText?: string; toolIsError?: boolean; rest?: any; restStatus?: number } = {}) {
  const calls: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: u, body });
    if (u.includes('mcp.browserbase.com')) {
      if (body?.method === 'initialize') {
        return jsonRes({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } });
      }
      if (body?.method === 'notifications/initialized') return jsonRes('', 202);
      return jsonRes({
        jsonrpc: '2.0',
        id: body.id,
        result: { isError: opts.toolIsError === true, content: [{ type: 'text', text: opts.toolText ?? '' }] },
      });
    }
    return jsonRes(opts.rest ?? {}, opts.restStatus ?? 200);
  }) as any;
  return calls;
}

describe('REST data plane: Browserbase handlers', () => {
  const app = createWebOnlyApp();
  const realFetch = globalThis.fetch;
  let apiKey: string;
  let rulesApiKey: string;

  before(async () => {
    await createMcpCatalog({
      slug: 'browserbase', name: 'Browserbase MCP', description: 'test',
      iconUrl: '', mcpUrl: '/browserbase', provider: 'browserbase', scopes: [],
      googleClientId: null, googleClientSecret: null, oauthScopes: [],
      isLocal: true, isActive: true,
    });

    // One account with no rules, one with an allowlist — the denial path needs
    // a connection that actually carries rules.
    await createOrUpdateUser(
      { email: 'bb-rest@example.com', googleId: 'google-bb-rest', name: 'BB Rest' },
      dummyTokens,
    );
    const open = await getUserByGoogleId('google-bb-rest');
    apiKey = (open as any).apiKey;
    await createMcpInstance(
      (open as any).id, 'browserbase', 'BB Rest Open', emptyGoogleTokens, null,
      'browserbase', { access_token: 'bb_live_k' } as any, null,
    );

    await createOrUpdateUser(
      { email: 'bb-rest-rules@example.com', googleId: 'google-bb-rest-rules', name: 'BB Rest Rules' },
      dummyTokens,
    );
    const restricted = await getUserByGoogleId('google-bb-rest-rules');
    rulesApiKey = (restricted as any).apiKey;
    await createMcpInstance(
      (restricted as any).id, 'browserbase', 'BB Rest Restricted', emptyGoogleTokens, null,
      'browserbase',
      { access_token: 'bb_live_k', accessRules: { allowedDomains: ['example.com'], blockedDomains: [] } } as any,
      null,
    );
  });

  after(() => { globalThis.fetch = realFetch; });

  const get = (path: string, key = apiKey) =>
    request(app).get(path).set('Authorization', `Bearer ${key}`);
  const post = (path: string, body: unknown = {}, key = apiKey) =>
    request(app).post(path).set('Authorization', `Bearer ${key}`).send(body as any);

  it('lists sessions as JSON, reporting how many are running', async () => {
    mockUpstreams({ rest: [{ id: 'a', status: 'RUNNING' }, { id: 'b', status: 'COMPLETED' }] });
    const res = await get('/api/v1/browserbase/sessions');
    assert.equal(res.status, 200);
    assert.equal(res.body.sessions.length, 2);
    // The reason this endpoint exists: a caller sweeping for stragglers should
    // not have to count them itself.
    assert.equal(res.body.running, 1);
  });

  it('forwards the status filter upstream', async () => {
    const calls = mockUpstreams({ rest: [] });
    await get('/api/v1/browserbase/sessions?status=RUNNING');
    assert.match(calls[0].url, /\/sessions\?status=RUNNING$/);
  });

  it('renders ?format=text with the same formatter the MCP tool uses', async () => {
    mockUpstreams({ rest: [{ id: 'a', status: 'RUNNING' }] });
    const res = await get('/api/v1/browserbase/sessions?format=text');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/plain/);
    assert.match(res.text, /1 still RUNNING and billing/);
  });

  it('gets one session by the path id', async () => {
    const calls = mockUpstreams({ rest: { id: 'sess-1', status: 'RUNNING' } });
    const res = await get('/api/v1/browserbase/sessions/sess-1');
    assert.equal(res.status, 200);
    assert.equal(res.body.id, 'sess-1');
    assert.match(calls[0].url, /\/sessions\/sess-1$/);
  });

  it('answers a real 404 for an unknown session, not a flat 500', async () => {
    // BrowserbaseClient puts the upstream status on `.status`, which
    // sendUpstreamError reads directly — no translation step, unlike ClickUp's
    // symbol-tagged status, which is why ~24 of its routes still 500 here.
    mockUpstreams({ rest: 'not found', restStatus: 404 });
    const res = await get('/api/v1/browserbase/sessions/gone');
    assert.equal(res.status, 404);
    assert.ok(res.body.error);
  });

  it('starts a session and answers 201 with the id to thread', async () => {
    mockUpstreams({ toolText: '{"sessionId":"sess-9"}', rest: { id: 'sess-9', status: 'RUNNING' } });
    const res = await post('/api/v1/browserbase/sessions/start');
    assert.equal(res.status, 201);
    assert.equal(res.body.sessionId, 'sess-9');
    assert.match(res.body.dashboardUrl, /browserbase\.com\/sessions\/sess-9/);
    assert.match(res.body.note, /every later call/);
  });

  it('takes sessionId from the PATH and sends it upstream', async () => {
    // The body schema omits sessionId on purpose, so a URL and a body can never
    // disagree about which browser to drive.
    const calls = mockUpstreams({ toolText: 'loaded' });
    const res = await post('/api/v1/browserbase/sessions/sess-1/navigate', { url: 'https://example.com/p' });
    assert.equal(res.status, 200);
    assert.equal(res.body.sessionId, 'sess-1');
    const toolCall = calls.find(c => c.body?.method === 'tools/call');
    assert.deepEqual(toolCall!.body.params.arguments, { url: 'https://example.com/p', sessionId: 'sess-1' });
  });

  it('ignores a sessionId smuggled into the body', async () => {
    const calls = mockUpstreams({ toolText: 'loaded' });
    await post('/api/v1/browserbase/sessions/sess-1/navigate', {
      url: 'https://example.com/p', sessionId: 'sess-other',
    });
    const toolCall = calls.find(c => c.body?.method === 'tools/call');
    assert.equal(toolCall!.body.params.arguments.sessionId, 'sess-1');
  });

  it('400s on an invalid body, naming the issues', async () => {
    mockUpstreams({ toolText: 'loaded' });
    const res = await post('/api/v1/browserbase/sessions/sess-1/navigate', {});
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Invalid request body/);
    assert.ok(res.body.issues, 'expected flattened zod issues');
  });

  it('enforces domain rules on navigate, with 403 rather than 502', async () => {
    // A denial is the caller's URL being out of bounds, not an upstream fault —
    // so a client can tell it from a 502 and knows a retry will not help.
    mockUpstreams({ toolText: 'loaded' });
    const res = await post(
      '/api/v1/browserbase/sessions/sess-1/navigate',
      { url: 'https://other.test' },
      rulesApiKey,
    );
    assert.equal(res.status, 403);
    assert.match(res.body.error, /not on this connection's allowed-domains list/);
  });

  it('allows an on-list URL for the same connection', async () => {
    mockUpstreams({ toolText: 'loaded' });
    const res = await post(
      '/api/v1/browserbase/sessions/sess-1/navigate',
      { url: 'https://app.example.com' },
      rulesApiKey,
    );
    assert.equal(res.status, 200);
  });

  it('observes and extracts, with instruction optional only on extract', async () => {
    mockUpstreams({ toolText: 'found it' });
    const observed = await post('/api/v1/browserbase/sessions/sess-1/observe', { instruction: 'find the form' });
    assert.equal(observed.status, 200);
    assert.equal(observed.body.result, 'found it');

    // extract's instruction is optional — omitting it means "the page text".
    const extracted = await post('/api/v1/browserbase/sessions/sess-1/extract', {});
    assert.equal(extracted.status, 200);

    const badObserve = await post('/api/v1/browserbase/sessions/sess-1/observe', {});
    assert.equal(badObserve.status, 400);
  });

  it('releases a session', async () => {
    const calls = mockUpstreams({ rest: { id: 'sess-1', status: 'REQUEST_RELEASE' } });
    const res = await post('/api/v1/browserbase/sessions/sess-1/release');
    assert.equal(res.status, 200);
    assert.equal(res.body.released, true);
    assert.equal(res.body.sessionId, 'sess-1');
    assert.equal(JSON.parse(calls[0].body ? JSON.stringify(calls[0].body) : '{}').status, 'REQUEST_RELEASE');
  });

  it('explains the sessionId contract when upstream reports no active session', async () => {
    // 400, not 502: this is the caller not following the contract, and the
    // message has to say what to do rather than echo "No active session".
    mockUpstreams({ toolIsError: true, toolText: 'No active session' });
    const res = await post('/api/v1/browserbase/sessions/sess-1/extract', {});
    assert.equal(res.status, 400);
    assert.match(res.body.error, /run 'start' to get a sessionId/);
  });

  it('does not route "start" as a session id', async () => {
    // Array order is registration order, so the static path must come first or
    // Express matches "start" as :sessionId.
    mockUpstreams({ toolText: '{"sessionId":"sess-9"}', rest: { id: 'sess-9' } });
    const res = await post('/api/v1/browserbase/sessions/start');
    assert.equal(res.status, 201);
    assert.equal(res.body.sessionId, 'sess-9');
  });

  it('403s for an account with no Browserbase connection', async () => {
    await createOrUpdateUser(
      { email: 'bb-none@example.com', googleId: 'google-bb-none', name: 'BB None' },
      dummyTokens,
    );
    const user = await getUserByGoogleId('google-bb-none');
    mockUpstreams({ rest: [] });
    const res = await get('/api/v1/browserbase/sessions', (user as any).apiKey);
    // createServiceAuth falls back to a plain Google session, so auth PASSES
    // and the key would go out undefined — this is the branch that catches it.
    assert.equal(res.status, 403);
    assert.match(res.body.error, /No Browserbase connection/);
  });
});
