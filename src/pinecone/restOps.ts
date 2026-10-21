// src/pinecone/restOps.ts
// One `perform*` per REST route, returning DATA where ops.ts returns a rendered
// string. Same split as src/browserbase/restOps.ts: the route emits JSON, the
// MCP tool renders prose, and both reach the same upstream call through the
// same guards — so the two surfaces cannot ask Pinecone different questions.
//
// ---------------------------------------------------------------------------
// ACCESS RULES APPLY HERE TOO, and that is not optional. Every function takes
// the same PineconeRulesState the MCP tools take and runs the same assert*.
// A REST plane that skipped them would be a way to read an index the rules
// deny by swapping one client for another — the rules would be a property of
// the transport rather than of the connection, which is not what the dashboard
// promises.
//
// The read-only switch matters most: this plane accepts the PERMANENT
// dashboard API key, so a connection set read-only must refuse a curl exactly
// as it refuses a tool call.
// ---------------------------------------------------------------------------
//
// NAMESPACE LIVES IN THE BODY, NEVER IN THE PATH — a contract choice, not a
// constraint. The original justification was wrong: it held that the default
// namespace was the empty string and so could not be a path segment, when in
// fact Pinecone reserves `__default__` and refuses `''`. The body stays
// because a namespace belongs beside the filter and rerank options it is used
// with, and because moving it would break every existing caller.

import type { z } from 'zod';

import {
  type PineconeRulesState,
  assertIndexAllowed,
  assertNamespaceAllowed,
  assertTargetsAllowed,
  assertWriteAllowed,
  filterIndexRows,
  filterNamespaceStats,
} from './accessRules.js';
import type { PineconeClient, PineconeIndexSummary, PineconeSearchHit } from './apiHelpers.js';
import { searchPineconeDocs } from './docsProxy.js';
import { primeIndexCache, resolveIndexes, withResolvedIndex } from './indexCatalog.js';
import {
  assertRecordsApiUsable,
  assertRecordsCarryTextField,
  assertUpsertBatchSize,
  assertUpsertBodySize,
  buildUpsertNdjson,
  classifyIndex,
  explainRecordsApiFailure,
} from './indexKind.js';
import type {
  cascadingSearchSchema,
  createIndexForModelSchema,
  rerankDocumentsSchema,
  searchDocsSchema,
  searchRecordsSchema,
  upsertRecordsSchema,
} from './schemas.js';

/** What a route handler holds: the client, the key that scopes the index cache, and the rules. */
export interface PineconeRestContext {
  client: PineconeClient;
  apiKey: string;
  rules: PineconeRulesState;
}

/**
 * Said on every response that reports a count or a search, for the reason
 * ops.ts says it: integrated embedding is asynchronous, so a read immediately
 * after a write legitimately may not see it.
 */
const FRESHNESS_NOTE =
  'Newly upserted records take a few seconds to be embedded and indexed, so they may not appear in searches or stats immediately.';

export interface ListIndexesResult {
  indexes: PineconeIndexSummary[];
  /** How many the connection's index rules hid. Always present, so 0 is explicit. */
  hiddenByRules: number;
  /** Set only when something was hidden. States that the hidden indexes EXIST. */
  note?: string;
}

export async function performListIndexes(ctx: PineconeRestContext): Promise<ListIndexesResult> {
  const all = await ctx.client.listIndexes();
  const { visible, hiddenCount, note } = filterIndexRows(ctx.rules, all);
  return { indexes: visible, hiddenByRules: hiddenCount, ...(note ? { note } : {}) };
}

export interface DescribeIndexResult {
  index: PineconeIndexSummary;
  /** What kind of index this is, and the evidence — the thing a bare payload does not say. */
  kind: string;
  kindEvidence: string;
  /** The field upserts must populate. Present only on a supported index. */
  textField?: string;
  recordsApiUsable: boolean;
}

export async function performDescribeIndex(ctx: PineconeRestContext, indexName: string): Promise<DescribeIndexResult> {
  assertIndexAllowed(ctx.rules, indexName);
  const index = await ctx.client.describeIndex(indexName);
  const verdict = classifyIndex(index);
  return {
    index,
    kind: verdict.kind,
    kindEvidence: verdict.evidence,
    ...(verdict.textField ? { textField: verdict.textField } : {}),
    // 'unknown' is reported as usable because it is attempted — absence of
    // evidence is not a refusal. See indexKind.ts.
    recordsApiUsable: verdict.kind === 'legacy-integrated' || verdict.kind === 'unknown',
  };
}

export interface IndexStatsResult {
  index: string;
  namespaces: Record<string, unknown>;
  /** Exactly as Pinecone gave it — it counts hidden namespaces too. */
  totalRecordCount?: number;
  hiddenByRules: number;
  note?: string;
  freshness: string;
}

export async function performDescribeIndexStats(
  ctx: PineconeRestContext,
  indexName: string,
): Promise<IndexStatsResult> {
  assertIndexAllowed(ctx.rules, indexName);
  const stats = await withResolvedIndex(ctx.client, ctx.apiKey, indexName, resolved =>
    ctx.client.describeIndexStats(resolved.host),
  );
  const { visible, hiddenCount, note } = filterNamespaceStats(ctx.rules, (stats?.namespaces ?? {}) as Record<string, unknown>);
  return {
    index: indexName,
    namespaces: visible,
    totalRecordCount: stats?.totalRecordCount ?? stats?.totalVectorCount,
    hiddenByRules: hiddenCount,
    ...(note ? { note } : {}),
    freshness: FRESHNESS_NOTE,
  };
}

export interface SearchResult {
  index: string;
  namespace: string;
  hits: PineconeSearchHit[];
  freshness: string;
}

export async function performSearchRecords(
  ctx: PineconeRestContext,
  args: z.infer<typeof searchRecordsSchema>,
): Promise<SearchResult> {
  assertIndexAllowed(ctx.rules, args.name);
  assertNamespaceAllowed(ctx.rules, args.name, args.namespace);
  const hits = await searchOne(ctx, args.name, args.namespace, args.query, args.rerank);
  return { index: args.name, namespace: args.namespace, hits, freshness: FRESHNESS_NOTE };
}

/** Shared by the single-index and cascading paths so the guards cannot diverge. */
async function searchOne(
  ctx: PineconeRestContext,
  indexName: string,
  namespace: string,
  query: z.infer<typeof searchRecordsSchema>['query'],
  rerank: z.infer<typeof searchRecordsSchema>['rerank'],
): Promise<PineconeSearchHit[]> {
  return withResolvedIndex(ctx.client, ctx.apiKey, indexName, async resolved => {
    assertRecordsApiUsable(resolved.verdict, indexName, 'search');
    try {
      const res = await ctx.client.searchRecords(resolved.host, namespace, query, rerank);
      return res?.result?.hits ?? [];
    } catch (error: any) {
      if (error?.status === 400 && resolved.verdict.kind === 'unknown') {
        const err: any = new Error(explainRecordsApiFailure(resolved.verdict, indexName, 'search', error?.message ?? 'no detail'));
        err.status = 400;
        throw err;
      }
      throw error;
    }
  });
}

export interface CascadingSearchResult {
  /** How many targets were actually searched. Lower than targetsRequested exactly when `partial`. */
  indexesSearched: number;
  /** How many were asked for. Added so a client can see the shortfall without diffing its own request. */
  targetsRequested: number;
  uniqueRecords: number;
  reranked: unknown;
  /**
   * Which targets could not be searched. NOT a rule denial — those refuse the
   * whole call before anything runs, because a fused ranking cannot be
   * honestly labelled partial. These are upstream failures, and `partial` says
   * so rather than letting a short ranking read as the complete one.
   */
  partial: boolean;
  failures: string[];
}

export async function performCascadingSearch(
  ctx: PineconeRestContext,
  args: z.infer<typeof cascadingSearchSchema>,
): Promise<CascadingSearchResult> {
  assertTargetsAllowed(ctx.rules, args.indexes.map(i => ({ index: i.name, namespace: i.namespace })));
  await resolveIndexes(ctx.client, ctx.apiKey, args.indexes.map(i => i.name));

  const settled = await Promise.allSettled(
    args.indexes.map(t => searchOne(ctx, t.name, t.namespace, args.query, undefined)),
  );

  const failures: string[] = [];
  // Keyed on the WHOLE record identity, as in ops.ts: `_id` alone loses data,
  // because ids are unique only within a namespace, so the same id in two
  // namespaces is two different records. NUL is a safe separator — Pinecone's
  // spec forbids it in a namespace name.
  const byIdentity = new Map<string, Record<string, unknown>>();
  settled.forEach((outcome, i) => {
    const t = args.indexes[i];
    if (outcome.status !== 'fulfilled') {
      failures.push(`${t.name} / ${t.namespace}: ${outcome.reason?.message ?? outcome.reason}`);
      return;
    }
    for (const hit of outcome.value) {
      const key = `${t.name}\u0000${t.namespace}\u0000${hit._id}`;
      if (byIdentity.has(key)) continue;
      // _index/_namespace ride along so a fused ranking can be attributed.
      byIdentity.set(key, { _id: hit._id, _index: t.name, _namespace: t.namespace, ...hit.fields });
    }
  });

  if (!byIdentity.size && failures.length) {
    const err: any = new Error(`None of the requested targets could be searched: ${failures.join('; ')}`);
    err.status = 502;
    throw err;
  }

  const documents = [...byIdentity.values()];

  const reranked = documents.length
    ? await ctx.client.rerank({
        model: args.rerank.model,
        query: args.rerank.query || args.query.inputs.text,
        documents,
        topN: args.rerank.topN ?? args.query.topK,
        rankFields: args.rerank.rankFields,
      })
    : { data: [] };

  return {
    // A count of what was actually searched, not what was requested — the two
    // differ exactly when `partial` is true, and overstating it there
    // contradicts the flag beside it.
    indexesSearched: args.indexes.length - failures.length,
    targetsRequested: args.indexes.length,
    uniqueRecords: documents.length,
    reranked,
    partial: failures.length > 0,
    failures,
  };
}

/** Touches no index, so no index or namespace rule applies. */
export async function performRerankDocuments(
  ctx: PineconeRestContext,
  args: z.infer<typeof rerankDocumentsSchema>,
): Promise<unknown> {
  return ctx.client.rerank({
    model: args.model,
    query: args.query,
    documents: args.documents as Array<Record<string, unknown>> | string[],
    topN: args.options?.topN,
    rankFields: args.options?.rankFields,
  });
}

/**
 * Touches no index and sends no credential — see docsProxy.ts. Takes no
 * context at all, which is the honest signature for a call that reaches a
 * public endpoint.
 */
export async function performSearchDocs(args: z.infer<typeof searchDocsSchema>): Promise<{ query: string; answer: string }> {
  return { query: args.query, answer: await searchPineconeDocs(args.query) };
}

export interface CreateIndexResult {
  /** false when an index of that name already existed and was returned unchanged. */
  created: boolean;
  index: PineconeIndexSummary;
  /** Pinecone builds asynchronously; a false here is normal, not a failure. */
  ready: boolean;
}

export async function performCreateIndexForModel(
  ctx: PineconeRestContext,
  args: z.infer<typeof createIndexForModelSchema>,
): Promise<CreateIndexResult> {
  // FIRST, before any argument-dependent work: a denial then costs no API call.
  assertWriteAllowed(ctx.rules, 'create-index-for-model');
  assertIndexAllowed(ctx.rules, args.name, { intent: 'create' });

  const existing = (await ctx.client.listIndexes()).find(i => i.name === args.name);
  if (existing) return { created: false, index: existing, ready: existing?.status?.ready === true };

  const created = await ctx.client.createIndexForModel(args);
  primeIndexCache(ctx.apiKey, args.name, created);
  return { created: true, index: created, ready: created?.status?.ready === true };
}

export interface UpsertResult {
  index: string;
  namespace: string;
  /**
   * How many records Pinecone ACCEPTED. Deliberately not "indexed": embedding
   * is asynchronous, and Pinecone answers this call 201 with an empty body, so
   * there is nothing that could confirm indexing here.
   */
  accepted: number;
  /** The field being embedded. Absent when the index kind could not be determined. */
  textField?: string;
  bytes: number;
  freshness: string;
}

export async function performUpsertRecords(
  ctx: PineconeRestContext,
  args: z.infer<typeof upsertRecordsSchema>,
): Promise<UpsertResult> {
  assertWriteAllowed(ctx.rules, 'upsert-records');
  assertIndexAllowed(ctx.rules, args.name);
  assertNamespaceAllowed(ctx.rules, args.name, args.namespace);
  // Also capped by the Zod schema; repeated so no caller can route around it.
  assertUpsertBatchSize(args.records.length);

  const built = await withResolvedIndex(ctx.client, ctx.apiKey, args.name, async resolved => {
    assertRecordsApiUsable(resolved.verdict, args.name, 'upsert');
    const field = resolved.verdict.textField;
    if (field) assertRecordsCarryTextField(args.records, field, args.name);

    const { body, bytes } = buildUpsertNdjson(args.records);
    assertUpsertBodySize(bytes, args.records.length);

    try {
      await ctx.client.upsertRecords(resolved.host, args.namespace, body);
    } catch (error: any) {
      if (error?.status === 400 && resolved.verdict.kind === 'unknown') {
        const err: any = new Error(explainRecordsApiFailure(resolved.verdict, args.name, 'upsert', error?.message ?? 'no detail'));
        err.status = 400;
        throw err;
      }
      throw error;
    }
    return { field, bytes };
  });

  return {
    index: args.name,
    namespace: args.namespace,
    accepted: args.records.length,
    ...(built.field ? { textField: built.field } : {}),
    bytes: built.bytes,
    freshness: FRESHNESS_NOTE,
  };
}
