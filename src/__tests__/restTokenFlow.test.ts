import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import request from 'supertest';
import { createWebApp } from '../website/webServer.js';
import { mintRestToken } from '../website/restTokenStore.js';
import { createOrUpdateUser, getUserByGoogleId, UserTokens } from '../userStore.js';

// End-to-end positive path for the REST data plane's auth flow:
//   1. A user exists with a known userId.
//   2. mintRestToken issues a short-lived bearer for that userId.
//   3. The bearer is accepted by createServiceAuth → resolveTokenToUser on
//      every /api/v1/* endpoint.
//
// The endpoint will then fail downstream because we don't wire a real Google
// connection in tests, but the contract we care about is:
//   - 401 = token NOT accepted (bug).
//   - any other status = token accepted (success).
//
// This complements the auth-gate tests in restRoutes.auth.test.ts which
// cover the negative path (missing/unknown bearer → 401).

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
  access_token: 'acc',
  refresh_token: 'ref',
  scope: 'email',
  token_type: 'Bearer',
  expiry_date: Date.now() + 3600_000,
};

describe('REST data-plane: short-lived bearer end-to-end', () => {
  let app: ReturnType<typeof createWebApp>;
  let token: string;

  before(async () => {
    app = createWebApp(0, 0, 0, 0, 0, 0, 0, 0, 0);

    await createOrUpdateUser(
      { email: 'rest-token-flow@example.com', googleId: 'google-rest-flow-1', name: 'Rest Flow' },
      dummyTokens,
    );
    const user = await getUserByGoogleId('google-rest-flow-1');
    assert.ok(user, 'user should exist after create');
    // The file-based user store doesn't assign numeric IDs; the auth flow
    // requires one. Patch it in place.
    (user as any).id = 99001;

    const minted = await mintRestToken(99001);
    token = minted.token;
    assert.ok(token.length > 0);
  });

  it('mintRestToken → /api/v1/calendars: bearer is accepted by the auth gate', async () => {
    const res = await request(app)
      .get('/api/v1/calendars')
      .set('Authorization', `Bearer ${token}`);
    // 401 would mean resolveTokenToUser rejected the bearer. Anything else
    // (200 if a session is built, 4xx/5xx if the downstream Google call
    // fails) proves the token was accepted.
    assert.notEqual(res.status, 401, `expected non-401, got ${res.status} body=${JSON.stringify(res.body)}`);
  });

  it('mintRestToken → /api/v1/sheets: bearer is accepted by the auth gate', async () => {
    const res = await request(app)
      .get('/api/v1/sheets')
      .set('Authorization', `Bearer ${token}`);
    assert.notEqual(res.status, 401, `expected non-401, got ${res.status}`);
  });

  it('mintRestToken → /api/v1/drive/shared-drives: bearer is accepted', async () => {
    const res = await request(app)
      .get('/api/v1/drive/shared-drives')
      .set('Authorization', `Bearer ${token}`);
    assert.notEqual(res.status, 401);
  });

  it('an unknown bearer is still 401 (control case)', async () => {
    const res = await request(app)
      .get('/api/v1/calendars')
      .set('Authorization', 'Bearer this-is-not-a-real-token');
    assert.equal(res.status, 401);
  });
});
