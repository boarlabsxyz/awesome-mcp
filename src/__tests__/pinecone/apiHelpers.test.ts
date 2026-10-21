import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UserError } from 'fastmcp';

import {
  PINECONE_API_VERSION,
  PineconeClient,
  dataBaseUrl,
  getPineconeClient,
  mapPineconeError,
  readSearchHits,
  withPineconeClient,
} from '../../pinecone/apiHelpers.js';

const silentLog = { info: () => {}, error: () => {} };

interface Captured {
  url: string;
  init: any;
}

/** A fetch stub that records the request and answers with `body`. */
function stubFetch(
  body: unknown,
  { status = 200, contentType = 'application/json' } = {},
): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const impl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'OK',
      headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? contentType : null) },
      json: async () => body,
      text: async () => JSON.stringify(body),
      body: null,
    } as any;
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

describe('PineconeClient headers', () => {
  it('sends Api-Key and the REQUIRED version header on every call', async () => {
    const { fetch: f, calls } = stubFetch({ indexes: [] });
    await new PineconeClient('pcsk_x', undefined, f).listIndexes();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers['Api-Key'], 'pcsk_x');
    // Pinecone rejects a request with no version header — it is not a
    // "default to latest".
    assert.equal(calls[0].init.headers['X-Pinecone-Api-Version'], PINECONE_API_VERSION);
  });

  it('never follows a redirect, so the key cannot cross an origin', async () => {
    const { fetch: f, calls } = stubFetch({ indexes: [] });
    await new PineconeClient('pcsk_x', undefined, f).listIndexes();
    assert.equal(calls[0].init.redirect, 'manual');
  });
});

describe('PineconeClient control plane', () => {
  it('returns an empty array when the payload carries no indexes', async () => {
    const { fetch: f } = stubFetch({});
    assert.deepEqual(await new PineconeClient('k', undefined, f).listIndexes(), []);
  });

  it('url-encodes the index name', async () => {
    const { fetch: f, calls } = stubFetch({ name: 'a b' });
    await new PineconeClient('k', undefined, f).describeIndex('a b');
    assert.match(calls[0].url, /\/indexes\/a%20b$/);
  });

  it('translates fieldMap to the snake_case field_map Pinecone expects', async () => {
    const { fetch: f, calls } = stubFetch({ name: 'docs' });
    await new PineconeClient('k', undefined, f).createIndexForModel({
      name: 'docs',
      cloud: 'aws',
      region: 'us-east-1',
      embed: { model: 'multilingual-e5-large', fieldMap: { text: 'chunk_text' } },
    });
    const sent = JSON.parse(calls[0].init.body);
    assert.deepEqual(sent.embed.field_map, { text: 'chunk_text' });
    assert.equal(sent.embed.fieldMap, undefined);
    assert.equal(sent.tags.source, 'mcp');
  });
});

describe('PineconeClient.rerank', () => {
  it('translates topN/rankFields to top_n/rank_fields', async () => {
    const { fetch: f, calls } = stubFetch({ data: [] });
    await new PineconeClient('k', undefined, f).rerank({
      model: 'cohere-rerank-3.5',
      query: 'q',
      documents: [{ text: 'a' }],
      topN: 3,
      rankFields: ['text'],
    });
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.top_n, 3);
    assert.deepEqual(sent.rank_fields, ['text']);
    assert.equal(sent.topN, undefined);
  });

  it('lifts a bare string into the { text } document shape Pinecone takes', async () => {
    const { fetch: f, calls } = stubFetch({ data: [] });
    await new PineconeClient('k', undefined, f).rerank({
      model: 'cohere-rerank-3.5',
      query: 'q',
      documents: ['hello'],
    });
    assert.deepEqual(JSON.parse(calls[0].init.body).documents, [{ text: 'hello' }]);
  });

  it('omits top_n and rank_fields entirely when not given', async () => {
    const { fetch: f, calls } = stubFetch({ data: [] });
    await new PineconeClient('k', undefined, f).rerank({ model: 'm', query: 'q', documents: ['a'] });
    const sent = JSON.parse(calls[0].init.body);
    assert.ok(!('top_n' in sent));
    assert.ok(!('rank_fields' in sent));
  });
});

describe('PineconeClient data plane', () => {
  const host = 'docs-abc.svc.us-east1-gcp.pinecone.io';

  it('addresses the per-index host, not the control plane', async () => {
    const { fetch: f, calls } = stubFetch({});
    await new PineconeClient('k', undefined, f).describeIndexStats(host);
    assert.equal(calls[0].url, `https://${host}/describe_index_stats`);
  });

  it('translates topK to top_k and the rerank fields', async () => {
    const { fetch: f, calls } = stubFetch({ result: { hits: [] } });
    await new PineconeClient('k', undefined, f).searchRecords(
      host,
      'hr',
      { topK: 5, inputs: { text: 'q' }, filter: { a: 1 } },
      { model: 'cohere-rerank-3.5', rankFields: ['chunk_text'], topN: 2 },
    );
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.query.top_k, 5);
    assert.deepEqual(sent.query.filter, { a: 1 });
    assert.deepEqual(sent.rerank.rank_fields, ['chunk_text']);
    assert.equal(sent.rerank.top_n, 2);
  });

  it('sends the DEFAULT namespace as __default__, never an empty path segment', async () => {
    // The bug this replaced: `''` encoded to nothing, producing
    // `/namespaces//search`, which Pinecone refuses with a 400 naming
    // __default__. Every tool description told callers to pass '', so the
    // translation happens here rather than refusing them.
    const { fetch: f, calls } = stubFetch({ result: { hits: [] } });
    await new PineconeClient('k', undefined, f).searchRecords(host, '', { topK: 1, inputs: { text: 'q' } });
    assert.equal(calls[0].url, `https://${host}/records/namespaces/__default__/search`);
  });

  it('passes __default__ through unchanged when the caller already uses it', async () => {
    const { fetch: f, calls } = stubFetch({ result: { hits: [] } });
    await new PineconeClient('k', undefined, f).searchRecords(host, '__default__', { topK: 1, inputs: { text: 'q' } });
    assert.equal(calls[0].url, `https://${host}/records/namespaces/__default__/search`);
  });

  it('translates the default namespace on UPSERT too, not just search', async () => {
    const { fetch: f, calls } = stubFetch(undefined, { status: 201, contentType: '' });
    await new PineconeClient('k', undefined, f).upsertRecords(host, '', '{"_id":"a"}\n');
    assert.equal(calls[0].url, `https://${host}/records/namespaces/__default__/upsert`);
  });

  it('leaves a named namespace alone', async () => {
    const { fetch: f, calls } = stubFetch({ result: { hits: [] } });
    await new PineconeClient('k', undefined, f).searchRecords(host, 'hr', { topK: 1, inputs: { text: 'q' } });
    assert.equal(calls[0].url, `https://${host}/records/namespaces/hr/search`);
  });

  it('sends the upsert body as NDJSON, not JSON', async () => {
    const { fetch: f, calls } = stubFetch(undefined, { status: 201, contentType: '' });
    await new PineconeClient('k', undefined, f).upsertRecords(host, 'hr', '{"_id":"a"}\n');
    // application/json here yields a 400 that reads like a schema error.
    assert.equal(calls[0].init.headers['Content-Type'], 'application/x-ndjson');
    assert.equal(calls[0].init.body, '{"_id":"a"}\n');
  });
});

describe('dataBaseUrl', () => {
  it('accepts a plain hostname', () => {
    assert.equal(dataBaseUrl('idx.svc.pinecone.io'), 'https://idx.svc.pinecone.io');
  });

  it('tolerates a scheme or trailing slash Pinecone might include', () => {
    assert.equal(dataBaseUrl('https://idx.svc.pinecone.io/'), 'https://idx.svc.pinecone.io');
  });

  it('refuses anything that is not a bare hostname', () => {
    // This value is the authority of a URL we then send the API key to.
    for (const bad of ['evil.test/path', '', 'not a host', 'host:9999', '../x']) {
      assert.throws(() => dataBaseUrl(bad), UserError, `expected refusal for ${JSON.stringify(bad)}`);
    }
  });

  it('refuses a single-label name, which could only be an internal host', () => {
    assert.throws(() => dataBaseUrl('localhost'), UserError);
    assert.throws(() => dataBaseUrl('metadata'), UserError);
  });

  it('enforces the label and total length limits', () => {
    assert.throws(() => dataBaseUrl(`${'a'.repeat(64)}.pinecone.io`), UserError);
    assert.throws(() => dataBaseUrl(`${'a'.repeat(60)}.`.repeat(5) + 'pinecone.io'), UserError);
    assert.equal(dataBaseUrl(`${'a'.repeat(63)}.pinecone.io`), `https://${'a'.repeat(63)}.pinecone.io`);
  });

  it('refuses a label that starts or ends with a hyphen', () => {
    assert.throws(() => dataBaseUrl('-idx.pinecone.io'), UserError);
    assert.throws(() => dataBaseUrl('idx-.pinecone.io'), UserError);
    assert.throws(() => dataBaseUrl('idx..pinecone.io'), UserError);
  });

  it('refuses an absurdly long value WITHOUT scanning it', () => {
    // The trailing-slash strip backtracks quadratically over a long run of
    // slashes that does not end the string (80k slashes measured at ~2s), so
    // the length bound has to come first.
    const nasty = `a${'/'.repeat(200_000)}b`;
    const started = Date.now();
    assert.throws(() => dataBaseUrl(nasty), UserError);
    assert.ok(Date.now() - started < 500, 'an over-long host must be refused unread');
  });

  it('validates in linear time — no catastrophic backtracking', () => {
    // The natural one-regex form nests a quantifier inside a repeated group.
    // This pins the shape that replaced it.
    const nasty = `${Array.from({ length: 40 }, () => 'aa-aa').join('.')}.!`;
    const started = Date.now();
    assert.throws(() => dataBaseUrl(nasty), UserError);
    assert.ok(Date.now() - started < 1000, 'validation should be immediate');
  });
});

describe('getPineconeClient', () => {
  it('names the dashboard when the connection has no key', () => {
    assert.throws(() => getPineconeClient(undefined as any), /not connected/);
    assert.throws(() => getPineconeClient({} as any), /dashboard/);
  });
});

describe('mapPineconeError', () => {
  const msg = (status: number | undefined) => {
    try {
      mapPineconeError('prefix', { status, message: 'raw' }, silentLog);
    } catch (err: any) {
      return err.message as string;
    }
    return '';
  };

  it('sends a 401 to re-issue the key', () => {
    assert.match(msg(401), /Reconnect from the dashboard/);
  });

  it('offers both causes for a 403 rather than asserting the index one', () => {
    // It used to claim an index in another project, which is wrong on any
    // path that touches no index — /rerank most of all.
    const m = msg(403);
    assert.match(m, /scoped to ONE project/);
    assert.match(m, /plan/);
    // And it rules the key out, since a bad key is a 401.
    assert.match(m, /401/);
  });

  it('explains a 404 as "not in this key\'s project"', () => {
    assert.match(msg(404), /this key's project/);
  });

  it('refuses to claim anything about a request with no status', () => {
    // undici reports every transport failure as a bare "fetch failed".
    assert.match(msg(undefined), /may or may not have been received/);
  });
});

describe('rerank 403', () => {
  it('names the MODEL and rules out the key and the index', async () => {
    // The reported bug: a cohere-rerank 403 was explained as "an index in a
    // different project" on a call that touches no index at all.
    const { fetch: f } = stubFetch({ error: 'forbidden' }, { status: 403 });
    await assert.rejects(
      () => new PineconeClient('k', undefined, f).rerank({ model: 'cohere-rerank-3.5', query: 'q', documents: ['a'] }),
      (err: any) => {
        assert.match(err.message, /cohere-rerank-3\.5/);
        assert.match(err.message, /not the API key/);
        assert.match(err.message, /touches no index/);
        assert.match(err.message, /plan/);
        // And it suggests a model that is included.
        assert.match(err.message, /pinecone-rerank-v0/);
        return true;
      },
    );
  });

  it('leaves other rerank failures to the generic mapping', async () => {
    const { fetch: f } = stubFetch({ error: 'boom' }, { status: 500 });
    await assert.rejects(
      () => new PineconeClient('k', undefined, f).rerank({ model: 'pinecone-rerank-v0', query: 'q', documents: ['a'] }),
      (err: any) => {
        assert.doesNotMatch(err.message, /not the API key/);
        return true;
      },
    );
  });
});

describe('withPineconeClient', () => {
  it('surfaces a missing-token error verbatim rather than as an upstream failure', async () => {
    await assert.rejects(
      () => withPineconeClient('p', {} as any, silentLog, async () => 'x'),
      /not connected/,
    );
  });

  it('lets a UserError from the body through untouched', async () => {
    await assert.rejects(
      () =>
        withPineconeClient('p', { pineconeAccessToken: 'k' } as any, silentLog, async () => {
          throw new UserError('a precise message');
        }),
      /^UserError: a precise message$/,
    );
  });

  it('maps an upstream error through mapPineconeError', async () => {
    await assert.rejects(
      () =>
        withPineconeClient('p', { pineconeAccessToken: 'k' } as any, silentLog, async () => {
          const err: any = new Error('boom');
          err.status = 429;
          throw err;
        }),
      /rate-limited/,
    );
  });
});

describe('readSearchHits', () => {
  it('returns the hits when Pinecone answered the question', async () => {
    const hits = [{ _id: 'a' }, { _id: 'b' }];
    assert.deepEqual(readSearchHits({ result: { hits } } as any, 'x'), hits);
  });

  it('accepts an EMPTY hits array as a real answer of zero matches', async () => {
    // `hits: []` is positive evidence; it is the one shape that must not throw.
    assert.deepEqual(readSearchHits({ result: { hits: [] } } as any, 'x'), []);
  });

  it('refuses an undefined response rather than calling it zero hits', async () => {
    // jsonApiRequest resolves to undefined for a 204 and for any non-JSON
    // 2xx. `res?.result?.hits ?? []` turned both into "nothing matched",
    // which is how a cascading-search target was counted as searched while
    // contributing nothing.
    assert.throws(
      () => readSearchHits(undefined, '"b" / "ns-b"'),
      (err: Error) => {
        assert.ok(err instanceof UserError);
        assert.match(err.message, /"b" \/ "ns-b"/);
        assert.match(err.message, /no readable JSON body/);
        assert.match(err.message, /reported as a FAILURE rather than as zero results/);
        return true;
      },
    );
  });

  it('refuses a response with no result envelope, naming what arrived', async () => {
    assert.throws(
      () => readSearchHits({ usage: { readUnits: 1 } } as any, 'x'),
      /no "result" key \(got: "usage"\)/,
    );
  });

  it('refuses a result with no hits array, naming what arrived', async () => {
    assert.throws(
      () => readSearchHits({ result: { matches: [] } } as any, 'x'),
      /"result" carried no "hits" array \(got: "matches"\)/,
    );
  });

  it('refuses a non-array hits value', async () => {
    assert.throws(() => readSearchHits({ result: { hits: 'none' } } as any, 'x'), /no "hits" array/);
  });
});
