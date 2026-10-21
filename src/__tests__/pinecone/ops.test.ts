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
  formatScore,
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
      // Pinecone keys the default namespace as __default__, not ''.
      return { namespaces: { __default__: { recordCount: 2 }, hr: { recordCount: 3 } }, totalRecordCount: 5 };
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

  it('matches a __default__ key from Pinecone against a rule saved as ""', async () => {
    // The read-path half of the namespace bug: stats come back keyed
    // __default__, while a rule saved before the fix holds ''. If those did
    // not canonicalise, the user's own default-namespace rule would hide the
    // namespace it was written to allow.
    const client = stub({}, { docs: indexPayload('docs') });
    const out = await opDescribeIndexStats(client, KEY, loaded({ allowedNamespaces: [''] }), { name: 'docs' }, log);
    assert.match(out, /\(default namespace\): 2 record\(s\)/);
    assert.doesNotMatch(out, /"hr"/);
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

  it('keeps the SAME _id from two different targets — they are different records', async () => {
    // The data-loss bug this replaced: dedup keyed on `_id` alone kept one of
    // them and discarded the other silently. Ids are unique only WITHIN a
    // namespace, so "a1" in two places is two records with different text.
    let sent: any;
    const client = stub(
      {
        rerank: async (input: any) => { sent = input; return { data: [] }; },
        searchRecords: async () => ({ result: { hits: [{ _id: 'a1', fields: { chunk_text: 'x' } }] } }),
      },
      { a: indexPayload('a'), b: indexPayload('b') },
    );
    const out = await opCascadingSearch(client, KEY, loaded(), args, log);
    assert.equal(sent.documents.length, 2, 'both records must survive dedup');
    assert.match(out, /2 unique record\(s\) from 2 of 2 target\(s\)/);
  });

  it('collapses a genuine duplicate — the same record seen twice', async () => {
    // Same index, same namespace, same id: one record, correctly deduped.
    let sent: any;
    const client = stub(
      {
        rerank: async (input: any) => { sent = input; return { data: [] }; },
        searchRecords: async () => ({ result: { hits: [{ _id: 'a1', fields: {} }, { _id: 'a1', fields: {} }] } }),
      },
      { a: indexPayload('a') },
    );
    await opCascadingSearch(client, KEY, loaded(), {
      ...args, indexes: [{ name: 'a', namespace: 'hr' }],
    } as any, log);
    assert.equal(sent.documents.length, 1);
  });

  it('tells each hit apart by naming its source index and namespace', async () => {
    // Without this the caller cannot tell WHICH a1 survived.
    const client = stub(
      {
        rerank: async (input: any) => ({
          data: input.documents.map((d: any, i: number) => ({ index: i, score: 1 - i * 0.1, document: d })),
        }),
        searchRecords: async () => ({ result: { hits: [{ _id: 'a1', fields: { chunk_text: 'x' } }] } }),
      },
      { a: indexPayload('a'), b: indexPayload('b') },
    );
    const out = await opCascadingSearch(client, KEY, loaded(), args, log);
    assert.match(out, /from "a" \/ "hr"/);
    assert.match(out, /from "b" \/ "hr"/);
  });

  it('renders a numbered list, not the raw rerank payload', async () => {
    // The raw payload exposed Pinecone's internal `index` field — the position
    // in an array the caller never saw, easily misread as the Pinecone index.
    const client = stub(
      {
        rerank: async (input: any) => ({
          data: [{ index: 0, score: 0.9, document: input.documents[0] }],
        }),
        searchRecords: async () => ({ result: { hits: [{ _id: 'a1', fields: { chunk_text: 'x' } }] } }),
      },
      { a: indexPayload('a') },
    );
    const out = await opCascadingSearch(client, KEY, loaded(), {
      ...args, indexes: [{ name: 'a', namespace: 'hr' }],
    } as any, log);
    assert.match(out, /^1\. a1 \(score 0\.9000\)/m);
    assert.doesNotMatch(out, /"index":/);
    // The internal bookkeeping fields must not leak into the rendered body.
    assert.doesNotMatch(out, /_namespace/);
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
    // The count must agree with the warning beside it: one target was
    // searched, not two. Saying "from 2 target(s)" overstated the coverage of
    // a ranking the same output calls partial.
    assert.match(out, /from 1 of 2 target\(s\)/);
  });

  it('sends _id with each document, so the ranking can say WHICH record ranked', async () => {
    // Pinecone's rerank reply refers to its inputs by array position, and the
    // caller never sees the array built here — without the id the result
    // cannot identify a single record, which is the one question this tool
    // answers. Two hits with identical fields would also be indistinguishable.
    let sent: any;
    const client = stub(
      {
        rerank: async (input: any) => { sent = input; return { data: [] }; },
        searchRecords: async () => ({ result: { hits: [{ _id: 'rec-7', fields: { chunk_text: 'hello' } }] } }),
      },
      { a: indexPayload('a'), b: indexPayload('b') },
    );
    await opCascadingSearch(client, KEY, loaded(), args, log);
    // Two targets each return rec-7, and those are two DIFFERENT records —
    // see the dedup test above. Both carry the id.
    assert.equal(sent.documents.length, 2);
    assert.equal(sent.documents[0]._id, 'rec-7');
    // The stored fields must still be there beside it.
    assert.equal(sent.documents[0].chunk_text, 'hello');
  });

  it('throws rather than returning an empty ranking when nothing could be reached', async () => {
    const client = stub(
      { searchRecords: async () => { throw new Error('down'); } },
      { a: indexPayload('a'), b: indexPayload('b') },
    );
    await assert.rejects(() => opCascadingSearch(client, KEY, loaded(), args, log), /reached none of the 2 requested target\(s\)/);
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

// ---------------------------------------------------------------------------
// The reported cascading-search bug and its neighbours.
//
// The report: one cascading call returned 4 records, all from ns-a, and said
// "from 2 of 2 target(s)" while ns-b — which held 3 records and returned all
// of them when searched alone — contributed nothing. It did not reproduce.
// Four things come out of that, each tested below: an unreadable sub-search
// must not be counted as an empty one, an empty one must be visible, a missing
// index must be named, and a score that rounds to 0.0000 must not hide the
// ordering.
// ---------------------------------------------------------------------------

describe('cascading-search: a sub-search that contributed nothing', () => {
  const args = {
    indexes: [{ name: 'a', namespace: 'ns-a' }, { name: 'b', namespace: 'ns-b' }],
    query: { topK: 5, inputs: { text: 'q' } },
    rerank: { model: 'cohere-rerank-3.5', rankFields: ['chunk_text'] },
  } as any;

  /** Hits for `a`, nothing for `b` — the exact shape of the report. */
  function lopsided(extra: Record<string, any> = {}) {
    return stub(
      {
        searchRecords: async (_host: string, namespace: string) =>
          namespace === 'ns-a'
            ? { result: { hits: [{ _id: 'a1', fields: { chunk_text: 'x' } }] } }
            : { result: { hits: [] } },
        rerank: async (input: any) => ({
          data: input.documents.map((d: any, i: number) => ({ index: i, score: 1 - i * 0.1, document: d })),
        }),
        ...extra,
      },
      { a: indexPayload('a'), b: indexPayload('b') },
    );
  }

  it('reports what EACH target contributed, not just how many were searched', async () => {
    // "from 2 of 2 target(s)" was true and useless: both were searched, one
    // gave nothing, and the output read as covering both.
    const out = await opCascadingSearch(lopsided(), KEY, loaded(), args, log);
    assert.match(out, /Per-target contribution:/);
    assert.match(out, /- "a" \/ "ns-a": 1 record\(s\)/);
    assert.match(out, /- "b" \/ "ns-b": 0 record\(s\) — searched, nothing matched/);
  });

  it('names the empty target and says how it was counted', async () => {
    const out = await opCascadingSearch(lopsided(), KEY, loaded(), args, log);
    assert.match(out, /returned NO records: "b" \/ "ns-b"/);
    assert.match(out, /count as searched rather than failed/);
    // And it points at the one call that settles whether that is real.
    assert.match(out, /run search-records against that one target/);
  });

  it('does not emit the empty-target note when EVERY target was empty', async () => {
    // The "no matching records" line already says it; per-target repetition
    // would be noise.
    const client = stub(
      { searchRecords: async () => ({ result: { hits: [] } }) },
      { a: indexPayload('a'), b: indexPayload('b') },
    );
    const out = await opCascadingSearch(client, KEY, loaded(), args, log);
    assert.match(out, /No matching records across 2 of 2 target\(s\)/);
    assert.doesNotMatch(out, /returned NO records:/);
    // The per-target block still goes out: "both empty" and "one empty, one
    // unreachable" are different situations.
    assert.match(out, /Per-target contribution:/);
  });

  it('treats an UNREADABLE sub-search as a failure, never as zero hits', async () => {
    // The root cause. jsonApiRequest resolves to undefined for a 204 and for
    // any non-JSON 2xx, and `res?.result?.hits ?? []` turned that into a
    // legitimate empty search — which is how a target counted as searched
    // while silently contributing nothing.
    const client = stub(
      {
        searchRecords: async (_host: string, namespace: string) =>
          namespace === 'ns-a'
            ? { result: { hits: [{ _id: 'a1', fields: { chunk_text: 'x' } }] } }
            : undefined,
        rerank: async (input: any) => ({
          data: input.documents.map((d: any, i: number) => ({ index: i, score: 0.5, document: d })),
        }),
      },
      { a: indexPayload('a'), b: indexPayload('b') },
    );
    const out = await opCascadingSearch(client, KEY, loaded(), args, log);
    assert.match(out, /PARTIAL RESULT/);
    assert.match(out, /from 1 of 2 target\(s\)/);
    assert.match(out, /- "b" \/ "ns-b": NOT SEARCHED — see the PARTIAL RESULT note above/);
    // The reason is in the banner, printed ONCE — these messages are several
    // sentences long and repeating each one buries the contribution column.
    assert.match(out, /no readable JSON body/);
    assert.equal(out.split('no readable JSON body').length - 1, 1);
    // The thing that must NOT happen: being rendered as a successful search.
    assert.doesNotMatch(out, /"b" \/ "ns-b": 0 record\(s\) — searched/);
  });

  it('treats a response missing the result envelope as a failure too', async () => {
    const client = stub(
      { searchRecords: async () => ({ usage: { readUnits: 1 } }) },
      { a: indexPayload('a'), b: indexPayload('b') },
    );
    await assert.rejects(
      () => opCascadingSearch(client, KEY, loaded(), args, log),
      /reached none of the 2 requested target\(s\)/,
    );
  });

  it('separates duplicates collapsed from nothing returned', async () => {
    const client = stub(
      {
        searchRecords: async () => ({
          result: { hits: [{ _id: 'a1', fields: {} }, { _id: 'a1', fields: {} }] },
        }),
        rerank: async () => ({ data: [] }),
      },
      { a: indexPayload('a') },
    );
    const out = await opCascadingSearch(
      client, KEY, loaded(), { ...args, indexes: [{ name: 'a', namespace: 'ns-a' }] } as any, log,
    );
    assert.match(out, /1 record\(s\) \(2 hit\(s\), 1 duplicate\(s\) collapsed\)/);
  });

  it('still answers when one target fails and the other legitimately has nothing', async () => {
    // The old guard threw "reached none of the 2 targets" here, which was
    // false: one target WAS reached and reported, with evidence, that it holds
    // no match.
    const client = stub(
      {
        searchRecords: async (_host: string, namespace: string) => {
          if (namespace === 'ns-b') throw new Error('upstream exploded');
          return { result: { hits: [] } };
        },
      },
      { a: indexPayload('a'), b: indexPayload('b') },
    );
    const out = await opCascadingSearch(client, KEY, loaded(), args, log);
    assert.match(out, /PARTIAL RESULT/);
    assert.match(out, /No matching records across 1 of 2 target\(s\)/);
  });
});

describe('cascading-search: a missing index is named', () => {
  const args = {
    indexes: [{ name: 'a', namespace: 'ns-a' }, { name: 'typo', namespace: 'ns-a' }],
    query: { topK: 5, inputs: { text: 'q' } },
    rerank: { model: 'cohere-rerank-3.5', rankFields: ['chunk_text'] },
  } as any;

  it('says WHICH index could not be resolved', async () => {
    // Promise.all rejected with whichever describe lost the race, and that
    // error carries no index name — so a four-index call with one typo said
    // "no index by that name" without ever saying which name.
    const client = stub({}, { a: indexPayload('a') });
    await assert.rejects(
      () => opCascadingSearch(client, KEY, loaded(), args, log),
      (err: Error) => {
        assert.match(err.message, /"typo"/);
        assert.match(err.message, /no index by that name exists/);
        // And which ones were fine, so the caller can see the shape of it.
        assert.match(err.message, /These resolved fine: "a"/);
        assert.doesNotMatch(err.message, /NOT SEARCHED/);
        return true;
      },
    );
    assert.ok(!client.calls.includes('search'), 'nothing is searched when a name will not resolve');
  });

  it('distinguishes a forbidden index from a missing one', async () => {
    // A key is scoped to one project, so an index in another project reads as
    // 403 rather than 404 — different problem, different fix.
    const client = stub(
      {
        describeIndex: async (name: string) => {
          if (name === 'a') return indexPayload('a');
          const e: any = new Error('forbidden');
          e.status = 403;
          throw e;
        },
      },
      { a: indexPayload('a') },
    );
    await assert.rejects(
      () => opCascadingSearch(client, KEY, loaded(), args, log),
      /scoped to one project/,
    );
  });
});

describe('rerank.topN above the candidate pool', () => {
  const base = {
    indexes: [{ name: 'a', namespace: 'ns-a' }],
    query: { topK: 5, inputs: { text: 'q' } },
    rerank: { model: 'cohere-rerank-3.5', rankFields: ['chunk_text'], topN: 50 },
  } as any;

  it('says a topN above the candidates does nothing, and names the parameter that would help', async () => {
    const client = stub(
      {
        searchRecords: async () => ({ result: { hits: [{ _id: 'a1', fields: { chunk_text: 'x' } }] } }),
        rerank: async (input: any) => ({ data: [{ index: 0, score: 0.9, document: input.documents[0] }] }),
      },
      { a: indexPayload('a') },
    );
    const out = await opCascadingSearch(client, KEY, loaded(), base, log);
    assert.match(out, /rerank\.topN is 50 but only 1 candidate record\(s\) reached the reranker/);
    assert.match(out, /raise query\.topK/);
  });

  it('stays silent when topN is reachable', async () => {
    const client = stub(
      {
        searchRecords: async () => ({ result: { hits: [{ _id: 'a1', fields: { chunk_text: 'x' } }] } }),
        rerank: async (input: any) => ({ data: [{ index: 0, score: 0.9, document: input.documents[0] }] }),
      },
      { a: indexPayload('a') },
    );
    const out = await opCascadingSearch(client, KEY, loaded(), { ...base, rerank: { ...base.rerank, topN: 1 } } as any, log);
    assert.doesNotMatch(out, /reached the reranker/);
  });

  it('warns on search-records too, where topK is the only cap', async () => {
    const client = stub({}, { docs: indexPayload('docs') });
    const out = await opSearchRecords(client, KEY, loaded(), {
      name: 'docs',
      namespace: 'hr',
      query: { topK: 5, inputs: { text: 'q' } },
      rerank: { model: 'cohere-rerank-3.5', rankFields: ['chunk_text'], topN: 40 },
    } as any, log);
    assert.match(out, /rerank\.topN is 40 but only 1 candidate record\(s\)/);
  });
});

describe('score rendering', () => {
  it('keeps a tiny score distinguishable instead of printing 0.0000', async () => {
    // Pinecone's reranker returns the tail of a ranking in the 1e-5 range,
    // where toFixed(4) renders every row as the identical 0.0000 — hiding
    // both the ordering and that the tail was scored at all.
    const client = stub(
      {
        searchRecords: async () => ({
          result: {
            hits: [
              { _id: 'hi', _score: 0.8123456, fields: {} },
              { _id: 'lo', _score: 0.0000241, fields: {} },
              { _id: 'lower', _score: 0.0000193, fields: {} },
            ],
          },
        }),
      },
      { docs: indexPayload('docs') },
    );
    const out = await opSearchRecords(client, KEY, loaded(), {
      name: 'docs', namespace: 'hr', query: { topK: 10, inputs: { text: 'q' } },
    } as any, log);
    // The ordinary score keeps the rendering it has always had.
    assert.match(out, /hi \(score 0\.8123\)/);
    // The tail does not collapse.
    assert.match(out, /lo \(score 2\.41e-5\)/);
    assert.match(out, /lower \(score 1\.93e-5\)/);
    assert.doesNotMatch(out, /0\.0000\)/);
  });

  it('prints an exact zero as 0, not as a measurement', async () => {
    assert.equal(formatScore(0), '0');
    assert.equal(formatScore(0.5), '0.5000');
    assert.equal(formatScore(0.001), '0.0010');
  });
});

describe('create-index-for-model on an existing name', () => {
  const args = {
    name: 'docs',
    cloud: 'aws',
    region: 'us-east-1',
    embed: { model: 'llama-text-embed-v2', fieldMap: { text: 'body' } },
  } as any;

  it('WARNS when the existing index embeds a different model and field', async () => {
    // "already exists" alone reported a success: the caller asked for
    // llama-text-embed-v2 embedding `body` and silently got an index embedding
    // `chunk_text` with multilingual-e5-large, then upserts records that are
    // refused for a missing field. Neither can be changed after creation.
    const client = stub({ listIndexes: async () => [indexPayload('docs')] });
    const out = await opCreateIndexForModel(client, KEY, loaded(), args, log);
    assert.match(out, /already exists/);
    assert.match(out, /WARNING/);
    assert.match(out, /you asked for "llama-text-embed-v2", the existing index uses "multilingual-e5-large"/);
    assert.match(out, /you asked for "body", the existing index embeds "chunk_text"/);
    assert.match(out, /Nothing was created or modified/);
    assert.ok(!client.calls.includes('create'));
  });

  it('stays quiet when the existing index matches the request', async () => {
    const client = stub({ listIndexes: async () => [indexPayload('docs')] });
    const out = await opCreateIndexForModel(client, KEY, loaded(), {
      ...args, embed: { model: 'multilingual-e5-large', fieldMap: { text: 'chunk_text' } },
    } as any, log);
    assert.match(out, /already exists/);
    assert.doesNotMatch(out, /WARNING/);
  });

  it('calls out an existing index with no integrated embedding at all', async () => {
    const client = stub({ listIndexes: async () => [indexPayload('docs', 'vectors')] });
    const out = await opCreateIndexForModel(client, KEY, loaded(), args, log);
    assert.match(out, /NO integrated-embedding configuration/);
  });
});
