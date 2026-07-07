// src/__tests__/outline/connectToken.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateOutlineToken,
  buildOutlineInstanceName,
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
