import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { PineconeRulesState } from '../../pinecone/accessRules.js';
import type { PineconeClient } from '../../pinecone/apiHelpers.js';
import { clearPineconeIndexCache } from '../../pinecone/indexCatalog.js';
import {
  type PineconeRestContext,
  performCascadingSearch,
  performCreateIndexForModel,
  performDescribeIndex,
  performDescribeIndexStats,
  performListIndexes,
  performRerankDocuments,
  performSearchRecords,
  performUpsertRecords,
} from '../../pinecone/restOps.js';

const KEY = 'pcsk_rest';
const loaded = (rules?: any): PineconeRulesState => ({ status: 'loaded', rules });
const unavailable: PineconeRulesState = { status: 'unavailable', detail: 'db down' };

function indexPayload(name: string, kind: 'legacy' | 'document' | 'vectors' = 'legacy') {
  const schema =
    kind === 'legacy'
      ? { fields: { chunk_text: { type: 'semantic_text' } } }
      : kind === 'document'
        ? { fields: { chunk_text: { type: 'string', embed: { model: 'm' } } } }
        : { fields: { _values: { type: 'dense_vector' } } };
  return {
    name,
    host: `${name}-abc.svc.pinecone.io`,
    status: { ready: true },
    schema,
    ...(kind === 'legacy' ? { embed: { model: 'multilingual-e5-large', field_map: { text: 'chunk_text' } } } : {}),
  };
}

function ctxWith(overrides: Record<string, any> = {}, payloads: Record<string, any> = {}, rules?: any): PineconeRestContext & { calls: string[] } {
  const calls: string[] = [];
  const client: any = {
    async listIndexes() { calls.push('listIndexes'); return Object.values(payloads); },
    async describeIndex(name: string) {
      calls.push(`describeIndex:${name}`);
      if (!payloads[name]) { const e: any = new Error('not found'); e.status = 404; throw e; }
      return payloads[name];
    },
    async describeIndexStats() {
      calls.push('stats');
      return { namespaces: { '': { recordCount: 2 }, hr: { recordCount: 3 } }, totalRecordCount: 5 };
    },
    async searchRecords() { calls.push('search'); return { result: { hits: [{ _id: 'r1', _score: 0.9, fields: {} }] } }; },
    async upsertRecords() { calls.push('upsert'); },
    async rerank() { calls.push('rerank'); return { data: [{ index: 0, score: 1 }] }; },
    async createIndexForModel(i: any) { calls.push('create'); return indexPayload(i.name); },
    ...overrides,
  };
  return Object.assign({ client: client as PineconeClient, apiKey: KEY, rules: loaded(rules) }, { calls }) as any;
}

beforeEach(() => clearPineconeIndexCache());

describe('performListIndexes', () => {
  it('reports hiddenByRules as 0 explicitly when nothing is hidden', async () => {
    const ctx = ctxWith({}, { a: indexPayload('a') });
    const out = await performListIndexes(ctx);
    assert.equal(out.indexes.length, 1);
    assert.equal(out.hiddenByRules, 0);
    assert.equal(out.note, undefined);
  });

  it('hides denied indexes and says they EXIST', async () => {
    const ctx = ctxWith({}, { a: indexPayload('a'), b: indexPayload('b') }, { allowedIndexes: ['a'] });
    const out = await performListIndexes(ctx);
    assert.deepEqual(out.indexes.map((i: any) => i.name), ['a']);
    assert.equal(out.hiddenByRules, 1);
    assert.match(String(out.note), /They exist/);
  });
});

describe('performDescribeIndex', () => {
  it('reports the kind and the field upserts must carry', async () => {
    const ctx = ctxWith({}, { docs: indexPayload('docs') });
    const out = await performDescribeIndex(ctx, 'docs');
    assert.equal(out.kind, 'legacy-integrated');
    assert.equal(out.textField, 'chunk_text');
    assert.equal(out.recordsApiUsable, true);
  });

  it('reports a document index as unusable, with the evidence', async () => {
    const ctx = ctxWith({}, { docs: indexPayload('docs', 'document') });
    const out = await performDescribeIndex(ctx, 'docs');
    assert.equal(out.kind, 'document');
    assert.equal(out.recordsApiUsable, false);
    assert.match(out.kindEvidence, /embed configuration/);
  });

  it('reports an unclassifiable index as USABLE — it is attempted, not refused', async () => {
    const mystery = { name: 'm', host: 'm.svc.pinecone.io', status: { ready: true }, schema: { fields: { b: { type: 'widget' } } } };
    const ctx = ctxWith({}, { m: mystery });
    assert.equal((await performDescribeIndex(ctx, 'm')).recordsApiUsable, true);
  });

  it('enforces the index rules before any API call', async () => {
    const ctx = ctxWith({}, { secret: indexPayload('secret') }, { allowedIndexes: ['other'] });
    await assert.rejects(() => performDescribeIndex(ctx, 'secret'), /allowed-indexes list/);
    assert.deepEqual(ctx.calls, []);
  });
});

describe('performDescribeIndexStats', () => {
  it('reports the total exactly as Pinecone gave it, hidden namespaces included', async () => {
    const ctx = ctxWith({}, { docs: indexPayload('docs') }, { allowedNamespaces: ['hr'] });
    const out = await performDescribeIndexStats(ctx, 'docs');
    assert.deepEqual(Object.keys(out.namespaces), ['hr']);
    assert.equal(out.totalRecordCount, 5);      // still counts the hidden default namespace
    assert.equal(out.hiddenByRules, 1);
    assert.match(String(out.note), /do not sum to the total/);
  });

  it('keeps the default namespace key as the empty string', async () => {
    const ctx = ctxWith({}, { docs: indexPayload('docs') });
    const out = await performDescribeIndexStats(ctx, 'docs');
    assert.ok('' in out.namespaces, 'the default namespace must survive as ""');
  });
});

describe('performSearchRecords', () => {
  const args = { name: 'docs', namespace: 'hr', query: { topK: 5, inputs: { text: 'q' } } } as any;

  it('returns the hits with the index and namespace echoed', async () => {
    const ctx = ctxWith({}, { docs: indexPayload('docs') });
    const out = await performSearchRecords(ctx, args);
    assert.equal(out.hits.length, 1);
    assert.equal(out.namespace, 'hr');
  });

  it('refuses a document index before searching', async () => {
    const ctx = ctxWith({}, { docs: indexPayload('docs', 'document') });
    await assert.rejects(() => performSearchRecords(ctx, args), /document index/);
    assert.ok(!ctx.calls.includes('search'));
  });

  it('enforces the namespace rule', async () => {
    const ctx = ctxWith({}, { docs: indexPayload('docs') }, { allowedNamespaces: [''] });
    await assert.rejects(() => performSearchRecords(ctx, args), /allowed-namespaces list/);
  });
});

describe('performCascadingSearch', () => {
  const args = {
    indexes: [{ name: 'a', namespace: 'hr' }, { name: 'b', namespace: 'hr' }],
    query: { topK: 5, inputs: { text: 'q' } },
    rerank: { model: 'cohere-rerank-3.5', rankFields: ['chunk_text'] },
  } as any;

  it('refuses the whole call when one target is denied, before any request', async () => {
    const ctx = ctxWith({}, { a: indexPayload('a'), b: indexPayload('b') }, { allowedIndexes: ['a'] });
    await assert.rejects(() => performCascadingSearch(ctx, args), /one ranking fused/);
    assert.deepEqual(ctx.calls, []);
  });

  it('marks partial=false on a clean run and keeps both records', async () => {
    const ctx = ctxWith({}, { a: indexPayload('a'), b: indexPayload('b') });
    const out = await performCascadingSearch(ctx, args);
    assert.equal(out.partial, false);
    // Both searches return the same _id from DIFFERENT targets, which is two
    // records — keying dedup on the id alone used to lose one.
    assert.equal(out.uniqueRecords, 2);
    assert.equal(out.indexesSearched, 2);
    assert.equal(out.targetsRequested, 2);
  });

  it('reports what was searched, not what was requested, on a partial run', async () => {
    let n = 0;
    const ctx = ctxWith(
      { searchRecords: async () => { n += 1; if (n === 1) throw new Error('boom'); return { result: { hits: [{ _id: 'r2', fields: {} }] } }; } },
      { a: indexPayload('a'), b: indexPayload('b') },
    );
    const out = await performCascadingSearch(ctx, args);
    assert.equal(out.partial, true);
    assert.equal(out.indexesSearched, 1);
    assert.equal(out.targetsRequested, 2);
  });

  it('attributes every document to its source target', async () => {
    let sent: any;
    const ctx = ctxWith(
      {
        rerank: async (input: any) => { sent = input; return { data: [] }; },
        searchRecords: async () => ({ result: { hits: [{ _id: 'a1', fields: {} }] } }),
      },
      { a: indexPayload('a'), b: indexPayload('b') },
    );
    await performCascadingSearch(ctx, args);
    assert.deepEqual(
      sent.documents.map((d: any) => `${d._index}/${d._namespace}/${d._id}`).sort(),
      ['a/hr/a1', 'b/hr/a1'],
    );
  });

  it('marks partial=true and names the failure when an index errors', async () => {
    let n = 0;
    const ctx = ctxWith(
      { searchRecords: async () => { n += 1; if (n === 1) throw new Error('boom'); return { result: { hits: [{ _id: 'r2', fields: {} }] } }; } },
      { a: indexPayload('a'), b: indexPayload('b') },
    );
    const out = await performCascadingSearch(ctx, args);
    assert.equal(out.partial, true);
    assert.equal(out.indexesSearched, 1);
    assert.match(out.failures.join(' '), /boom/);
  });

  it('sends _id with each document, so the ranking can identify the record', async () => {
    let sent: any;
    const ctx = ctxWith(
      {
        rerank: async (input: any) => { sent = input; return { data: [] }; },
        searchRecords: async () => ({ result: { hits: [{ _id: 'rec-9', fields: { chunk_text: 'hi' } }] } }),
      },
      { a: indexPayload('a'), b: indexPayload('b') },
    );
    await performCascadingSearch(ctx, args);
    assert.equal(sent.documents[0]._id, 'rec-9');
    assert.equal(sent.documents[0].chunk_text, 'hi');
  });

  it('throws 502 rather than answering an empty ranking when nothing was reachable', async () => {
    const ctx = ctxWith(
      { searchRecords: async () => { throw new Error('down'); } },
      { a: indexPayload('a'), b: indexPayload('b') },
    );
    await assert.rejects(() => performCascadingSearch(ctx, args), (e: any) => e.status === 502);
  });
});

describe('performRerankDocuments', () => {
  it('needs no index and applies no index rule', async () => {
    // Even with an allowlist that denies everything, this must work.
    const ctx = ctxWith({}, {}, { allowedIndexes: ['nothing-matches'] });
    const out: any = await performRerankDocuments(ctx, { model: 'cohere-rerank-3.5', query: 'q', documents: ['a'] } as any);
    assert.equal(out.data.length, 1);
    assert.deepEqual(ctx.calls, ['rerank']);
  });
});

describe('performCreateIndexForModel', () => {
  const args = { name: 'fresh', cloud: 'aws', region: 'us-east-1', embed: { model: 'multilingual-e5-large', fieldMap: { text: 'chunk_text' } } } as any;

  it('reports created=true for a new index', async () => {
    const ctx = ctxWith({ listIndexes: async () => [] });
    const out = await performCreateIndexForModel(ctx, args);
    assert.equal(out.created, true);
  });

  it('reports created=false when it already existed — so a 201 is never a lie', async () => {
    const ctx = ctxWith({ listIndexes: async () => [indexPayload('fresh')] });
    const out = await performCreateIndexForModel(ctx, args);
    assert.equal(out.created, false);
    assert.ok(!ctx.calls.includes('create'));
  });

  it('is refused by read-only before any API call', async () => {
    const ctx = ctxWith({ listIndexes: async () => [] }, {}, { readOnly: true });
    await assert.rejects(() => performCreateIndexForModel(ctx, args), /read-only/);
    assert.deepEqual(ctx.calls, []);
  });

  it('is refused when the rules cannot be read — the write gate fails CLOSED over REST too', async () => {
    const ctx = ctxWith({ listIndexes: async () => [] });
    ctx.rules = unavailable;
    await assert.rejects(() => performCreateIndexForModel(ctx, args), /temporary failure/);
    assert.deepEqual(ctx.calls, []);
  });
});

describe('performUpsertRecords', () => {
  const args = { name: 'docs', namespace: 'hr', records: [{ _id: 'a', chunk_text: 'hello' }] } as any;

  it('reports ACCEPTED, never indexed', async () => {
    const ctx = ctxWith({}, { docs: indexPayload('docs') });
    const out = await performUpsertRecords(ctx, args);
    assert.equal(out.accepted, 1);
    assert.equal(out.textField, 'chunk_text');
    assert.ok(out.bytes > 0);
    assert.match(out.freshness, /asynchronous|few seconds/);
  });

  it('keeps the default namespace as the empty string in the response', async () => {
    const ctx = ctxWith({}, { docs: indexPayload('docs') });
    assert.equal((await performUpsertRecords(ctx, { ...args, namespace: '' })).namespace, '');
  });

  it('is refused by read-only before the index is resolved', async () => {
    const ctx = ctxWith({}, { docs: indexPayload('docs') }, { readOnly: true });
    await assert.rejects(() => performUpsertRecords(ctx, args), /read-only/);
    assert.deepEqual(ctx.calls, []);
  });

  it('refuses a record missing the text field and sends nothing', async () => {
    const ctx = ctxWith({}, { docs: indexPayload('docs') });
    await assert.rejects(
      () => performUpsertRecords(ctx, { ...args, records: [{ _id: 'a', text: 'x' }] }),
      /missing the text field/,
    );
    assert.ok(!ctx.calls.includes('upsert'));
  });

  it('refuses an over-size batch even though Zod also caps it', async () => {
    const ctx = ctxWith({}, { docs: indexPayload('docs') });
    const records = Array.from({ length: 1001 }, (_, i) => ({ _id: `r${i}`, chunk_text: 'x' }));
    await assert.rejects(() => performUpsertRecords(ctx, { ...args, records }), /per-request limit of 1000/);
    assert.ok(!ctx.calls.includes('upsert'));
  });

  it('enforces the namespace rule', async () => {
    const ctx = ctxWith({}, { docs: indexPayload('docs') }, { allowedNamespaces: ['other'] });
    await assert.rejects(() => performUpsertRecords(ctx, args), /allowed-namespaces list/);
  });
});

// ---------------------------------------------------------------------------
// The REST half of the cascading-search report. The findings have to be
// machine-readable here, not prose: a client checking only `partial` saw
// `false` for a ranking that was missing an entire namespace.
// ---------------------------------------------------------------------------

describe('performCascadingSearch: per-target contribution', () => {
  const args = {
    indexes: [{ name: 'a', namespace: 'ns-a' }, { name: 'b', namespace: 'ns-b' }],
    query: { topK: 5, inputs: { text: 'q' } },
    rerank: { model: 'cohere-rerank-3.5', rankFields: ['chunk_text'] },
  } as any;

  function lopsided(secondAnswer: any) {
    return ctxWith(
      {
        searchRecords: async (_host: string, namespace: string) =>
          namespace === 'ns-a'
            ? { result: { hits: [{ _id: 'a1', fields: { chunk_text: 'x' } }] } }
            : secondAnswer,
        rerank: async (input: any) => ({ data: input.documents.map((d: any, i: number) => ({ index: i, score: 1, document: d })) }),
      },
      { a: indexPayload('a'), b: indexPayload('b') },
    );
  }

  it('reports each target separately, so searched does not imply contributed', async () => {
    const res = await performCascadingSearch(lopsided({ result: { hits: [] } }), args);
    // The flag a naive client reads is still false — nothing failed.
    assert.equal(res.partial, false);
    assert.equal(res.indexesSearched, 2);
    // ...which is exactly why the per-target array has to exist.
    assert.deepEqual(res.targets.map(t => [t.index, t.searched, t.hits, t.kept]), [
      ['a', true, 1, 1],
      ['b', true, 0, 0],
    ]);
    assert.deepEqual(res.emptyTargets, ['b/ns-b']);
  });

  it('counts an unreadable sub-search as NOT searched', async () => {
    // undefined is what jsonApiRequest resolves to for a 204 or a non-JSON
    // 2xx. Reported as zero hits, it made a target look answered.
    const res = await performCascadingSearch(lopsided(undefined), args);
    assert.equal(res.partial, true);
    assert.equal(res.indexesSearched, 1);
    assert.equal(res.targets[1].searched, false);
    assert.match(res.targets[1].error!, /could not be read/);
    assert.deepEqual(res.emptyTargets, [], 'a failure is not an empty result');
  });

  it('reports topNNote when topN exceeds the candidates', async () => {
    const res = await performCascadingSearch(lopsided({ result: { hits: [] } }), {
      ...args, rerank: { ...args.rerank, topN: 40 },
    } as any);
    assert.match(res.topNNote!, /topN is 40 but only 1 candidate/);
  });

  it('omits topNNote when topN is reachable', async () => {
    const res = await performCascadingSearch(lopsided({ result: { hits: [] } }), {
      ...args, rerank: { ...args.rerank, topN: 1 },
    } as any);
    assert.equal(res.topNNote, undefined);
  });

  it('names the index that would not resolve', async () => {
    const ctx = ctxWith({}, { a: indexPayload('a') });
    await assert.rejects(
      () => performCascadingSearch(ctx, { ...args, indexes: [{ name: 'a', namespace: 'ns-a' }, { name: 'typo', namespace: 'ns-a' }] } as any),
      /"typo"/,
    );
    assert.ok(!ctx.calls.includes('search'));
  });

  it('still answers when one target fails and the other is genuinely empty', async () => {
    const ctx = ctxWith(
      {
        searchRecords: async (_host: string, namespace: string) => {
          if (namespace === 'ns-b') throw new Error('boom');
          return { result: { hits: [] } };
        },
      },
      { a: indexPayload('a'), b: indexPayload('b') },
    );
    const res = await performCascadingSearch(ctx, args);
    assert.equal(res.partial, true);
    assert.equal(res.uniqueRecords, 0);
    assert.equal(res.indexesSearched, 1);
  });
});

describe('performSearchRecords: an unreadable answer', () => {
  it('fails rather than reporting an empty hit list', async () => {
    const ctx = ctxWith({ searchRecords: async () => undefined }, { docs: indexPayload('docs') });
    await assert.rejects(
      () => performSearchRecords(ctx, { name: 'docs', namespace: 'hr', query: { topK: 5, inputs: { text: 'q' } } } as any),
      /could not be read/,
    );
  });
});

describe('performCreateIndexForModel: drift against an existing index', () => {
  const args = {
    name: 'docs',
    cloud: 'aws',
    region: 'us-east-1',
    embed: { model: 'llama-text-embed-v2', fieldMap: { text: 'body' } },
  } as any;

  it('reports the model and field mismatch as data', async () => {
    const ctx = ctxWith({ listIndexes: async () => [indexPayload('docs')] });
    const res = await performCreateIndexForModel(ctx, args);
    assert.equal(res.created, false);
    assert.equal(res.configDrift.length, 2);
    assert.match(res.configDrift[0], /embedding model/);
    assert.match(res.configDrift[1], /embedded field/);
  });

  it('is an empty array when the existing index matches', async () => {
    const ctx = ctxWith({ listIndexes: async () => [indexPayload('docs')] });
    const res = await performCreateIndexForModel(ctx, {
      ...args, embed: { model: 'multilingual-e5-large', fieldMap: { text: 'chunk_text' } },
    } as any);
    assert.deepEqual(res.configDrift, []);
  });

  it('is an empty array on a real create', async () => {
    const ctx = ctxWith({ listIndexes: async () => [] });
    const res = await performCreateIndexForModel(ctx, args);
    assert.equal(res.created, true);
    assert.deepEqual(res.configDrift, []);
  });
});
