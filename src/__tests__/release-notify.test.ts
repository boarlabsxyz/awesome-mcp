import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import request from 'supertest';
import { createWebOnlyApp } from '../website/webServer.js';
import { createOrUpdateUser, UserTokens } from '../userStore.js';

// Set dummy Google credentials
if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: {
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:8080/auth/callback'],
    },
  });
}

const testKey = 'test-internal-key-12345';

// Snapshot env vars that tests mutate, restore after suite
const originalInternalKey = process.env.INTERNAL_API_KEY;
const originalAdminEmails = process.env.ADMIN_EMAILS;

describe('POST /api/internal/release-notify', () => {
  const app = createWebOnlyApp();

  after(() => {
    if (originalInternalKey !== undefined) process.env.INTERNAL_API_KEY = originalInternalKey;
    else delete process.env.INTERNAL_API_KEY;
    if (originalAdminEmails !== undefined) process.env.ADMIN_EMAILS = originalAdminEmails;
    else delete process.env.ADMIN_EMAILS;
  });

  describe('requireInternalApiKey middleware', () => {
    it('returns 503 when INTERNAL_API_KEY is not set', async () => {
      const saved = process.env.INTERNAL_API_KEY;
      delete process.env.INTERNAL_API_KEY;

      const res = await request(app)
        .post('/api/internal/release-notify')
        .set('Authorization', 'Bearer some-key')
        .send({ subject: 'Test', body: '<p>Hello</p>' });
      assert.equal(res.status, 503);
      assert.equal(res.body.error, 'Internal API not configured');

      if (saved !== undefined) process.env.INTERNAL_API_KEY = saved;
    });

    it('returns 401 with no authorization header', async () => {
      process.env.INTERNAL_API_KEY = testKey;
      const res = await request(app)
        .post('/api/internal/release-notify')
        .send({ subject: 'Test', body: '<p>Hello</p>' });
      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'Invalid internal API key');
    });

    it('returns 401 with wrong API key', async () => {
      process.env.INTERNAL_API_KEY = testKey;
      const res = await request(app)
        .post('/api/internal/release-notify')
        .set('Authorization', 'Bearer wrong-key')
        .send({ subject: 'Test', body: '<p>Hello</p>' });
      assert.equal(res.status, 401);
    });

    it('passes with correct API key', async () => {
      process.env.INTERNAL_API_KEY = testKey;
      const res = await request(app)
        .post('/api/internal/release-notify')
        .set('Authorization', `Bearer ${testKey}`)
        .send({ subject: 'Test', body: '<p>Hello</p>' });
      // Should not be 401 or 503 from middleware — may be 503 from admin lookup
      assert.notEqual(res.status, 401);
    });
  });

  describe('input validation', () => {
    before(() => { process.env.INTERNAL_API_KEY = testKey; });

    it('returns 400 when subject is missing', async () => {
      const res = await request(app)
        .post('/api/internal/release-notify')
        .set('Authorization', `Bearer ${testKey}`)
        .send({ body: '<p>Hello</p>' });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'subject and body are required');
    });

    it('returns 400 when body is missing', async () => {
      const res = await request(app)
        .post('/api/internal/release-notify')
        .set('Authorization', `Bearer ${testKey}`)
        .send({ subject: 'Test' });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'subject and body are required');
    });

    it('returns 400 when both are missing', async () => {
      const res = await request(app)
        .post('/api/internal/release-notify')
        .set('Authorization', `Bearer ${testKey}`)
        .send({});
      assert.equal(res.status, 400);
    });
  });

  describe('admin user lookup', () => {
    before(() => { process.env.INTERNAL_API_KEY = testKey; });

    it('returns 503 when ADMIN_EMAILS has no matching user', async () => {
      const saved = process.env.ADMIN_EMAILS;
      process.env.ADMIN_EMAILS = 'nobody-matches@example.com';

      const res = await request(app)
        .post('/api/internal/release-notify')
        .set('Authorization', `Bearer ${testKey}`)
        .send({ subject: 'Release v1.0', body: '<p>Notes</p>' });
      assert.equal(res.status, 503);
      assert.equal(res.body.error, 'No admin user found for sending emails');

      if (saved !== undefined) process.env.ADMIN_EMAILS = saved;
      else delete process.env.ADMIN_EMAILS;
    });

    it('returns 503 when admin exists but has no id (file-based store)', async () => {
      const adminEmail = 'release-test-admin@example.com';
      const saved = process.env.ADMIN_EMAILS;
      process.env.ADMIN_EMAILS = adminEmail;

      const dummyTokens: UserTokens = {
        access_token: 'acc', refresh_token: 'ref',
        scope: 'email', token_type: 'Bearer', expiry_date: Date.now() + 3600_000,
      };
      await createOrUpdateUser(
        { email: adminEmail, googleId: 'google-release-test', name: 'Release Test Admin' },
        dummyTokens
      );

      const res = await request(app)
        .post('/api/internal/release-notify')
        .set('Authorization', `Bearer ${testKey}`)
        .send({ subject: 'Release v1.0', body: '<p>Notes</p>' });

      // File-based users don't have numeric id, so !adminUser.id is true
      assert.equal(res.status, 503);
      assert.equal(res.body.error, 'No admin user found for sending emails');

      if (saved !== undefined) process.env.ADMIN_EMAILS = saved;
      else delete process.env.ADMIN_EMAILS;
    });

    it('returns 503 when ADMIN_EMAILS is empty', async () => {
      const saved = process.env.ADMIN_EMAILS;
      process.env.ADMIN_EMAILS = '';

      const res = await request(app)
        .post('/api/internal/release-notify')
        .set('Authorization', `Bearer ${testKey}`)
        .send({ subject: 'Release v1.0', body: '<p>Notes</p>' });
      assert.equal(res.status, 503);

      if (saved !== undefined) process.env.ADMIN_EMAILS = saved;
      else delete process.env.ADMIN_EMAILS;
    });
  });
});
