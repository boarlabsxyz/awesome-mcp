// src/pinecone/ops.ts
// One exported function per tool body, so they can be driven directly against
// a stubbed client in tests. server.ts keeps the descriptions, annotations and
// schemas; this file keeps the behaviour. Same split as src/redmine/ops.ts and
// src/browserbase/ops.ts.
//
// Every op takes the already-resolved rules state rather than a session, so
// the access-rule policy is exercised by the same tests that exercise the
// behaviour — the one piece of I/O (reading providerTokens) stays in server.ts.

import { UserError } from 'fastmcp';
import type { z } from 'zod';

import {
  type PineconeRulesState,
  assertIndexAllowed,
  assertNamespaceAllowed,
  assertTargetsAllowed,
  assertWriteAllowed,
  describeNamespace,
  describeRules,
  filterIndexRows,
  filterNamespaceStats,
} from './accessRules.js';
import type {
  PineconeClient,
  PineconeIndexSummary,
  PineconeSearchHit,
  PineconeToolLog,
} from './apiHelpers.js';
import { searchPineconeDocs } from './docsProxy.js';
import { primeIndexCache, resolveIndexes, withResolvedIndex } from './indexCatalog.js';
import {
  type IndexKindVerdict,
  assertRecordsApiUsable,
  classifyIndex,
  assertRecordsCarryTextField,
  assertUpsertBatchSize,
  assertUpsertBodySize,
  buildUpsertNdjson,
  explainRecordsApiFailure,
} from './indexKind.js';
import type {
  cascadingSearchSchema,
  createIndexForModelSchema,
  describeIndexSchema,
  describeIndexStatsSchema,
  rerankDocumentsSchema,
  searchDocsSchema,
  searchRecordsSchema,
  upsertRecordsSchema,
} from './schemas.js';

/**
 * Newly upserted records are embedded asynchronously, so recent writes may not
 * be visible yet. Said in one place so the wording cannot drift between the
 * three tools that need it.
 */
const FRESHNESS_NOTE =
  'Newly upserted records take a few seconds to be embedded and indexed, so they may not appear in searches or stats immediately. If recent data is missing, wait briefly and retry.';

/** Append the access-rules line when there is one. */
function withRulesNote(body: string, state: PineconeRulesState): string {
  const note = state.status === 'loaded' ? describeRules(state.rules) : undefined;
  return note ? `${body}\n\n${note}` : body;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// ---------------------------------------------------------------------------
// Index discovery
// ---------------------------------------------------------------------------

function formatIndexRow(index: PineconeIndexSummary): string {
  const bits = [
    `- ${index.name}`,
    index.status?.ready === false ? '(not ready)' : null,
    index.dimension ? `dim ${index.dimension}` : null,
    index.metric ? `metric ${index.metric}` : null,
    index.embed?.model ? `model ${index.embed.model}` : null,
  ].filter(Boolean);
  return bits.join(' · ');
}

/** Body of `list-indexes`. */
export async function opListIndexes(
  client: PineconeClient,
  state: PineconeRulesState,
  log: PineconeToolLog,
): Promise<string> {
  log.info('Listing Pinecone indexes');
  const all = await client.listIndexes();
  const { visible, note } = filterIndexRows(state, all);

  if (!visible.length) {
    // An empty list after filtering is NOT the same as an empty project, and
    // saying "no indexes" for the first would be the exact Slack trap the
    // filter note exists to close.
    const body = note
      ? `No indexes are visible to this connection.\n\n${note}`
      : 'This Pinecone project has no indexes. Create one with create-index-for-model.';
    return withRulesNote(body, state);
  }

  const lines = visible.map(formatIndexRow).join('\n');
  const header = `${visible.length} index(es):`;
  const body = note ? `${header}\n${lines}\n\n${note}` : `${header}\n${lines}`;
  return withRulesNote(`${body}\n\n${json(visible)}`, state);
}

/**
 * Body of `describe-index`.
 *
 * This is also the diagnose path: a name the index rules hide answers with the
 * DENIAL rather than a 404, which is the second half of closing the Slack trap
 * in filterIndexRows and is why this connector needs no tenth "why can't I see
 * X" tool. The refusal is decided from the rules alone, before any Pinecone
 * call, so a name that exists nowhere gets the identical answer — the message
 * says so, to stop a reader treating a denial as confirmation of existence.
 */
export async function opDescribeIndex(
  client: PineconeClient,
  state: PineconeRulesState,
  args: z.infer<typeof describeIndexSchema>,
  log: PineconeToolLog,
): Promise<string> {
  assertIndexAllowed(state, args.name);
  log.info(`Describing Pinecone index ${args.name}`);
  const index = await client.describeIndex(args.name);
  const kindNote = kindSummary(index);
  return withRulesNote(`${kindNote}\n\n${json(index)}`, state);
}

/** A one-line statement of what kind of index this is, for describe-index. */
function kindSummary(index: PineconeIndexSummary): string {
  const verdict: IndexKindVerdict = classifyIndex(index);
  switch (verdict.kind) {
    case 'legacy-integrated':
      return `Index "${index.name}" is an integrated-embedding index — search-records and upsert-records work against it. It embeds the field "${verdict.textField}" (${verdict.evidence}).`;
    case 'document':
      return `Index "${index.name}" is a document index (${verdict.evidence}). search-records and upsert-records do NOT work against it: they use Pinecone's legacy Records API, which a document index rejects. This connector does not call the Documents API.`;
    case 'vectors':
      return `Index "${index.name}" is a vectors index (${verdict.evidence}). search-records and upsert-records do NOT work against it — there is no embedding model attached, so there is nothing to turn query text into a vector.`;
    default:
      return `Index "${index.name}": this connector could not determine the index type (${verdict.evidence}). search-records and upsert-records will be attempted anyway and Pinecone will decide.`;
  }
}

/** Body of `describe-index-stats`. */
export async function opDescribeIndexStats(
  client: PineconeClient,
  apiKey: string,
  state: PineconeRulesState,
  args: z.infer<typeof describeIndexStatsSchema>,
  log: PineconeToolLog,
): Promise<string> {
  assertIndexAllowed(state, args.name);
  log.info(`Reading Pinecone index stats for ${args.name}`);

  const stats = await withResolvedIndex(client, apiKey, args.name, resolved =>
    client.describeIndexStats(resolved.host),
  );

  const namespaces = (stats?.namespaces ?? {}) as Record<string, { recordCount?: number; vectorCount?: number }>;
  const { visible, note } = filterNamespaceStats(state, namespaces);

  const rows = Object.entries(visible)
    .map(([ns, v]) => `- ${describeNamespace(ns)}: ${v?.recordCount ?? v?.vectorCount ?? 0} record(s)`)
    .join('\n');

  const total = stats?.totalRecordCount ?? stats?.totalVectorCount;
  const lines = [
    `Index "${args.name}"${total !== undefined ? ` — ${total} record(s) in total` : ''}:`,
    rows || '  (no namespaces visible)',
    note ?? null,
    FRESHNESS_NOTE,
  ]
    .filter(Boolean)
    .join('\n\n');

  return withRulesNote(lines, state);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function formatHits(hits: PineconeSearchHit[]): string {
  if (!hits.length) return 'No matching records.';
  return hits
    .map((h, i) => {
      const score = typeof h._score === 'number' ? ` (score ${h._score.toFixed(4)})` : '';
      return `${i + 1}. ${h._id}${score}\n${json(h.fields ?? {})}`;
    })
    .join('\n\n');
}

/**
 * Run a Records search, converting an upstream 400 on an index we could not
 * classify into a message that names the real cause.
 */
async function searchOne(
  client: PineconeClient,
  apiKey: string,
  indexName: string,
  namespace: string,
  query: z.infer<typeof searchRecordsSchema>['query'],
  rerank: z.infer<typeof searchRecordsSchema>['rerank'],
): Promise<PineconeSearchHit[]> {
  return withResolvedIndex(client, apiKey, indexName, async resolved => {
    assertRecordsApiUsable(resolved.verdict, indexName, 'search');
    try {
      const res = await client.searchRecords(resolved.host, namespace, query, rerank);
      return res?.result?.hits ?? [];
    } catch (error: any) {
      if (error?.status === 400 && resolved.verdict.kind === 'unknown') {
        throw new UserError(
          explainRecordsApiFailure(resolved.verdict, indexName, 'search', error?.message ?? 'no detail'),
        );
      }
      throw error;
    }
  });
}

/** Body of `search-records`. */
export async function opSearchRecords(
  client: PineconeClient,
  apiKey: string,
  state: PineconeRulesState,
  args: z.infer<typeof searchRecordsSchema>,
  log: PineconeToolLog,
): Promise<string> {
  assertIndexAllowed(state, args.name);
  assertNamespaceAllowed(state, args.name, args.namespace);
  log.info(`Searching Pinecone index ${args.name} namespace ${describeNamespace(args.namespace)}`);

  const hits = await searchOne(client, apiKey, args.name, args.namespace, args.query, args.rerank);
  const header = `${hits.length} hit(s) in "${args.name}" / ${describeNamespace(args.namespace)}${
    args.rerank ? `, reranked with ${args.rerank.model}` : ''
  }:`;
  const body = hits.length ? `${header}\n\n${formatHits(hits)}` : `${header}\n\n${FRESHNESS_NOTE}`;
  return withRulesNote(body, state);
}

/**
 * Body of `cascading-search`.
 *
 * Every target is checked against the rules BEFORE any request goes out, and
 * one denial refuses the whole call — see assertTargetsAllowed for why a
 * dropped source cannot be honestly labelled in a fused ranking.
 *
 * An index that fails at the API, as opposed to one the rules deny, is a
 * different matter: those are collected and REPORTED alongside the result,
 * because a network failure is not a policy decision and refusing everything
 * for one flaky index would be worse than saying which one was missing. The
 * result still says so in its first line, so it is never read as complete.
 */
export async function opCascadingSearch(
  client: PineconeClient,
  apiKey: string,
  state: PineconeRulesState,
  args: z.infer<typeof cascadingSearchSchema>,
  log: PineconeToolLog,
): Promise<string> {
  assertTargetsAllowed(
    state,
    args.indexes.map(i => ({ index: i.name, namespace: i.namespace })),
  );
  log.info(`Cascading search across ${args.indexes.length} Pinecone index(es)`);

  // Resolve first so a bad index name fails before any search runs.
  await resolveIndexes(client, apiKey, args.indexes.map(i => i.name));

  const settled = await Promise.allSettled(
    args.indexes.map(target =>
      searchOne(client, apiKey, target.name, target.namespace, args.query, undefined),
    ),
  );

  const failures: string[] = [];
  const hits: PineconeSearchHit[] = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === 'fulfilled') hits.push(...outcome.value);
    else {
      const t = args.indexes[i];
      failures.push(`"${t.name}" / ${describeNamespace(t.namespace)}: ${outcome.reason?.message ?? outcome.reason}`);
    }
  });

  if (!hits.length && failures.length) {
    throw new UserError(
      `cascading-search reached none of the requested indexes:\n${failures.map(f => `  - ${f}`).join('\n')}`,
    );
  }

  // Deduplicate by record id, keeping the first occurrence. The reranker then
  // scores the union, which is the whole point of this tool over N searches.
  const byId = new Map<string, Record<string, unknown>>();
  for (const hit of hits) if (!byId.has(hit._id)) byId.set(hit._id, (hit.fields ?? {}) as Record<string, unknown>);
  const documents = [...byId.values()];

  if (!documents.length) {
    return withRulesNote(`No matching records across ${args.indexes.length} index(es).\n\n${FRESHNESS_NOTE}`, state);
  }

  const reranked = await client.rerank({
    model: args.rerank.model,
    query: args.rerank.query || args.query.inputs.text,
    documents,
    topN: args.rerank.topN ?? args.query.topK,
    rankFields: args.rerank.rankFields,
  });

  const warning = failures.length
    ? `PARTIAL RESULT — ${failures.length} of ${args.indexes.length} index(es) could not be searched, so this ranking is missing whatever they would have contributed:\n${failures
        .map(f => `  - ${f}`)
        .join('\n')}\n\n`
    : '';

  const header = `${documents.length} unique record(s) from ${args.indexes.length} index(es), reranked with ${args.rerank.model}:`;
  return withRulesNote(`${warning}${header}\n\n${json(reranked)}`, state);
}

/** Body of `rerank-documents`. Touches no index, so no index or namespace rule applies. */
export async function opRerankDocuments(
  client: PineconeClient,
  args: z.infer<typeof rerankDocumentsSchema>,
  log: PineconeToolLog,
): Promise<string> {
  log.info(`Reranking ${args.documents.length} document(s) with ${args.model}`);
  const res = await client.rerank({
    model: args.model,
    query: args.query,
    documents: args.documents as Array<Record<string, unknown>> | string[],
    topN: args.options?.topN,
    rankFields: args.options?.rankFields,
  });
  return json(res);
}

/** Body of `search-docs`. Needs no API key and touches no index. */
export async function opSearchDocs(
  args: z.infer<typeof searchDocsSchema>,
  log: PineconeToolLog,
): Promise<string> {
  log.info(`Searching the Pinecone documentation for "${args.query}"`);
  return searchPineconeDocs(args.query);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Body of `create-index-for-model`. */
export async function opCreateIndexForModel(
  client: PineconeClient,
  apiKey: string,
  state: PineconeRulesState,
  args: z.infer<typeof createIndexForModelSchema>,
  log: PineconeToolLog,
): Promise<string> {
  // FIRST statement, before any argument-dependent work: a denial then costs
  // no API call and cannot half-apply. See PINECONE_WRITE_TOOLS.
  assertWriteAllowed(state, 'create-index-for-model');
  assertIndexAllowed(state, args.name, { intent: 'create' });

  // Pinecone answers a duplicate name with a 409 whose body does not show what
  // the existing index looks like, which is the thing the caller needs in
  // order to decide whether to reuse it. Checking first costs one cheap list
  // call and turns the error into an answer.
  const existing = (await client.listIndexes()).find(i => i.name === args.name);
  if (existing) {
    return withRulesNote(
      `Index not created — an index named "${args.name}" already exists:\n\n${json(existing)}`,
      state,
    );
  }

  log.info(`Creating Pinecone index ${args.name} for model ${args.embed.model}`);
  const created = await client.createIndexForModel(args);
  // Seed the cache from the response, which is what removes the need for
  // negative caching: create-then-upsert is the obvious next step.
  primeIndexCache(apiKey, args.name, created);

  const ready = created?.status?.ready === true;
  const readiness = ready
    ? 'It is ready for upserts and searches.'
    : 'It is still initializing — call describe-index until status.ready is true before upserting.';

  return withRulesNote(
    `Created index "${args.name}" (${args.embed.model}, embedding the field "${args.embed.fieldMap.text}"). ${readiness}\n\n${json(created)}`,
    state,
  );
}

/**
 * Body of `upsert-records`.
 *
 * Everything that can be refused is refused before the first byte goes out,
 * because a Records upsert is NOT atomic across the body: a rejection part-way
 * through leaves the earlier records written with no rollback. The order is
 * write gate, rules, batch size, index kind, per-record fields, body size.
 */
export async function opUpsertRecords(
  client: PineconeClient,
  apiKey: string,
  state: PineconeRulesState,
  args: z.infer<typeof upsertRecordsSchema>,
  log: PineconeToolLog,
): Promise<string> {
  assertWriteAllowed(state, 'upsert-records');
  assertIndexAllowed(state, args.name);
  assertNamespaceAllowed(state, args.name, args.namespace);
  // Also enforced by the Zod schema; repeated here so a non-MCP caller cannot
  // route around it.
  assertUpsertBatchSize(args.records.length);

  // withResolvedIndex rather than a bare resolveIndex, and that is safe for a
  // WRITE for one specific reason: it retries only when the re-resolved host
  // DIFFERS from the one just used. A differing host means the failed request
  // went to a host that is no longer this index's, so it cannot have written
  // anything here — and when the host is unchanged it rethrows rather than
  // repeating the call. Without this, an index deleted and recreated between
  // calls answers with a stale-host error for the whole TTL window.
  const textField = await withResolvedIndex(client, apiKey, args.name, async resolved => {
    assertRecordsApiUsable(resolved.verdict, args.name, 'upsert');

    const field = resolved.verdict.textField;
    // Skipped when the kind is 'unknown': we do not know the field name there,
    // and guessing would be a refusal built on absence of evidence.
    if (field) assertRecordsCarryTextField(args.records, field, args.name);

    const { body, bytes } = buildUpsertNdjson(args.records);
    assertUpsertBodySize(bytes, args.records.length);

    log.info(`Upserting ${args.records.length} record(s) into ${args.name}/${describeNamespace(args.namespace)}`);

    try {
      await client.upsertRecords(resolved.host, args.namespace, body);
    } catch (error: any) {
      if (error?.status === 400 && resolved.verdict.kind === 'unknown') {
        throw new UserError(
          explainRecordsApiFailure(resolved.verdict, args.name, 'upsert', error?.message ?? 'no detail'),
        );
      }
      throw error;
    }
    return field;
  });

  // Synthesized: Pinecone answers 201 with an empty body. It must NOT claim
  // the records are indexed — integrated embedding is asynchronous, and a
  // search issued immediately after may legitimately not see them.
  const embedded = textField ? ` Pinecone is embedding the field "${textField}".` : '';
  return withRulesNote(
    `Accepted ${args.records.length} record(s) into "${args.name}" / ${describeNamespace(args.namespace)}.${embedded}\n\n${FRESHNESS_NOTE}`,
    state,
  );
}
