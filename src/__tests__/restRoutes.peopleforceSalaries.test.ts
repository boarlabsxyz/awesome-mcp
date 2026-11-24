// The PeopleForce salaries REST route is operator-gated: a caller whose email
// is not in PEOPLEFORCE_COMPENSATION_EMAILS / ADMIN_EMAILS gets a 403 before
// any upstream call, and an upstream 403 is reported as a key restriction.
import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import request from 'supertest';

import { createWebOnlyApp } from '../website/webServer.js';
import { createOrUpdateUser, getUserByGoogleId, UserTokens } from '../userStore.js';
import { createMcpInstance, GoogleTokens } from '../mcpConnectionStore.js';
import { createMcpCatalog } from '../mcpCatalogStore.js';

if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: {
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:8080/auth/callback'],
    },
  });
}

const dummyTokens: UserTokens = {
  access_token: 'acc', refresh_token: 'ref', scope: 'email',
  token_type: 'Bearer', expiry_date: Date.now() + 3600_000,
};
const emptyGoogleTokens: GoogleTokens = {
  access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0,
};

describe('REST data plane: PeopleForce salaries gate', () => {
  const app = createWebOnlyApp();
  const realFetch = globalThis.fetch;
  let listedKey: string;
  let unlistedKey: string;
  let urls: string[] = [];
  let upstreamStatus = 200;
  const saved: Record<string, string | undefined> = {};

  async function connect(email: string, googleId: string): Promise<string> {
    await createOrUpdateUser({ email, googleId, name: googleId }, dummyTokens);
    const user = await getUserByGoogleId(googleId);
    await createMcpInstance(
      (user as any).id, 'peopleforce', `PF ${googleId}`, emptyGoogleTokens, null,
      'peopleforce', { access_token: 'pf-key' } as any, null,
    );
    return (user as any).apiKey;
  }

  before(async () => {
    await createMcpCatalog({
      slug: 'peopleforce', name: 'PeopleForce MCP', description: 'test',
      iconUrl: '', mcpUrl: '/peopleforce', provider: 'peopleforce', scopes: [],
      googleClientId: null, googleClientSecret: null, oauthScopes: [],
      isLocal: true, isActive: true,
    });
    listedKey = await connect('pf-hr@example.com', 'google-pf-hr');
    unlistedKey = await connect('pf-other@example.com', 'google-pf-other');
  });

  beforeEach(() => {
    saved.admin = process.env.ADMIN_EMAILS;
    saved.comp = process.env.PEOPLEFORCE_COMPENSATION_EMAILS;
    delete process.env.ADMIN_EMAILS;
    process.env.PEOPLEFORCE_COMPENSATION_EMAILS = 'PF-HR@example.com';
    urls = [];
    upstreamStatus = 200;
    globalThis.fetch = (async (url: any, init: any) => {
      // supertest talks to a local ephemeral server through the same global
      // fetch only if it uses it; record only PeopleForce traffic.
      if (String(url).includes('peopleforce')) urls.push(String(url));
      return new Response(
        JSON.stringify(upstreamStatus === 200
          ? { data: [{ id: 1, effective_on: '2026-01-01', amount: '1234.00', currency_code: 'EUR', per: 'month' }] }
          : { error: 'forbidden' }),
        { status: upstreamStatus, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (saved.admin === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = saved.admin;
    if (saved.comp === undefined) delete process.env.PEOPLEFORCE_COMPENSATION_EMAILS; else process.env.PEOPLEFORCE_COMPENSATION_EMAILS = saved.comp;
  });

  after(() => { globalThis.fetch = realFetch; });

  const get = (key: string, q = '') =>
    request(app).get(`/api/v1/peopleforce/employees/7/salaries${q}`).set('Authorization', `Bearer ${key}`);

  it('refuses an unlisted caller with 403 compensation_restricted and makes no upstream call', async () => {
    const res = await get(unlistedKey);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'compensation_restricted');
    assert.match(res.body.error, /PEOPLEFORCE_COMPENSATION_EMAILS/);
    assert.deepEqual(urls, []);
  });

  it('serves a listed caller (case-insensitive match)', async () => {
    const res = await get(listedKey);
    assert.equal(res.status, 200);
    assert.equal(res.body.data[0].amount, '1234.00');
    assert.equal(urls.length, 1);
    assert.match(urls[0], /\/employees\/7\/salaries/);
  });

  it('serves an admin who is not on the compensation list', async () => {
    process.env.PEOPLEFORCE_COMPENSATION_EMAILS = '';
    process.env.ADMIN_EMAILS = 'pf-other@example.com';
    const res = await get(unlistedKey);
    assert.equal(res.status, 200);
  });

  it('reports an upstream 403 as a key restriction, distinct from the gate', async () => {
    upstreamStatus = 403;
    const res = await get(listedKey);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'compensation_forbidden_by_key');
  });
});
