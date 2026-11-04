import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { UserTokens } from '../userStore.js';
import type { GoogleTokens } from '../mcpConnectionStore.js';

// A throwaway store, set before anything reads DATA_DIR: the point of this
// file is WHICH connection serves the call, so no connection from an earlier
// run may sit in front of the ones created here.
const dataDir = mkdtempSync(join(tmpdir(), 'rest-multi-instance-'));
process.env.DATA_DIR = dataDir;
delete process.env.DATABASE_URL;

const { createWebOnlyApp } = await import('../website/webServer.js');
const { createOrUpdateUser, getUserByGoogleId } = await import('../userStore.js');
const { createMcpInstance } = await import('../mcpConnectionStore.js');
const { mintRestToken } = await import('../website/restTokenStore.js');

// Two connections to one service (two Slack bots here, two Google accounts on
// Sheets in the report that prompted this): a bearer minted from the second
// instance's MCP session must reach the second account. Before the bearer
// carried its instance, the REST plane always served the first connection.
// Slack stands in for every service because its token is visible on the wire.

if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: {
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:8080/auth/callback'],
    },
  });
}

const USER_ID = 8923;
const OTHER_USER_ID = 8924;
/** One slack-bot connection only, plus a Slack user one to mint from. */
const SINGLE_USER_ID = 8925;
const tokens: UserTokens = { access_token: 'acc', refresh_token: 'ref', scope: 'email', token_type: 'Bearer', expiry_date: Date.now() + 3600_000 };
const googleTokens: GoogleTokens = { access_token: 'mcp-acc', refresh_token: 'mcp-ref', scope: 'email', token_type: 'Bearer', expiry_date: Date.now() + 3600_000 };

const realFetch = globalThis.fetch;
/** The bot token on each call that reached "Slack". */
let tokensSeen: string[] = [];

function stubFetch(): void {
  globalThis.fetch = (async (_input: any, init: any = {}) => {
    tokensSeen.push(String(init.headers?.Authorization ?? '').replace('Bearer ', ''));
    const json = { ok: true, messages: [], has_more: false };
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const PATH = '/api/v1/slack/channels/C0C9/messages';

describe('REST data plane: which of several connections serves the call', () => {
  const app = createWebOnlyApp();
  let apiKey: string;
  let firstInstance: string;
  let secondInstance: string;
  let otherUsersInstance: string;
  let slackUserInstance: string;
  let singleUsersSlackUserInstance: string;

  before(async () => {
    const created = await createOrUpdateUser({ email: 'rest-multi@example.com', googleId: 'google-rest-multi', name: 'Multi' }, tokens);
    apiKey = created.apiKey;
    const user = await getUserByGoogleId('google-rest-multi');
    if (user) (user as any).id = USER_ID;
    firstInstance = (await createMcpInstance(USER_ID, 'slack-bot', 'Bot A', googleTokens, null, 'slack-bot', { access_token: 'xoxb-first' }, null)).instanceId;
    secondInstance = (await createMcpInstance(USER_ID, 'slack-bot', 'Bot B', googleTokens, null, 'slack-bot', { access_token: 'xoxb-second' }, null)).instanceId;
    otherUsersInstance = (await createMcpInstance(OTHER_USER_ID, 'slack-bot', 'Theirs', googleTokens, null, 'slack-bot', { access_token: 'xoxb-theirs' }, null)).instanceId;
    slackUserInstance = (await createMcpInstance(USER_ID, 'slack', 'Me on Slack', googleTokens, null, 'slack', { access_token: 'xoxp-user' }, null)).instanceId;
    await createOrUpdateUser({ email: 'rest-single@example.com', googleId: 'google-rest-single', name: 'Single' }, tokens);
    const single = await getUserByGoogleId('google-rest-single');
    if (single) (single as any).id = SINGLE_USER_ID;
    await createMcpInstance(SINGLE_USER_ID, 'slack-bot', 'Only bot', googleTokens, null, 'slack-bot', { access_token: 'xoxb-only' }, null);
    singleUsersSlackUserInstance = (await createMcpInstance(SINGLE_USER_ID, 'slack', 'Single on Slack', googleTokens, null, 'slack', { access_token: 'xoxp-single' }, null)).instanceId;
    stubFetch();
  });

  after(() => {
    globalThis.fetch = realFetch;
    rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => { tokensSeen = []; });

  const get = (bearer: string, instanceHeader?: string) => {
    const r = request(app).get(PATH).set('Authorization', `Bearer ${bearer}`);
    return instanceHeader ? r.set('X-Instance-Id', instanceHeader) : r;
  };

  it('a bearer minted on the second instance reaches the second account', async () => {
    const bearer = (await mintRestToken(USER_ID, secondInstance)).token;
    const res = await get(bearer);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(tokensSeen, ['xoxb-second']);
  });

  it('a bearer minted on the first instance reaches the first account', async () => {
    const bearer = (await mintRestToken(USER_ID, firstInstance)).token;
    const res = await get(bearer);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(tokensSeen, ['xoxb-first']);
  });

  it('a bearer minted on another service is a 409 listing the choices, not the first account', async () => {
    const bearer = (await mintRestToken(USER_ID, slackUserInstance)).token;
    const res = await get(bearer);
    assert.equal(res.status, 409);
    assert.deepEqual(res.body.instances.map((i: any) => i.instanceId).sort(), [firstInstance, secondInstance].sort());
    assert.deepEqual(tokensSeen, []);
  });

  it('a bearer minted on another service is fine when there is only one connection to pick', async () => {
    const bearer = (await mintRestToken(SINGLE_USER_ID, singleUsersSlackUserInstance)).token;
    const res = await get(bearer);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(tokensSeen, ['xoxb-only']);
  });

  it('a bearer minted on another service still works with X-Instance-Id', async () => {
    const bearer = (await mintRestToken(USER_ID, slackUserInstance)).token;
    const res = await get(bearer, secondInstance);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(tokensSeen, ['xoxb-second']);
  });

  it('the response names the instance that served it', async () => {
    const bearer = (await mintRestToken(USER_ID, secondInstance)).token;
    const res = await get(bearer);
    assert.equal(res.headers['x-instance-id'], secondInstance);
  });

  it('a bearer with no instance keeps the old behaviour (first connection)', async () => {
    // Minted before bearers carried an instance; the dashboard key behaves the same.
    const bearer = (await mintRestToken(USER_ID)).token;
    const res = await get(bearer);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(tokensSeen, ['xoxb-first']);
  });

  it('X-Instance-Id picks the connection for the dashboard API key', async () => {
    const res = await get(apiKey, secondInstance);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(tokensSeen, ['xoxb-second']);
  });

  it('X-Instance-Id overrides the instance a bearer was minted on', async () => {
    const bearer = (await mintRestToken(USER_ID, firstInstance)).token;
    const res = await get(bearer, secondInstance);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(tokensSeen, ['xoxb-second']);
  });

  for (const [label, id] of [
    ['an unknown instance', 'no-such-instance'],
    ["another user's instance", () => otherUsersInstance],
    ["another service's instance", () => slackUserInstance],
  ] as const) {
    it(`X-Instance-Id naming ${label} is a 404, never another account`, async () => {
      const res = await get(apiKey, typeof id === 'function' ? id() : id);
      assert.equal(res.status, 404);
      assert.deepEqual(tokensSeen, []);
    });
  }
});
