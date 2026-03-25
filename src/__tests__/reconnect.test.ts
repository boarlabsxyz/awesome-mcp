import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeTokenStatus, mergeReconnectTokens } from '../website/webServer.js';

// ---------- computeTokenStatus ----------

describe('computeTokenStatus', () => {
  it('returns expired=true when no refresh_token and expiry_date is in the past', () => {
    const result = computeTokenStatus({
      refresh_token: '',
      expiry_date: Date.now() - 3600_000, // 1 hour ago
    });
    assert.equal(result.hasRefreshToken, false);
    assert.equal(result.isExpired, true);
    assert.equal(typeof result.expiryDate, 'number');
  });

  it('returns expired=false when no refresh_token but expiry_date is in the future', () => {
    const futureDate = Date.now() + 3600_000;
    const result = computeTokenStatus({
      refresh_token: '',
      expiry_date: futureDate,
    });
    assert.equal(result.hasRefreshToken, false);
    assert.equal(result.isExpired, false);
    assert.equal(result.expiryDate, futureDate);
  });

  it('returns expired=false when refresh_token exists even if expiry_date is in the past', () => {
    const result = computeTokenStatus({
      refresh_token: 'valid-refresh-token',
      expiry_date: Date.now() - 3600_000,
    });
    assert.equal(result.hasRefreshToken, true);
    assert.equal(result.isExpired, false);
  });

  it('handles null googleTokens', () => {
    const result = computeTokenStatus(null);
    assert.equal(result.hasRefreshToken, false);
    assert.equal(result.expiryDate, null);
    assert.equal(result.isExpired, false);
  });

  it('handles undefined googleTokens', () => {
    const result = computeTokenStatus(undefined);
    assert.equal(result.hasRefreshToken, false);
    assert.equal(result.expiryDate, null);
    assert.equal(result.isExpired, false);
  });

  it('handles tokens with no expiry_date', () => {
    const result = computeTokenStatus({
      refresh_token: 'some-token',
    });
    assert.equal(result.hasRefreshToken, true);
    assert.equal(result.expiryDate, null);
    assert.equal(result.isExpired, false);
  });

  it('handles empty object', () => {
    const result = computeTokenStatus({});
    assert.equal(result.hasRefreshToken, false);
    assert.equal(result.expiryDate, null);
    assert.equal(result.isExpired, false);
  });
});

// ---------- mergeReconnectTokens ----------

describe('mergeReconnectTokens', () => {
  const baseTokens = {
    access_token: 'new-access',
    refresh_token: '',
    scope: 'email profile',
    token_type: 'Bearer',
    expiry_date: Date.now() + 3600_000,
  };

  it('preserves existing refresh_token when new tokens have empty refresh_token', () => {
    const result = mergeReconnectTokens(
      { ...baseTokens, refresh_token: '' },
      'existing-refresh-token'
    );
    assert.equal(result.refresh_token, 'existing-refresh-token');
    assert.equal(result.access_token, 'new-access');
  });

  it('uses new refresh_token when provided', () => {
    const result = mergeReconnectTokens(
      { ...baseTokens, refresh_token: 'brand-new-refresh' },
      'existing-refresh-token'
    );
    assert.equal(result.refresh_token, 'brand-new-refresh');
  });

  it('returns empty refresh_token when both are empty', () => {
    const result = mergeReconnectTokens(
      { ...baseTokens, refresh_token: '' },
      ''
    );
    assert.equal(result.refresh_token, '');
  });

  it('returns empty refresh_token when existing is undefined and new is empty', () => {
    const result = mergeReconnectTokens(
      { ...baseTokens, refresh_token: '' },
      undefined
    );
    assert.equal(result.refresh_token, '');
  });

  it('preserves all other token fields unchanged', () => {
    const tokens = {
      access_token: 'acc-123',
      refresh_token: '',
      scope: 'docs drive',
      token_type: 'Bearer',
      expiry_date: 1234567890,
    };
    const result = mergeReconnectTokens(tokens, 'old-refresh');
    assert.equal(result.access_token, 'acc-123');
    assert.equal(result.scope, 'docs drive');
    assert.equal(result.token_type, 'Bearer');
    assert.equal(result.expiry_date, 1234567890);
    assert.equal(result.refresh_token, 'old-refresh');
  });

  it('does not mutate the original tokens object', () => {
    const tokens = {
      access_token: 'acc',
      refresh_token: '',
      scope: 's',
      token_type: 'Bearer',
      expiry_date: 1000,
    };
    mergeReconnectTokens(tokens, 'preserved');
    assert.equal(tokens.refresh_token, '', 'original should not be mutated');
  });
});
