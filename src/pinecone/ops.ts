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
import {
  type PineconeClient,
  type PineconeIndexSummary,
  type PineconeSearchHit,
  type PineconeToolLog,
  readSearchHits,
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

/** One indented bullet per line, the shape every multi-item message here uses. */
function bulleted(items: readonly string[]): string {
  return items.map(item => `  - ${item}`).join('\n');
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
  const totalSuffix = total === undefined ? '' : ` — ${total} record(s) in total`;
  const lines = [
    `Index "${args.name}"${totalSuffix}:`,
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

/**
 * Render a relevance score so that the RANKING stays visible.
 *
 * `toFixed(4)` alone is wrong for this data, not merely terse. Pinecone's
 * reranker returns scores for lower-ranked hits down in the 1e-5 range, where
 * four decimals renders every one of them as the identical `0.0000` — so a
 * ranking of ten records read as "one scored hit and nine zeroes", hiding both
 * the ordering and the fact that the tail was scored at all.
 *
 * Four decimals is kept for anything at or above 0.001, because that is what
 * every ordinary score looks like and changing its rendering would churn the
 * output for no gain. Below that the value switches to exponential with three
 * significant digits, which is the only format that keeps 2.4e-5 and 1.9e-5
 * distinguishable. Exact zero prints as `0` rather than `0.00e+0`: that one
 * really is nothing, and dressing it up as a measurement would be worse.
 */
export function formatScore(score: number): string {
  if (!Number.isFinite(score)) return String(score);
  if (score === 0) return '0';
  return Math.abs(score) >= 0.001 ? score.toFixed(4) : score.toExponential(2);
}

function formatHits(hits: PineconeSearchHit[]): string {
  if (!hits.length) return 'No matching records.';
  return hits
    .map((h, i) => {
      const score = typeof h._score === 'number' ? ` (score ${formatScore(h._score)})` : '';
      return `${i + 1}. ${h._id}${score}\n${json(h.fields ?? {})}`;
    })
    .join('\n\n');
}

/**
 * Say so when `rerank.topN` asks for more records than the reranker was given.
 *
 * Reranking NARROWS a candidate pool; it cannot add to it. A `topN` above the
 * candidate count is accepted by Pinecone and silently has no effect, so a
 * caller who asked for 50 and got 7 has no way to tell "only 7 matched" from
 * "topN was ignored" — and the fix (raise `topK`, which is what caps the pool)
 * is in a different parameter than the one they set.
 *
 * Computed from the candidates that ACTUALLY reached the reranker rather than
 * from topK alone, which is what makes it correct for the cascading case too:
 * there the pool is up to topK per target, so `topN > topK` is not by itself
 * unreachable.
 */
function topNReachNote(
  topN: number | undefined,
  topK: number,
  targets: number,
  candidates: number,
): string | null {
  if (topN === undefined || topN <= candidates) return null;
  const ceiling =
    targets > 1
      ? `query.topK (${topK}) applies per target, so these ${targets} target(s) could retrieve at most ${topK * targets} candidate(s)`
      : `query.topK (${topK}) is what caps the candidate pool`;
  return (
    `NOTE — rerank.topN is ${topN} but only ${candidates} candidate record(s) reached the reranker, so at most ${candidates} can come back. ` +
    `Reranking narrows a pool of candidates; it never adds to it, and ${ceiling}. ` +
    `If you wanted ${topN} results, raise query.topK — raising topN alone does nothing.`
  );
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
      // readSearchHits, never `?? []`: an answer that could not be read must
      // not arrive here as "nothing matched". See its header.
      return readSearchHits(res, `"${indexName}" / ${describeNamespace(namespace)}`);
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
  // Pinecone reranks server-side on this path, so the candidate pool it saw is
  // capped by topK — a topN above that is accepted and quietly ignored.
  const reach = args.rerank
    ? topNReachNote(args.rerank.topN, args.query.topK, 1, Math.min(args.query.topK, hits.length))
    : null;
  const body = hits.length ? `${header}\n\n${formatHits(hits)}` : `${header}\n\n${FRESHNESS_NOTE}`;
  return withRulesNote(reach ? `${body}\n\n${reach}` : body, state);
}

/** A hit plus the target it came from, which the dedup key and the output both need. */
interface SourcedHit {
  index: string;
  namespace: string;
  hit: PineconeSearchHit;
}

/**
 * What one target of a cascading search did.
 *
 * Kept per target rather than only counted in aggregate, because "searched"
 * and "contributed" are different facts and conflating them is the reported
 * bug: a ranking said `from 2 of 2 target(s)` — which was true, both were
 * searched — while one of them had contributed nothing, so the output read as
 * complete coverage of both. `hits` and `kept` are what make that visible.
 */
interface TargetOutcome {
  index: string;
  namespace: string;
  /** `"idx" / "ns"`, the label every message here uses for a target. */
  label: string;
  /** False only for an upstream failure; a rules denial never gets this far. */
  searched: boolean;
  /** Hits Pinecone returned. 0 is a real answer here, unlike a failed search. */
  hits: number;
  /** How many survived dedup, i.e. what this target actually put into the ranking. */
  kept: number;
  error?: string;
}

function targetLabel(index: string, namespace: string): string {
  return `"${index}" / ${describeNamespace(namespace)}`;
}

/**
 * Deduplicate the union of hits, keyed on the WHOLE identity of a record.
 *
 * A record is identified by (index, namespace, _id) — not by `_id` alone,
 * which is what the first version used and which silently LOST DATA: `a1` in
 * namespace `ns-a` and `a1` in `ns-b` are different records holding different
 * text, and keying on the id alone kept one and discarded the other with
 * nothing in the output to say so. Ids are only unique within a namespace.
 *
 * The NUL byte is the separator because Pinecone's own spec requires a
 * namespace to contain no NUL character, so no name can forge a key boundary.
 *
 * `_index` and `_namespace` ride along in each document so the reranked
 * output can attribute every row to its source. Like `_id`, they do not
 * affect scoring — ranking reads only the caller's rankFields.
 *
 * Returns the per-target kept counts alongside the documents: without them the
 * output can say how many records went into the ranking but not where from,
 * which is the question a short result actually raises.
 */
function dedupeAcrossTargets(found: readonly SourcedHit[]): {
  documents: Array<Record<string, unknown>>;
  keptByTarget: Map<string, number>;
} {
  const byIdentity = new Map<string, Record<string, unknown>>();
  const keptByTarget = new Map<string, number>();
  for (const { index, namespace, hit } of found) {
    const target = `${index}\u0000${namespace}`;
    const key = `${target}\u0000${hit._id}`;
    if (byIdentity.has(key)) continue;
    byIdentity.set(key, { _id: hit._id, _index: index, _namespace: namespace, ...hit.fields });
    keptByTarget.set(target, (keptByTarget.get(target) ?? 0) + 1);
  }
  return { documents: [...byIdentity.values()], keptByTarget };
}

/**
 * One line per target: what it was asked, and what it gave.
 *
 * A failed target is marked `NOT SEARCHED` and its reason is NOT repeated
 * here: the PARTIAL RESULT banner above carries the full text, and these
 * messages run to several sentences — printing each one twice buries the one
 * thing this block exists to show, which is the contribution column.
 */
function formatContributions(outcomes: readonly TargetOutcome[]): string {
  const rows = outcomes.map(o => {
    if (!o.searched) return `  - ${o.label}: NOT SEARCHED — see the PARTIAL RESULT note above`;
    const deduped = o.hits !== o.kept ? ` (${o.hits} hit(s), ${o.hits - o.kept} duplicate(s) collapsed)` : '';
    const nothing = o.kept === 0 ? ' — searched, nothing matched' : '';
    return `  - ${o.label}: ${o.kept} record(s)${deduped}${nothing}`;
  });
  return `Per-target contribution:\n${rows.join('\n')}`;
}

/**
 * Say so when a target was searched successfully and contributed nothing.
 *
 * This is the half of the reported bug that is not a transport failure. A
 * sub-search that genuinely returns zero hits is a legitimate answer and is
 * counted as searched — but a fused ranking built from it looks identical to
 * one built from every target, and the per-target counts alone are easy to
 * read past. Naming the empty targets, and the reasons a namespace that holds
 * records can still return none, is what turns "the result looks short" into a
 * question the caller can answer in one more call.
 *
 * Emitted only when something else DID contribute: when every target came back
 * empty the "no matching records" path already says so, and repeating it per
 * target would be noise.
 */
function emptyTargetNote(outcomes: readonly TargetOutcome[]): string | null {
  const searched = outcomes.filter(o => o.searched);
  const empty = searched.filter(o => o.kept === 0);
  if (!empty.length || empty.length === searched.length) return null;
  return (
    `NOTE — ${empty.length} of the ${searched.length} target(s) that were searched returned NO records: ` +
    `${empty.map(o => o.label).join(', ')}. Pinecone answered those searches, so they count as searched rather than failed — ` +
    `an unreadable or failed sub-search is reported separately, as NOT SEARCHED. ` +
    `If you expect records there, run search-records against that one target to confirm: a namespace that holds records and still returns none here usually means ` +
    `the query text matched nothing, a metadata filter excluded everything, or the records are still being embedded (which takes a few seconds after an upsert).`
  );
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
 *
 * The third case is the one this was rebuilt for: a target that was searched
 * successfully and returned nothing. That is neither a failure nor a
 * contribution, and reporting only how many targets were SEARCHED let a
 * ranking missing an entire namespace read as covering it. Every target's own
 * contribution is now in the output, and a zero-contribution target is called
 * out by name.
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

  // Resolve first so a bad index name fails before any search runs — and
  // resolveIndexes names which name was bad, which Promise.all could not.
  await resolveIndexes(client, apiKey, args.indexes.map(i => i.name));

  const settled = await Promise.allSettled(
    args.indexes.map(target =>
      searchOne(client, apiKey, target.name, target.namespace, args.query, undefined),
    ),
  );

  // Each hit is kept WITH the target it came from. Losing that is what made
  // the first version drop records (see dedupeAcrossTargets) and left the
  // output unable to say which source a row was from.
  const found: SourcedHit[] = [];
  const outcomes: TargetOutcome[] = args.indexes.map((t, i) => {
    const outcome = settled[i];
    const base = { index: t.name, namespace: t.namespace, label: targetLabel(t.name, t.namespace) };
    if (outcome.status === 'fulfilled') {
      for (const hit of outcome.value) found.push({ index: t.name, namespace: t.namespace, hit });
      return { ...base, searched: true, hits: outcome.value.length, kept: 0 };
    }
    return {
      ...base,
      searched: false,
      hits: 0,
      kept: 0,
      error: outcome.reason?.message ?? String(outcome.reason),
    };
  });

  const failures = outcomes.filter(o => !o.searched);
  const searched = outcomes.length - failures.length;

  if (!found.length && failures.length === args.indexes.length) {
    throw new UserError(
      `cascading-search reached none of the ${args.indexes.length} requested target(s):\n` +
        bulleted(failures.map(f => `${f.label}: ${f.error}`)),
    );
  }

  const { documents, keptByTarget } = dedupeAcrossTargets(found);
  for (const o of outcomes) {
    o.kept = keptByTarget.get(`${o.index}\u0000${o.namespace}`) ?? 0;
  }

  const contributions = formatContributions(outcomes);
  const warning = failures.length
    ? `PARTIAL RESULT — ${failures.length} of ${args.indexes.length} target(s) could not be searched, ` +
      `so this ranking is missing whatever they would have contributed:\n${bulleted(failures.map(f => `${f.label}: ${f.error}`))}\n\n`
    : '';

  if (!documents.length) {
    // Every target that answered answered with nothing. The per-target block
    // still goes out, because "no matches in either namespace" and "no matches
    // in one of them, the other unreachable" are different situations.
    return withRulesNote(
      `${warning}No matching records across ${searched} of ${args.indexes.length} target(s).\n\n${contributions}\n\n${FRESHNESS_NOTE}`,
      state,
    );
  }

  const reranked = await client.rerank({
    model: args.rerank.model,
    query: args.rerank.query || args.query.inputs.text,
    documents,
    topN: args.rerank.topN ?? args.query.topK,
    rankFields: args.rerank.rankFields,
  });

  // Counts what was actually SEARCHED, not what was asked for: reporting
  // "from 2 targets" after one of them failed overstated the ranking's
  // coverage, and that number sits right beside the PARTIAL warning
  // contradicting it. It still does not claim every searched target
  // CONTRIBUTED — that is what the per-target block below is for.
  const header =
    `${documents.length} unique record(s) from ${searched} of ${args.indexes.length} target(s) ` +
    `(index + namespace pairs), reranked with ${args.rerank.model}:`;

  const notes = [
    contributions,
    emptyTargetNote(outcomes),
    // `searched`, not the requested count: with a target unreachable, only the
    // targets that answered contributed to the pool, so the ceiling this note
    // quotes would otherwise overstate what was reachable.
    topNReachNote(args.rerank.topN, args.query.topK, searched, documents.length),
  ].filter(Boolean);

  return withRulesNote(
    `${warning}${header}\n\n${notes.join('\n\n')}\n\n${formatRerankedHits(reranked)}`,
    state,
  );
}

/**
 * Render a reranked ranking the way search-records renders hits: a numbered
 * list, highest first.
 *
 * Previously this returned the raw rerank payload, which exposed Pinecone's
 * internal `index` field — the position of the document in the array WE
 * built, meaningless to a caller who never saw that array and easily misread
 * as the Pinecone index. Each row now names its real source instead, which is
 * what makes a fused ranking across targets interpretable at all.
 */
function formatRerankedHits(reranked: any): string {
  const rows = Array.isArray(reranked?.data) ? reranked.data : [];
  if (!rows.length) return 'No records survived reranking.';
  return rows
    .map((row: any, i: number) => {
      const doc = (row?.document ?? {}) as Record<string, unknown>;
      const { _id, _index, _namespace, ...fields } = doc;
      // formatScore, not toFixed(4): the reranked tail is exactly where the
      // scores are small enough for four decimals to flatten every row to
      // 0.0000. See its header.
      const score = typeof row?.score === 'number' ? ` (score ${formatScore(row.score)})` : '';
      const source =
        _index === undefined
          ? ''
          : ` — from "${String(_index)}" / ${describeNamespace(String(_namespace ?? ''))}`;
      return `${i + 1}. ${String(_id ?? '(no id)')}${score}${source}\n${json(fields)}`;
    })
    .join('\n\n');
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

/**
 * Compare a create request against the index that already bears that name.
 *
 * `create-index-for-model` is idempotent by name, which is deliberate — but
 * "returned unchanged" was reported as an unqualified success even when the
 * existing index embeds a DIFFERENT model, or a different field. Those are the
 * two things that cannot be changed after creation: the field name is fixed at
 * creation and every later upsert must carry it, and the model decides what
 * the vectors mean. So a caller who asked for `llama-text-embed-v2` embedding
 * `body`, and silently got an index embedding `chunk_text` with
 * `multilingual-e5-large`, goes on to upsert records that are rejected for a
 * missing field — or, worse, accepted and embedded by a model they did not
 * choose, with the mismatch discoverable only by reading the payload.
 *
 * Reported rather than refused: the index is real, usable, and reusing it is
 * very often what was meant. What is not acceptable is not SAYING so. The
 * payload is already in the response, but a difference inside 40 lines of JSON
 * is not something a reader is going to notice unprompted.
 */
function describeIndexConfigDrift(
  existing: PineconeIndexSummary,
  args: z.infer<typeof createIndexForModelSchema>,
): string | null {
  const existingModel = existing.embed?.model;
  const existingField = existing.embed?.field_map?.text;
  const differences: string[] = [];

  if (existingModel !== undefined && existingModel !== args.embed.model) {
    differences.push(
      `embedding MODEL: you asked for "${args.embed.model}", the existing index uses "${existingModel}". ` +
        `A model cannot be changed after creation, and vectors from two models are not comparable.`,
    );
  }
  if (existingField !== undefined && existingField !== args.embed.fieldMap.text) {
    differences.push(
      `embedded FIELD: you asked for "${args.embed.fieldMap.text}", the existing index embeds "${existingField}". ` +
        `upsert-records will require "${existingField}" on every record and refuse the ones carrying "${args.embed.fieldMap.text}".`,
    );
  }
  // Absent rather than different: an index with no `embed` block at all is not
  // an integrated-embedding index, which is a bigger mismatch than a changed
  // field and is the one case where reusing it cannot work.
  if (existingModel === undefined && existingField === undefined) {
    differences.push(
      `the existing index has NO integrated-embedding configuration at all, so it is not the kind of index this tool creates. ` +
        `Run describe-index "${existing.name}" to see what it is; search-records and upsert-records may not work against it.`,
    );
  }

  if (!differences.length) return null;
  return (
    `WARNING — the existing index does NOT match what you asked for, and these cannot be changed after creation:\n` +
    `${bulleted(differences)}\n` +
    `Nothing was created or modified. To get the configuration you asked for, use a different index name.`
  );
}

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
    const drift = describeIndexConfigDrift(existing, args);
    return withRulesNote(
      `Index not created — an index named "${args.name}" already exists.${drift ? `\n\n${drift}` : ''}\n\n${json(existing)}`,
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
