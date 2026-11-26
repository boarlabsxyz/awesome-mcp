// A valid Auth0 token whose identity mapJwtToUser refuses (a new account
// outside ALLOWED_SIGNUP_DOMAINS) must get a 403 on the REST plane, not
// "401 Invalid token": a REST 401 tells the client its bearer is bad and sends
// it round a re-authentication loop (root CLAUDE.md).

import assert from 'node:assert/strict';
import { describe, it, before, after, mock } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rest-signup-refusal-'));
const saved = { domain: process.env.AUTH0_DOMAIN, list: process.env.ALLOWED_SIGNUP_DOMAINS };
process.env.AUTH0_DOMAIN = 'https://refusal-test.auth0.example';
if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: { client_id: 'x.apps.googleusercontent.com', client_secret: 's', redirect_uris: ['http://localhost:8080/auth/callback'] },
  });
}

const { createMcpOnlyApp } = await import('../website/webServer.js');

describe('REST plane: refused identities', () => {
  const realFetch = globalThis.fetch;
  let app: ReturnType<typeof createMcpOnlyApp>;

  before(() => {
    app = createMcpOnlyApp(3901);
    globalThis.fetch = mock.fn(async (input: any, init?: any) => {
      const url = String(input);
      if (url.endsWith('/userinfo')) {
        const auth = String(init?.headers?.Authorization ?? '');
        const verified = !auth.includes('unverified');
        return new Response(JSON.stringify({ sub: `auth0|${auth.slice(-12)}`, email: `new-${auth.slice(-12)}@outside.test`, email_verified: verified }), { status: 200 });
      }
      return realFetch(input, init);
    }) as any;
  });

  after(() => {
    globalThis.fetch = realFetch;
    fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
    if (saved.domain === undefined) delete process.env.AUTH0_DOMAIN; else process.env.AUTH0_DOMAIN = saved.domain;
    if (saved.list === undefined) delete process.env.ALLOWED_SIGNUP_DOMAINS; else process.env.ALLOWED_SIGNUP_DOMAINS = saved.list;
  });

  it('answers a new account outside the sign-up list with 403 signup_domain_not_allowed', async () => {
    process.env.ALLOWED_SIGNUP_DOMAINS = 'corp.test';
    const res = await request(app).get('/api/v1/calendars').set('Authorization', 'Bearer opaque-token-aaaaaaaaaaaa');
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'signup_domain_not_allowed');
  });

  it('still answers a token nobody recognises with 401', async () => {
    globalThis.fetch = mock.fn(async () => new Response('{}', { status: 401 })) as any;
    const res = await request(app).get('/api/v1/calendars').set('Authorization', 'Bearer not-a-token-at-all');
    assert.equal(res.status, 401);
  });
});
