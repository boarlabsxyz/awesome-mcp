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
