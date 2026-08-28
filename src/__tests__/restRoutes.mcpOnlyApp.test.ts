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
