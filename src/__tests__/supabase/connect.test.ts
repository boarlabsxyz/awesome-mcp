// src/__tests__/supabase/connect.test.ts
// Connect-time pieces: paste-token validation, instance naming, the OAuth
// exchange and refresh, and the session factory both flows land in.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSupabaseInstanceName,
  fetchSupabaseOrganizationSummary,
  validateSupabaseToken,
} from '../../supabase/connectToken.js';
import { exchangeSupabaseOauthCode, refreshSupabaseToken, SUPABASE_TOKEN_URL } from '../../supabase/oauthCallback.js';
import { createSupabaseSession } from '../../userSession.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function recordingFetch(handler: (url: string, init: RequestInit) => Response) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: any, init: any) => {
    seen.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  return { fetchImpl, seen };
}

describe('validateSupabaseToken', () => {
  it('probes GET /v1/organizations with the token as Bearer, without following redirects', async () => {
    const { fetchImpl, seen } = recordingFetch(() => json(200, []));
    const result = await validateSupabaseToken({ token: ' sbp_abc ', fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(seen[0].url, 'https://api.supabase.com/v1/organizations');
    assert.equal((seen[0].init.headers as Record<string, string>).Authorization, 'Bearer sbp_abc');
    assert.equal(seen[0].init.redirect, 'error');
  });

  it('says a project key is not the account token when rejected', async () => {
    const { fetchImpl } = recordingFetch(() => json(401, { message: 'Unauthorized' }));
    const result = await validateSupabaseToken({ token: 'eyJhbGciOi...', fetchImpl });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.userMessage, /not a project API key/);
  });

  it('rejects a blank token before touching the network', async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return json(200, []); }) as typeof fetch;
    const result = await validateSupabaseToken({ token: '  ', fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(called, false);
  });
});

describe('fetchSupabaseOrganizationSummary', () => {
  it('counts the organizations and names the first', async () => {
    const { fetchImpl } = recordingFetch(() => json(200, [{ id: 'o1', name: 'Acme' }, { id: 'o2', name: 'Personal' }]));
    assert.deepEqual(await fetchSupabaseOrganizationSummary('t', fetchImpl), { count: 2, firstName: 'Acme' });
  });

  it('degrades to {} rather than failing the connect', async () => {
    const failing = (async () => { throw new Error('boom'); }) as typeof fetch;
    assert.deepEqual(await fetchSupabaseOrganizationSummary('t', failing), {});
    const { fetchImpl } = recordingFetch(() => json(500, {}));
    assert.deepEqual(await fetchSupabaseOrganizationSummary('t', fetchImpl), {});
  });
});

describe('buildSupabaseInstanceName', () => {
  it('prefers an explicit name, then one organization, then a count', () => {
    assert.equal(buildSupabaseInstanceName({ serviceName: 'Supabase', providedInstanceName: 'Work' }), 'Work');
    assert.equal(buildSupabaseInstanceName({ serviceName: 'Supabase', organizationCount: 1, firstOrganizationName: 'Acme' }), 'Supabase (Acme)');
    assert.equal(buildSupabaseInstanceName({ serviceName: 'Supabase', organizationCount: 3, firstOrganizationName: 'Acme' }), 'Supabase (3 organizations)');
  });

  it('does not render zero organizations as a label that reads like a failure', () => {
    assert.equal(buildSupabaseInstanceName({ serviceName: 'Supabase', organizationCount: 0 }), 'Supabase');
  });
});

describe('exchangeSupabaseOauthCode', () => {
  it('posts the code to the token endpoint, then names the grant after its organization', async () => {
    const { fetchImpl, seen } = recordingFetch(url =>
      url === SUPABASE_TOKEN_URL
        ? json(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 })
        : json(200, [{ id: 'o1', name: 'Acme' }]));
    const result = await exchangeSupabaseOauthCode({
      tokenUrl: SUPABASE_TOKEN_URL, code: 'c', clientId: 'id', clientSecret: 'sec', redirectUri: 'https://x/cb', fetchImpl,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.accessToken, 'at');
      assert.equal(result.refreshToken, 'rt');
      assert.equal(result.expiresIn, 3600);
      assert.equal(result.organizationName, 'Acme');
    }
    const body = new URLSearchParams(String(seen[0].init.body));
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('client_secret'), 'sec');
    assert.equal(body.get('redirect_uri'), 'https://x/cb');
  });

  it('reports a failed exchange without throwing', async () => {
    const { fetchImpl } = recordingFetch(() => json(400, { error: 'invalid_grant' }));
    const result = await exchangeSupabaseOauthCode({
      tokenUrl: SUPABASE_TOKEN_URL, code: 'c', clientId: 'id', clientSecret: 'sec', redirectUri: 'https://x/cb', fetchImpl,
    });
    assert.equal(result.ok, false);
  });
});

describe('refreshSupabaseToken', () => {
  it('sends the refresh grant and returns the new tokens', async () => {
    const { fetchImpl, seen } = recordingFetch(() => json(200, { access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 }));
    const result = await refreshSupabaseToken({ tokenUrl: SUPABASE_TOKEN_URL, refreshToken: 'rt', clientId: 'id', clientSecret: 'sec', fetchImpl });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.refreshToken, 'rt2');
    assert.equal(new URLSearchParams(String(seen[0].init.body)).get('grant_type'), 'refresh_token');
  });
});

describe('createSupabaseSession', () => {
  const user = { id: 'u1', apiKey: 'k-supabase-test', email: 'a@b.c' } as any;

  it('carries the token, and refresh plumbing only when the connection has it', () => {
    const pat = createSupabaseSession(user, {
      instanceId: 'i-pat', mcpSlug: 'supabase', providerTokens: { access_token: 'sbp_x' },
    } as any);
    assert.equal(pat.supabaseAccessToken, 'sbp_x');
    assert.equal(pat.supabaseRefreshToken, undefined);
    assert.equal(pat.supabaseTokenExpiry, undefined);
    assert.equal(pat.supabaseInstanceId, 'i-pat');

    const oauth = createSupabaseSession(user, {
      instanceId: 'i-oauth', mcpSlug: 'supabase', providerTokens: { access_token: 'at', refresh_token: 'rt', expiry_date: 123 },
    } as any);
    assert.equal(oauth.supabaseRefreshToken, 'rt');
    assert.equal(oauth.supabaseTokenExpiry, 123);
  });

  it('refuses a connection with no token instead of building a session that fails later', () => {
    assert.throws(
      () => createSupabaseSession(user, { instanceId: 'i-empty', mcpSlug: 'supabase', providerTokens: {} } as any),
      /missing/,
    );
  });
});
