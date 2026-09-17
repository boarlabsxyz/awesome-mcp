// src/__tests__/peopleforce-v4/connectToken.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePeopleForceV4Token,
  buildPeopleForceV4InstanceName,
} from '../../peopleforce-v4/connectToken.js';

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

describe('validatePeopleForceV4Token', () => {
  test('rejects an empty key before touching the network', async () => {
    const r = await validatePeopleForceV4Token({ token: '   ' });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.match(r.userMessage, /service account API key is required/);
    }
  });

  test('probes /people — NOT /employees, which v4 404s', async () => {
    let calledUrl = '';
    let headers: Record<string, string> = {};
    const fetchImpl = makeFetch(async (url, init) => {
      calledUrl = url;
      headers = init.headers as Record<string, string>;
      return { status: 200, json: { data: [] } };
    });
    const prev = process.env.PEOPLEFORCE_V4_BASE_URL;
    delete process.env.PEOPLEFORCE_V4_BASE_URL;
    try {
      const r = await validatePeopleForceV4Token({ token: 'sa-key', fetchImpl });
      assert.equal(r.ok, true);
      assert.equal(calledUrl, 'https://app.peopleforce.io/api/v4/people?per_page=1');
    } finally {
      if (prev !== undefined) process.env.PEOPLEFORCE_V4_BASE_URL = prev;
    }
    // v4 documents X-API-KEY only. The v2/v3 client also sends a bearer; doing
    // that here would be sending a credential to a surface that never asked.
    assert.equal(headers['X-API-KEY'], 'sa-key');
    assert.equal(headers.Authorization, undefined);
  });

  test('strips trailing slashes from an overridden base URL', async () => {
    const fetchImpl = makeFetch(async () => ({ status: 200, json: { data: [] } }));
    const r = await validatePeopleForceV4Token({
      token: 'sa-key',
      baseUrl: 'https://tenant.example.com/api/v4//',
      fetchImpl,
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.baseUrl, 'https://tenant.example.com/api/v4');
  });

  test('401 names the key type — a Company key fails here identically to a revoked one', async () => {
    const fetchImpl = makeFetch(async () => ({ status: 401 }));
    const r = await validatePeopleForceV4Token({ token: 'company-key', fetchImpl });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.match(r.userMessage, /Service account key only/);
      assert.match(r.userMessage, /Company or Career API key is rejected/);
    }
  });

  test('403 takes the same rejection path as 401', async () => {
    const fetchImpl = makeFetch(async () => ({ status: 403 }));
    const r = await validatePeopleForceV4Token({ token: 'k', fetchImpl });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.userMessage, /Service account/);
  });

  test('500 is reported as an upstream failure, not a bad key', async () => {
    const fetchImpl = makeFetch(async () => ({ status: 500, text: 'boom' }));
    const r = await validatePeopleForceV4Token({ token: 'k', fetchImpl });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 502);
      assert.match(r.userMessage, /unexpected response \(500\)/);
    }
  });
});

describe('buildPeopleForceV4InstanceName', () => {
  test('prefers a user-provided name', () => {
    assert.equal(
      buildPeopleForceV4InstanceName({ serviceName: 'PeopleForce v4 MCP', providedInstanceName: 'HR bot' }),
      'HR bot',
    );
  });

  test('falls back to the service name', () => {
    assert.equal(buildPeopleForceV4InstanceName({ serviceName: 'PeopleForce v4 MCP' }), 'PeopleForce v4 MCP');
  });
});
