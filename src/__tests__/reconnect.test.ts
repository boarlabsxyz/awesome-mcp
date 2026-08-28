import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeTokenStatus, mergeReconnectTokens, mergeProviderReconnectTokens } from '../website/webServer.js';

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

// ---------- mergeProviderReconnectTokens ----------
//
// The non-Google providers (ClickUp, Outline, HubSpot) used to ignore
// reconnectInstanceId entirely: the callback fell through to an
// "already connected?" check that matches on the regenerated instance name,
// and since that name is derived from the workspace/portal it ALWAYS matches
// on a reconnect. So re-consenting redirected to `already_exists` and the
// stale token was never replaced — a guaranteed no-op, reported in the field
// as "it says ClickUp (S&F) is already connected when I try to reconnect".
// These pin the merge that reconnect now runs.

describe('mergeProviderReconnectTokens', () => {
  it('keeps the refresh_token when the fresh exchange omitted it', () => {
    // Outline rotates its refresh token and HubSpot can omit it. Overwriting
    // with undefined yields a connection that works for an hour, then dies.
    const merged = mergeProviderReconnectTokens(
      { access_token: 'new-access', refresh_token: undefined },
      { access_token: 'old-access', refresh_token: 'stored-refresh' },
    );
    assert.equal(merged.access_token, 'new-access');
    assert.equal(merged.refresh_token, 'stored-refresh');
  });

  it('prefers a freshly-issued refresh_token over the stored one', () => {
    const merged = mergeProviderReconnectTokens(
      { access_token: 'new-access', refresh_token: 'rotated' },
      { access_token: 'old-access', refresh_token: 'stored-refresh' },
    );
    assert.equal(merged.refresh_token, 'rotated');
  });

  it('preserves a Slack channel allowlist rather than widening access', () => {
    // A reconnect must never move access outward.
    const rules = { allowedOrgs: ['T1'], whitelistChannels: ['C-allowed'], blacklistChannels: [] };
    const merged = mergeProviderReconnectTokens(
      { access_token: 'new-access' },
      { access_token: 'old-access', accessRules: rules },
    );
    assert.deepEqual(merged.accessRules, rules);
  });

  it('preserves Outline baseUrl when the env var is no longer set', () => {
    const merged = mergeProviderReconnectTokens(
      { access_token: 'new-access', baseUrl: '' },
      { access_token: 'old', baseUrl: 'https://wiki.example.test' },
    );
    assert.equal(merged.baseUrl, 'https://wiki.example.test');
  });

  it('does not invent keys the stored record never had', () => {
    const merged = mergeProviderReconnectTokens(
      { access_token: 'new-access' },
      { access_token: 'old-access' },
    );
    assert.deepEqual(Object.keys(merged), ['access_token']);
  });

  it('carries nothing over on a first connect (no stored record)', () => {
    const merged = mergeProviderReconnectTokens({ access_token: 'a', refresh_token: undefined }, null);
    assert.equal(merged.access_token, 'a');
    assert.equal(merged.refresh_token, undefined);
  });

  it('never mutates either input', () => {
    const fresh = { access_token: 'new' };
    const stored = { access_token: 'old', refresh_token: 'r' };
    mergeProviderReconnectTokens(fresh, stored);
    assert.deepEqual(fresh, { access_token: 'new' });
    assert.deepEqual(stored, { access_token: 'old', refresh_token: 'r' });
  });

  it('only carries the allowlisted keys, not arbitrary stored state', () => {
    const merged = mergeProviderReconnectTokens(
      { access_token: 'new' },
      { access_token: 'old', someLegacyField: 'should-not-survive' },
    );
    assert.equal((merged as any).someLegacyField, undefined);
  });
});
