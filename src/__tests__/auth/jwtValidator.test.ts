import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { hasScope, validateJwt, validateOpaqueToken, _resetJwks } from '../../auth/jwtValidator.js';

describe('jwtValidator', () => {
  const originalDomain = process.env.AUTH0_DOMAIN;
  const originalAudience = process.env.AUTH0_AUDIENCE;

  afterEach(() => {
    if (originalDomain !== undefined) process.env.AUTH0_DOMAIN = originalDomain;
    else delete process.env.AUTH0_DOMAIN;
    if (originalAudience !== undefined) process.env.AUTH0_AUDIENCE = originalAudience;
    else delete process.env.AUTH0_AUDIENCE;
    _resetJwks();
  });

  describe('hasScope', () => {
    it('should return true when scope is present', () => {
      const payload = { sub: 'u1', scope: 'mcp:docs mcp:sheets', iss: 'iss', aud: 'aud' };
      assert.ok(hasScope(payload, 'mcp:docs'));
      assert.ok(hasScope(payload, 'mcp:sheets'));
    });

    it('should return false when scope is missing', () => {
      const payload = { sub: 'u1', scope: 'mcp:docs', iss: 'iss', aud: 'aud' };
      assert.equal(hasScope(payload, 'mcp:sheets'), false);
    });

    it('should return false for empty scope without isOpaque flag', () => {
      const payload = { sub: 'u1', scope: '', iss: 'iss', aud: 'aud' };
      assert.equal(hasScope(payload, 'mcp:docs'), false);
    });

    it('should return true for opaque tokens (isOpaque flag)', () => {
      const payload = { sub: 'u1', scope: '', iss: 'iss', aud: 'aud', isOpaque: true };
      assert.ok(hasScope(payload, 'mcp:docs'));
    });

    it('should still check scopes for JWT tokens with isOpaque=false', () => {
      const payload = { sub: 'u1', scope: 'mcp:docs', iss: 'iss', aud: 'aud', isOpaque: false };
      assert.ok(hasScope(payload, 'mcp:docs'));
      assert.equal(hasScope(payload, 'mcp:sheets'), false);
    });

    it('should not match partial scope names', () => {
      const payload = { sub: 'u1', scope: 'mcp:docs-admin', iss: 'iss', aud: 'aud' };
      assert.equal(hasScope(payload, 'mcp:docs'), false);
    });

    it('should handle single scope', () => {
      const payload = { sub: 'u1', scope: 'mcp:calendar', iss: 'iss', aud: 'aud' };
      assert.ok(hasScope(payload, 'mcp:calendar'));
    });
  });

  describe('validateJwt', () => {
    it('should throw when AUTH0_AUDIENCE is not set', async () => {
      process.env.AUTH0_DOMAIN = 'test.auth0.com';
      delete process.env.AUTH0_AUDIENCE;
      _resetJwks();

      await assert.rejects(
        () => validateJwt('eyJhbGciOiJSUzI1NiJ9.eyJ0ZXN0IjoxfQ.sig'),
        { message: /AUTH0_AUDIENCE/ }
      );
    });

    it('should throw when AUTH0_DOMAIN is not set', async () => {
      delete process.env.AUTH0_DOMAIN;
      process.env.AUTH0_AUDIENCE = 'https://mcp.test';
      _resetJwks();

      await assert.rejects(
        () => validateJwt('eyJhbGciOiJSUzI1NiJ9.eyJ0ZXN0IjoxfQ.sig'),
        { message: /AUTH0_DOMAIN/ }
      );
    });
  });

  describe('validateOpaqueToken', () => {
    it('reports emailVerified only when /userinfo says email_verified: true', async () => {
      const realFetch = globalThis.fetch;
      const savedDomain = process.env.AUTH0_DOMAIN;
      process.env.AUTH0_DOMAIN = 'tenant.example.test';
      const answers: Record<string, unknown>[] = [
        { sub: 'auth0|v', email: 'v@example.com', email_verified: true },
        { sub: 'auth0|u', email: 'u@example.com', email_verified: false },
        { sub: 'auth0|m', email: 'm@example.com' },
        { sub: 'auth0|s', email: 's@example.com', email_verified: 'true' },
      ];
      let i = 0;
      globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => answers[i++] })) as any;
      try {
        const results = [];
        for (const token of ['tok-verified', 'tok-unverified', 'tok-missing', 'tok-string']) {
          results.push((await validateOpaqueToken(`${token}-${Date.now()}`)).emailVerified);
        }
        // Only a real boolean true counts; a string "true" is not trusted.
        assert.deepEqual(results, [true, false, false, false]);
      } finally {
        globalThis.fetch = realFetch;
        if (savedDomain === undefined) delete process.env.AUTH0_DOMAIN;
        else process.env.AUTH0_DOMAIN = savedDomain;
      }
    });

    it('should throw when AUTH0_DOMAIN is not set', async () => {
      delete process.env.AUTH0_DOMAIN;

      await assert.rejects(
        () => validateOpaqueToken('some-opaque-token'),
        { message: /AUTH0_DOMAIN/ }
      );
    });
  });
});
