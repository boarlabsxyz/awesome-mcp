import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import request from 'supertest';
import crypto from 'crypto';
import { createWebOnlyApp } from '../website/webServer.js';
import { createSession } from '../website/sessionStore.js';
import { createOrUpdateUser, getUserByGoogleId, UserTokens } from '../userStore.js';
import { createMcpInstance, getMcpConnectionByInstanceId, GoogleTokens } from '../mcpConnectionStore.js';
import { createMcpCatalog } from '../mcpCatalogStore.js';

// Exercises /api/connect-token end to end. The sibling pasteTokenReauth.test.ts
// asserts source shape, which cannot show that the handler actually replaces a
// credential — only that it looks like it might. These drive the route.
//
// slack-bot is the vehicle because its validation is a single fetch to
// slack.com/api/auth.test, so one stub covers it. The behaviour under test
// (create vs. replace, ownership checks) lives in persistPasteConnection and is
// shared by every paste provider.

if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: {
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:8080/auth/callback'],
    },
  });
}

const COOKIE_SECRET = process.env.COOKIE_SECRET || 'dev-secret-change-me';
function signCookie(val: string): string {
  const sig = crypto.createHmac('sha256', COOKIE_SECRET).update(val).digest('base64').replace(/=+$/, '');
  return `s:${val}.${sig}`;
}

const OWNER_ID = 9101;
const STRANGER_ID = 9102;
const dummyTokens: UserTokens = {
  access_token: 'acc', refresh_token: 'ref', scope: 'email',
  token_type: 'Bearer', expiry_date: Date.now() + 3600_000,
};
const emptyGoogleTokens: GoogleTokens = {
  access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0,
};

describe('/api/connect-token — paste-token re-authentication', () => {
  const app = createWebOnlyApp();
  let sessionCookie: string;
  let strangersInstanceId: string;
  let wrongSlugInstanceId: string;
  const realFetch = globalThis.fetch;

  before(async () => {
    await createMcpCatalog({
      slug: 'slack-bot', name: 'Slack Bot MCP', description: 'test',
      iconUrl: '', mcpUrl: '/slack-bot', provider: 'slack-bot', scopes: [],
      googleClientId: null, googleClientSecret: null, oauthScopes: [],
      isLocal: true, isActive: true,
    });
    await createMcpCatalog({
      slug: 'peopleforce', name: 'PeopleForce MCP', description: 'test',
      iconUrl: '', mcpUrl: '/peopleforce', provider: 'peopleforce', scopes: [],
      googleClientId: null, googleClientSecret: null, oauthScopes: [],
      isLocal: true, isActive: true,
    });

    await createOrUpdateUser(
      { email: 'paste-reauth@example.com', googleId: 'google-paste-reauth', name: 'Paste Reauth' },
      dummyTokens,
    );
    const user = await getUserByGoogleId('google-paste-reauth');
    if (user) (user as any).id = OWNER_ID;

    // Someone else's connection, and one of ours under a different slug —
    // both must be rejected as re-auth targets.
    const stranger = await createMcpInstance(
      STRANGER_ID, 'slack-bot', 'Someone Else', emptyGoogleTokens, null,
      'slack-bot', { access_token: 'xoxb-not-yours' } as any, null,
    );
    strangersInstanceId = stranger.instanceId;
    const wrongSlug = await createMcpInstance(
      OWNER_ID, 'peopleforce', 'Our PeopleForce', emptyGoogleTokens, null,
      'peopleforce', { access_token: 'pf-key' } as any, null,
    );
    wrongSlugInstanceId = wrongSlug.instanceId;

    sessionCookie = signCookie(await createSession('google-paste-reauth'));

    // Slack's auth.test is the only network call on this path.
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ ok: true, team: 'Acme', user_id: 'U1', bot_id: 'B1' }),
    })) as any;
  });

  after(() => { globalThis.fetch = realFetch; });

  const post = (body: Record<string, unknown>) =>
    request(app).post('/api/connect-token').set('Cookie', `session=${sessionCookie}`).send(body);

  const storedToken = async (instanceId: string) => {
    const conn = await getMcpConnectionByInstanceId(instanceId);
    return (conn?.providerTokens as any)?.access_token;
  };

  let createdInstanceId: string;

  it('creates a connection when no instanceId is supplied', async () => {
    const res = await post({ mcpSlug: 'slack-bot', token: 'xoxb-original' });
    assert.equal(res.status, 200);
    assert.ok(res.body.instanceId, 'expected an instanceId back');
    assert.notEqual(res.body.reauthenticated, true, 'a first connect is not a re-auth');
    createdInstanceId = res.body.instanceId;
    assert.equal(await storedToken(createdInstanceId), 'xoxb-original');
  });

  it('replaces the credential in place when instanceId is supplied', async () => {
    const res = await post({
      mcpSlug: 'slack-bot', token: 'xoxb-rotated', instanceId: createdInstanceId,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.reauthenticated, true);
    // The whole point: same instance, so the MCP URL the user already
    // configured in Claude keeps working.
    assert.equal(res.body.instanceId, createdInstanceId);
    assert.equal(await storedToken(createdInstanceId), 'xoxb-rotated');
  });

  it('does not create a duplicate connection while re-authenticating', async () => {
    // The bug this replaced: re-pasting added a second connection and left the
    // dead one in place.
    const before = await request(app).get('/api/me').set('Cookie', `session=${sessionCookie}`);
    const countBefore = before.body.connections.filter((c: any) => c.mcpSlug === 'slack-bot').length;

    await post({ mcpSlug: 'slack-bot', token: 'xoxb-again', instanceId: createdInstanceId });

    const after = await request(app).get('/api/me').set('Cookie', `session=${sessionCookie}`);
    const countAfter = after.body.connections.filter((c: any) => c.mcpSlug === 'slack-bot').length;
    assert.equal(countAfter, countBefore, 're-auth must not add a connection');
  });

  it("refuses to write to another user's instance", async () => {
    const res = await post({
      mcpSlug: 'slack-bot', token: 'xoxb-stolen', instanceId: strangersInstanceId,
    });
    assert.equal(res.status, 404);
    assert.equal(await storedToken(strangersInstanceId), 'xoxb-not-yours', 'must be untouched');
  });

  it('refuses an instance belonging to a different MCP', async () => {
    // Ours, but a PeopleForce connection — writing a Slack token into it would
    // leave a connection whose credential does not match its provider.
    const res = await post({
      mcpSlug: 'slack-bot', token: 'xoxb-wrong-home', instanceId: wrongSlugInstanceId,
    });
    assert.equal(res.status, 404);
    assert.equal(await storedToken(wrongSlugInstanceId), 'pf-key', 'must be untouched');
  });

  it('rejects an unknown instanceId rather than silently creating one', async () => {
    const res = await post({
      mcpSlug: 'slack-bot', token: 'xoxb-ghost', instanceId: 'inst_does_not_exist',
    });
    assert.equal(res.status, 404);
  });

  it('still requires a session', async () => {
    const res = await request(app)
      .post('/api/connect-token')
      .send({ mcpSlug: 'slack-bot', token: 'xoxb-anon', instanceId: createdInstanceId });
    assert.equal(res.status, 401);
  });
});
