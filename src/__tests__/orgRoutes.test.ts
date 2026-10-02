import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import request from 'supertest';
import crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Both orgStore and webServer read their env at module load, so everything has
// to be set before the dynamic imports below.
const tmpDir = path.join(__dirname, '..', '..', '.test-data-org-routes-' + Date.now());
process.env.DATA_DIR = tmpDir;
process.env.ADMIN_EMAILS = 'operator@example.com';
if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: {
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:8080/auth/callback'],
    },
  });
}

const { createWebOnlyApp } = await import('../website/webServer.js');
const { createSession } = await import('../website/sessionStore.js');
const { createOrUpdateUser } = await import('../userStore.js');
const orgStore = await import('../orgStore.js');
import type { UserTokens } from '../userStore.js';

const COOKIE_SECRET = process.env.COOKIE_SECRET || 'dev-secret-change-me';
function signCookie(val: string): string {
  const sig = crypto.createHmac('sha256', COOKIE_SECRET).update(val).digest('base64').replace(/=+$/, '');
  return `s:${val}.${sig}`;
}

const dummyTokens: UserTokens = {
  access_token: 'acc', refresh_token: 'ref', scope: 'email',
  token_type: 'Bearer', expiry_date: Date.now() + 3600_000,
};

async function makeUser(email: string, googleId: string): Promise<{ id: number; cookie: string }> {
  const user = await createOrUpdateUser({ email, googleId, name: email }, dummyTokens);
  const sessionId = await createSession({ userId: user.id, googleId });
  return { id: user.id!, cookie: signCookie(sessionId) };
}

describe('Org routes', () => {
  const app = createWebOnlyApp();
  let operator: { id: number; cookie: string };
  let orgAdmin: { id: number; cookie: string };
  let member: { id: number; cookie: string };
  let outsider: { id: number; cookie: string };
  let orgId: number;

  before(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    operator = await makeUser('operator@example.com', 'g-operator');
    orgAdmin = await makeUser('boss@acme-routes.com', 'g-boss');
    member = await makeUser('worker@acme-routes.com', 'g-worker');
    outsider = await makeUser('nobody@elsewhere.com', 'g-nobody');
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('authentication gate', () => {
    const sessionRoutes: Array<[string, string]> = [
      ['get', '/api/org/me'],
      ['get', '/api/org/members'],
      ['get', '/api/org/invites/preview?token=x'],
      ['post', '/api/org/invites'],
      ['post', '/api/org/invites/accept'],
      ['delete', '/api/org/invites/1'],
      ['patch', '/api/org/members/1'],
      ['delete', '/api/org/members/1'],
      ['get', '/api/admin/orgs'],
      ['post', '/api/admin/orgs'],
      ['post', '/api/admin/orgs/1/members'],
      ['post', '/api/admin/orgs/1/domains'],
      ['post', '/api/admin/orgs/1/domains/verify'],
      ['delete', '/api/admin/orgs/1/domains/x.com'],
    ];

    for (const [method, route] of sessionRoutes) {
      it(`${method.toUpperCase()} ${route} rejects an unauthenticated caller`, async () => {
        const res = await (request(app) as any)[method](route).send({});
        assert.equal(res.status, 401, `expected 401, got ${res.status}`);
      });
    }

    it('GET /invite bounces an unauthenticated visitor to /login and parks the link', async () => {
      const res = await request(app).get('/invite?token=abc');
      assert.equal(res.status, 302);
      assert.equal(res.headers.location, '/login');
      const cookies = String(res.headers['set-cookie'] ?? '');
      assert.match(cookies, /post_login_redirect=/, 'the invite URL must be parked for after login');
    });
  });

  describe('platform-operator gate', () => {
    it('a non-operator cannot list or create orgs', async () => {
      const list = await request(app).get('/api/admin/orgs').set('Cookie', `session=${orgAdmin.cookie}`);
      assert.equal(list.status, 403);
      const create = await request(app)
        .post('/api/admin/orgs')
        .set('Cookie', `session=${orgAdmin.cookie}`)
        .send({ name: 'Sneaky Co' });
      assert.equal(create.status, 403);
    });

    it('the operator creates an org and seeds its first admin', async () => {
      const res = await request(app)
        .post('/api/admin/orgs')
        .set('Cookie', `session=${operator.cookie}`)
        .send({ name: 'Acme Routes', adminEmail: 'boss@acme-routes.com' });
      assert.equal(res.status, 201);
      assert.equal(res.body.org.name, 'Acme Routes');
      assert.equal(res.body.adminUserId, orgAdmin.id);
      orgId = res.body.org.id;
    });

    it('creating an org with a taken slug is a 409, and a blank name a 400', async () => {
      const dup = await request(app)
        .post('/api/admin/orgs')
        .set('Cookie', `session=${operator.cookie}`)
        .send({ name: 'Acme Routes' });
      assert.equal(dup.status, 409);
      const blank = await request(app)
        .post('/api/admin/orgs')
        .set('Cookie', `session=${operator.cookie}`)
        .send({ name: '   ' });
      assert.equal(blank.status, 400);
    });

    it('seeding an admin that has no account reports it instead of failing silently', async () => {
      const res = await request(app)
        .post('/api/admin/orgs')
        .set('Cookie', `session=${operator.cookie}`)
        .send({ name: 'Ghost Admin Co', adminEmail: 'ghost@nowhere.test' });
      assert.equal(res.status, 201);
      assert.match(res.body.warning, /No account exists/);
    });

    it('a public mail domain cannot be claimed, and an unverified claim does not auto-join', async () => {
      const pub = await request(app)
        .post(`/api/admin/orgs/${orgId}/domains`)
        .set('Cookie', `session=${operator.cookie}`)
        .send({ domain: 'gmail.com' });
      assert.equal(pub.status, 400);
      assert.match(pub.body.error, /public email provider/);

      const claim = await request(app)
        .post(`/api/admin/orgs/${orgId}/domains`)
        .set('Cookie', `session=${operator.cookie}`)
        .send({ domain: 'acme-routes.com' });
      assert.equal(claim.status, 201);
      assert.equal(claim.body.domain.verifiedAt, null);
      assert.equal(
        await orgStore.findOrgByVerifiedDomain('anyone@acme-routes.com'), undefined,
        'an unverified claim must not resolve an org',
      );

      const verify = await request(app)
        .post(`/api/admin/orgs/${orgId}/domains/verify`)
        .set('Cookie', `session=${operator.cookie}`)
        .send({ domain: 'acme-routes.com' });
      assert.equal(verify.status, 200);
      assert.ok(verify.body.domain.verifiedAt);
      assert.equal((await orgStore.findOrgByVerifiedDomain('anyone@acme-routes.com'))?.id, orgId);
    });

    it('verifying a domain this org never claimed is a 404', async () => {
      const res = await request(app)
        .post(`/api/admin/orgs/${orgId}/domains/verify`)
        .set('Cookie', `session=${operator.cookie}`)
        .send({ domain: 'not-claimed.com' });
      assert.equal(res.status, 404);
    });
  });

  describe('org-admin gate', () => {
    before(async () => {
      await orgStore.addOrgMember(orgId, member.id, 'member', 'manual');
    });

    it('a user in no org is told so, rather than getting a bare 403', async () => {
      const res = await request(app).get('/api/org/members').set('Cookie', `session=${outsider.cookie}`);
      assert.equal(res.status, 403);
      assert.match(res.body.error, /do not belong/);
    });

    it('a plain member cannot read the member list or invite anyone', async () => {
      const list = await request(app).get('/api/org/members').set('Cookie', `session=${member.cookie}`);
      assert.equal(list.status, 403);
      assert.match(list.body.error, /admin access required/);
      const invite = await request(app)
        .post('/api/org/invites')
        .set('Cookie', `session=${member.cookie}`)
        .send({ email: 'x@acme-routes.com' });
      assert.equal(invite.status, 403);
    });

    it('a PLATFORM operator is not implicitly an org admin', async () => {
      const res = await request(app).get('/api/org/members').set('Cookie', `session=${operator.cookie}`);
      assert.equal(res.status, 403, 'ADMIN_EMAILS must not grant org-scoped access');
    });

    it('the org admin sees members, domains and pending invites', async () => {
      const res = await request(app).get('/api/org/members').set('Cookie', `session=${orgAdmin.cookie}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.org.id, orgId);
      assert.equal(res.body.adminCount, 1);
      const emails = res.body.members.map((m: any) => m.email).sort();
      assert.deepEqual(emails, ['boss@acme-routes.com', 'worker@acme-routes.com']);
      assert.deepEqual(res.body.domains.map((d: any) => d.domain), ['acme-routes.com']);
      assert.ok(Array.isArray(res.body.pendingInvites));
    });

    it('/api/org/me reports role and platform-admin status separately', async () => {
      const admin = await request(app).get('/api/org/me').set('Cookie', `session=${orgAdmin.cookie}`);
      assert.equal(admin.status, 200);
      assert.equal(admin.body.role, 'admin');
      assert.equal(admin.body.org.id, orgId);
      assert.equal(admin.body.isPlatformAdmin, false);

      const op = await request(app).get('/api/org/me').set('Cookie', `session=${operator.cookie}`);
      assert.equal(op.body.org, null);
      assert.equal(op.body.role, null);
      assert.equal(op.body.isPlatformAdmin, true);
    });
  });

  describe('invitations', () => {
    it('rejects a malformed email before minting a token', async () => {
      const res = await request(app)
        .post('/api/org/invites')
        .set('Cookie', `session=${orgAdmin.cookie}`)
        .send({ email: 'not-an-email' });
      assert.equal(res.status, 400);
    });

    it('refuses to invite somebody who already belongs to an org', async () => {
      const same = await request(app)
        .post('/api/org/invites')
        .set('Cookie', `session=${orgAdmin.cookie}`)
        .send({ email: 'worker@acme-routes.com' });
      assert.equal(same.status, 409);
      assert.match(same.body.error, /already a member of this organisation/);
    });

    it('sends an invitation and lists it as pending, then revokes it', async () => {
      const res = await request(app)
        .post('/api/org/invites')
        .set('Cookie', `session=${orgAdmin.cookie}`)
        .send({ email: 'newhire@acme-routes.com', role: 'admin' });
      assert.equal(res.status, 201);
      assert.equal(res.body.invite.role, 'admin');
      assert.equal(res.body.invite.email, 'newhire@acme-routes.com');
      // The response must never carry the token or its hash.
      assert.equal(res.body.token, undefined);
      assert.equal(res.body.invite.tokenHash, undefined);

      const list = await request(app).get('/api/org/members').set('Cookie', `session=${orgAdmin.cookie}`);
      assert.deepEqual(list.body.pendingInvites.map((i: any) => i.email), ['newhire@acme-routes.com']);

      const revoke = await request(app)
        .delete(`/api/org/invites/${res.body.invite.id}`)
        .set('Cookie', `session=${orgAdmin.cookie}`);
      assert.equal(revoke.status, 200);
      const again = await request(app)
        .delete(`/api/org/invites/${res.body.invite.id}`)
        .set('Cookie', `session=${orgAdmin.cookie}`);
      assert.equal(again.status, 404);
    });

    it('preview reads without consuming, and accept then joins the org', async () => {
      const { token } = await orgStore.createInvite({ orgId, email: 'outsider-join@x.com', role: 'member' });

      const preview = await request(app)
        .get(`/api/org/invites/preview?token=${encodeURIComponent(token)}`)
        .set('Cookie', `session=${outsider.cookie}`);
      assert.equal(preview.status, 200);
      assert.equal(preview.body.orgName, 'Acme Routes');
      assert.equal(preview.body.status, 'pending');
      assert.equal(preview.headers['referrer-policy'], 'no-referrer');

      // A second preview must still leave it redeemable — this is the whole
      // point of splitting preview from accept.
      const second = await request(app)
        .get(`/api/org/invites/preview?token=${encodeURIComponent(token)}`)
        .set('Cookie', `session=${outsider.cookie}`);
      assert.equal(second.body.status, 'pending');

      const accept = await request(app)
        .post('/api/org/invites/accept')
        .set('Cookie', `session=${outsider.cookie}`)
        .send({ token });
      assert.equal(accept.status, 200);
      assert.equal(accept.body.org.id, orgId);
      assert.equal((await orgStore.getMembershipForUser(outsider.id))?.org.id, orgId);
    });

    it('re-accepting an invite to the org you are already in is a harmless no-op', async () => {
      const { token } = await orgStore.createInvite({ orgId, email: 'outsider-join@x.com' });
      const res = await request(app)
        .post('/api/org/invites/accept')
        .set('Cookie', `session=${outsider.cookie}`)
        .send({ token });
      assert.equal(res.status, 200, 'the membership already exists, so nothing is wrong');
      assert.equal((await orgStore.getMembershipForUser(outsider.id))?.org.id, orgId);
    });

    it('an invite to a DIFFERENT org is refused for a user who already has one', async () => {
      const other = await orgStore.createOrg({ name: 'Rival Routes Co' });
      const { token } = await orgStore.createInvite({ orgId: other.id, email: 'poach@x.com' });
      const res = await request(app)
        .post('/api/org/invites/accept')
        .set('Cookie', `session=${outsider.cookie}`)
        .send({ token });
      assert.equal(res.status, 409);
      assert.match(res.body.error, /one organisation at a time/);
      assert.equal(
        (await orgStore.getMembershipForUser(outsider.id))?.org.id, orgId,
        'the original membership must survive a refused poach',
      );
      // The link is spent even though the join failed: it was genuine and was
      // used, and re-offering it would suggest the second org is joinable.
      assert.ok((await orgStore.peekInvite(token))?.acceptedAt);
    });

    it('a token that was already used, and an unknown token, are both refused', async () => {
      const stranger = await makeUser('stranger@acme-routes.com', 'g-stranger');
      const { token } = await orgStore.createInvite({ orgId, email: 'stranger@acme-routes.com' });
      assert.equal(
        (await request(app).post('/api/org/invites/accept')
          .set('Cookie', `session=${stranger.cookie}`).send({ token })).status,
        200,
      );

      const second = await makeUser('second@acme-routes.com', 'g-second');
      const reuse = await request(app)
        .post('/api/org/invites/accept')
        .set('Cookie', `session=${second.cookie}`)
        .send({ token });
      assert.equal(reuse.status, 400);
      assert.match(reuse.body.error, /already been used/);
      assert.equal(await orgStore.getMembershipForUser(second.id), undefined);

      const unknown = await request(app)
        .post('/api/org/invites/accept')
        .set('Cookie', `session=${second.cookie}`)
        .send({ token: 'no-such-token' });
      assert.equal(unknown.status, 400);
      assert.match(unknown.body.error, /not valid/);

      const noToken = await request(app)
        .post('/api/org/invites/accept')
        .set('Cookie', `session=${second.cookie}`)
        .send({});
      assert.equal(noToken.status, 400);
    });

    it('preview of an unknown token is a 404, and a missing token a 400', async () => {
      const unknown = await request(app)
        .get('/api/org/invites/preview?token=nope')
        .set('Cookie', `session=${outsider.cookie}`);
      assert.equal(unknown.status, 404);
      const missing = await request(app)
        .get('/api/org/invites/preview')
        .set('Cookie', `session=${outsider.cookie}`);
      assert.equal(missing.status, 400);
    });
  });

  describe('member management', () => {
    it('refuses to demote or remove the last admin', async () => {
      const demote = await request(app)
        .patch(`/api/org/members/${orgAdmin.id}`)
        .set('Cookie', `session=${orgAdmin.cookie}`)
        .send({ role: 'member' });
      assert.equal(demote.status, 409);
      assert.match(demote.body.error, /at least one admin/);

      const remove = await request(app)
        .delete(`/api/org/members/${orgAdmin.id}`)
        .set('Cookie', `session=${orgAdmin.cookie}`);
      assert.equal(remove.status, 409);
    });

    it('promotes a member, which then frees the original admin to step down', async () => {
      const promote = await request(app)
        .patch(`/api/org/members/${member.id}`)
        .set('Cookie', `session=${orgAdmin.cookie}`)
        .send({ role: 'admin' });
      assert.equal(promote.status, 200);
      assert.equal(promote.body.role, 'admin');
      assert.equal(await orgStore.countOrgAdmins(orgId), 2);

      const demote = await request(app)
        .patch(`/api/org/members/${orgAdmin.id}`)
        .set('Cookie', `session=${orgAdmin.cookie}`)
        .send({ role: 'member' });
      assert.equal(demote.status, 200);
      assert.equal(await orgStore.countOrgAdmins(orgId), 1);
    });

    it('rejects an unknown role and a non-member target', async () => {
      const badRole = await request(app)
        .patch(`/api/org/members/${member.id}`)
        .set('Cookie', `session=${member.cookie}`)
        .send({ role: 'superuser' });
      assert.equal(badRole.status, 400);

      const ghost = await request(app)
        .patch('/api/org/members/424242')
        .set('Cookie', `session=${member.cookie}`)
        .send({ role: 'member' });
      assert.equal(ghost.status, 404);

      const removeGhost = await request(app)
        .delete('/api/org/members/424242')
        .set('Cookie', `session=${member.cookie}`);
      assert.equal(removeGhost.status, 404);
    });

    it('removes a member', async () => {
      const res = await request(app)
        .delete(`/api/org/members/${outsider.id}`)
        .set('Cookie', `session=${member.cookie}`);
      assert.equal(res.status, 200);
      assert.equal(await orgStore.getMembershipForUser(outsider.id), undefined);
    });
  });
});
