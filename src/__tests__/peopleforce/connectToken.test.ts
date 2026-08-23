// src/__tests__/peopleforce/connectToken.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePeopleForceToken,
  buildPeopleForceInstanceName,
} from '../../peopleforce/connectToken.js';

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

describe('validatePeopleForceToken — input checks', () => {
  test('rejects empty token', async () => {
    const r = await validatePeopleForceToken({ token: '' });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.match(r.userMessage, /API key is required/);
    }
  });

  test('rejects whitespace-only token', async () => {
    const r = await validatePeopleForceToken({ token: '   ' });
    assert.equal(r.ok, false);
  });

  test('rejects non-string token', async () => {
    const r = await validatePeopleForceToken({ token: 123 as any });
    assert.equal(r.ok, false);
  });
});

describe('validatePeopleForceToken — network responses', () => {
  test('returns ok with baseUrl on 200', async () => {
    let calledUrl = '';
    let calledHeaders: Record<string, string> = {};
    const fetchImpl = makeFetch(async (url, init) => {
      calledUrl = url;
      calledHeaders = init.headers as Record<string, string>;
      return { status: 200, json: { data: [] } };
    });
    const r = await validatePeopleForceToken({
      token: 'abc',
      baseUrl: 'https://custom.example.com/api/',
      fetchImpl,
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      // Trailing slash stripped
      assert.equal(r.baseUrl, 'https://custom.example.com/api');
    }
    assert.match(calledUrl, /\/employees\?per_page=1$/);
    assert.equal(calledHeaders['X-API-KEY'], 'abc');
    assert.equal(calledHeaders.Authorization, 'Bearer abc');
  });

  test('falls back to default base URL when none provided', async () => {
    let calledUrl = '';
    const fetchImpl = makeFetch(async (url) => {
      calledUrl = url;
      return { status: 200, json: { data: [] } };
    });
    // Ensure env var doesn't leak into this test's expectations
    const prev = process.env.PEOPLEFORCE_BASE_URL;
    delete process.env.PEOPLEFORCE_BASE_URL;
    try {
      const r = await validatePeopleForceToken({ token: 'abc', fetchImpl });
      assert.equal(r.ok, true);
      assert.match(calledUrl, /^https:\/\/app\.peopleforce\.io\/api\/public\/v2\/employees/);
    } finally {
      if (prev !== undefined) process.env.PEOPLEFORCE_BASE_URL = prev;
    }
  });

  test('401 → user-facing "rejected the API key" error', async () => {
    const fetchImpl = makeFetch(async () => ({ status: 401 }));
    const r = await validatePeopleForceToken({ token: 'bad', fetchImpl });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.match(r.userMessage, /rejected the API key/);
    }
  });

  test('403 → same rejection path as 401', async () => {
    const fetchImpl = makeFetch(async () => ({ status: 403 }));
    const r = await validatePeopleForceToken({ token: 'bad', fetchImpl });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.userMessage, /rejected the API key/);
  });

  test('500 → 502 upstream error', async () => {
    const fetchImpl = makeFetch(async () => ({ status: 500, text: 'boom' }));
    const r = await validatePeopleForceToken({ token: 'abc', fetchImpl });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 502);
      assert.match(r.userMessage, /unexpected response \(500\)/);
    }
  });

  test('network error → 502 unreachable', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as any;
    const r = await validatePeopleForceToken({ token: 'abc', fetchImpl });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 502);
      assert.match(r.userMessage, /Could not reach PeopleForce/);
    }
  });

  test('redirect error → 400 with redirect-specific message', async () => {
    const fetchImpl = (async () => {
      throw new Error('unexpected redirect encountered');
    }) as any;
    const r = await validatePeopleForceToken({ token: 'abc', fetchImpl });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.match(r.userMessage, /redirected to another host/);
    }
  });
});

describe('buildPeopleForceInstanceName', () => {
  test('prefers a user-provided name', () => {
    const name = buildPeopleForceInstanceName({
      serviceName: 'PeopleForce',
      providedInstanceName: 'Acme HR',
    });
    assert.equal(name, 'Acme HR');
  });

  test('falls back to the service name', () => {
    const name = buildPeopleForceInstanceName({ serviceName: 'PeopleForce' });
    assert.equal(name, 'PeopleForce');
  });

  test('treats empty string as no-name (falls back to service name)', () => {
    const name = buildPeopleForceInstanceName({
      serviceName: 'PeopleForce',
      providedInstanceName: '',
    });
    assert.equal(name, 'PeopleForce');
  });
});
