// src/__tests__/redmine/connectToken.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateRedmineToken, buildRedmineInstanceName } from '../../redmine/connectToken.js';

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

const BASE = 'https://redmine.example.com';

describe('validateRedmineToken — base URL guard', () => {
  test('rejects a missing base URL before touching the network', async () => {
    let called = false;
    const fetchImpl = makeFetch(async () => { called = true; return { status: 200 }; });
    const r = await validateRedmineToken({ token: 'abc', baseUrl: '', fetchImpl });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.match(r.userMessage, /Redmine URL is required/);
    }
    assert.equal(called, false, 'must not call out with no base URL');
  });

  test('rejects a schemeless URL', async () => {
    const r = await validateRedmineToken({ token: 'abc', baseUrl: 'redmine.example.com' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.userMessage, /must start with http/);
  });

  // Redmine is self-hosted, so the pasted host is attacker-controllable and this
  // is the guard that stops the credential reaching an internal address.
  test('rejects private hosts (SSRF guard)', async () => {
    for (const host of ['http://localhost:3000', 'http://127.0.0.1', 'http://169.254.169.254', 'http://10.0.0.5', 'http://[::1]/']) {
      const r = await validateRedmineToken({ token: 'abc', baseUrl: host });
      assert.equal(r.ok, false, `${host} should be rejected`);
      if (!r.ok) assert.match(r.userMessage, /public host/, host);
    }
  });

  test('rejects an empty token', async () => {
    const r = await validateRedmineToken({ token: '   ', baseUrl: BASE });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.userMessage, /API key is required/);
  });
});

describe('validateRedmineToken — network responses', () => {
  test('returns ok and strips the trailing slash on 200', async () => {
    let calledUrl = '';
    let calledHeaders: Record<string, string> = {};
    const fetchImpl = makeFetch(async (url, init) => {
      calledUrl = url;
      calledHeaders = init.headers as Record<string, string>;
      return { status: 200, json: { user: { id: 1, login: 'jsmith' } } };
    });
    const r = await validateRedmineToken({ token: 'abc', baseUrl: `${BASE}///`, fetchImpl });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.baseUrl, BASE);
    assert.equal(calledUrl, `${BASE}/users/current.json`);
    assert.equal(calledHeaders['X-Redmine-API-Key'], 'abc');
    assert.equal(calledHeaders.Authorization, undefined, 'an API key must not be sent as a bearer');
  });

  // The dashboard health probe re-validates stored credentials, and an OAuth
  // access token sent as X-Redmine-API-Key is rejected — which would report a
  // healthy OAuth connection as a bad key.
  test('sends a bearer instead when authMode is oauth', async () => {
    let calledHeaders: Record<string, string> = {};
    const fetchImpl = makeFetch(async (_url, init) => {
      calledHeaders = init.headers as Record<string, string>;
      return { status: 200, json: { user: {} } };
    });
    const r = await validateRedmineToken({ token: 'tok', baseUrl: BASE, authMode: 'oauth', fetchImpl });
    assert.equal(r.ok, true);
    assert.equal(calledHeaders.Authorization, 'Bearer tok');
    assert.equal(calledHeaders['X-Redmine-API-Key'], undefined);
  });

  // 401 and 403 mean opposite things here and the messages must not be swapped:
  // 403 is "an admin switched the REST API off", 401 is "this key is wrong".
  test('403 names the disabled REST API, not the key', async () => {
    const fetchImpl = makeFetch(async () => ({ status: 403, text: 'Forbidden' }));
    const r = await validateRedmineToken({ token: 'abc', baseUrl: BASE, fetchImpl });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.match(r.userMessage, /REST API is disabled/);
      assert.match(r.userMessage, /Enable REST API/);
      assert.match(r.userMessage, /not the problem/, 'must say the key is not at fault');
    }
  });

  test('401 names the key AND the pre-4.1 disabled-API case', async () => {
    const fetchImpl = makeFetch(async () => ({ status: 401, text: 'Unauthorized' }));
    const r = await validateRedmineToken({ token: 'abc', baseUrl: BASE, fetchImpl });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.match(r.userMessage, /rejected the API key/);
      assert.match(r.userMessage, /my\/account/);
      assert.match(r.userMessage, /older than 4\.1/, 'must mention the ambiguous older-version case');
    }
  });

  test('500 maps to 502 unexpected-response', async () => {
    const fetchImpl = makeFetch(async () => ({ status: 500, text: 'boom' }));
    const r = await validateRedmineToken({ token: 'abc', baseUrl: BASE, fetchImpl });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 502);
      assert.match(r.userMessage, /unexpected response \(500\)/);
    }
  });

  test('network error maps to 502 unreachable', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as any;
    const r = await validateRedmineToken({ token: 'abc', baseUrl: BASE, fetchImpl });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 502);
      assert.match(r.userMessage, /Could not reach Redmine/);
    }
  });

  test('a redirect is refused rather than followed', async () => {
    const fetchImpl = (async () => { throw new Error('unexpected redirect encountered'); }) as any;
    const r = await validateRedmineToken({ token: 'abc', baseUrl: BASE, fetchImpl });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.match(r.userMessage, /redirected to another host/);
    }
  });
});

describe('buildRedmineInstanceName', () => {
  test('a user-provided name wins', () => {
    assert.equal(
      buildRedmineInstanceName({ serviceName: 'Redmine', providedInstanceName: 'Ops tracker', baseUrl: `${BASE}` }),
      'Ops tracker',
    );
  });

  // Host beats identity: two Redmine connections are almost certainly the same
  // person on different instances, so the host is what tells them apart.
  test('falls back to the host before the login', () => {
    assert.equal(
      buildRedmineInstanceName({ serviceName: 'Redmine', baseUrl: BASE, login: 'jsmith' }),
      'Redmine (redmine.example.com)',
    );
  });

  test('falls back to the login when there is no base URL', () => {
    assert.equal(buildRedmineInstanceName({ serviceName: 'Redmine', login: 'jsmith' }), 'Redmine (jsmith)');
  });

  test('falls back to the email, then the bare service name', () => {
    assert.equal(buildRedmineInstanceName({ serviceName: 'Redmine', email: 'j@x.com' }), 'Redmine (j@x.com)');
    assert.equal(buildRedmineInstanceName({ serviceName: 'Redmine' }), 'Redmine');
  });

  test('an unparseable base URL does not throw', () => {
    assert.equal(buildRedmineInstanceName({ serviceName: 'Redmine', baseUrl: 'not a url' }), 'Redmine');
  });
});
