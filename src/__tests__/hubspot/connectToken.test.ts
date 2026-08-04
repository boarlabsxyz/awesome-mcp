// src/__tests__/hubspot/connectToken.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateHubSpotToken, buildHubSpotInstanceName } from '../../hubspot/connectToken.js';

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
      json: async () => partial.json,
      text: async () => partial.text ?? (partial.json ? JSON.stringify(partial.json) : ''),
      headers: new Headers(),
    } as any as Response;
  }) as any;
}

describe('validateHubSpotToken — input checks', () => {
  test('rejects empty token', async () => {
    const r = await validateHubSpotToken({ token: '' });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.match(r.userMessage, /access token is required/);
    }
  });

  test('rejects whitespace-only token', async () => {
    const r = await validateHubSpotToken({ token: '   ' });
    assert.equal(r.ok, false);
  });

  test('rejects non-string token', async () => {
    const r = await validateHubSpotToken({ token: 123 as any });
    assert.equal(r.ok, false);
  });
});

describe('validateHubSpotToken — network responses', () => {
  test('returns ok, strips trailing slash, sends bearer header, hits companies endpoint', async () => {
    let calledUrl = '';
    let calledHeaders: Record<string, string> = {};
    const fetchImpl = makeFetch(async (url, init) => {
      calledUrl = url;
      calledHeaders = init.headers as Record<string, string>;
      return { status: 200, json: { results: [] } };
    });
    const r = await validateHubSpotToken({ token: 'pat-xyz', baseUrl: 'https://api.hubapi.com/', fetchImpl });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.baseUrl, 'https://api.hubapi.com');
    assert.match(calledUrl, /\/crm\/v3\/objects\/companies\?limit=1$/);
    assert.equal(calledHeaders.Authorization, 'Bearer pat-xyz');
    assert.equal(calledHeaders['X-API-KEY'], undefined, 'HubSpot uses bearer only, not X-API-KEY');
  });

  test('falls back to the public default base URL', async () => {
    let calledUrl = '';
    const fetchImpl = makeFetch(async (url) => {
      calledUrl = url;
      return { status: 200, json: {} };
    });
    const prev = process.env.HUBSPOT_BASE_URL;
    delete process.env.HUBSPOT_BASE_URL;
    try {
      const r = await validateHubSpotToken({ token: 'abc', fetchImpl });
      assert.equal(r.ok, true);
      assert.match(calledUrl, /^https:\/\/api\.hubapi\.com\/crm\/v3\/objects\/companies/);
    } finally {
      if (prev !== undefined) process.env.HUBSPOT_BASE_URL = prev;
    }
  });

  test('401 → user-facing "rejected the token" error mapped to 400', async () => {
    const fetchImpl = makeFetch(async () => ({ status: 401 }));
    const r = await validateHubSpotToken({ token: 'bad', fetchImpl });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.match(r.userMessage, /rejected the token/);
    }
  });

  test('403 → same rejection path as 401', async () => {
    const fetchImpl = makeFetch(async () => ({ status: 403 }));
    const r = await validateHubSpotToken({ token: 'bad', fetchImpl });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.userMessage, /rejected the token/);
  });

  test('500 → 502 upstream error', async () => {
    const fetchImpl = makeFetch(async () => ({ status: 500, text: 'boom' }));
    const r = await validateHubSpotToken({ token: 'abc', fetchImpl });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 502);
      assert.match(r.userMessage, /unexpected response \(500\)/);
    }
  });

  test('network error → 502 unreachable', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as any;
    const r = await validateHubSpotToken({ token: 'abc', fetchImpl });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 502);
      assert.match(r.userMessage, /Could not reach HubSpot/);
    }
  });

  test('redirect error → 400 with redirect-specific message', async () => {
    const fetchImpl = (async () => { throw new Error('unexpected redirect encountered'); }) as any;
    const r = await validateHubSpotToken({ token: 'abc', fetchImpl });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.match(r.userMessage, /redirected to another host/);
    }
  });
});

describe('buildHubSpotInstanceName', () => {
  test('prefers a user-provided name', () => {
    assert.equal(buildHubSpotInstanceName({ serviceName: 'HubSpot', providedInstanceName: 'Acme CRM' }), 'Acme CRM');
  });
  test('falls back to the service name', () => {
    assert.equal(buildHubSpotInstanceName({ serviceName: 'HubSpot' }), 'HubSpot');
  });
  test('treats empty string as no-name', () => {
    assert.equal(buildHubSpotInstanceName({ serviceName: 'HubSpot', providedInstanceName: '' }), 'HubSpot');
  });
});
