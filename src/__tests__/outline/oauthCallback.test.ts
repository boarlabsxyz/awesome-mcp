// src/__tests__/outline/oauthCallback.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  exchangeOutlineOauthCode,
  refreshOutlineToken,
  fetchOutlineUserInfo,
  buildOutlineInstanceName,
  type ExchangeInput,
} from '../../outline/oauthCallback.js';

// -----------------------------------------------------------------------------
// buildOutlineInstanceName — pure function, cover every branch
// -----------------------------------------------------------------------------

describe('buildOutlineInstanceName', () => {
  test('providedInstanceName wins over everything else', () => {
    assert.equal(
      buildOutlineInstanceName({
        serviceName: 'Outline Wiki',
        providedInstanceName: 'My Custom Name',
        teamName: 'Team A',
        email: 'e@e.com',
      }),
      'My Custom Name',
    );
  });

  test('team name wraps when no explicit name', () => {
    assert.equal(
      buildOutlineInstanceName({ serviceName: 'Outline Wiki', teamName: 'Team A', email: 'e@e.com' }),
      'Outline Wiki (Team A)',
    );
  });

  test('email is the fallback when team is unknown', () => {
    assert.equal(
      buildOutlineInstanceName({ serviceName: 'Outline Wiki', email: 'user@example.com' }),
      'Outline Wiki (user@example.com)',
    );
  });

  test('just the service name if nothing else is known', () => {
    assert.equal(buildOutlineInstanceName({ serviceName: 'Outline Wiki' }), 'Outline Wiki');
  });

  test('null values are treated the same as undefined', () => {
    assert.equal(
      buildOutlineInstanceName({
        serviceName: 'Outline Wiki',
        providedInstanceName: null,
        teamName: null,
        email: null,
      }),
      'Outline Wiki',
    );
  });
});

// -----------------------------------------------------------------------------
// Test doubles for fetch
// -----------------------------------------------------------------------------

type Call = { url: string; init: RequestInit };

function makeMockFetch(handler: (call: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    const call = { url, init };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

const baseInput: Omit<ExchangeInput, 'fetchImpl'> = {
  tokenUrl: 'https://wiki.example.com/oauth/token',
  code: 'auth-code-abc',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'https://mcp.example.com/connect/outline/callback',
  baseUrl: 'https://wiki.example.com',
};

// -----------------------------------------------------------------------------
// fetchOutlineUserInfo — best-effort, returns nulls on any failure
// -----------------------------------------------------------------------------

describe('fetchOutlineUserInfo', () => {
  test('parses email + team from a happy response', async () => {
    const { fetch: mockFetch, calls } = makeMockFetch(() =>
      new Response(
        JSON.stringify({ data: { user: { email: 'a@a.com' }, team: { name: 'Team X' } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const out = await fetchOutlineUserInfo('https://wiki.example.com', 'tok', mockFetch);
    assert.deepEqual(out, { email: 'a@a.com', teamName: 'Team X' });
    assert.equal(calls[0].url, 'https://wiki.example.com/api/auth.info');
    assert.equal((calls[0].init.headers as any).Authorization, 'Bearer tok');
    assert.equal(calls[0].init.method, 'POST');
  });

  test('returns nulls on non-2xx response', async () => {
    const { fetch: mockFetch } = makeMockFetch(() => new Response('nope', { status: 500 }));
    assert.deepEqual(
      await fetchOutlineUserInfo('https://wiki.example.com', 'tok', mockFetch),
      { email: null, teamName: null },
    );
  });

  test('returns nulls when fetch throws', async () => {
    const { fetch: mockFetch } = makeMockFetch(() => { throw new Error('nope'); });
    assert.deepEqual(
      await fetchOutlineUserInfo('https://wiki.example.com', 'tok', mockFetch),
      { email: null, teamName: null },
    );
  });

  test('handles malformed JSON response gracefully', async () => {
    const { fetch: mockFetch } = makeMockFetch(() =>
      new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    assert.deepEqual(
      await fetchOutlineUserInfo('https://wiki.example.com', 'tok', mockFetch),
      { email: null, teamName: null },
    );
  });

  test('returns null fields when partial data is present', async () => {
    const { fetch: mockFetch } = makeMockFetch(() =>
      new Response(JSON.stringify({ data: { user: {} } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    assert.deepEqual(
      await fetchOutlineUserInfo('https://wiki.example.com', 'tok', mockFetch),
      { email: null, teamName: null },
    );
  });
});

// -----------------------------------------------------------------------------
// exchangeOutlineOauthCode — full callback business logic
// -----------------------------------------------------------------------------

describe('exchangeOutlineOauthCode', () => {
  test('happy path: returns access token + email + team', async () => {
    const { fetch: mockFetch, calls } = makeMockFetch((call) => {
      if (call.url.endsWith('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'tok-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ data: { user: { email: 'u@e.com' }, team: { name: 'Team' } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const result = await exchangeOutlineOauthCode({ ...baseInput, fetchImpl: mockFetch });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.accessToken, 'tok-1');
    assert.equal(result.email, 'u@e.com');
    assert.equal(result.teamName, 'Team');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://wiki.example.com/oauth/token');
    assert.equal((calls[0].init.headers as any)['Content-Type'], 'application/x-www-form-urlencoded');
  });

  test('token exchange body includes all OAuth 2.0 required params', async () => {
    const { fetch: mockFetch, calls } = makeMockFetch(() =>
      new Response(JSON.stringify({ access_token: 't' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await exchangeOutlineOauthCode({ ...baseInput, fetchImpl: mockFetch });
    const body = new URLSearchParams(calls[0].init.body as string);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), baseInput.code);
    assert.equal(body.get('client_id'), baseInput.clientId);
    assert.equal(body.get('client_secret'), baseInput.clientSecret);
    assert.equal(body.get('redirect_uri'), baseInput.redirectUri);
  });

  test('returns 500 when Outline returns non-2xx from token endpoint', async () => {
    const { fetch: mockFetch } = makeMockFetch(() => new Response('bad request', { status: 400 }));
    const result = await exchangeOutlineOauthCode({ ...baseInput, fetchImpl: mockFetch });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 500);
    assert.match(result.userMessage, /Outline token exchange failed/);
    assert.match(result.logMessage, /400 bad request/);
  });

  test('returns 500 when token endpoint returns 2xx but no access_token', async () => {
    const { fetch: mockFetch } = makeMockFetch(() =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await exchangeOutlineOauthCode({ ...baseInput, fetchImpl: mockFetch });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 500);
    assert.match(result.userMessage, /no access token/);
    assert.match(result.logMessage, /missing access_token/);
  });

  test('returns 502 with timeout message when fetch aborts', async () => {
    const { fetch: mockFetch } = makeMockFetch(() => {
      const err: any = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    const result = await exchangeOutlineOauthCode({ ...baseInput, fetchImpl: mockFetch });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 502);
    assert.match(result.userMessage, /timed out/);
    assert.match(result.logMessage, /timed out/);
  });

  test('returns 502 with network-error message on other fetch failures', async () => {
    const { fetch: mockFetch } = makeMockFetch(() => { throw new Error('ECONNREFUSED'); });
    const result = await exchangeOutlineOauthCode({ ...baseInput, fetchImpl: mockFetch });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 502);
    assert.match(result.userMessage, /ECONNREFUSED/);
    assert.match(result.logMessage, /ECONNREFUSED/);
  });

  test('malformed JSON in token response is treated as missing access_token', async () => {
    const { fetch: mockFetch } = makeMockFetch(() =>
      new Response('this is not json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await exchangeOutlineOauthCode({ ...baseInput, fetchImpl: mockFetch });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.userMessage, /no access token/);
  });

  test('userinfo failure does not fail the exchange — returns nulls', async () => {
    const { fetch: mockFetch } = makeMockFetch((call) => {
      if (call.url.endsWith('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'tok-2' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('server error', { status: 500 });
    });
    const result = await exchangeOutlineOauthCode({ ...baseInput, fetchImpl: mockFetch });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.accessToken, 'tok-2');
    assert.equal(result.email, null);
    assert.equal(result.teamName, null);
  });

  test('non-2xx body-read failure surfaces gracefully in log message', async () => {
    const { fetch: mockFetch } = makeMockFetch(() => {
      // Response whose body throws when read
      const throwingBody = new Response('', { status: 502 });
      // Override text() to throw
      (throwingBody as any).text = async () => { throw new Error('body-read-fail'); };
      return throwingBody;
    });
    const result = await exchangeOutlineOauthCode({ ...baseInput, fetchImpl: mockFetch });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 500);
    // logMessage still assembled with status code even if body read failed
    assert.match(result.logMessage, /502/);
  });

  test('captures refresh_token and expires_in from the token response', async () => {
    const { fetch: mockFetch } = makeMockFetch((call) => {
      if (call.url.endsWith('/oauth/token')) {
        return new Response(
          JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const result = await exchangeOutlineOauthCode({ ...baseInput, fetchImpl: mockFetch });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.refreshToken, 'rt');
    assert.equal(result.expiresIn, 3600);
  });

  test('refresh_token and expires_in default to null when Outline omits them', async () => {
    const { fetch: mockFetch } = makeMockFetch((call) => {
      if (call.url.endsWith('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'at' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const result = await exchangeOutlineOauthCode({ ...baseInput, fetchImpl: mockFetch });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.refreshToken, null);
    assert.equal(result.expiresIn, null);
  });
});

// -----------------------------------------------------------------------------
// refreshOutlineToken — the refresh_token grant used at tool-call time
// -----------------------------------------------------------------------------

describe('refreshOutlineToken', () => {
  const refreshInput = {
    tokenUrl: 'https://wiki.example.com/oauth/token',
    refreshToken: 'old-rt',
    clientId: 'client-id',
    clientSecret: 'client-secret',
  };

  test('happy path: returns rotated access + refresh token and expires_in', async () => {
    const { fetch: mockFetch, calls } = makeMockFetch(() =>
      new Response(JSON.stringify({ access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await refreshOutlineToken({ ...refreshInput, fetchImpl: mockFetch });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.accessToken, 'new-at');
    assert.equal(result.refreshToken, 'new-rt');
    assert.equal(result.expiresIn, 3600);
    const body = new URLSearchParams(calls[0].init.body as string);
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), 'old-rt');
    assert.equal(body.get('client_id'), 'client-id');
    assert.equal(body.get('client_secret'), 'client-secret');
  });

  test('surfaces upstream status on non-2xx', async () => {
    const { fetch: mockFetch } = makeMockFetch(() => new Response('invalid_grant', { status: 400 }));
    const result = await refreshOutlineToken({ ...refreshInput, fetchImpl: mockFetch });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
    assert.match(result.logMessage, /400 invalid_grant/);
  });

  test('returns 500 when the response is 2xx but has no access_token', async () => {
    const { fetch: mockFetch } = makeMockFetch(() =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await refreshOutlineToken({ ...refreshInput, fetchImpl: mockFetch });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 500);
    assert.match(result.logMessage, /missing access_token/);
  });

  test('returns 502 with timeout message when the fetch aborts', async () => {
    const { fetch: mockFetch } = makeMockFetch(() => {
      const err: any = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    const result = await refreshOutlineToken({ ...refreshInput, fetchImpl: mockFetch });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 502);
    assert.match(result.logMessage, /timed out/);
  });
});
