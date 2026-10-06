import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildBrowserbaseInstanceName,
  fetchBrowserbaseProject,
  validateBrowserbaseToken,
} from '../../browserbase/connectToken.js';

/** Minimal fetch stub recording the request it was given. */
function stubFetch(status: number, body: unknown = {}) {
  const calls: Array<{ url: string; init: any }> = [];
  const impl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('validateBrowserbaseToken', () => {
  it('probes GET /v1/projects with the x-bb-api-key header', async () => {
    const { impl, calls } = stubFetch(200, [{ id: 'proj-1', name: 'Acme' }]);
    const result = await validateBrowserbaseToken({ token: 'bb_live_123', fetchImpl: impl });
    assert.equal(result.ok, true);
    assert.equal(calls[0].url, 'https://api.browserbase.com/v1/projects');
    assert.equal(calls[0].init.headers['x-bb-api-key'], 'bb_live_123');
  });

  it('rejects a blank key before touching the network', async () => {
    const { impl, calls } = stubFetch(200, []);
    const result = await validateBrowserbaseToken({ token: '   ', fetchImpl: impl });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0);
  });

  it('names the key and where to get it on a rejection', async () => {
    const { impl } = stubFetch(401, { message: 'unauthorized' });
    const result = await validateBrowserbaseToken({ token: 'bad', fetchImpl: impl });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.userMessage, /browserbase\.com\/settings/);
    // Users paste session and context ids by mistake; saying so is cheaper than
    // letting them re-issue a key that was never the problem.
    assert.match(result.userMessage, /not the session or context id|not a session/i);
  });

  it('ignores a base URL override — Browserbase is SaaS with one API host', async () => {
    const { impl, calls } = stubFetch(200, []);
    await validateBrowserbaseToken({ token: 'bb_live_123', baseUrl: 'https://evil.test', fetchImpl: impl } as any);
    assert.equal(calls[0].url, 'https://api.browserbase.com/v1/projects');
  });
});

describe('fetchBrowserbaseProject', () => {
  it('returns the first project id and name', async () => {
    const { impl } = stubFetch(200, [{ id: 'proj-1', name: 'Acme' }, { id: 'proj-2' }]);
    assert.deepEqual(await fetchBrowserbaseProject('bb_live_123', impl), { id: 'proj-1', name: 'Acme' });
  });

  it('degrades to empty rather than throwing', async () => {
    // Best-effort by design: the key already passed its probe, so failing the
    // connect over a display name would reject a credential that works.
    for (const impl of [stubFetch(500).impl, stubFetch(200, []).impl]) {
      assert.deepEqual(await fetchBrowserbaseProject('bb_live_123', impl), {});
    }
    const throwing = (async () => { throw new Error('network'); }) as unknown as typeof fetch;
    assert.deepEqual(await fetchBrowserbaseProject('bb_live_123', throwing), {});
  });
});

describe('buildBrowserbaseInstanceName', () => {
  it('prefers a user-provided name', () => {
    assert.equal(
      buildBrowserbaseInstanceName({ serviceName: 'Browserbase', providedInstanceName: 'My browser', projectName: 'Acme' }),
      'My browser',
    );
  });

  it('names the instance after the project, matching what the user sees upstream', () => {
    assert.equal(
      buildBrowserbaseInstanceName({ serviceName: 'Browserbase', projectName: 'Acme' }),
      'Browserbase (Acme)',
    );
  });

  it('falls back to the service name when no project was resolved', () => {
    assert.equal(buildBrowserbaseInstanceName({ serviceName: 'Browserbase' }), 'Browserbase');
    assert.equal(buildBrowserbaseInstanceName({ serviceName: 'Browserbase', projectName: '  ' }), 'Browserbase');
  });
});
