import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it, before, after } from 'node:test';
import request from 'supertest';
import { createWebApp, createWebOnlyApp, createMcpOnlyApp } from '../website/webServer.js';

// The Slack counterpart of clickup-webhook-route-mounted.test.ts, and the same
// regression scope: /webhooks/slack/inbound must respond from EVERY app factory.
// The stakes are higher here than for ClickUp — Slack delivers every event in
// the workspace to a single Request URL, so a pod that 404s takes out every
// subscriber in every channel once Slack disables the URL, not one user's
// digest.
//
// The test needs neither a valid signature nor a subscription: it only proves
// the route exists. An unsigned POST gets 401 from the handler (signature is
// checked before anything else) — any non-404 4xx/5xx is the pass condition,
// since 404 is the Express-default-handler signature.

if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: {
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:8080/auth/callback'],
    },
  });
}

async function assertIngestionMounted(app: any, factoryName: string) {
  const res = await request(app)
    .post('/webhooks/slack/inbound')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify({ type: 'event_callback' }));
  assert.notEqual(res.status, 404, `${factoryName}: Slack ingestion route missing (Express default 404).`);
  assert.ok(res.status >= 400 && res.status < 600, `${factoryName}: unexpected status ${res.status} for an unsigned body`);
}

describe('Slack events ingestion route is mounted on every app factory', () => {
  let webApp: ReturnType<typeof createWebApp>;
  let webOnlyApp: ReturnType<typeof createWebOnlyApp>;
  let mcpOnlyApp: ReturnType<typeof createMcpOnlyApp>;

  before(() => {
    // Zero-ports are fine: /webhooks/* doesn't overlap the proxy paths.
    webApp = createWebApp(0, 0, 0, 0, 0, 0, 0, 0, 0);
    webOnlyApp = createWebOnlyApp();
    mcpOnlyApp = createMcpOnlyApp(0);
  });

  it('createWebApp mounts /webhooks/slack/inbound', async () => {
    await assertIngestionMounted(webApp, 'createWebApp');
  });

  it('createWebOnlyApp mounts /webhooks/slack/inbound', async () => {
    await assertIngestionMounted(webOnlyApp, 'createWebOnlyApp');
  });

  it('createMcpOnlyApp mounts /webhooks/slack/inbound', async () => {
    await assertIngestionMounted(mcpOnlyApp, 'createMcpOnlyApp');
  });

  it('rejects an unsigned delivery rather than accepting it', async () => {
    // Proves the route is signature-gated, not merely present: the URL is
    // public because Slack POSTs to it, so the signature is the only auth.
    const res = await request(webApp)
      .post('/webhooks/slack/inbound')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ type: 'url_verification', challenge: 'should-not-be-echoed' }));
    assert.equal(res.status, 401);
    assert.ok(!JSON.stringify(res.body).includes('should-not-be-echoed'));
  });
});

// The url_verification handshake is the highest-risk step of the whole feature:
// it is what Slack performs when the operator saves the Request URL, and it is
// the one path that exercises raw-body preservation + signature verification
// end-to-end through real Express without needing Postgres.
describe('Slack Request URL verification handshake, end to end', () => {
  const SECRET = 'test-signing-secret';
  let app: ReturnType<typeof createWebApp>;
  let previousSecret: string | undefined;

  before(() => {
    previousSecret = process.env.SLACK_SIGNING_SECRET;
    process.env.SLACK_SIGNING_SECRET = SECRET;
    app = createWebApp(0, 0, 0, 0, 0, 0, 0, 0, 0);
  });

  after(() => {
    if (previousSecret === undefined) delete process.env.SLACK_SIGNING_SECRET;
    else process.env.SLACK_SIGNING_SECRET = previousSecret;
  });

  function signed(body: string, timestampSec = Math.floor(Date.now() / 1000)) {
    return {
      'Content-Type': 'application/json',
      'X-Slack-Request-Timestamp': String(timestampSec),
      'X-Slack-Signature': 'v0=' + crypto
        .createHmac('sha256', SECRET)
        .update(`v0:${timestampSec}:${body}`)
        .digest('hex'),
    };
  }

  it('echoes the challenge for a correctly signed request', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'chal-abc-123' });
    const res = await request(app)
      .post('/webhooks/slack/inbound')
      .set(signed(body))
      .send(body);

    // A 401 here means the raw body was mutated before the handler saw it —
    // typically an express.json() mounted ahead of the route.
    assert.equal(res.status, 200, `expected the challenge to be echoed, got ${res.status}`);
    assert.deepEqual(res.body, { challenge: 'chal-abc-123' });
  });

  it('rejects a signature computed over the bare body (the ClickUp scheme)', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'chal-abc-123' });
    const res = await request(app)
      .post('/webhooks/slack/inbound')
      .set('Content-Type', 'application/json')
      .set('X-Slack-Request-Timestamp', String(Math.floor(Date.now() / 1000)))
      .set('X-Slack-Signature', 'v0=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex'))
      .send(body);

    assert.equal(res.status, 401);
  });

  it('rejects a replayed request from outside the window', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'chal-abc-123' });
    const stale = Math.floor(Date.now() / 1000) - 10 * 60;
    const res = await request(app)
      .post('/webhooks/slack/inbound')
      .set(signed(body, stale))
      .send(body);

    assert.equal(res.status, 401);
    assert.match(JSON.stringify(res.body), /timestamp/i);
  });
});
