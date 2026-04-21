import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { hasScope, validateJwt, _resetJwks } from '../../auth/jwtValidator.js';

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

    it('should return true for empty scope string (opaque tokens)', () => {
      const payload = { sub: 'u1', scope: '', iss: 'iss', aud: 'aud' };
      assert.ok(hasScope(payload, 'mcp:docs'));
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
});
