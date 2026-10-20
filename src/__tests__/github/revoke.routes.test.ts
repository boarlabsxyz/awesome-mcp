// src/__tests__/github/revoke.routes.test.ts
// Deleting or reconnecting a GitHub connector revokes it on GitHub BEFORE the
// token is thrown away, so the next connect shows GitHub's consent screen
// (and its organization panel) again. Driven through the real routes, against
// the file backend in a throwaway DATA_DIR set before anything reads it.
import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'crypto';
import request from 'supertest';

const dir = mkdtempSync(join(tmpdir(), 'gh-revoke-routes-'));
process.env.DATA_DIR = dir;
delete process.env.DATABASE_URL;
process.env.GITHUB_CLIENT_ID = 'Ov23cid';
process.env.GITHUB_CLIENT_SECRET = 'sec';
if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: { client_id: 'test.apps.googleusercontent.com', client_secret: 's', redirect_uris: ['http://localhost:8080/auth/callback'] },
  });
}

const { createWebOnlyApp } = await import('../../website/webServer.js');
const { createSession } = await import('../../website/sessionStore.js');
const { createOrUpdateUser, getUserByGoogleId } = await import('../../userStore.js');
const { createMcpInstance, getMcpConnectionByInstanceId } = await import('../../mcpConnectionStore.js');
const { createMcpCatalog } = await import('../../mcpCatalogStore.js');
const { GITHUB_AUTHORIZE_URL, GITHUB_TOKEN_URL } = await import('../../github/oauthCallback.js');

const COOKIE_SECRET = process.env.COOKIE_SECRET || 'dev-secret-change-me';
const signCookie = (val: string) =>
  `s:${val}.${crypto.createHmac('sha256', COOKIE_SECRET).update(val).digest('base64').replace(/=+$/, '')}`;
const OWNER_ID = 9501;
const EMPTY_GOOGLE = { access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0 };

describe('GitHub connector revocation on delete and reconnect', () => {
  const app = createWebOnlyApp();
  const realFetch = globalThis.fetch;
  let cookie: string;
  let deletes: Array<{ path: string; token: string }> = [];

  const connector = async (name: string, token: string) =>
    (await createMcpInstance(OWNER_ID, 'github', name, EMPTY_GOOGLE, null, 'github', { access_token: token } as any, null)).instanceId;

  before(async () => {
    await createMcpCatalog({
      slug: 'github', name: 'GitHub MCP Server', description: 't', iconUrl: null, mcpUrl: '/github', provider: 'github',
      scopes: [], googleClientId: 'Ov23cid', googleClientSecret: 'sec',
      oauthAuthorizationUrl: GITHUB_AUTHORIZE_URL, oauthTokenUrl: GITHUB_TOKEN_URL, oauthScopes: ['repo', 'read:org'],
      isLocal: true, isActive: true,
    });
    await createOrUpdateUser({ email: 'gh-revoke@example.com', googleId: 'google-gh-revoke', name: 'GH' },
      { access_token: 'a', refresh_token: 'r', scope: 'email', token_type: 'Bearer', expiry_date: Date.now() + 3600_000 });
    const user = await getUserByGoogleId('google-gh-revoke');
    if (user) (user as any).id = OWNER_ID;
    cookie = `session=${signCookie(await createSession('google-gh-revoke'))}`;

    globalThis.fetch = (async (input: any, init: any = {}) => {
      const path = new URL(String(input)).pathname;
      if (init.method === 'DELETE') {
        deletes.push({ path, token: JSON.parse(init.body).access_token });
        return new Response(null, { status: 204 });
      }
      // Every OAuth token in this suite belongs to the same GitHub account.
      return new Response(JSON.stringify({ login: 'me' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  });
  beforeEach(() => { deletes = []; });
  after(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  it('delete revokes the grant, then removes the connector, and reports it', async () => {
    const id = await connector('GitHub (me)', 'gho_only');
    const res = await request(app).delete(`/api/instances/${id}`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.githubRevoke.outcome, 'grant');
    assert.deepEqual(deletes, [{ path: '/applications/Ov23cid/grant', token: 'gho_only' }]);
    assert.equal(await getMcpConnectionByInstanceId(id), null);
  });

  it('reconnect revokes BEFORE redirecting to GitHub, so the consent screen is shown', async () => {
    const id = await connector('GitHub (me) r', 'gho_reconnect');
    const res = await request(app).get(`/connect/github?reconnect=${id}`).set('Cookie', cookie);
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    assert.deepEqual(deletes, [{ path: '/applications/Ov23cid/grant', token: 'gho_reconnect' }]);
    // Clean up so the next case sees only its own connectors.
    await request(app).delete(`/api/instances/${id}`).set('Cookie', cookie);
  });

  it('with a second connector on the same account, revokes only the token', async () => {
    const a = await connector('GitHub (me) a', 'gho_aaa');
    await connector('GitHub (me) b', 'gho_bbb');
    const res = await request(app).delete(`/api/instances/${a}`).set('Cookie', cookie);
    assert.equal(res.body.githubRevoke.outcome, 'token');
    assert.deepEqual(deletes, [{ path: '/applications/Ov23cid/token', token: 'gho_aaa' }]);
  });

  it('never revokes someone else\'s connector through a forged reconnect id', async () => {
    const theirs = (await createMcpInstance(OWNER_ID + 1, 'github', 'Theirs', EMPTY_GOOGLE, null, 'github',
      { access_token: 'gho_theirs' } as any, null)).instanceId;
    await request(app).get(`/connect/github?reconnect=${theirs}`).set('Cookie', cookie);
    assert.deepEqual(deletes, []);
  });

  it('a pasted token is not revoked, and the delete says where to remove it', async () => {
    const id = await connector('GitHub (pat)', 'ghp_pasted');
    const res = await request(app).delete(`/api/instances/${id}`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.githubRevoke.outcome, 'not-oauth');
    assert.deepEqual(deletes, []);
  });
});
