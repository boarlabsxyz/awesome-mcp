// The two web-side halves of the Admin MCP: its catalog row is visible only to
// admins, and /connect/admin creates the connector for admins only.
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import request from 'supertest';
import crypto from 'crypto';

if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: {
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:8080/auth/callback'],
    },
  });
}

import { createWebOnlyApp } from '../../website/webServer.js';
import { createSession } from '../../website/sessionStore.js';
import { createOrUpdateUser, getUserByGoogleId, UserTokens } from '../../userStore.js';
import { getUserConnectedMcps, disconnectMcpInstance } from '../../mcpConnectionStore.js';
import { createMcpCatalog } from '../../mcpCatalogStore.js';

const COOKIE_SECRET = process.env.COOKIE_SECRET || 'dev-secret-change-me';
function signCookie(val: string): string {
  const sig = crypto.createHmac('sha256', COOKIE_SECRET).update(val).digest('base64').replace(/=+$/, '');
  return `s:${val}.${sig}`;
}

const ADMIN_ID = 9401;
const MEMBER_ID = 9402;
const dummyTokens: UserTokens = {
  access_token: 'acc', refresh_token: 'ref', scope: 'email',
  token_type: 'Bearer', expiry_date: Date.now() + 3600_000,
};

describe('Admin MCP web routes', () => {
  const app = createWebOnlyApp();
  const savedAdmins = process.env.ADMIN_EMAILS;
  let adminCookie: string;
  let memberCookie: string;

  before(async () => {
    process.env.ADMIN_EMAILS = 'admin-mcp-admin@example.com';
    await createMcpCatalog({
      slug: 'admin', name: 'Admin — Usage analytics', description: 'test',
      iconUrl: null, mcpUrl: '/admin-mcp', provider: 'admin', scopes: [],
      googleClientId: null, googleClientSecret: null, oauthScopes: [],
      isLocal: true, isActive: true,
    });
    for (const slug of ['storage', 'sandbox']) {
      await createMcpCatalog({
        slug, name: slug, description: 'test',
        iconUrl: null, mcpUrl: `/${slug}`, provider: slug, scopes: [],
        googleClientId: null, googleClientSecret: null, oauthScopes: [],
        isLocal: true, isActive: true,
      });
    }
    await createMcpCatalog({
      slug: 'clickup', name: 'ClickUp', description: 'test',
      iconUrl: null, mcpUrl: '/clickup', provider: 'clickup', scopes: [],
      googleClientId: null, googleClientSecret: null, oauthScopes: [],
      isLocal: true, isActive: true,
    });

    for (const [email, googleId, id] of [
      ['admin-mcp-admin@example.com', 'google-admin-mcp-admin', ADMIN_ID],
      ['admin-mcp-member@example.com', 'google-admin-mcp-member', MEMBER_ID],
    ] as const) {
      await createOrUpdateUser({ email, googleId, name: email }, dummyTokens);
      const user = await getUserByGoogleId(googleId);
      if (user) (user as any).id = id;
    }
    // The file-based store under ./data outlives a test run, so start from no
    // admin connectors rather than trusting the previous run to have left none.
    for (const id of [ADMIN_ID, MEMBER_ID]) {
      for (const c of await getUserConnectedMcps(id)) {
        if (c.mcpSlug === 'admin') await disconnectMcpInstance(c.instanceId);
      }
    }
    adminCookie = signCookie(await createSession('google-admin-mcp-admin'));
    memberCookie = signCookie(await createSession('google-admin-mcp-member'));
  });

  after(() => {
    if (savedAdmins === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = savedAdmins;
  });

  const slugs = (res: any) => (res.body.catalogs as any[]).map((c) => c.slug);

  describe('catalog visibility', () => {
    it('an anonymous caller does not see the admin row, but sees the others', async () => {
      const res = await request(app).get('/api/v1/catalogs');
      assert.equal(res.status, 200);
      assert.ok(slugs(res).includes('clickup'));
      assert.ok(!slugs(res).includes('admin'));
      assert.equal((await request(app).get('/api/v1/catalogs/admin')).status, 404);
    });

    it('a signed-in non-admin does not see it either', async () => {
      const res = await request(app).get('/api/v1/catalogs').set('Cookie', `session=${memberCookie}`);
      assert.ok(!slugs(res).includes('admin'));
      const one = await request(app).get('/api/v1/catalogs/admin').set('Cookie', `session=${memberCookie}`);
      assert.equal(one.status, 404);
    });

    it('an admin sees it', async () => {
      const res = await request(app).get('/api/v1/catalogs').set('Cookie', `session=${adminCookie}`);
      assert.ok(slugs(res).includes('admin'));
      const one = await request(app).get('/api/v1/catalogs/admin').set('Cookie', `session=${adminCookie}`);
      assert.equal(one.status, 200);
    });

    it('Storage and Sandbox are admin-only too: hidden from a non-admin, shown to an admin', async () => {
      const member = await request(app).get('/api/v1/catalogs').set('Cookie', `session=${memberCookie}`);
      const admin = await request(app).get('/api/v1/catalogs').set('Cookie', `session=${adminCookie}`);
      for (const slug of ['storage', 'sandbox']) {
        assert.ok(!slugs(member).includes(slug), slug);
        assert.ok(slugs(admin).includes(slug), slug);
        assert.equal((await request(app).get(`/api/v1/catalogs/${slug}`)).status, 404, slug);
      }
    });

    it('a forged session cookie counts as anonymous', async () => {
      const res = await request(app).get('/api/v1/catalogs').set('Cookie', 'session=s:not-a-session.bad');
      assert.equal(res.status, 200);
      assert.ok(!slugs(res).includes('admin'));
    });
  });

  describe('/connect/storage and /connect/sandbox', () => {
    it('refuse a non-admin and create nothing', async () => {
      for (const slug of ['storage', 'sandbox']) {
        const res = await request(app).get(`/connect/${slug}`).set('Cookie', `session=${memberCookie}`);
        assert.equal(res.status, 403, slug);
        assert.match(res.text, /administrators only/);
      }
      const conns = await getUserConnectedMcps(MEMBER_ID);
      assert.equal(conns.filter((c) => c.mcpSlug === 'storage' || c.mcpSlug === 'sandbox').length, 0);
    });
  });

  describe('/connect/admin', () => {
    it('refuses a non-admin and creates nothing', async () => {
      const res = await request(app).get('/connect/admin').set('Cookie', `session=${memberCookie}`);
      assert.equal(res.status, 403);
      const conns = await getUserConnectedMcps(MEMBER_ID);
      assert.equal(conns.filter((c) => c.mcpSlug === 'admin').length, 0);
    });

    it('creates exactly one connector for an admin', async () => {
      const first = await request(app).get('/connect/admin').set('Cookie', `session=${adminCookie}`);
      assert.equal(first.status, 302);
      assert.equal(first.headers.location, '/dashboard?connected=Admin');

      const second = await request(app).get('/connect/admin').set('Cookie', `session=${adminCookie}`);
      assert.equal(second.status, 302);
      assert.match(second.headers.location, /^\/dashboard\?already_exists=Admin/);

      const conns = (await getUserConnectedMcps(ADMIN_ID)).filter((c) => c.mcpSlug === 'admin');
      assert.equal(conns.length, 1);
      assert.equal(conns[0].provider, 'admin');
    });
  });
});
