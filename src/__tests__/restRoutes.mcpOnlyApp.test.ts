import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import request from 'supertest';
import { createMcpOnlyApp } from '../website/webServer.js';

// Regression test: per-service Railway subdomains (google-calendar.awesome-mcp.xyz,
// google-sheets.awesome-mcp.xyz, etc.) run MCP_MODE=mcp, which boots
// `createMcpOnlyApp()`. Prior to this fix, that factory didn't register the
// REST data-plane routes — so bearers minted by the shared mintRestBearerForCurl
// MCP tool 404'd on the subdomain they were minted from, even though
// listRestEndpoints advertised them as "status": live. This file asserts the
// routes are reachable from createMcpOnlyApp too — if the factory stops
// mounting them, the test fails before deploy.

if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: {
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:8080/auth/callback'],
    },
  });
}

const SAMPLE_REST_ENDPOINTS: ReadonlyArray<string> = [
  '/api/v1/calendars',
  '/api/v1/sheets',
  '/api/v1/docs/recent',
  '/api/v1/drive/shared-drives',
  '/api/v1/gmail/labels',
  '/api/v1/slack/channels',
  '/api/v1/clickup/workspaces',
  '/api/v1/hubspot/companies',
  '/api/v1/redmine/projects',
];

describe('REST routes are reachable from createMcpOnlyApp (MCP_MODE=mcp factory)', () => {
  let app: ReturnType<typeof createMcpOnlyApp>;

  before(() => {
    app = createMcpOnlyApp(3001);
  });

  for (const path of SAMPLE_REST_ENDPOINTS) {
    it(`GET ${path} → 401 (route registered + auth gate fires)`, async () => {
      const res = await request(app).get(path);
      // A 404 here means the route isn't registered in this factory — exactly
      // the bug we're guarding against. 401 means the route exists and the
      // auth middleware ran.
      assert.notEqual(
        res.status,
        404,
        `${path} returned 404: route is NOT registered in createMcpOnlyApp`,
      );
      assert.equal(res.status, 401);
    });
  }
});

// A 401 from the MCP endpoint is only actionable if it says WHERE to
// authenticate. RFC 9728 §5.1 and the MCP authorization spec both require
// WWW-Authenticate with a resource_metadata pointer; without it a client has
// nothing to act on and reports an opaque transport failure rather than
// prompting the user to re-authorize — indistinguishable, from the user's
// side, from "reconnecting didn't work". The header was dropped here once
// (the base URL was still being computed, then thrown away), so it is pinned.
describe('MCP endpoint 401s carry WWW-Authenticate (re-auth discovery)', () => {
  const MCP_PATHS = ['/mcp', '/sse'];

  for (const path of MCP_PATHS) {
    it(`GET ${path} without a token → 401 + WWW-Authenticate resource_metadata`, async () => {
      const app = createMcpOnlyApp(3001);
      const res = await request(app).get(path).set('Accept', 'text/event-stream');
      assert.equal(res.status, 401);
      const header = res.headers['www-authenticate'];
      assert.ok(header, `${path} 401 has no WWW-Authenticate header`);
      assert.match(header, /^Bearer /);
      assert.match(header, /resource_metadata="https?:\/\/[^"]+\/\.well-known\/oauth-protected-resource"/);
    });
  }

  // Deliberately NOT asserted here: a malformed *present* bearer. With
  // DUAL_AUTH_MODE on (the default), the edge forwards any non-JWT, non-Auth0
  // bearer to FastMCP, whose own authenticate handler re-validates it as an
  // API key and rejects with 401. So the edge is not the rejecting party for
  // that case and has no 401 to decorate. Only the no-token case is the edge's
  // to answer, which is what these tests pin.
  it('points at this MCP\'s own subdomain, not the main site', async () => {
    const prevMcpBase = process.env.MCP_BASE_URL;
    process.env.MCP_BASE_URL = 'https://gmail.example.test';
    try {
      const app = createMcpOnlyApp(3001);
      const res = await request(app).get('/mcp');
      assert.equal(res.status, 401);
      // Sending a client to the wrong resource's metadata is worse than
      // sending it nowhere: it would discover an authorization server that
      // cannot issue a token for this resource.
      assert.match(res.headers['www-authenticate'], /https:\/\/gmail\.example\.test\/\.well-known\/oauth-protected-resource/);
    } finally {
      if (prevMcpBase === undefined) delete process.env.MCP_BASE_URL;
      else process.env.MCP_BASE_URL = prevMcpBase;
    }
  });
});

// Second regression in the same factory, and a nastier one than the missing
// routes above because it failed with a *plausible* error instead of a 404.
//
// createMcpOnlyApp registered registerRestApiRoutes but mounted NO json() body
// parser, so on every per-service subdomain `req.body` was undefined for every
// REST POST. Each handler does `safeParse({ ...req.body, id: req.params.id })`,
// and spreading undefined yields `{}` — so the route answered 400 with
// "range: Required, values: Required" for a request that carried both. GET
// routes worked throughout, which is exactly why this was reported as a body
// parser or proxy fault rather than as a missing middleware.
//
// The auth gate runs before the parser matters, so these assert the gate's 401
// rather than a 200: what is being pinned is that a *parser* is mounted on the
// path at all. The 400-with-a-valid-body signature is pinned below.
describe('REST POST bodies are parsed in createMcpOnlyApp', () => {
  const POST_WITH_BODY: ReadonlyArray<{ path: string; body: object }> = [
    { path: '/api/v1/sheets/abc123/write', body: { range: 'A1:B2', values: [['a', 'b']] } },
    { path: '/api/v1/sheets/abc123/append', body: { range: 'A1', values: [['a']] } },
    { path: '/api/v1/sheets/abc123/batchUpdate', body: { operations: [{ type: 'addSheet', title: 't' }] } },
    { path: '/api/v1/sheets/abc123/ranges/clear', body: { range: 'A1:B2' } },
  ];

  for (const { path, body } of POST_WITH_BODY) {
    it(`POST ${path} is not rejected as an empty body`, async () => {
      const app = createMcpOnlyApp(3001);
      const res = await request(app).post(path).send(body).set('Content-Type', 'application/json');
      // 401 (unauthenticated) is the expected answer. The failure this guards
      // against is a 400 whose issues name the fields we just sent — that is
      // the "body was dropped" signature, and it would mean the parser is gone
      // again even though the auth gate happens to run first today.
      assert.notEqual(res.status, 404, `${path} is not registered in createMcpOnlyApp`);
      if (res.status === 400) {
        assert.fail(`${path} rejected a valid body as invalid — body parser missing: ${JSON.stringify(res.body)}`);
      }
      assert.equal(res.status, 401);
    });
  }

  it('mounts a JSON parser on /api/v1 (a valid body survives to the handler)', async () => {
    // The direct form of the assertion above: reach past the auth gate by
    // checking the parser itself, which is the thing that was missing. An
    // unparseable body must come back as the REST plane's own JSON 400, not as
    // Express's HTML error page — which only happens if a parser ran.
    const app = createMcpOnlyApp(3001);
    const res = await request(app)
      .post('/api/v1/sheets/abc123/write')
      .set('Content-Type', 'application/json')
      .send('{"range": not json}');
    assert.equal(res.status, 400);
    assert.match(String(res.body?.error ?? ''), /not valid JSON/i);
  });

  it('leaves /mcp and /sse request streams unparsed for the proxy', async () => {
    // The parser is scoped to /api/v1 precisely so it cannot consume the
    // proxied MCP request stream. A global express.json() here would fix the
    // REST POSTs and break every MCP call on the same subdomain, so the scope
    // is pinned: an unauthenticated POST to /mcp must still be the edge's 401,
    // never a body-parser error.
    const app = createMcpOnlyApp(3001);
    const res = await request(app).post('/mcp').send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    assert.equal(res.status, 401);
  });
});
