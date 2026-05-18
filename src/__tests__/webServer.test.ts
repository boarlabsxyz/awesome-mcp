import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeEffectiveScopes, computeTokenStatus, mergeReconnectTokens } from '../website/webServer.js';

// Test the exported pure functions with more edge cases
// to boost coverage on the webServer.ts new code

describe('computeTokenStatus – additional edge cases', () => {
  it('returns correct shape for tokens with zero expiry_date', () => {
    const result = computeTokenStatus({
      refresh_token: '',
      expiry_date: 0,
    });
    assert.equal(result.hasRefreshToken, false);
    // 0 is falsy, so expiryDate should be null
    assert.equal(result.expiryDate, null);
    assert.equal(result.isExpired, false);
  });

  it('handles expiry_date exactly at Date.now() boundary', () => {
    const now = Date.now();
    const result = computeTokenStatus({
      refresh_token: '',
      expiry_date: now - 1, // just expired
    });
    assert.equal(result.isExpired, true);
  });

  it('returns full token-shaped input correctly', () => {
    const expiry = Date.now() + 7200_000;
    const result = computeTokenStatus({
      refresh_token: 'ref-tok',
      expiry_date: expiry,
    });
    assert.equal(result.hasRefreshToken, true);
    assert.equal(result.expiryDate, expiry);
    assert.equal(result.isExpired, false);
  });

  it('returns expired for full tokens with empty refresh and past expiry', () => {
    const result = computeTokenStatus({
      refresh_token: '',
      expiry_date: Date.now() - 86400_000, // 24 hours ago
    });
    assert.equal(result.hasRefreshToken, false);
    assert.equal(result.isExpired, true);
    assert.equal(typeof result.expiryDate, 'number');
  });
});

describe('mergeReconnectTokens – additional edge cases', () => {
  it('handles tokens where refresh_token is a whitespace string', () => {
    // Whitespace is truthy, so it counts as "has refresh token"
    const result = mergeReconnectTokens(
      { access_token: 'a', refresh_token: ' ', scope: 's', token_type: 'B', expiry_date: 1 },
      'old-refresh'
    );
    // ' ' is truthy, so new token is used as-is
    assert.equal(result.refresh_token, ' ');
  });

  it('returns the exact same object reference when refresh_token is provided', () => {
    const tokens = { access_token: 'a', refresh_token: 'new-ref', scope: 's', token_type: 'B', expiry_date: 1 };
    const result = mergeReconnectTokens(tokens, 'old-ref');
    assert.equal(result, tokens, 'should return same reference when no merge needed');
  });

  it('returns a new object when merging (not same reference)', () => {
    const tokens = { access_token: 'a', refresh_token: '', scope: 's', token_type: 'B', expiry_date: 1 };
    const result = mergeReconnectTokens(tokens, 'preserved');
    assert.notEqual(result, tokens, 'should return a new object when merging');
    assert.equal(result.refresh_token, 'preserved');
  });
});

describe('computeEffectiveScopes', () => {
  const USERINFO_EMAIL = 'https://www.googleapis.com/auth/userinfo.email';
  const USERINFO_PROFILE = 'https://www.googleapis.com/auth/userinfo.profile';

  it('falls back to BASE_SCOPES + mcp.scopes when google provider has empty oauthScopes', () => {
    const result = computeEffectiveScopes(
      'google',
      [],
      ['https://www.googleapis.com/auth/documents']
    );
    assert.deepEqual(result, [
      USERINFO_EMAIL,
      USERINFO_PROFILE,
      'https://www.googleapis.com/auth/documents',
    ]);
  });

  it('falls back when google provider has null/undefined oauthScopes', () => {
    assert.deepEqual(
      computeEffectiveScopes('google', null, ['https://www.googleapis.com/auth/drive']),
      [USERINFO_EMAIL, USERINFO_PROFILE, 'https://www.googleapis.com/auth/drive']
    );
    assert.deepEqual(
      computeEffectiveScopes('google', undefined, undefined),
      [USERINFO_EMAIL, USERINFO_PROFILE]
    );
  });

  it('returns declared oauthScopes when google provider has them', () => {
    const declared = [
      USERINFO_EMAIL,
      'https://www.googleapis.com/auth/gmail.modify',
    ];
    assert.deepEqual(computeEffectiveScopes('google', declared, ['ignored']), declared);
  });

  it('returns declared oauthScopes for non-google providers without fallback', () => {
    assert.deepEqual(
      computeEffectiveScopes('clickup', [], ['ignored']),
      []
    );
    assert.deepEqual(
      computeEffectiveScopes('slack', ['channels:read', 'chat:write'], ['ignored']),
      ['channels:read', 'chat:write']
    );
    assert.deepEqual(
      computeEffectiveScopes('slack-bot', null, ['ignored']),
      []
    );
  });
});
