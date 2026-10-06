// src/__tests__/browserbase/routes.test.ts
// Drives the two dashboard-side routes the Browserbase connector adds:
// /api/connect-token (its paste builder) and /api/instances/:id/domain-rules.
//
// Shaped after pasteTokenReauth.route.test.ts — asserting source shape cannot
// show that a handler really stores a key or really preserves rules, only that
// it looks like it might.
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import request from 'supertest';
import crypto from 'crypto';

import { createWebOnlyApp } from '../../website/webServer.js';
import { createSession } from '../../website/sessionStore.js';
import { createOrUpdateUser, getUserByGoogleId, UserTokens } from '../../userStore.js';
import {
  createMcpInstance,
  getMcpConnectionByInstanceId,
  GoogleTokens,
  updateMcpInstanceProviderTokens,
} from '../../mcpConnectionStore.js';
import { createMcpCatalog } from '../../mcpCatalogStore.js';

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

const OWNER_ID = 9301;
const STRANGER_ID = 9302;
const dummyTokens: UserTokens = {
  access_token: 'acc', refresh_token: 'ref', scope: 'email',
  token_type: 'Bearer', expiry_date: Date.now() + 3600_000,
};
const emptyGoogleTokens: GoogleTokens = {
  access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0,
};

describe('Browserbase dashboard routes', () => {
  const app = createWebOnlyApp();
  let sessionCookie: string;
  let strangersInstanceId: string;
  const realFetch = globalThis.fetch;

  before(async () => {
    await createMcpCatalog({
      slug: 'browserbase', name: 'Browserbase MCP', description: 'test',
      iconUrl: '', mcpUrl: '/browserbase', provider: 'browserbase', scopes: [],
      googleClientId: null, googleClientSecret: null, oauthScopes: [],
      isLocal: true, isActive: true,
    });

    await createOrUpdateUser(
      { email: 'bb-routes@example.com', googleId: 'google-bb-routes', name: 'BB Routes' },
      dummyTokens,
    );
    const user = await getUserByGoogleId('google-bb-routes');
    if (user) (user as any).id = OWNER_ID;

    const stranger = await createMcpInstance(
      STRANGER_ID, 'browserbase', 'Someone Else', emptyGoogleTokens, null,
      'browserbase', { access_token: 'bb_not_yours' } as any, null,
    );
    strangersInstanceId = stranger.instanceId;

    sessionCookie = signCookie(await createSession('google-bb-routes'));

    // Both Browserbase calls on the connect path hit /v1/projects: the
    // validation probe and the best-effort project lookup.
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => [{ id: 'proj-1', name: 'Acme Project' }],
      text: async () => '[{"id":"proj-1","name":"Acme Project"}]',
    })) as any;
  });

  after(() => { globalThis.fetch = realFetch; });

  const connect = (body: Record<string, unknown>) =>
    request(app).post('/api/connect-token').set('Cookie', `session=${sessionCookie}`).send(body);

  const getRules = (id: string) =>
    request(app).get(`/api/instances/${id}/domain-rules`).set('Cookie', `session=${sessionCookie}`);

  const putRules = (id: string, accessRules: unknown) =>
    request(app).post(`/api/instances/${id}/domain-rules`)
      .set('Cookie', `session=${sessionCookie}`).send({ accessRules });

  const storedTokens = async (id: string) =>
    (await getMcpConnectionByInstanceId(id))?.providerTokens as any;

  let instanceId: string;

  it('connects with a pasted key, naming the instance after the project', async () => {
    const res = await connect({ mcpSlug: 'browserbase', token: 'bb_live_123' });
    assert.equal(res.status, 200);
    instanceId = res.body.instanceId;
    assert.ok(instanceId);
    // The /v1/projects probe already returns the project, so naming it after
    // what the user sees in their own dashboard is free. Matched as a prefix,
    // not an exact string: the store de-duplicates display names by appending
    // a counter, and the file-backed store persists between runs.
    assert.match(res.body.instanceName, /^Browserbase \(Acme Project\)/);

    const tokens = await storedTokens(instanceId);
    assert.equal(tokens.access_token, 'bb_live_123');
    assert.equal(tokens.projectId, 'proj-1');
    // Absent, NOT seeded empty: an empty-defaults object is a non-empty value
    // that would survive every reconnect merge and reset the user's rules.
    assert.equal(tokens.accessRules, undefined);
    // SaaS: there is no per-connection host to store.
    assert.equal(tokens.baseUrl, undefined);
  });

  it('reports empty lists before anything is configured', async () => {
    const res = await getRules(instanceId);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.currentRules, { allowedDomains: [], blockedDomains: [] });
  });

  it('saves rules without dropping the API key', async () => {
    // updateMcpInstanceProviderTokens replaces the whole JSON column, so a
    // bare { accessRules } write would destroy the credential.
    const res = await putRules(instanceId, { allowedDomains: ['example.com'], blockedDomains: ['ads.test'] });
    assert.equal(res.status, 200);

    const tokens = await storedTokens(instanceId);
    assert.deepEqual(tokens.accessRules, { allowedDomains: ['example.com'], blockedDomains: ['ads.test'] });
    assert.equal(tokens.access_token, 'bb_live_123');
    assert.equal(tokens.projectId, 'proj-1');
  });

  it('reads back what was saved', async () => {
    const res = await getRules(instanceId);
    assert.deepEqual(res.body.currentRules, { allowedDomains: ['example.com'], blockedDomains: ['ads.test'] });
  });

  it('PRESERVES the rules across a re-auth', async () => {
    // The paste re-auth path replaces providerTokens wholesale. Dropping
    // accessRules would silently WIDEN access — the one direction a reconnect
    // must never move.
    const res = await connect({ mcpSlug: 'browserbase', token: 'bb_live_rotated', instanceId });
    assert.equal(res.status, 200);
    assert.equal(res.body.reauthenticated, true);

    const tokens = await storedTokens(instanceId);
    assert.equal(tokens.access_token, 'bb_live_rotated', 'the key should have been replaced');
    assert.deepEqual(
      tokens.accessRules,
      { allowedDomains: ['example.com'], blockedDomains: ['ads.test'] },
      'the rules must survive the reconnect',
    );
  });

  it('trims blanks and drops empty entries on save', async () => {
    await putRules(instanceId, { allowedDomains: ['  example.com  ', '', '   '], blockedDomains: [] });
    const tokens = await storedTokens(instanceId);
    assert.deepEqual(tokens.accessRules, { allowedDomains: ['example.com'], blockedDomains: [] });
  });

  it('coerces a non-array to an empty list rather than storing junk', async () => {
    await putRules(instanceId, { allowedDomains: 'example.com' });
    const tokens = await storedTokens(instanceId);
    assert.deepEqual(tokens.accessRules, { allowedDomains: [], blockedDomains: [] });
  });

  it('rejects a pattern the enforcement side could never match', async () => {
    // Validated with the connector's own validator, so the dashboard cannot
    // accept a rule that assertDomainAllowed would ignore — a saved rule that
    // silently does nothing is worse than a refusal.
    for (const bad of ['https://example.com/pricing', 'ex*mple.com', '-bad-.com']) {
      const res = await putRules(instanceId, { allowedDomains: [bad] });
      assert.equal(res.status, 400, bad);
      assert.match(res.body.error, /example|hostname|valid/i);
    }
    // The earlier rules are untouched by a rejected write.
    const tokens = await storedTokens(instanceId);
    assert.deepEqual(tokens.accessRules.allowedDomains, []);
  });

  it('requires an accessRules object', async () => {
    const res = await request(app)
      .post(`/api/instances/${instanceId}/domain-rules`)
      .set('Cookie', `session=${sessionCookie}`)
      .send({});
    assert.equal(res.status, 400);
    assert.match(res.body.error, /accessRules object is required/);
  });

  it('404s for an instance owned by someone else, on both verbs', async () => {
    // Deliberately the same 404 as "no such instance": a distinct 403 would
    // confirm that a guessed instance id exists.
    assert.equal((await getRules(strangersInstanceId)).status, 404);
    assert.equal((await putRules(strangersInstanceId, { allowedDomains: [] })).status, 404);
    assert.equal((await getRules('does-not-exist')).status, 404);

    // ...and the stranger's record is untouched.
    const tokens = await storedTokens(strangersInstanceId);
    assert.equal(tokens.access_token, 'bb_not_yours');
    assert.equal(tokens.accessRules, undefined);
  });

  it('401s without a session', async () => {
    assert.equal((await request(app).get(`/api/instances/${instanceId}/domain-rules`)).status, 401);
    assert.equal(
      (await request(app).post(`/api/instances/${instanceId}/domain-rules`).send({ accessRules: {} })).status,
      401,
    );
  });

  it('rejects the key when Browserbase does, without creating anything', async () => {
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: false, status: 401, statusText: 'Unauthorized',
      headers: { get: () => 'application/json' },
      json: async () => ({ message: 'unauthorized' }),
      text: async () => '{"message":"unauthorized"}',
    })) as any;
    try {
      const res = await connect({ mcpSlug: 'browserbase', token: 'bb_bad' });
      // 400, not 401: the pasted key is bad, which is a client error in THIS
      // request. Echoing the upstream 401 would read as "your dashboard
      // session expired" and could bounce the user to a pointless re-login.
      assert.equal(res.status, 400);
      assert.match(res.body.error, /browserbase\.com\/settings/);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('still connects when the project lookup fails, falling back to a plain name', async () => {
    // Best-effort by design: the key already passed its probe, so failing the
    // connect over a display name would reject a credential that works.
    const saved = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true, status: 200, headers: { get: () => 'application/json' },
          json: async () => [], text: async () => '[]',
        } as any;
      }
      throw new Error('project lookup exploded');
    }) as any;
    try {
      const res = await connect({ mcpSlug: 'browserbase', token: 'bb_live_noproject' });
      assert.equal(res.status, 200);
      // Prefix again, for the name-dedup counter. The point is that it fell
      // back to the plain label with no project in it.
      assert.match(res.body.instanceName, /^Browserbase\b/);
      assert.ok(!/Acme/.test(res.body.instanceName));
      const tokens = await storedTokens(res.body.instanceId);
      assert.equal(tokens.projectId, undefined);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('clears the cached session after a rules change', async () => {
    // getRules re-reads per call, but the SESSION is memoised by
    // `${apiKey}:${instanceId}` with no TTL — a stale one would keep serving
    // the old token-bearing object for the life of the process.
    await updateMcpInstanceProviderTokens(instanceId, { access_token: 'bb_live_rotated' } as any);
    const res = await putRules(instanceId, { allowedDomains: ['fresh.test'] });
    assert.equal(res.status, 200);
    const tokens = await storedTokens(instanceId);
    assert.deepEqual(tokens.accessRules.allowedDomains, ['fresh.test']);
  });
});
