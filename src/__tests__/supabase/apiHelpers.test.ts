// src/__tests__/supabase/apiHelpers.test.ts
// Call-time OAuth refresh: a no-op for a pasted token, single-flight for an
// expiring one, and never fatal.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { maybeRefreshSupabaseToken } from '../../supabase/apiHelpers.js';
import { SUPABASE_TOKEN_URL } from '../../supabase/oauthCallback.js';

const log = { info: () => {}, error: () => {} };

function oauthSession(overrides: Record<string, unknown> = {}): any {
  return {
    supabaseAccessToken: 'old',
    supabaseRefreshToken: 'rt',
    supabaseTokenExpiry: Date.now() - 1_000,
    supabaseOauthClientId: 'id',
    supabaseOauthClientSecret: 'sec',
    ...overrides,
  };
}

describe('maybeRefreshSupabaseToken', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  function tokenEndpoint(body: unknown, status = 200) {
    const calls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      calls.push(String(url));
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return calls;
  }

  it('does nothing for a personal access token, which never expires', async () => {
    const calls = tokenEndpoint({});
    const session = { supabaseAccessToken: 'sbp_x' } as any;
    await maybeRefreshSupabaseToken(session, log);
    assert.equal(calls.length, 0);
    assert.equal(session.supabaseAccessToken, 'sbp_x');
  });

  it('does nothing while the token is comfortably valid', async () => {
    const calls = tokenEndpoint({});
    await maybeRefreshSupabaseToken(oauthSession({ supabaseTokenExpiry: Date.now() + 60 * 60_000 }), log);
    assert.equal(calls.length, 0);
  });

  it('swaps in the new tokens when the old one has expired', async () => {
    const calls = tokenEndpoint({ access_token: 'new', refresh_token: 'rt2', expires_in: 3600 });
    const session = oauthSession();
    await maybeRefreshSupabaseToken(session, log);
    assert.deepEqual(calls, [SUPABASE_TOKEN_URL]);
    assert.equal(session.supabaseAccessToken, 'new');
    assert.equal(session.supabaseRefreshToken, 'rt2');
    assert.ok(session.supabaseTokenExpiry > Date.now());
  });

  it('keeps the old refresh token when Supabase does not send a new one', async () => {
    tokenEndpoint({ access_token: 'new', expires_in: 3600 });
    const session = oauthSession();
    await maybeRefreshSupabaseToken(session, log);
    assert.equal(session.supabaseRefreshToken, 'rt');
  });

  it('runs ONE refresh for concurrent calls on the same session', async () => {
    const calls = tokenEndpoint({ access_token: 'new', refresh_token: 'rt2', expires_in: 3600 });
    const session = oauthSession();
    await Promise.all([maybeRefreshSupabaseToken(session, log), maybeRefreshSupabaseToken(session, log)]);
    assert.equal(calls.length, 1);
  });

  it('falls through to the existing token when the refresh fails, rather than throwing', async () => {
    tokenEndpoint({ error: 'invalid_grant' }, 400);
    const session = oauthSession();
    await maybeRefreshSupabaseToken(session, log);
    assert.equal(session.supabaseAccessToken, 'old');
  });
});
