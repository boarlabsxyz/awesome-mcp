// src/__tests__/github/accessRules.routes.test.ts
// Drives the dashboard's GitHub Access Rules routes end to end: discovery on
// GET, validation and persistence on POST, ownership, and that saving never
// drops the credential (the store replaces provider_tokens whole). Shaped
// after src/__tests__/browserbase/routes.test.ts. File backend, throwaway
// DATA_DIR — set before anything that reads it is imported.
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'crypto';
import request from 'supertest';

const dir = mkdtempSync(join(tmpdir(), 'gh-rules-routes-'));
process.env.DATA_DIR = dir;
delete process.env.DATABASE_URL;
if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: { client_id: 'test.apps.googleusercontent.com', client_secret: 's', redirect_uris: ['http://localhost:8080/auth/callback'] },
  });
}

const { createWebOnlyApp } = await import('../../website/webServer.js');
const { createSession } = await import('../../website/sessionStore.js');
const { createOrUpdateUser, getUserByGoogleId } = await import('../../userStore.js');
const { createMcpInstance, getMcpConnectionByInstanceId } = await import('../../mcpConnectionStore.js');

const COOKIE_SECRET = process.env.COOKIE_SECRET || 'dev-secret-change-me';
const signCookie = (val: string) =>
  `s:${val}.${crypto.createHmac('sha256', COOKIE_SECRET).update(val).digest('base64').replace(/=+$/, '')}`;

const OWNER_ID = 9401;
const EMPTY_GOOGLE = { access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0 };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('GitHub Access Rules dashboard routes', () => {
  const app = createWebOnlyApp();
  const realFetch = globalThis.fetch;
  let cookie: string;
  let instanceId: string;
  let strangersId: string;

  before(async () => {
    await createOrUpdateUser({ email: 'gh-rules@example.com', googleId: 'google-gh-rules', name: 'GH' },
      { access_token: 'a', refresh_token: 'r', scope: 'email', token_type: 'Bearer', expiry_date: Date.now() + 3600_000 });
    const user = await getUserByGoogleId('google-gh-rules');
    if (user) (user as any).id = OWNER_ID;
    cookie = `session=${signCookie(await createSession('google-gh-rules'))}`;

    instanceId = (await createMcpInstance(OWNER_ID, 'github', 'GitHub (me)', EMPTY_GOOGLE, null, 'github',
      { access_token: 'ghp_mine' } as any, null)).instanceId;
    strangersId = (await createMcpInstance(OWNER_ID + 1, 'github', 'GitHub (them)', EMPTY_GOOGLE, null, 'github',
      { access_token: 'ghp_theirs' } as any, null)).instanceId;

    globalThis.fetch = (async (input: any) => {
      const path = new URL(String(input)).pathname;
      if (path === '/user') return json(200, { login: 'me' });
      if (path === '/user/repos') return json(200, [
        { owner: { login: 'me', type: 'User' } },
        { owner: { login: 'acme', type: 'Organization' } },
        { owner: { login: 'speed-and-function', type: 'Organization' } },
      ]);
      return json(403, { message: 'needs read:org' });
    }) as typeof fetch;
  });

  after(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (id: string) => request(app).get(`/api/instances/${id}/github-access-rules`).set('Cookie', cookie);
  const post = (id: string, accessRules: unknown) =>
    request(app).post(`/api/instances/${id}/github-access-rules`).set('Cookie', cookie).send({ accessRules });
  const stored = async (id: string) => (await getMcpConnectionByInstanceId(id))?.providerTokens as any;

  it('lists the account and its organizations, and reports no rules as null (unrestricted), not []', async () => {
    const res = await get(instanceId);
    assert.equal(res.status, 200);
    assert.equal(res.body.self, 'me');
    assert.deepEqual(res.body.owners.map((o: any) => o.login), ['acme', 'speed-and-function']);
    assert.equal(res.body.currentRules, null);
  });

  it('saves an allowlist without dropping the token, and reads it back', async () => {
    const res = await post(instanceId, { allowedOwners: ['me', 'Acme', 'https://github.com/acme'] });
    assert.equal(res.status, 200);
    const tokens = await stored(instanceId);
    assert.equal(tokens.access_token, 'ghp_mine');
    assert.deepEqual(tokens.accessRules, { allowedOwners: ['me', 'acme'] }, 'normalised and de-duplicated');
    assert.deepEqual((await get(instanceId)).body.currentRules, { allowedOwners: ['me', 'acme'] });
  });

  it('adds the connected account at save time even when a direct POST omits it', async () => {
    const res = await post(instanceId, { allowedOwners: ['acme'] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.accessRules, { allowedOwners: ['me', 'acme'] });
    assert.deepEqual((await stored(instanceId)).accessRules, { allowedOwners: ['me', 'acme'] });
  });

  it('refuses to save, writing nothing, when GitHub cannot confirm the account', async () => {
    const before = await stored(instanceId);
    const working = globalThis.fetch;
    globalThis.fetch = (async () => json(401, { message: 'Bad credentials' })) as typeof fetch;
    try {
      const res = await post(instanceId, { allowedOwners: ['acme'] });
      assert.equal(res.status, 502);
      assert.match(res.body.error, /Rules not saved/);
    } finally {
      globalThis.fetch = working;
    }
    assert.deepEqual(await stored(instanceId), before);
  });

  it('marks a saved owner the scan no longer sees, so Save cannot silently revoke it', async () => {
    await post(instanceId, { allowedOwners: ['me', 'vanished-org'] });
    const row = (await get(instanceId)).body.owners.find((o: any) => o.login === 'vanished-org');
    assert.deepEqual(row, { login: 'vanished-org', type: null, saved: true, discovered: false, member: false, repos: 0 });
  });

  it('refuses a name that cannot be a GitHub owner, and an empty list, with nothing written', async () => {
    const before = await stored(instanceId);
    assert.equal((await post(instanceId, { allowedOwners: ['me', 'not a login'] })).status, 400);
    assert.equal((await post(instanceId, { allowedOwners: [] })).status, 400);
    assert.equal((await post(instanceId, undefined)).status, 400);
    assert.deepEqual(await stored(instanceId), before);
  });

  it('null removes the restriction by deleting the key, not by storing {}', async () => {
    const res = await post(instanceId, null);
    assert.equal(res.status, 200);
    const tokens = await stored(instanceId);
    assert.equal('accessRules' in tokens, false);
    assert.equal(tokens.access_token, 'ghp_mine');
  });

  it('answers 404 for a connector that is not yours, on both routes', async () => {
    assert.equal((await get(strangersId)).status, 404);
    assert.equal((await post(strangersId, { allowedOwners: ['me'] })).status, 404);
    assert.equal((await stored(strangersId)).accessRules, undefined);
  });

  it('answers 502 with GitHub\'s reason when the organizations cannot be listed', async () => {
    const working = globalThis.fetch;
    globalThis.fetch = (async () => json(401, { message: 'Bad credentials' })) as typeof fetch;
    try {
      const res = await get(instanceId);
      assert.equal(res.status, 502);
      assert.match(res.body.error, /Could not list this account's organizations/);
    } finally {
      globalThis.fetch = working;
    }
  });
});
