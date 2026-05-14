import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import request from 'supertest';
import { createWebOnlyApp } from '../website/webServer.js';

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

describe('POST /api/internal/release-notify', () => {
  const app = createWebOnlyApp();

  describe('when INTERNAL_API_KEY is not configured', () => {
    before(() => {
      delete process.env.INTERNAL_API_KEY;
    });

    it('returns 503 when internal API is not configured', async () => {
      const res = await request(app)
        .post('/api/internal/release-notify')
        .set('Authorization', 'Bearer some-key')
        .send({ subject: 'Test', body: '<p>Hello</p>' });
      assert.equal(res.status, 503);
      assert.equal(res.body.error, 'Internal API not configured');
    });
  });

  describe('when INTERNAL_API_KEY is configured', () => {
    const testKey = 'test-internal-key-12345';

    before(() => {
      process.env.INTERNAL_API_KEY = testKey;
    });

    it('returns 401 with missing authorization header', async () => {
      const res = await request(app)
        .post('/api/internal/release-notify')
        .send({ subject: 'Test', body: '<p>Hello</p>' });
      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'Invalid internal API key');
    });

    it('returns 401 with wrong API key', async () => {
      const res = await request(app)
        .post('/api/internal/release-notify')
        .set('Authorization', 'Bearer wrong-key')
        .send({ subject: 'Test', body: '<p>Hello</p>' });
      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'Invalid internal API key');
    });

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

    it('returns 503 when no admin user exists', async () => {
      // No ADMIN_EMAILS set or no matching users
      const originalAdmins = process.env.ADMIN_EMAILS;
      process.env.ADMIN_EMAILS = 'nonexistent-admin@example.com';

      const res = await request(app)
        .post('/api/internal/release-notify')
        .set('Authorization', `Bearer ${testKey}`)
        .send({ subject: 'Test Release', body: '<p>Release notes</p>' });

      // Should be 503 (no admin found) or 503 (no Gmail connection)
      assert.ok([503].includes(res.status));

      if (originalAdmins !== undefined) {
        process.env.ADMIN_EMAILS = originalAdmins;
      } else {
        delete process.env.ADMIN_EMAILS;
      }
    });
  });
});
