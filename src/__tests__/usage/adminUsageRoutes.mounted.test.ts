import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import { createWebOnlyApp } from '../../website/webServer.js';

// The route module is tested with a stand-in gate (adminUsageRoutes.test.ts);
// this pins the other half — that the real app mounts the routes behind the
// real admin check, so an anonymous caller gets 401, never usage data.

if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: {
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:8080/auth/callback'],
    },
  });
}

describe('admin usage routes are mounted behind requireAdmin', () => {
  const app = createWebOnlyApp();
  for (const path of [
    '/api/admin/usage/overview',
    '/api/admin/usage/tools',
    '/api/admin/usage/errors',
    '/api/admin/usage/loops',
    '/api/admin/usage/users/1/events',
  ]) {
    it(`GET ${path} without a session → 401`, async () => {
      const res = await request(app).get(path);
      assert.notEqual(res.status, 404, `${path} is not registered`);
      assert.equal(res.status, 401);
    });
  }
});
