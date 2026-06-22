import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import request from 'supertest';
import { createWebApp } from '../website/webServer.js';

// Set dummy Google credentials so createWebOnlyApp does not throw.
if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: {
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:8080/auth/callback'],
    },
  });
}

// Every new REST data-plane GET endpoint is wrapped in a service-specific
// `requireApiKey` middleware. These tests exercise the unauthenticated path:
//   - no Authorization header → 401
//   - syntactically valid but unknown bearer → 401
// They do not require any upstream Google/Slack/ClickUp mocking, so they
// cover the routes' presence + auth gate cheaply.
const NEW_REST_ENDPOINTS: ReadonlyArray<string> = [
  '/api/v1/docs',
  '/api/v1/docs/recent',
  '/api/v1/docs/doc-123',
  '/api/v1/docs/doc-123/tabs',
  '/api/v1/drive/shared-drives',
  '/api/v1/drive/folders/folder-123',
  '/api/v1/drive/files/file-123/permissions',
  '/api/v1/drive/files/file-123/public',
  '/api/v1/gmail/labels',
  '/api/v1/slides/presentation-123/pages/page-123/thumbnail',
  '/api/v1/slides/presentation-123/comments',
  '/api/v1/sheets/sheet-123/ranges?range=A1:B2',
  '/api/v1/sheets/sheet-123/rows/1',
  '/api/v1/sheets/sheet-123/search?col=A&val=x',
  '/api/v1/clickup/docs/doc-123?workspaceId=w-1',
  '/api/v1/clickup/docs/doc-123/pages/page-123?workspaceId=w-1',
  '/api/v1/slack/channels',
  '/api/v1/slack/channels/C123/messages',
  '/api/v1/slack/channels/C123/threads/1234.5678',
  '/api/v1/slack/users',
  '/api/v1/drive/files/file-123/download',
  '/api/v1/gmail/messages/m-1/attachments/a-1',
  '/api/v1/clickup/workspaces/w-1/members',
];

describe('REST data-plane: auth gate', () => {
  let app: ReturnType<typeof createWebApp>;

  before(() => {
    // Ports are unused — the REST routes we test live under /api/v1/*, which
    // don't overlap the MCP proxy path filters (/mcp, /calendar, /sheets, …),
    // so the proxy targets being unreachable doesn't affect this test.
    app = createWebApp(0, 0, 0, 0, 0, 0, 0, 0, 0);
  });

  for (const path of NEW_REST_ENDPOINTS) {
    it(`GET ${path} → 401 when Authorization is missing`, async () => {
      const res = await request(app).get(path);
      assert.equal(res.status, 401);
      assert.ok(res.body.error, 'expected an error body');
    });

    it(`GET ${path} → 401 when the bearer is unknown`, async () => {
      const res = await request(app).get(path).set('Authorization', 'Bearer not-a-real-token');
      assert.equal(res.status, 401);
      assert.ok(res.body.error);
    });
  }
});
