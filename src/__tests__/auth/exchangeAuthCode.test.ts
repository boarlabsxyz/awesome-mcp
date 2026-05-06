import assert from 'node:assert/strict';
import { describe, it, mock, beforeEach } from 'node:test';
import crypto from 'crypto';

// We need to mock the storage layer before importing exchangeAuthCode.
// Since exchangeAuthCode uses module-level imports (getAuthCode, deleteAuthCode, verifyPKCE),
// we test it indirectly through the exported function with pre-seeded auth codes.
import { exchangeAuthCode, storeAuthCode } from '../../website/oauthServer.js';

// Helper: create a valid PKCE challenge/verifier pair
function makePKCE(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// Helper: seed an auth code into the store
async function seedAuthCode(code: string, overrides: Record<string, any> = {}): Promise<{ verifier: string }> {
  const { verifier, challenge } = makePKCE();
  await storeAuthCode(code, {
    apiKey: 'test-api-key',
    clientId: 'client-1',
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    redirectUri: 'https://example.com/callback',
    expiresAt: Date.now() + 600_000,
    scope: 'mcp',
    ...overrides,
  });
  return { verifier };
}

describe('exchangeAuthCode', () => {
  it('rejects unsupported grant_type', async () => {
    const result = await exchangeAuthCode({
      grant_type: 'client_credentials',
      code: 'any',
      code_verifier: 'any',
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, 'unsupported_grant_type');
      assert.equal(result.status, 400);
    }
  });

  it('rejects missing code', async () => {
    const result = await exchangeAuthCode({
      grant_type: 'authorization_code',
      code: '',
      code_verifier: 'any',
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, 'invalid_request');
      assert.ok(result.errorDescription?.includes('Missing'));
    }
  });

  it('rejects missing code_verifier', async () => {
    const result = await exchangeAuthCode({
      grant_type: 'authorization_code',
      code: 'any',
      code_verifier: '',
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, 'invalid_request');
    }
  });

  it('rejects expired or invalid auth code', async () => {
    const result = await exchangeAuthCode({
      grant_type: 'authorization_code',
      code: 'nonexistent-code',
      code_verifier: 'any',
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, 'invalid_grant');
      assert.ok(result.errorDescription?.includes('expired'));
    }
  });

  it('rejects client_id mismatch', async () => {
    const code = crypto.randomBytes(16).toString('hex');
    const { verifier } = await seedAuthCode(code, { clientId: 'client-1' });

    const result = await exchangeAuthCode({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: 'wrong-client',
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, 'invalid_grant');
      assert.ok(result.errorDescription?.includes('client_id'));
    }
  });

  it('rejects redirect_uri mismatch', async () => {
    const code = crypto.randomBytes(16).toString('hex');
    const { verifier } = await seedAuthCode(code, { redirectUri: 'https://example.com/callback' });

    const result = await exchangeAuthCode({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: 'https://evil.com/callback',
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, 'invalid_grant');
      assert.ok(result.errorDescription?.includes('redirect_uri'));
    }
  });

  it('rejects invalid PKCE verifier', async () => {
    const code = crypto.randomBytes(16).toString('hex');
    await seedAuthCode(code);

    const result = await exchangeAuthCode({
      grant_type: 'authorization_code',
      code,
      code_verifier: 'wrong-verifier',
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, 'invalid_grant');
      assert.ok(result.errorDescription?.includes('PKCE'));
    }
  });

  it('succeeds with valid params and returns apiKey', async () => {
    const code = crypto.randomBytes(16).toString('hex');
    const { verifier } = await seedAuthCode(code, {
      apiKey: 'my-api-key',
      clientId: 'client-1',
      scope: 'mcp:slack',
    });

    const result = await exchangeAuthCode({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: 'client-1',
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.apiKey, 'my-api-key');
      assert.equal(result.scope, 'mcp:slack');
      assert.equal(result.clientId, 'client-1');
    }
  });

  it('uses default scope "mcp" when auth code has no scope', async () => {
    const code = crypto.randomBytes(16).toString('hex');
    const { verifier } = await seedAuthCode(code, { scope: undefined });

    const result = await exchangeAuthCode({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.scope, 'mcp');
    }
  });

  it('auth code is single-use (second exchange fails)', async () => {
    const code = crypto.randomBytes(16).toString('hex');
    const { verifier } = await seedAuthCode(code);

    const first = await exchangeAuthCode({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
    });
    assert.equal(first.ok, true);

    const second = await exchangeAuthCode({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
    });
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.error, 'invalid_grant');
    }
  });

  it('allows omitting client_id and redirect_uri (skips validation)', async () => {
    const code = crypto.randomBytes(16).toString('hex');
    const { verifier } = await seedAuthCode(code);

    const result = await exchangeAuthCode({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      // no client_id or redirect_uri
    });
    assert.equal(result.ok, true);
  });
});
