// src/__tests__/outline/connectToken.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateOutlineToken,
  buildOutlineInstanceName,
  checkBaseUrl,
  isPrivateHost,
  type ValidateInput,
} from '../../outline/connectToken.js';

// -----------------------------------------------------------------------------
// buildOutlineInstanceName — the paste-token flow's copy of the name builder
// -----------------------------------------------------------------------------

describe('buildOutlineInstanceName (paste-token)', () => {
  test('providedInstanceName always wins', () => {
    assert.equal(
      buildOutlineInstanceName({
        serviceName: 'Outline Wiki',
        providedInstanceName: 'Named by user',
        teamName: 'Team',
        email: 'e@e.com',
      }),
      'Named by user',
    );
  });

  test('falls back to team, then email, then service name', () => {
    assert.equal(
      buildOutlineInstanceName({ serviceName: 'Outline Wiki', teamName: 'Team A', email: 'e@e.com' }),
      'Outline Wiki (Team A)',
    );
    assert.equal(
      buildOutlineInstanceName({ serviceName: 'Outline Wiki', email: 'e@e.com' }),
      'Outline Wiki (e@e.com)',
    );
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
// Mock fetch helpers
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

function goodInput(overrides: Partial<ValidateInput> = {}): ValidateInput {
  return {
    baseUrl: 'https://wiki.example.com',
    token: 'ol_pat_abc',
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// validateOutlineToken — pre-flight URL & token checks (no network)
// -----------------------------------------------------------------------------

describe('validateOutlineToken — pre-flight checks', () => {
  test('empty base URL rejected with 400', async () => {
    const result = await validateOutlineToken({ baseUrl: '', token: 'x' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
    assert.match(result.userMessage, /Outline URL is required/);
  });

  test('whitespace in URL rejected', async () => {
    const result = await validateOutlineToken({ baseUrl: 'https://wiki.example.com/foo bar', token: 'x' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
    assert.match(result.userMessage, /whitespace/);
  });

  test('missing scheme rejected', async () => {
    const result = await validateOutlineToken({ baseUrl: 'wiki.example.com', token: 'x' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
    assert.match(result.userMessage, /http:\/\/ or https:\/\//);
  });

  test('malformed URL rejected', async () => {
    const result = await validateOutlineToken({ baseUrl: 'https://', token: 'x' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
  });

  test('empty token rejected', async () => {
    const result = await validateOutlineToken({ baseUrl: 'https://wiki.example.com', token: '' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
    assert.match(result.userMessage, /API key is required/);
  });

  test('whitespace-only token rejected', async () => {
    const result = await validateOutlineToken({ baseUrl: 'https://wiki.example.com', token: '   ' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
  });
});

// -----------------------------------------------------------------------------
// validateOutlineToken — happy paths and network cases
// -----------------------------------------------------------------------------

describe('validateOutlineToken — network', () => {
  test('happy path returns email + teamName', async () => {
    const { fetch: mockFetch, calls } = makeMockFetch(() =>
      new Response(
        JSON.stringify({ data: { user: { email: 'a@a.com' }, team: { name: 'Team X' } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const result = await validateOutlineToken({ ...goodInput(), fetchImpl: mockFetch });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.baseUrl, 'https://wiki.example.com');
    assert.equal(result.email, 'a@a.com');
    assert.equal(result.teamName, 'Team X');

    // Verify the outbound request
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://wiki.example.com/api/auth.info');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal((calls[0].init.headers as any).Authorization, 'Bearer ol_pat_abc');
    // SSRF hardening — regression guard. If this ever changes, a 302 from
    // Outline could redirect the token onto a private host.
    assert.equal((calls[0].init as any).redirect, 'error');
  });

  test('redirect thrown by fetch → 400 with a specific message', async () => {
    // Simulates the TypeError undici throws when redirect:'error' meets a 3xx.
    // Match on `message`, `cause.message`, or both — we handle either.
    const { fetch: mockFetch } = makeMockFetch(() => {
      const err: any = new TypeError('fetch failed');
      err.cause = { message: 'unexpected redirect' };
      throw err;
    });
    const result = await validateOutlineToken({ ...goodInput(), fetchImpl: mockFetch });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
    assert.match(result.userMessage, /redirected/i);
    assert.match(result.logMessage, /blocked at redirect/i);
  });

  test('redirect keyword in outer message (no cause) also routes to 400', async () => {
    // Defensive: some runtimes put the redirect signal on `err.message`
    // directly rather than `err.cause.message`.
    const { fetch: mockFetch } = makeMockFetch(() => {
      const err: any = new TypeError('redirect not allowed');
      throw err;
    });
    const result = await validateOutlineToken({ ...goodInput(), fetchImpl: mockFetch });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
    assert.match(result.userMessage, /redirected/i);
  });

  test('trailing slashes on baseUrl are stripped', async () => {
    const { fetch: mockFetch, calls } = makeMockFetch(() =>
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await validateOutlineToken({ ...goodInput({ baseUrl: 'https://wiki.example.com///' }), fetchImpl: mockFetch });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.baseUrl, 'https://wiki.example.com');
    assert.equal(calls[0].url, 'https://wiki.example.com/api/auth.info');
  });

  test('leading/trailing whitespace on token trimmed', async () => {
    const { fetch: mockFetch, calls } = makeMockFetch(() =>
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await validateOutlineToken({ ...goodInput({ token: '  tok  ' }), fetchImpl: mockFetch });
    assert.equal((calls[0].init.headers as any).Authorization, 'Bearer tok');
  });

  test('401 becomes a friendly "check the API key" 400', async () => {
    const { fetch: mockFetch } = makeMockFetch(() => new Response('unauthorized', { status: 401 }));
    const result = await validateOutlineToken({ ...goodInput(), fetchImpl: mockFetch });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
    assert.match(result.userMessage, /API key/i);
  });

  test('403 also becomes a 400 with API-key hint', async () => {
    const { fetch: mockFetch } = makeMockFetch(() => new Response('forbidden', { status: 403 }));
    const result = await validateOutlineToken({ ...goodInput(), fetchImpl: mockFetch });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
    assert.match(result.userMessage, /API key/i);
  });

  test('non-401/403 non-2xx becomes 502 with the upstream status logged', async () => {
    const { fetch: mockFetch } = makeMockFetch(() => new Response('server error', { status: 500 }));
    const result = await validateOutlineToken({ ...goodInput(), fetchImpl: mockFetch });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 502);
    assert.match(result.logMessage, /500/);
  });

  test('AbortError → 502 with timeout message', async () => {
    const { fetch: mockFetch } = makeMockFetch(() => {
      const err: any = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    const result = await validateOutlineToken({ ...goodInput(), fetchImpl: mockFetch });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 502);
    assert.match(result.userMessage, /respond in time|Check the URL/);
    assert.match(result.logMessage, /timed out/);
  });

  test('generic network error → 502 with URL-check hint', async () => {
    const { fetch: mockFetch } = makeMockFetch(() => { throw new Error('ENOTFOUND'); });
    const result = await validateOutlineToken({ ...goodInput(), fetchImpl: mockFetch });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 502);
    assert.match(result.userMessage, /Check the URL/);
    assert.match(result.logMessage, /ENOTFOUND/);
  });

  test('malformed JSON on 2xx is treated as ok with null email/team', async () => {
    const { fetch: mockFetch } = makeMockFetch(() =>
      new Response('not json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await validateOutlineToken({ ...goodInput(), fetchImpl: mockFetch });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.email, null);
    assert.equal(result.teamName, null);
  });

  test('partial data (missing team) still resolves happy path', async () => {
    const { fetch: mockFetch } = makeMockFetch(() =>
      new Response(JSON.stringify({ data: { user: { email: 'e@e.com' } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await validateOutlineToken({ ...goodInput(), fetchImpl: mockFetch });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.email, 'e@e.com');
    assert.equal(result.teamName, null);
  });

  test('non-2xx body-read failure surfaces gracefully in log message', async () => {
    const { fetch: mockFetch } = makeMockFetch(() => {
      const throwingBody = new Response('', { status: 502 });
      (throwingBody as any).text = async () => { throw new Error('body-read-fail'); };
      return throwingBody;
    });
    const result = await validateOutlineToken({ ...goodInput(), fetchImpl: mockFetch });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 502);
    // logMessage still assembled with the upstream status even when the body read fails
    assert.match(result.logMessage, /502/);
  });
});

// -----------------------------------------------------------------------------
// isPrivateHost — direct enumeration of every range we defend against
// -----------------------------------------------------------------------------

describe('isPrivateHost', () => {
  test('rejects loopback hostnames', () => {
    for (const h of ['localhost', 'LOCALHOST', 'LocalHost', 'ip6-localhost', 'ip6-loopback']) {
      assert.equal(isPrivateHost(h), true, `expected ${h} to be private`);
    }
  });

  test('rejects the entire 127.0.0.0/8 loopback range', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', '127.255.255.255']) {
      assert.equal(isPrivateHost(h), true, `expected ${h} to be private`);
    }
  });

  test('rejects 10.0.0.0/8 (RFC1918)', () => {
    for (const h of ['10.0.0.0', '10.1.2.3', '10.255.255.255']) {
      assert.equal(isPrivateHost(h), true, `expected ${h} to be private`);
    }
  });

  test('rejects 172.16.0.0/12 (RFC1918) with boundary checks', () => {
    for (const h of ['172.16.0.0', '172.20.5.5', '172.31.255.255']) {
      assert.equal(isPrivateHost(h), true, `expected ${h} to be private`);
    }
    // Just outside the range: 172.15 and 172.32 must NOT be blocked
    assert.equal(isPrivateHost('172.15.0.1'), false);
    assert.equal(isPrivateHost('172.32.0.1'), false);
  });

  test('rejects 192.168.0.0/16 (RFC1918)', () => {
    for (const h of ['192.168.0.1', '192.168.1.1', '192.168.255.255']) {
      assert.equal(isPrivateHost(h), true, `expected ${h} to be private`);
    }
    assert.equal(isPrivateHost('192.169.0.1'), false);
  });

  test('rejects 169.254.0.0/16 link-local (AWS metadata endpoint)', () => {
    assert.equal(isPrivateHost('169.254.169.254'), true, 'must block the AWS metadata IP');
    assert.equal(isPrivateHost('169.254.0.0'), true);
    assert.equal(isPrivateHost('169.254.255.255'), true);
    assert.equal(isPrivateHost('169.253.0.1'), false);
  });

  test('rejects 0.0.0.0/8', () => {
    assert.equal(isPrivateHost('0.0.0.0'), true);
    assert.equal(isPrivateHost('0.1.2.3'), true);
  });

  test('rejects IPv6 canonical loopback / unspecified', () => {
    assert.equal(isPrivateHost('::1'), true);
    assert.equal(isPrivateHost('::'), true);
    assert.equal(isPrivateHost('[::1]'), true, 'brackets should be tolerated');
  });

  test('rejects uncompressed IPv6 loopback (0:0:0:0:0:0:0:1)', () => {
    assert.equal(isPrivateHost('0:0:0:0:0:0:0:1'), true);
    assert.equal(isPrivateHost('0:0:0:0:0:0:0:0'), true);
  });

  test('rejects fe80::/10 link-local', () => {
    for (const h of ['fe80::1', 'fe90::1', 'FEBF::1', 'febf::abcd']) {
      assert.equal(isPrivateHost(h), true, `expected ${h} to be link-local`);
    }
    // Just outside the range
    assert.equal(isPrivateHost('fec0::1'), false, 'fec0:: is not link-local');
    assert.equal(isPrivateHost('fe7f::1'), false);
  });

  test('rejects fc00::/7 unique-local', () => {
    for (const h of ['fc00::1', 'fd00::1', 'fdff::abcd']) {
      assert.equal(isPrivateHost(h), true, `expected ${h} to be unique-local`);
    }
    assert.equal(isPrivateHost('fe00::1'), false);
  });

  test('rejects IPv4-mapped IPv6 pointing at a private IPv4 (dotted-quad form)', () => {
    assert.equal(isPrivateHost('::ffff:127.0.0.1'), true);
    assert.equal(isPrivateHost('::ffff:169.254.169.254'), true);
    assert.equal(isPrivateHost('::ffff:10.0.0.1'), true);
    // IPv4-mapped to a public IPv4 must NOT be blocked
    assert.equal(isPrivateHost('::ffff:8.8.8.8'), false);
  });

  test('rejects IPv4-mapped IPv6 in WHATWG canonical form (two hex groups)', () => {
    // WHATWG URL rewrites ::ffff:127.0.0.1 → ::ffff:7f00:1 in URL.hostname.
    // If this test regresses, http://[::ffff:127.0.0.1]/ silently passes SSRF.
    assert.equal(isPrivateHost('::ffff:7f00:1'), true, '127.0.0.1 canonical');
    assert.equal(isPrivateHost('::ffff:a9fe:a9fe'), true, '169.254.169.254 canonical (AWS metadata)');
    assert.equal(isPrivateHost('::ffff:a00:1'), true, '10.0.0.1 canonical');
    assert.equal(isPrivateHost('::ffff:c0a8:1'), true, '192.168.0.1 canonical');
    // Canonical form of 8.8.8.8 must NOT be blocked
    assert.equal(isPrivateHost('::ffff:808:808'), false);
  });

  test('strips zone id from IPv6 addresses', () => {
    assert.equal(isPrivateHost('fe80::1%eth0'), true);
  });

  test('accepts public IPv4 addresses', () => {
    for (const h of ['8.8.8.8', '1.1.1.1', '208.67.222.222', '192.169.1.1']) {
      assert.equal(isPrivateHost(h), false, `expected ${h} to be public`);
    }
  });

  test('accepts public IPv6 addresses', () => {
    for (const h of ['2001:db8::1', '2606:4700:4700::1111']) {
      assert.equal(isPrivateHost(h), false, `expected ${h} to be public`);
    }
  });

  test('accepts ordinary hostnames', () => {
    for (const h of ['wiki.gluzdov.com', 'example.com', 'app.slack.com']) {
      assert.equal(isPrivateHost(h), false, `expected ${h} to be public`);
    }
  });

  test('empty / whitespace hostnames report as not-private (checkBaseUrl catches those first)', () => {
    assert.equal(isPrivateHost(''), false);
  });
});

// -----------------------------------------------------------------------------
// checkBaseUrl — SSRF-guard behavior via the URL layer
// -----------------------------------------------------------------------------

describe('checkBaseUrl — SSRF guard', () => {
  test('accepts a public https URL', () => {
    assert.equal(checkBaseUrl('https://wiki.gluzdov.com'), null);
  });

  test('rejects http://localhost', () => {
    assert.match(checkBaseUrl('http://localhost:3000') ?? '', /public host/);
  });

  test('rejects the AWS metadata endpoint', () => {
    assert.match(checkBaseUrl('http://169.254.169.254/latest/meta-data/') ?? '', /public host/);
  });

  test('rejects http://127.0.0.1 with a port + path', () => {
    assert.match(checkBaseUrl('http://127.0.0.1:8080/anything') ?? '', /public host/);
  });

  test('rejects bracketed IPv6 loopback', () => {
    assert.match(checkBaseUrl('http://[::1]:3000/') ?? '', /public host/);
  });

  test('rejects an RFC1918 IPv4', () => {
    assert.match(checkBaseUrl('http://10.0.0.1/') ?? '', /public host/);
  });

  test('rejects an IPv4-mapped IPv6 pointing at loopback', () => {
    assert.match(checkBaseUrl('http://[::ffff:127.0.0.1]/') ?? '', /public host/);
  });

  test('rejects link-local IPv6', () => {
    assert.match(checkBaseUrl('http://[fe80::1]/') ?? '', /public host/);
  });

  test('user-facing error message is stable and matches connect-token error shape', () => {
    // The paste-token endpoint surfaces the checkBaseUrl string verbatim.
    // If this ever changes, downstream error copy needs to move too.
    assert.equal(checkBaseUrl('http://localhost'), 'Outline URL must point to a public host.');
  });
});

// -----------------------------------------------------------------------------
// validateOutlineToken — end-to-end SSRF rejection + body-read timeout
// -----------------------------------------------------------------------------

describe('validateOutlineToken — SSRF guard forwards checkBaseUrl error', () => {
  test('rejects a loopback URL before any fetch is attempted', async () => {
    let fetchCalled = false;
    const fetchImpl = (async () => { fetchCalled = true; return new Response(); }) as unknown as typeof fetch;
    const result = await validateOutlineToken({
      baseUrl: 'http://127.0.0.1:3000',
      token: 'tok',
      fetchImpl,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
    assert.match(result.userMessage, /public host/);
    assert.equal(fetchCalled, false, 'must not touch the network for a private host');
  });

  test('rejects the AWS metadata endpoint before any fetch is attempted', async () => {
    let fetchCalled = false;
    const fetchImpl = (async () => { fetchCalled = true; return new Response(); }) as unknown as typeof fetch;
    const result = await validateOutlineToken({
      baseUrl: 'http://169.254.169.254/latest/meta-data/',
      token: 'tok',
      fetchImpl,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(fetchCalled, false);
  });
});

// -----------------------------------------------------------------------------
// validateOutlineToken — body-read AbortError → timeout
// -----------------------------------------------------------------------------

describe('validateOutlineToken — timeout covers response body', () => {
  test('AbortError from response.json() on 2xx path → 502 timeout', async () => {
    const fetchImpl = makeMockFetch(() => {
      const res = new Response('', { status: 200, headers: { 'content-type': 'application/json' } });
      (res as any).json = async () => {
        const err: any = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      };
      return res;
    }).fetch;
    const result = await validateOutlineToken({ ...goodInput(), fetchImpl });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 502);
    assert.match(result.userMessage, /did not respond in time/);
    assert.match(result.logMessage, /timed out/);
  });

  test('AbortError from response.text() on non-2xx path → 502 timeout', async () => {
    const fetchImpl = makeMockFetch(() => {
      const res = new Response('', { status: 502 });
      (res as any).text = async () => {
        const err: any = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      };
      return res;
    }).fetch;
    const result = await validateOutlineToken({ ...goodInput(), fetchImpl });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 502);
    assert.match(result.userMessage, /did not respond in time/);
  });

  test('non-abort JSON parse failure still yields ok=true with null email/team', async () => {
    // Regression guard for the existing contract: malformed JSON on 2xx is not
    // treated as an error, so the connect flow still succeeds. Only AbortError
    // from the body reader is upgraded to a timeout.
    const { fetch: fetchImpl } = makeMockFetch(() =>
      new Response('not json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await validateOutlineToken({ ...goodInput(), fetchImpl });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.email, null);
    assert.equal(result.teamName, null);
  });
});
