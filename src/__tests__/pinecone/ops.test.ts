import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { PineconeClient } from '../../pinecone/apiHelpers.js';
import type { PineconeRulesState } from '../../pinecone/accessRules.js';
import { clearPineconeIndexCache } from '../../pinecone/indexCatalog.js';
import {
  opCascadingSearch,
  opCreateIndexForModel,
  opDescribeIndex,
  opDescribeIndexStats,
  opListIndexes,
  opSearchRecords,
  opUpsertRecords,
} from '../../pinecone/ops.js';

const KEY = 'pcsk_test';
const log = { info: () => {}, error: () => {} };
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

/** A recording client stub; each test overrides only what it exercises. */
function stub(overrides: Partial<Record<string, any>> = {}, payloads: Record<string, any> = {}) {
  const calls: string[] = [];
  const base: any = {
    calls,
    async listIndexes() {
      calls.push('listIndexes');
      return Object.values(payloads);
    },
    async describeIndex(name: string) {
      calls.push(`describeIndex:${name}`);
      if (!payloads[name]) {
        const e: any = new Error('not found');
        e.status = 404;
        throw e;
      }
      return payloads[name];
    },
    async describeIndexStats() {
      calls.push('stats');
      return { namespaces: { '': { recordCount: 2 }, hr: { recordCount: 3 } }, totalRecordCount: 5 };
    },
    async searchRecords() {
      calls.push('search');
      return { result: { hits: [{ _id: 'r1', _score: 0.9, fields: { chunk_text: 'hello' } }] } };
    },
    async upsertRecords() {
      calls.push('upsert');
    },
    async rerank() {
      calls.push('rerank');
      return { data: [] };
    },
    async createIndexForModel(input: any) {
      calls.push('create');
      return indexPayload(input.name);
    },
  };
  return Object.assign(base, overrides) as PineconeClient & { calls: string[] };
}

beforeEach(() => clearPineconeIndexCache());

describe('opListIndexes', () => {
  it('lists everything when no rules are set', async () => {
    const client = stub({}, { a: indexPayload('a'), b: indexPayload('b') });
    const out = await opListIndexes(client, loaded(), log);
    assert.match(out, /2 index\(es\)/);
    assert.match(out, /- a/);
  });

  it('hides denied indexes and states that they exist', async () => {
    const client = stub({}, { a: indexPayload('a'), b: indexPayload('b') });
    const out = await opListIndexes(client, loaded({ allowedIndexes: ['a'] }), log);
    assert.match(out, /1 index\(es\)/);
    assert.doesNotMatch(out, /- b/);
    assert.match(out, /They exist; this connection cannot use them/);
  });

  it('never reports an all-hidden project as an empty one', async () => {
    // "No indexes" for a filtered list is the Slack trap this closes.
    const client = stub({}, { a: indexPayload('a') });
    const out = await opListIndexes(client, loaded({ allowedIndexes: ['zzz'] }), log);
    assert.match(out, /No indexes are visible to this connection/);
    assert.match(out, /They exist/);
    assert.doesNotMatch(out, /has no indexes/);
  });

  it('does say so when the project really is empty', async () => {
    const client = stub({ listIndexes: async () => [] });
    const out = await opListIndexes(client, loaded(), log);
    assert.match(out, /has no indexes/);
  });

  it('appends the access-rules line when rules are configured', async () => {
    const client = stub({}, { a: indexPayload('a') });
    const out = await opListIndexes(client, loaded({ allowedIndexes: ['a'] }), log);
    assert.match(out, /do not limit the API key itself/);
  });
});

describe('opDescribeIndex', () => {
  it('reports a usable index and the field it embeds', async () => {
    const client = stub({}, { docs: indexPayload('docs') });
    const out = await opDescribeIndex(client, loaded(), { name: 'docs' }, log);
    assert.match(out, /integrated-embedding index/);
    assert.match(out, /chunk_text/);
  });

  it('warns that a document index will not work with search or upsert', async () => {
    const client = stub({}, { docs: indexPayload('docs', 'document') });
    const out = await opDescribeIndex(client, loaded(), { name: 'docs' }, log);
    assert.match(out, /document index/);
    assert.match(out, /do NOT work/);
  });

  it('answers a HIDDEN index with the denial, not a 404 — the diagnose path', async () => {
    const client = stub({}, { secret: indexPayload('secret') });
    await assert.rejects(
      () => opDescribeIndex(client, loaded({ allowedIndexes: ['other'] }), { name: 'secret' }, log),
      /not on this connection's allowed-indexes list/,
    );
    // Decided from the rules alone: no API call, so the denial reveals nothing
    // about whether the index exists.
    assert.deepEqual(client.calls, []);
  });
});

describe('opDescribeIndexStats', () => {
  it('renders the default namespace by name, never as an empty string', async () => {
    const client = stub({}, { docs: indexPayload('docs') });
    const out = await opDescribeIndexStats(client, KEY, loaded(), { name: 'docs' }, log);
    assert.match(out, /\(default namespace\)/);
    assert.match(out, /5 record\(s\) in total/);
  });

  it('explains why filtered counts will not sum to the total', async () => {
    const client = stub({}, { docs: indexPayload('docs') });
    const out = await opDescribeIndexStats(client, KEY, loaded({ allowedNamespaces: ['hr'] }), { name: 'docs' }, log);
    assert.match(out, /do not sum to the total/);
  });

  it('warns that recent writes may not be visible', async () => {
    const client = stub({}, { docs: indexPayload('docs') });
    const out = await opDescribeIndexStats(client, KEY, loaded(), { name: 'docs' }, log);
    assert.match(out, /take a few seconds to be embedded/);
  });
});

describe('opSearchRecords', () => {
  const args = { name: 'docs', namespace: 'hr', query: { topK: 5, inputs: { text: 'q' } } } as any;

  it('returns the hits', async () => {
    const client = stub({}, { docs: indexPayload('docs') });
    const out = await opSearchRecords(client, KEY, loaded(), args, log);
    assert.match(out, /1 hit\(s\)/);
    assert.match(out, /r1/);
  });

  it('refuses a document index BEFORE searching it', async () => {
    const client = stub({}, { docs: indexPayload('docs', 'document') });
    await assert.rejects(() => opSearchRecords(client, KEY, loaded(), args, log), /document index/);
    assert.ok(!client.calls.includes('search'));
  });

  it('enforces the namespace rule', async () => {
    const client = stub({}, { docs: indexPayload('docs') });
    await assert.rejects(
      () => opSearchRecords(client, KEY, loaded({ allowedNamespaces: ['other'] }), args, log),
      /allowed-namespaces list/,
    );
  });

  it('attaches the classifier evidence to an upstream 400 on an unclassifiable index', async () => {
    const mystery = { name: 'm', host: 'm.svc.pinecone.io', status: { ready: true }, schema: { fields: { b: { type: 'widget' } } } };
    const client = stub(
      {
        searchRecords: async () => {
          const e: any = new Error('bad request');
          e.status = 400;
          throw e;
        },
      },
      { m: mystery },
    );
    await assert.rejects(
      () => opSearchRecords(client, KEY, loaded(), { ...args, name: 'm' }, log),
      /attempted the call rather than guessing/,
    );
  });
});

describe('opCascadingSearch', () => {
  const args = {
    indexes: [{ name: 'a', namespace: 'hr' }, { name: 'b', namespace: 'hr' }],
    query: { topK: 5, inputs: { text: 'q' } },
    rerank: { model: 'cohere-rerank-3.5', rankFields: ['chunk_text'] },
  } as any;

  it('refuses the whole call when one target is denied, before any request', async () => {
    const client = stub({}, { a: indexPayload('a'), b: indexPayload('b') });
    await assert.rejects(
      () => opCascadingSearch(client, KEY, loaded({ allowedIndexes: ['a'] }), args, log),
      /one ranking fused across every index/,
    );
    assert.deepEqual(client.calls, []);
  });

  it('reranks the deduplicated union when every target is allowed', async () => {
    const client = stub({}, { a: indexPayload('a'), b: indexPayload('b') });
    const out = await opCascadingSearch(client, KEY, loaded(), args, log);
    // Both searches return the same _id, so the union is one record.
    assert.match(out, /1 unique record\(s\) from 2 index\(es\)/);
    assert.ok(client.calls.includes('rerank'));
  });

  it('labels a result PARTIAL when an index fails at the API', async () => {
    // A network failure is not a policy decision, so the other indexes are
    // still searched — but the result must say what is missing.
    let n = 0;
    const client = stub(
      {
        searchRecords: async () => {
          n += 1;
          if (n === 1) throw new Error('upstream exploded');
          return { result: { hits: [{ _id: 'r2', fields: {} }] } };
        },
      },
      { a: indexPayload('a'), b: indexPayload('b') },
    );
    const out = await opCascadingSearch(client, KEY, loaded(), args, log);
    assert.match(out, /PARTIAL RESULT/);
    assert.match(out, /upstream exploded/);
  });

  it('throws rather than returning an empty ranking when nothing could be reached', async () => {
    const client = stub(
      { searchRecords: async () => { throw new Error('down'); } },
      { a: indexPayload('a'), b: indexPayload('b') },
    );
    await assert.rejects(() => opCascadingSearch(client, KEY, loaded(), args, log), /reached none of the requested/);
  });
});

describe('opCreateIndexForModel', () => {
  const args = {
    name: 'fresh',
    cloud: 'aws',
    region: 'us-east-1',
    embed: { model: 'multilingual-e5-large', fieldMap: { text: 'chunk_text' } },
  } as any;

  it('creates and reports the embedded field', async () => {
    const client = stub({ listIndexes: async () => [] });
    const out = await opCreateIndexForModel(client, KEY, loaded(), args, log);
    assert.match(out, /Created index "fresh"/);
    assert.match(out, /chunk_text/);
  });

  it('returns the existing index instead of erroring on a duplicate name', async () => {
    const client = stub({ listIndexes: async () => [indexPayload('fresh')] });
    const out = await opCreateIndexForModel(client, KEY, loaded(), args, log);
    assert.match(out, /already exists/);
    assert.ok(!client.calls.includes('create'));
  });

  it('is REFUSED by read-only before any API call', async () => {
    const client = stub({ listIndexes: async () => [] });
    await assert.rejects(
      () => opCreateIndexForModel(client, KEY, loaded({ readOnly: true }), args, log),
      /read-only/,
    );
    assert.deepEqual(client.calls, []);
  });

  it('is refused when the rules cannot be read — the write gate fails closed', async () => {
    const client = stub({ listIndexes: async () => [] });
    await assert.rejects(
      () => opCreateIndexForModel(client, KEY, unavailable, args, log),
      /temporary failure, not a configured restriction/,
    );
    assert.deepEqual(client.calls, []);
  });
});

describe('opUpsertRecords', () => {
  const args = {
    name: 'docs',
    namespace: 'hr',
    records: [{ _id: 'a', chunk_text: 'hello' }],
  } as any;

  it('accepts records and does NOT claim they are indexed', async () => {
    const client = stub({}, { docs: indexPayload('docs') });
    const out = await opUpsertRecords(client, KEY, loaded(), args, log);
    assert.match(out, /Accepted 1 record\(s\)/);
    // Embedding is asynchronous; "indexed" would start a bug hunt.
    assert.doesNotMatch(out, /records indexed/);
    assert.match(out, /take a few seconds to be embedded/);
  });

  it('names the namespace and the embedded field', async () => {
    const client = stub({}, { docs: indexPayload('docs') });
    const out = await opUpsertRecords(client, KEY, loaded(), args, log);
    assert.match(out, /"hr"/);
    assert.match(out, /chunk_text/);
  });

  it('renders the default namespace by name, not as an empty string', async () => {
    const client = stub({}, { docs: indexPayload('docs') });
    const out = await opUpsertRecords(client, KEY, loaded(), { ...args, namespace: '' }, log);
    assert.match(out, /\(default namespace\)/);
  });

  it('is refused by read-only before the index is even resolved', async () => {
    const client = stub({}, { docs: indexPayload('docs') });
    await assert.rejects(() => opUpsertRecords(client, KEY, loaded({ readOnly: true }), args, log), /read-only/);
    assert.deepEqual(client.calls, []);
  });

  it('refuses a record missing the text field, sending nothing', async () => {
    const client = stub({}, { docs: indexPayload('docs') });
    await assert.rejects(
      () => opUpsertRecords(client, KEY, loaded(), { ...args, records: [{ _id: 'a', text: 'x' }] }, log),
      /missing the text field "chunk_text"/,
    );
    assert.ok(!client.calls.includes('upsert'));
  });

  it('refuses an over-size batch even though the Zod schema also caps it', async () => {
    const client = stub({}, { docs: indexPayload('docs') });
    const records = Array.from({ length: 1001 }, (_, i) => ({ _id: `r${i}`, chunk_text: 'x' }));
    await assert.rejects(
      () => opUpsertRecords(client, KEY, loaded(), { ...args, records }, log),
      /per-request limit of 1000/,
    );
    assert.ok(!client.calls.includes('upsert'));
  });

  it('refuses a document index before writing to it', async () => {
    const client = stub({}, { docs: indexPayload('docs', 'document') });
    await assert.rejects(() => opUpsertRecords(client, KEY, loaded(), args, log), /document index/);
    assert.ok(!client.calls.includes('upsert'));
  });

  it('skips the per-record check when the index kind is unknown', async () => {
    // We do not know the field name there, so refusing would be a guess.
    const mystery = { name: 'm', host: 'm.svc.pinecone.io', status: { ready: true }, schema: { fields: { b: { type: 'widget' } } } };
    const client = stub({}, { m: mystery });
    const out = await opUpsertRecords(client, KEY, loaded(), { ...args, name: 'm', records: [{ _id: 'a' }] }, log);
    assert.match(out, /Accepted 1 record\(s\)/);
  });
});
