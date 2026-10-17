import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PINECONE_API_VERSION } from '../../pinecone/apiHelpers.js';
import {
  buildPineconeInstanceName,
  fetchPineconeIndexSummary,
  validatePineconeToken,
} from '../../pinecone/connectToken.js';

function stubFetch(body: unknown, { status = 200 } = {}) {
  const calls: Array<{ url: string; init: any }> = [];
  const impl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as any;
  }) as any;
  return { impl, calls };
}

describe('validatePineconeToken', () => {
  it('probes GET /indexes with the key and the required version header', async () => {
    const { impl, calls } = stubFetch({ indexes: [] });
    const res = await validatePineconeToken({ token: 'pcsk_x', fetchImpl: impl });
    assert.equal(res.ok, true);
    assert.match(calls[0].url, /^https:\/\/api\.pinecone\.io\/indexes$/);
    assert.equal(calls[0].init.headers['Api-Key'], 'pcsk_x');
    assert.equal(calls[0].init.headers['X-Pinecone-Api-Version'], PINECONE_API_VERSION);
  });

  it('accepts an EMPTY project — that is a real answer, not a bad key', async () => {
    const { impl } = stubFetch({ indexes: [] });
    assert.equal((await validatePineconeToken({ token: 'pcsk_x', fetchImpl: impl })).ok, true);
  });

  it('rejects a blank token before touching the network', async () => {
    let called = false;
    const impl = (async () => { called = true; return {} as any; }) as any;
    const res = await validatePineconeToken({ token: '   ', fetchImpl: impl });
    assert.equal(res.ok, false);
    assert.equal(called, false);
  });

  it('tells the user a key is scoped to one project when rejected', async () => {
    const { impl } = stubFetch({ error: 'nope' }, { status: 401 });
    const res = await validatePineconeToken({ token: 'bad', fetchImpl: impl });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.userMessage, /scoped to one project/);
  });

  it('refuses to follow a redirect, so the key cannot reach another host', async () => {
    const { impl, calls } = stubFetch({ indexes: [] });
    await validatePineconeToken({ token: 'pcsk_x', fetchImpl: impl });
    assert.equal(calls[0].init.redirect, 'error');
  });
});

describe('fetchPineconeIndexSummary', () => {
  it('reports the count and the first name', async () => {
    const { impl } = stubFetch({ indexes: [{ name: 'docs' }, { name: 'other' }] });
    assert.deepEqual(await fetchPineconeIndexSummary('k', impl), { count: 2, firstName: 'docs' });
  });

  it('degrades to {} rather than failing a connect that already validated', async () => {
    const impl = (async () => { throw new Error('boom'); }) as any;
    assert.deepEqual(await fetchPineconeIndexSummary('k', impl), {});
  });

  it('degrades to {} on a non-2xx too', async () => {
    const { impl } = stubFetch({}, { status: 500 });
    assert.deepEqual(await fetchPineconeIndexSummary('k', impl), {});
  });
});

describe('buildPineconeInstanceName', () => {
  it('prefers a name the user typed', () => {
    assert.equal(
      buildPineconeInstanceName({ serviceName: 'Pinecone', providedInstanceName: 'Mine', indexCount: 2 }),
      'Mine',
    );
  });

  it('names a single-index connection after that index', () => {
    assert.equal(
      buildPineconeInstanceName({ serviceName: 'Pinecone', indexCount: 1, firstIndexName: 'docs' }),
      'Pinecone (docs)',
    );
  });

  it('counts when there are several', () => {
    assert.equal(buildPineconeInstanceName({ serviceName: 'Pinecone', indexCount: 3 }), 'Pinecone (3 indexes)');
  });

  it('falls back to the plain label for an empty project', () => {
    // "Pinecone (0 indexes)" reads like a failure.
    assert.equal(buildPineconeInstanceName({ serviceName: 'Pinecone', indexCount: 0 }), 'Pinecone');
    assert.equal(buildPineconeInstanceName({ serviceName: 'Pinecone' }), 'Pinecone');
  });
});
