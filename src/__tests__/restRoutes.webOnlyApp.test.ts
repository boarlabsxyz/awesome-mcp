import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import request from 'supertest';
import { createWebOnlyApp } from '../website/webServer.js';

// Regression test: the website pod on Railway runs MCP_MODE=web, which boots
// `createWebOnlyApp()` (not `createWebApp()`). Prior to this fix, the
// REST data-plane routes were only registered inside createWebApp's body,
// so every `/api/v1/*` request to the website host returned 404. This file
// asserts the routes are reachable from `createWebOnlyApp` too — if either
// factory stops mounting them, the test fails before deploy.

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

describe('REST routes are reachable from createWebOnlyApp (MCP_MODE=web factory)', () => {
  let app: ReturnType<typeof createWebOnlyApp>;

  before(() => {
    app = createWebOnlyApp();
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
        `${path} returned 404: route is NOT registered in createWebOnlyApp`,
      );
      assert.equal(res.status, 401);
    });
  }
});
