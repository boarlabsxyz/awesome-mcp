import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import type { Request, Response, NextFunction } from 'express';
import { resourceServerMiddleware } from '../../auth/resourceServerMiddleware.js';

const originalDualAuth = process.env.DUAL_AUTH_MODE;
const originalAuth0Domain = process.env.AUTH0_DOMAIN;
const originalAuth0Audience = process.env.AUTH0_AUDIENCE;
const originalBaseUrl = process.env.BASE_URL;

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    path: '/mcp',
    query: {},
    ip: '127.0.0.1',
    ...overrides,
  } as any;
}

function makeRes(): Response & { _status: number; _headers: Record<string, string>; _json: any } {
  const res: any = {
    _status: 200,
    _headers: {},
    _json: null,
    status(code: number) { res._status = code; return res; },
    setHeader(key: string, val: string) { res._headers[key] = val; return res; },
    json(body: any) { res._json = body; return res; },
  };
  return res;
}

describe('resourceServerMiddleware', () => {
  afterEach(() => {
    if (originalDualAuth !== undefined) process.env.DUAL_AUTH_MODE = originalDualAuth;
    else delete process.env.DUAL_AUTH_MODE;
    if (originalBaseUrl !== undefined) process.env.BASE_URL = originalBaseUrl;
    else delete process.env.BASE_URL;
    if (originalAuth0Domain !== undefined) process.env.AUTH0_DOMAIN = originalAuth0Domain;
    else delete process.env.AUTH0_DOMAIN;
    if (originalAuth0Audience !== undefined) process.env.AUTH0_AUDIENCE = originalAuth0Audience;
    else delete process.env.AUTH0_AUDIENCE;
  });

  describe('no auth header', () => {
    it('should return 401 with WWW-Authenticate when no auth header and dual mode off', async () => {
      process.env.DUAL_AUTH_MODE = 'false';
      process.env.BASE_URL = 'https://mcp.test';

      const req = makeReq({ headers: {} });
      const res = makeRes();
      let nextCalled = false;

      await resourceServerMiddleware(req, res as any, (() => { nextCalled = true; }) as NextFunction);

      assert.equal(res._status, 401);
      assert.ok(res._headers['WWW-Authenticate']?.includes('oauth-protected-resource'));
      assert.equal(nextCalled, false);
    });

    it('should allow API key in query param during dual mode', async () => {
      process.env.DUAL_AUTH_MODE = 'true';

      const req = makeReq({ headers: {}, query: { apiKey: 'some-key' } });
      const res = makeRes();
      let nextCalled = false;

      await resourceServerMiddleware(req, res as any, (() => { nextCalled = true; }) as NextFunction);

      assert.ok(nextCalled);
      assert.equal(res._headers['X-Auth-Migration'], 'deprecated');
    });
  });

  describe('non-JWT bearer token (API key)', () => {
    it('should pass through with deprecation header in dual mode', async () => {
      process.env.DUAL_AUTH_MODE = 'true';

      const req = makeReq({
        headers: { authorization: 'Bearer abc123plainapikey' },
      });
      const res = makeRes();
      let nextCalled = false;

      await resourceServerMiddleware(req, res as any, (() => { nextCalled = true; }) as NextFunction);

      assert.ok(nextCalled);
      assert.equal(res._headers['X-Auth-Migration'], 'deprecated');
    });

    it('should reject non-JWT bearer token when dual mode is off', async () => {
      process.env.DUAL_AUTH_MODE = 'false';
      process.env.BASE_URL = 'https://mcp.test';

      const req = makeReq({
        headers: { authorization: 'Bearer abc123plainapikey' },
      });
      const res = makeRes();
      let nextCalled = false;

      await resourceServerMiddleware(req, res as any, (() => { nextCalled = true; }) as NextFunction);

      assert.equal(nextCalled, false);
      assert.equal(res._status, 401);
      assert.equal(res._json?.error, 'invalid_token');
    });
  });

  describe('JWT-like token without valid Auth0 config', () => {
    it('should return 401 for invalid JWT', async () => {
      process.env.AUTH0_DOMAIN = 'test.auth0.com';
      process.env.AUTH0_AUDIENCE = 'https://mcp.test';
      process.env.BASE_URL = 'https://mcp.test';
      process.env.DUAL_AUTH_MODE = 'false';

      const fakeJwt = 'eyJhbGciOiJSUzI1NiJ9.eyJ0ZXN0IjoxfQ.invalidsig';
      const req = makeReq({
        headers: { authorization: `Bearer ${fakeJwt}` },
      });
      const res = makeRes();
      let nextCalled = false;

      await resourceServerMiddleware(req, res as any, (() => { nextCalled = true; }) as NextFunction);

      assert.equal(nextCalled, false);
      assert.equal(res._status, 401);
      assert.equal(res._json?.error, 'invalid_token');
      assert.ok(res._headers['WWW-Authenticate']);
    });
  });

  describe('missing Authorization prefix', () => {
    it('should reject non-Bearer authorization header when dual mode off', async () => {
      process.env.DUAL_AUTH_MODE = 'false';
      process.env.BASE_URL = 'https://mcp.test';

      const req = makeReq({
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
      });
      const res = makeRes();
      let nextCalled = false;

      await resourceServerMiddleware(req, res as any, (() => { nextCalled = true; }) as NextFunction);

      assert.equal(nextCalled, false);
      assert.equal(res._status, 401);
    });
  });
});
