import assert from 'node:assert/strict';
import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import type { Request, Response, NextFunction } from 'express';
import { createResourceServerMiddleware, looksLikeJwt, type MiddlewareDeps } from '../../auth/resourceServerMiddleware.js';

const originalDualAuth = process.env.DUAL_AUTH_MODE;
const originalBaseUrl = process.env.BASE_URL;

const fakePayload = { sub: 'auth0|123', scope: 'mcp:docs mcp:sheets', email: 'u@test.com', iss: 'iss', aud: 'aud' };
const fakeUser = { id: 1, email: 'u@test.com', apiKey: 'k1', googleId: null, name: 'Test', authMethod: 'google' as const, createdAt: '', updatedAt: '' };
// Auth0 opaque tokens are JWE: start with eyJ, 400+ chars
const fakeOpaqueToken = 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIiwiaXNzIjoiaHR0cHM6Ly90ZXN0LmF1dGgwLmNvbS8ifQ' + '.'.repeat(3) + 'x'.repeat(300);

function makeDeps(overrides: Partial<MiddlewareDeps> = {}): MiddlewareDeps {
  return {
    validateJwt: mock.fn(async () => fakePayload),
    validateOpaqueToken: mock.fn(async () => fakePayload),
    hasScope: mock.fn(() => true),
    getRequiredScope: mock.fn((path: string) => path === '/mcp' ? 'mcp:docs' : path.replace(/^\//, '').replace(/-sse$/, '') === 'calendar' ? 'mcp:calendar' : null),
    mapJwtToUser: mock.fn(async () => fakeUser),
    ...overrides,
  };
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, path: '/mcp', query: {}, ip: '127.0.0.1', ...overrides } as any;
}

function makeRes(): Response & { _status: number; _headers: Record<string, string>; _json: any } {
  const res: any = {
    _status: 200, _headers: {}, _json: null,
    status(code: number) { res._status = code; return res; },
    setHeader(key: string, val: string) { res._headers[key] = val; return res; },
    json(body: any) { res._json = body; return res; },
  };
  return res;
}

describe('looksLikeJwt', () => {
  it('returns true for JWT-shaped tokens', () => {
    assert.ok(looksLikeJwt('eyJhbGciOiJSUzI1NiJ9.eyJ0ZXN0IjoxfQ.sig'));
  });

  it('returns false for plain API keys', () => {
    assert.equal(looksLikeJwt('abc123plainapikey'), false);
  });

  it('returns false for tokens with dots but no eyJ prefix', () => {
    assert.equal(looksLikeJwt('abc.def.ghi'), false);
  });
});

describe('resourceServerMiddleware', () => {
  afterEach(() => {
    if (originalDualAuth !== undefined) process.env.DUAL_AUTH_MODE = originalDualAuth;
    else delete process.env.DUAL_AUTH_MODE;
    if (originalBaseUrl !== undefined) process.env.BASE_URL = originalBaseUrl;
    else delete process.env.BASE_URL;
  });

  // --- No auth header ---

  it('returns 401 when no auth header (JWT-only mode)', async () => {
    process.env.DUAL_AUTH_MODE = 'false';
    process.env.BASE_URL = 'https://mcp.test';
    const mw = createResourceServerMiddleware(makeDeps());

    const req = makeReq({ headers: {} });
    const res = makeRes();
    let nextCalled = false;
    await mw(req, res as any, (() => { nextCalled = true; }) as NextFunction);

    assert.equal(res._status, 401);
    assert.ok(res._headers['WWW-Authenticate']?.includes('oauth-protected-resource'));
    assert.equal(nextCalled, false);
  });

  it('allows API key in query param during dual mode', async () => {
    process.env.DUAL_AUTH_MODE = 'true';
    const mw = createResourceServerMiddleware(makeDeps());

    const req = makeReq({ headers: {}, query: { apiKey: 'some-key' } });
    const res = makeRes();
    let nextCalled = false;
    await mw(req, res as any, (() => { nextCalled = true; }) as NextFunction);

    assert.ok(nextCalled);
    assert.equal(res._headers['X-Auth-Migration'], 'deprecated');
  });

  // The MCP server behind the proxy trusts these headers from loopback, and
  // the dual-mode paths pass a request on WITHOUT identifying the caller, so a
  // client-supplied one must never survive this middleware.
  it('strips client-supplied identity headers on every path that calls next()', async () => {
    process.env.DUAL_AUTH_MODE = 'true';
    const spoofed = () => ({ 'x-mcp-user-id': '1', 'x-mcp-user-email': 'boss@example.com', 'x-mcp-user-sub': 'auth0|boss' });
    const mw = createResourceServerMiddleware(makeDeps({
      validateOpaqueToken: mock.fn(async () => { throw new Error('not an Auth0 token'); }),
    }));

    for (const req of [
      makeReq({ headers: spoofed(), query: { apiKey: 'unvalidated' } }),
      makeReq({ headers: { ...spoofed(), authorization: 'Bearer plain-api-key' } }),
    ]) {
      let nextCalled = false;
      await mw(req, makeRes() as any, (() => { nextCalled = true; }) as NextFunction);
      assert.ok(nextCalled);
      assert.equal(req.headers['x-mcp-user-id'], undefined);
      assert.equal(req.headers['x-mcp-user-email'], undefined);
      assert.equal(req.headers['x-mcp-user-sub'], undefined);
    }
  });

  it('replaces a spoofed identity with the one it verified', async () => {
    const mw = createResourceServerMiddleware(makeDeps());
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJ0ZXN0IjoxfQ.validsig';
    const req = makeReq({ headers: { authorization: `Bearer ${jwt}`, 'x-mcp-user-id': '999999' } });
    await mw(req, makeRes() as any, (() => {}) as NextFunction);
    assert.notEqual(req.headers['x-mcp-user-id'], '999999');
  });

  // --- Non-JWT bearer token ---

  it('validates non-JWT token as opaque via /userinfo', async () => {
    const deps = makeDeps();
    const mw = createResourceServerMiddleware(deps);

    const req = makeReq({ headers: { authorization: `Bearer ${fakeOpaqueToken}` } });
    const res = makeRes();
    let nextCalled = false;
    await mw(req, res as any, (() => { nextCalled = true; }) as NextFunction);

    assert.ok(nextCalled);
    assert.equal(req.headers['x-mcp-user-id'], '1');
  });

  it('falls through to API key in dual mode when opaque validation fails', async () => {
    process.env.DUAL_AUTH_MODE = 'true';
    const deps = makeDeps({ validateOpaqueToken: mock.fn(async () => { throw new Error('invalid'); }) });
    const mw = createResourceServerMiddleware(deps);

    const req = makeReq({ headers: { authorization: 'Bearer abc123plainapikey' } });
    const res = makeRes();
    let nextCalled = false;
    await mw(req, res as any, (() => { nextCalled = true; }) as NextFunction);

    assert.ok(nextCalled);
    assert.equal(res._headers['X-Auth-Migration'], 'deprecated');
  });

  it('rejects non-JWT bearer token when dual mode off and opaque validation fails', async () => {
    process.env.DUAL_AUTH_MODE = 'false';
    const deps = makeDeps({ validateOpaqueToken: mock.fn(async () => { throw new Error('invalid'); }) });
    const mw = createResourceServerMiddleware(deps);

    const req = makeReq({ headers: { authorization: 'Bearer abc123plainapikey' } });
    const res = makeRes();
    let nextCalled = false;
    await mw(req, res as any, (() => { nextCalled = true; }) as NextFunction);

    assert.equal(nextCalled, false);
    assert.equal(res._status, 401);
  });

  // --- JWT path ---

  it('returns 401 for invalid JWT (validation failure)', async () => {
    process.env.DUAL_AUTH_MODE = 'false';
    const deps = makeDeps({ validateJwt: mock.fn(async () => { throw new Error('invalid sig'); }) });
    const mw = createResourceServerMiddleware(deps);

    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJ0ZXN0IjoxfQ.invalidsig';
    const req = makeReq({ headers: { authorization: `Bearer ${jwt}` } });
    const res = makeRes();
    let nextCalled = false;
    await mw(req, res as any, (() => { nextCalled = true; }) as NextFunction);

    assert.equal(nextCalled, false);
    assert.equal(res._status, 401);
    assert.equal(res._json?.error, 'invalid_token');
    assert.ok(res._headers['WWW-Authenticate']);
  });

  it('returns 403 for insufficient scope', async () => {
    const deps = makeDeps({ hasScope: mock.fn(() => false) });
    const mw = createResourceServerMiddleware(deps);

    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJ0ZXN0IjoxfQ.validsig';
    const req = makeReq({ headers: { authorization: `Bearer ${jwt}` }, path: '/calendar' });
    const res = makeRes();
    let nextCalled = false;
    await mw(req, res as any, (() => { nextCalled = true; }) as NextFunction);

    assert.equal(nextCalled, false);
    assert.equal(res._status, 403);
    assert.equal(res._json?.error, 'insufficient_scope');
    assert.equal(res._json?.required_scope, 'mcp:calendar');
  });

  it('calls next and sets trusted headers on valid JWT', async () => {
    const deps = makeDeps();
    const mw = createResourceServerMiddleware(deps);

    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJ0ZXN0IjoxfQ.validsig';
    const req = makeReq({ headers: { authorization: `Bearer ${jwt}` }, path: '/mcp' });
    const res = makeRes();
    let nextCalled = false;
    await mw(req, res as any, (() => { nextCalled = true; }) as NextFunction);

    assert.ok(nextCalled);
    assert.equal(req.headers['x-mcp-user-id'], '1');
    assert.equal(req.headers['x-mcp-user-sub'], 'auth0|123');
    assert.equal(req.headers['x-mcp-user-email'], 'u@test.com');
  });

  it('does not set email header when user has no email', async () => {
    const noEmailUser = { ...fakeUser, email: '' };
    const deps = makeDeps({ mapJwtToUser: mock.fn(async () => noEmailUser) });
    const mw = createResourceServerMiddleware(deps);

    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJ0ZXN0IjoxfQ.validsig';
    const req = makeReq({ headers: { authorization: `Bearer ${jwt}` } });
    const res = makeRes();
    let nextCalled = false;
    await mw(req, res as any, (() => { nextCalled = true; }) as NextFunction);

    assert.ok(nextCalled);
    assert.equal(req.headers['x-mcp-user-email'], undefined);
  });

  it('returns 503 when user mapping fails', async () => {
    const deps = makeDeps({ mapJwtToUser: mock.fn(async () => { throw new Error('db down'); }) });
    const mw = createResourceServerMiddleware(deps);

    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJ0ZXN0IjoxfQ.validsig';
    const req = makeReq({ headers: { authorization: `Bearer ${jwt}` } });
    const res = makeRes();
    let nextCalled = false;
    await mw(req, res as any, (() => { nextCalled = true; }) as NextFunction);

    assert.equal(nextCalled, false);
    assert.equal(res._status, 503);
    assert.equal(res._json?.error, 'user_mapping_error');
  });

  it('returns 403, not a retryable 503, when the JWT email is not verified', async () => {
    const unverified = Object.assign(new Error('The email x@y.z is not verified'), { name: 'UnverifiedEmailError' });
    const deps = makeDeps({ mapJwtToUser: mock.fn(async () => { throw unverified; }) });
    const mw = createResourceServerMiddleware(deps);
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJ0ZXN0IjoxfQ.validsig';
    const res = makeRes();
    let nextCalled = false;
    await mw(makeReq({ headers: { authorization: `Bearer ${jwt}` } }), res as any, (() => { nextCalled = true; }) as NextFunction);
    assert.equal(nextCalled, false);
    assert.equal(res._status, 403);
    assert.equal(res._json?.error, 'email_not_verified');
  });

  it('skips scope check for unknown routes', async () => {
    const deps = makeDeps({ getRequiredScope: mock.fn(() => null) });
    const mw = createResourceServerMiddleware(deps);

    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJ0ZXN0IjoxfQ.validsig';
    const req = makeReq({ headers: { authorization: `Bearer ${jwt}` }, path: '/unknown' });
    const res = makeRes();
    let nextCalled = false;
    await mw(req, res as any, (() => { nextCalled = true; }) as NextFunction);

    assert.ok(nextCalled);
    assert.equal((deps.hasScope as any).mock.callCount(), 0);
  });

  // --- Opaque token path ---

  it('returns 503 when opaque user mapping fails', async () => {
    const deps = makeDeps({
      validateOpaqueToken: mock.fn(async () => ({ ...fakePayload, isOpaque: true })),
      mapJwtToUser: mock.fn(async () => { throw new Error('db down'); }),
    });
    const mw = createResourceServerMiddleware(deps);

    const req = makeReq({ headers: { authorization: `Bearer ${fakeOpaqueToken}` } });
    const res = makeRes();
    let nextCalled = false;
    await mw(req, res as any, (() => { nextCalled = true; }) as NextFunction);

    assert.equal(nextCalled, false);
    assert.equal(res._status, 503);
  });

  it('returns 403 when the opaque token email is not verified', async () => {
    const unverified = Object.assign(new Error('not verified'), { name: 'UnverifiedEmailError' });
    const deps = makeDeps({
      validateOpaqueToken: mock.fn(async () => ({ ...fakePayload, isOpaque: true })),
      mapJwtToUser: mock.fn(async () => { throw unverified; }),
    });
    const mw = createResourceServerMiddleware(deps);
    const res = makeRes();
    await mw(makeReq({ headers: { authorization: `Bearer ${fakeOpaqueToken}` } }), res as any, (() => {}) as NextFunction);
    assert.equal(res._status, 403);
    assert.equal(res._json?.error, 'email_not_verified');
  });

  it('returns 403 for opaque token with insufficient scope', async () => {
    const deps = makeDeps({
      validateOpaqueToken: mock.fn(async () => ({ ...fakePayload, isOpaque: true })),
      hasScope: mock.fn(() => false),
    });
    const mw = createResourceServerMiddleware(deps);

    const req = makeReq({ headers: { authorization: `Bearer ${fakeOpaqueToken}` }, path: '/calendar' });
    const res = makeRes();
    let nextCalled = false;
    await mw(req, res as any, (() => { nextCalled = true; }) as NextFunction);

    assert.equal(nextCalled, false);
    assert.equal(res._status, 403);
  });

  // --- Non-Bearer auth ---

  it('rejects non-Bearer authorization header when dual mode off', async () => {
    process.env.DUAL_AUTH_MODE = 'false';
    const deps = makeDeps({ validateOpaqueToken: mock.fn(async () => { throw new Error('invalid'); }) });
    const mw = createResourceServerMiddleware(deps);

    const req = makeReq({ headers: { authorization: 'Basic dXNlcjpwYXNz' } });
    const res = makeRes();
    let nextCalled = false;
    await mw(req, res as any, (() => { nextCalled = true; }) as NextFunction);

    assert.equal(nextCalled, false);
    assert.equal(res._status, 401);
  });
});
