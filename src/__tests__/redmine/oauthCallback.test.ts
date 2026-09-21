// src/__tests__/redmine/oauthCallback.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  exchangeRedmineOauthCode,
  refreshRedmineToken,
  fetchRedmineCurrentUser,
  redmineOauthUrls,
} from '../../redmine/oauthCallback.js';

type HandlerResult = { status?: number; json?: unknown; text?: string };
type Handler = (url: string, init: RequestInit) => Promise<HandlerResult>;

function makeFetch(handler: Handler): typeof fetch {
  return (async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    const partial = await handler(url, init);
    const status = partial.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (partial.json === undefined) throw new Error('no json');
        return partial.json;
      },
      text: async () => partial.text ?? (partial.json ? JSON.stringify(partial.json) : ''),
      headers: new Headers(),
    } as any as Response;
  }) as any;
}

const BASE = 'https://redmine.example.com';
const TOKEN_URL = `${BASE}/oauth/token`;

describe('redmineOauthUrls', () => {
  // The endpoints belong to the instance, not to a central host — there is no
  // api.redmine.com to hardcode.
  test('derives both endpoints from the instance base URL', () => {
    assert.deepEqual(redmineOauthUrls(BASE), {
      authorizeUrl: `${BASE}/oauth/authorize`,
      tokenUrl: `${BASE}/oauth/token`,
    });
  });

  test('tolerates trailing slashes', () => {
    assert.equal(redmineOauthUrls(`${BASE}//`).tokenUrl, `${BASE}/oauth/token`);
  });
});

describe('exchangeRedmineOauthCode', () => {
  test('posts the authorization_code grant and returns the tokens', async () => {
    let body = '';
    let postedUrl = '';
    const fetchImpl = makeFetch(async (url, init) => {
      if (url.endsWith('/oauth/token')) {
        postedUrl = url;
        body = String(init.body);
        return { status: 200, json: { access_token: 'at', refresh_token: 'rt', expires_in: 7200 } };
      }
      return { status: 200, json: { user: { login: 'jsmith', mail: 'j@x.com' } } };
    });

    const r = await exchangeRedmineOauthCode({
      tokenUrl: TOKEN_URL, code: 'c0de', clientId: 'cid', clientSecret: 'secret',
      redirectUri: 'https://app.example.com/connect/redmine/callback', baseUrl: BASE, fetchImpl,
    });

    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.accessToken, 'at');
      assert.equal(r.refreshToken, 'rt');
      assert.equal(r.expiresIn, 7200);
      assert.equal(r.login, 'jsmith');
      assert.equal(r.email, 'j@x.com');
    }
    assert.equal(postedUrl, TOKEN_URL);
    const params = new URLSearchParams(body);
    assert.equal(params.get('grant_type'), 'authorization_code');
    assert.equal(params.get('code'), 'c0de');
    assert.equal(params.get('client_id'), 'cid');
    assert.equal(params.get('client_secret'), 'secret');
    assert.equal(params.get('redirect_uri'), 'https://app.example.com/connect/redmine/callback');
  });

  // The user lookup only names the connection — losing it must not lose the
  // token that was just successfully minted.
  test('still succeeds when the user lookup fails', async () => {
    const fetchImpl = makeFetch(async url => {
      if (url.endsWith('/oauth/token')) return { status: 200, json: { access_token: 'at' } };
      return { status: 403, text: 'nope' };
    });
    const r = await exchangeRedmineOauthCode({
      tokenUrl: TOKEN_URL, code: 'c', clientId: 'i', clientSecret: 's', redirectUri: 'r', baseUrl: BASE, fetchImpl,
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.accessToken, 'at');
      assert.equal(r.login, null);
      assert.equal(r.email, null);
      assert.equal(r.refreshToken, null);
      assert.equal(r.expiresIn, null);
    }
  });

  test('propagates a token-endpoint rejection', async () => {
    const fetchImpl = makeFetch(async () => ({ status: 400, text: '{"error":"invalid_grant"}' }));
    const r = await exchangeRedmineOauthCode({
      tokenUrl: TOKEN_URL, code: 'c', clientId: 'i', clientSecret: 's', redirectUri: 'r', fetchImpl,
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.match(r.logMessage, /invalid_grant/);
      assert.match(r.userMessage, /Redmine token exchange failed/);
    }
  });

  test('a 200 with no access_token is an error, not a success', async () => {
    const fetchImpl = makeFetch(async () => ({ status: 200, json: { token_type: 'Bearer' } }));
    const r = await exchangeRedmineOauthCode({
      tokenUrl: TOKEN_URL, code: 'c', clientId: 'i', clientSecret: 's', redirectUri: 'r', fetchImpl,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.userMessage, /no access token/);
  });

  test('a network failure maps to 502', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNRESET'); }) as any;
    const r = await exchangeRedmineOauthCode({
      tokenUrl: TOKEN_URL, code: 'c', clientId: 'i', clientSecret: 's', redirectUri: 'r', fetchImpl,
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 502);
      assert.match(r.logMessage, /ECONNRESET/);
    }
  });
});

describe('refreshRedmineToken', () => {
  test('posts the refresh_token grant', async () => {
    let body = '';
    const fetchImpl = makeFetch(async (_url, init) => {
      body = String(init.body);
      return { status: 200, json: { access_token: 'at2', refresh_token: 'rt2', expires_in: 7200 } };
    });
    const r = await refreshRedmineToken({ tokenUrl: TOKEN_URL, refreshToken: 'rt1', clientId: 'i', clientSecret: 's', fetchImpl });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.accessToken, 'at2');
      // Doorkeeper ROTATES the refresh token; the new one has to surface or the
      // caller persists a token that is already dead.
      assert.equal(r.refreshToken, 'rt2');
      assert.equal(r.expiresIn, 7200);
    }
    const params = new URLSearchParams(body);
    assert.equal(params.get('grant_type'), 'refresh_token');
    assert.equal(params.get('refresh_token'), 'rt1');
  });

  test('reports a null refreshToken when the response omits one', async () => {
    const fetchImpl = makeFetch(async () => ({ status: 200, json: { access_token: 'at2' } }));
    const r = await refreshRedmineToken({ tokenUrl: TOKEN_URL, refreshToken: 'rt1', clientId: 'i', clientSecret: 's', fetchImpl });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.refreshToken, null, 'caller keeps its existing token when this is null');
  });

  test('a rejected refresh reports the status and never throws', async () => {
    const fetchImpl = makeFetch(async () => ({ status: 401, text: 'invalid_grant' }));
    const r = await refreshRedmineToken({ tokenUrl: TOKEN_URL, refreshToken: 'stale', clientId: 'i', clientSecret: 's', fetchImpl });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 401);
      assert.match(r.logMessage, /invalid_grant/);
    }
  });
});

describe('fetchRedmineCurrentUser', () => {
  test('sends a bearer and unwraps the user envelope', async () => {
    let calledUrl = '';
    let headers: Record<string, string> = {};
    const fetchImpl = makeFetch(async (url, init) => {
      calledUrl = url;
      headers = init.headers as Record<string, string>;
      return { status: 200, json: { user: { login: 'jsmith', mail: 'j@x.com' } } };
    });
    const r = await fetchRedmineCurrentUser(`${BASE}/`, 'tok', fetchImpl);
    assert.deepEqual(r, { login: 'jsmith', email: 'j@x.com' });
    assert.equal(calledUrl, `${BASE}/users/current.json`);
    assert.equal(headers.Authorization, 'Bearer tok');
  });

  test('returns nulls rather than throwing on any failure', async () => {
    assert.deepEqual(
      await fetchRedmineCurrentUser(BASE, 'tok', (async () => { throw new Error('boom'); }) as any),
      { login: null, email: null },
    );
    assert.deepEqual(
      await fetchRedmineCurrentUser(BASE, 'tok', makeFetch(async () => ({ status: 500 }))),
      { login: null, email: null },
    );
  });
});
