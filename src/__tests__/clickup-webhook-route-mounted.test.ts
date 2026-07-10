import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import request from 'supertest';
import { createWebApp, createWebOnlyApp, createMcpOnlyApp } from '../website/webServer.js';

// Regression test for PR5: the ingestion route must respond from EVERY app
// factory, not just createWebApp. Prior to PR5 the MCP-only factory did not
// register /webhooks/clickup/inbound, so a Railway deploy where a ClickUp MCP
// service's BASE_URL was used at subscribeToTaskEvents time gave 30
// consecutive Express-default 404s before ClickUp disabled the webhook.
//
// The test doesn't need a valid signature or a subscription in the DB — it
// just needs to prove the route exists. We POST an intentionally malformed
// body and require any 4xx status code that isn't 404 (the default-handler
// signature). Ingestion returns 400 for bad JSON; that's the pass condition.

if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: {
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:8080/auth/callback'],
    },
  });
}

const BAD_BODY = '{not-json';

async function assertIngestionMounted(app: any, factoryName: string) {
  const res = await request(app)
    .post('/webhooks/clickup/inbound')
    .set('Content-Type', 'application/json')
    .send(BAD_BODY);
  assert.notEqual(res.status, 404, `${factoryName}: ingestion route missing (Express default 404). Prior to PR5 this was the production symptom.`);
  // A mounted handler returns 400 for bad JSON via handleClickUpWebhookIngest.
  // If it 5xx'd instead that also proves the route is mounted (handler ran and
  // crashed) — still a pass for THIS test's regression scope.
  assert.ok(res.status >= 400 && res.status < 600, `${factoryName}: unexpected status ${res.status} for malformed body`);
}

describe('ClickUp webhook ingestion route is mounted on every app factory', () => {
  let webApp: ReturnType<typeof createWebApp>;
  let webOnlyApp: ReturnType<typeof createWebOnlyApp>;
  let mcpOnlyApp: ReturnType<typeof createMcpOnlyApp>;

  before(() => {
    // Zero-ports are fine: /webhooks/* doesn't overlap the proxy paths.
    webApp = createWebApp(0, 0, 0, 0, 0, 0, 0, 0, 0);
    webOnlyApp = createWebOnlyApp();
    mcpOnlyApp = createMcpOnlyApp(0);
  });

  it('createWebApp mounts /webhooks/clickup/inbound', async () => {
    await assertIngestionMounted(webApp, 'createWebApp');
  });

  it('createWebOnlyApp mounts /webhooks/clickup/inbound', async () => {
    await assertIngestionMounted(webOnlyApp, 'createWebOnlyApp');
  });

  it('createMcpOnlyApp mounts /webhooks/clickup/inbound (PR5 fix)', async () => {
    // This is the regression guard: before PR5 this test would 404 because
    // createMcpOnlyApp only mounted /health + /oauth + /mcp.
    await assertIngestionMounted(mcpOnlyApp, 'createMcpOnlyApp');
  });
});
