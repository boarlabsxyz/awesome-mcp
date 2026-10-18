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

  it('marks partial=false on a clean run', async () => {
    const ctx = ctxWith({}, { a: indexPayload('a'), b: indexPayload('b') });
    const out = await performCascadingSearch(ctx, args);
    assert.equal(out.partial, false);
    assert.equal(out.uniqueRecords, 1);   // both searches return the same _id
    assert.equal(out.indexesSearched, 2);
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
