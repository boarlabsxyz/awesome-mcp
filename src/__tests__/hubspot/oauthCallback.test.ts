// src/__tests__/hubspot/oauthCallback.test.ts
import { test, describe, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  exchangeHubSpotOauthCode,
  refreshHubSpotToken,
  fetchHubSpotTokenInfo,
  buildHubSpotOauthInstanceName,
  HUBSPOT_TOKEN_URL,
} from '../../hubspot/oauthCallback.js';

type Rt = { status?: number; body?: any; throw?: any };
function makeFetch(handler: (url: string, init: any) => Rt): typeof fetch {
  return (async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    const r = handler(url, init);
    if (r.throw) throw r.throw;
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.body,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? '')),
    } as any as Response;
  }) as any;
}

afterEach(() => mock.restoreAll());

const baseInput = {
  tokenUrl: HUBSPOT_TOKEN_URL,
  code: 'the-code',
  clientId: 'cid',
  clientSecret: 'secret',
  redirectUri: 'https://app.example.com/connect/hubspot/callback',
};

describe('exchangeHubSpotOauthCode', () => {
  test('exchanges code, then enriches with portal domain + email', async () => {
    let tokenBody: URLSearchParams | undefined;
    const fetchImpl = makeFetch((url, init) => {
      if (url === HUBSPOT_TOKEN_URL) {
        tokenBody = new URLSearchParams(init.body);
        return { body: { access_token: 'AT', refresh_token: 'RT', expires_in: 1800 } };
      }
      // token-info endpoint
      return { body: { hub_domain: 'acme.hubspot.com', user: 'ops@acme.com' } };
    });
    const r = await exchangeHubSpotOauthCode({ ...baseInput, fetchImpl });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.accessToken, 'AT');
      assert.equal(r.refreshToken, 'RT');
      assert.equal(r.expiresIn, 1800);
      assert.equal(r.hubDomain, 'acme.hubspot.com');
      assert.equal(r.email, 'ops@acme.com');
    }
    // form-encoded authorization_code grant
    assert.equal(tokenBody?.get('grant_type'), 'authorization_code');
    assert.equal(tokenBody?.get('code'), 'the-code');
    assert.equal(tokenBody?.get('redirect_uri'), baseInput.redirectUri);
  });

  test('succeeds even when token-info lookup fails (nulls, not an error)', async () => {
    const fetchImpl = makeFetch((url) =>
      url === HUBSPOT_TOKEN_URL ? { body: { access_token: 'AT', expires_in: 1800 } } : { status: 500 },
    );
    const r = await exchangeHubSpotOauthCode({ ...baseInput, fetchImpl });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.refreshToken, null);
      assert.equal(r.hubDomain, null);
      assert.equal(r.email, null);
    }
  });

  test('maps a non-2xx token response to its status', async () => {
    const fetchImpl = makeFetch(() => ({ status: 400, body: 'bad code' }));
    const r = await exchangeHubSpotOauthCode({ ...baseInput, fetchImpl });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.match(r.userMessage, /token exchange failed/i);
    }
  });

  test('rejects a 200 response with no access_token', async () => {
    const fetchImpl = makeFetch(() => ({ body: { expires_in: 1800 } }));
    const r = await exchangeHubSpotOauthCode({ ...baseInput, fetchImpl });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.userMessage, /no access token/i);
  });

  test('maps a timeout to 502', async () => {
    const fetchImpl = makeFetch(() => ({ throw: Object.assign(new Error('aborted'), { name: 'AbortError' }) }));
    const r = await exchangeHubSpotOauthCode({ ...baseInput, fetchImpl });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 502);
      assert.match(r.userMessage, /timed out/i);
    }
  });
});

describe('refreshHubSpotToken', () => {
  test('refreshes and keeps the old refresh token when none returned', async () => {
    let body: URLSearchParams | undefined;
    const fetchImpl = makeFetch((_url, init) => {
      body = new URLSearchParams(init.body);
      return { body: { access_token: 'AT2', expires_in: 1800 } };
    });
    const r = await refreshHubSpotToken({ tokenUrl: HUBSPOT_TOKEN_URL, refreshToken: 'RT', clientId: 'cid', clientSecret: 'secret', fetchImpl });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.accessToken, 'AT2');
      assert.equal(r.refreshToken, null); // caller keeps the existing one
      assert.equal(r.expiresIn, 1800);
    }
    assert.equal(body?.get('grant_type'), 'refresh_token');
    assert.equal(body?.get('refresh_token'), 'RT');
  });

  test('reports failure on a non-2xx', async () => {
    const fetchImpl = makeFetch(() => ({ status: 403, body: 'nope' }));
    const r = await refreshHubSpotToken({ tokenUrl: HUBSPOT_TOKEN_URL, refreshToken: 'RT', clientId: 'cid', clientSecret: 'secret', fetchImpl });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 403);
  });
});

describe('fetchHubSpotTokenInfo', () => {
  test('returns hub domain + user email', async () => {
    const fetchImpl = makeFetch((url) => {
      assert.match(url, /\/oauth\/v1\/access-tokens\/AT$/);
      return { body: { hub_domain: 'acme.hubspot.com', user: 'ops@acme.com' } };
    });
    assert.deepEqual(await fetchHubSpotTokenInfo('AT', fetchImpl), { hubDomain: 'acme.hubspot.com', email: 'ops@acme.com' });
  });

  test('returns nulls on failure', async () => {
    const fetchImpl = makeFetch(() => ({ throw: new Error('boom') }));
    assert.deepEqual(await fetchHubSpotTokenInfo('AT', fetchImpl), { hubDomain: null, email: null });
  });
});

describe('buildHubSpotOauthInstanceName', () => {
  const s = 'HubSpot';
  test('prefers provided name', () => {
    assert.equal(buildHubSpotOauthInstanceName({ serviceName: s, providedInstanceName: 'My CRM', hubDomain: 'x.com' }), 'My CRM');
  });
  test('then portal domain', () => {
    assert.equal(buildHubSpotOauthInstanceName({ serviceName: s, hubDomain: 'acme.hubspot.com', email: 'a@b.com' }), 'HubSpot (acme.hubspot.com)');
  });
  test('then email', () => {
    assert.equal(buildHubSpotOauthInstanceName({ serviceName: s, email: 'a@b.com' }), 'HubSpot (a@b.com)');
  });
  test('falls back to service name', () => {
    assert.equal(buildHubSpotOauthInstanceName({ serviceName: s }), 'HubSpot');
  });
});
