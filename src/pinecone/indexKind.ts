// src/pinecone/indexKind.ts
// What kind of index is this, and can the legacy Records API serve it?
//
// WHY THIS MODULE EXISTS. As of Pinecone API version 2026-07 the two endpoints
// this connector writes and searches through — POST /records/namespaces/{ns}/
// upsert and .../search — are labelled the "legacy Records API", and
// create-for-model is labelled a "legacy integrated index". They are NOT
// marked deprecated and they still work, so targeting them is correct for now
// (it is also what Pinecone's own MCP server does). But Pinecone has since
// added a Documents API for a different index shape, and a vectors index has
// never been servable this way at all — and against either of those the
// Records API answers a bare HTTP 400 that names neither the index nor the
// reason.
//
// Passing that 400 through is the failure this repo keeps designing against: a
// message that sends the user to check their query when the query was never
// the problem. So every data-plane path classifies the index first and refuses
// with the evidence.
//
// WHY THAT IS AFFORDABLE. Pinecone's data plane is per-index: every search,
// stats and upsert goes to `https://{index.host}/...`, and the ONLY way to
// learn `host` is GET /indexes/{name}. So those paths already make the describe
// call that carries `schema.fields`. Classification is a pure function over a
// payload we are holding anyway — zero added latency, which is why it runs on
// every call instead of being an opt-in `diagnose` tool nobody would call
// before they were already confused.
//
// Everything here is PURE. The caching and the HTTP live in indexCatalog.ts and
// apiHelpers.ts respectively, following src/slack-user/teamNames.ts: a stateful
// TTL cache does not belong in a stateless module, and a pure classifier does
// not belong with a cache.

import { UserError } from 'fastmcp';

export type PineconeIndexKind = 'legacy-integrated' | 'document' | 'vectors' | 'unknown';

export interface IndexKindVerdict {
  kind: PineconeIndexKind;
  /** Exactly which field names and types the decision was read from. Quoted verbatim in every refusal. */
  evidence: string;
  /** The `field_map` text field. Only on 'legacy-integrated'; the one thing upsert needs. */
  textField?: string;
  /** `embed.model` when present, for the message only. */
  embedModel?: string;
}

/** Vector fields Pinecone reserves; their presence alone does not make a document index. */
const RESERVED_VECTOR_FIELDS = new Set(['_values', '_sparse_values']);

function fieldsOf(payload: any): Record<string, any> | null {
  const fields = payload?.schema?.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null;
  return fields as Record<string, any>;
}

/**
 * Classify an index from its `GET /indexes/{name}` body. Pure; never throws.
 *
 * Decision order is load-bearing:
 *
 *   1. No readable `schema.fields` object            -> unknown
 *   2. A field of type `semantic_text`               -> legacy-integrated
 *   3. A non-reserved `string` field carrying
 *      `embed` or `sparse_embed`                     -> document
 *   4. Only reserved `_values` / `_sparse_values`    -> vectors
 *   5. anything else                                 -> unknown
 *
 * `semantic_text` is tested FIRST, before the string-with-embed test, because
 * the only kind this connector supports must not be misclassified as one it
 * refuses. A payload that somehow carries both is treated as the kind the
 * Records API can actually serve, and the ambiguity is recorded in `evidence`
 * so it shows up in a bug report rather than as a silent refusal.
 */
export function classifyIndex(payload: unknown): IndexKindVerdict {
  const fields = fieldsOf(payload);
  if (!fields) {
    return { kind: 'unknown', evidence: 'the describe response carried no readable schema.fields object' };
  }

  const entries = Object.entries(fields);
  if (!entries.length) {
    return { kind: 'unknown', evidence: 'schema.fields is present but empty' };
  }

  const semantic = entries.filter(([, cfg]) => cfg?.type === 'semantic_text');
  const embedding = entries.filter(
    ([name, cfg]) => cfg?.type === 'string' && !RESERVED_VECTOR_FIELDS.has(name) && (cfg?.embed || cfg?.sparse_embed),
  );

  if (semantic.length) {
    const [semanticName, semanticCfg] = semantic[0];
    // field_map is what the DATA PLANE actually reads, so it wins when the two
    // disagree — but both names go into the evidence, because a disagreement
    // here is the sort of thing that should surface in a bug report rather
    // than be quietly resolved.
    const mapped = (payload as any)?.embed?.field_map?.text ?? semanticCfg?.field_map?.text;
    const textField = typeof mapped === 'string' && mapped ? mapped : semanticName;
    const disagree = textField !== semanticName ? ` (field_map names "${textField}")` : '';
    const ambiguity = embedding.length
      ? `; it ALSO declares "${embedding[0][0]}" as a string field with an embed configuration, which is unusual — treated as legacy integrated because that is the API that can serve it`
      : '';
    const embedModel = (payload as any)?.embed?.model ?? semanticCfg?.model;
    return {
      kind: 'legacy-integrated',
      evidence: `field "${semanticName}" has type semantic_text${disagree}${ambiguity}`,
      textField,
      embedModel: typeof embedModel === 'string' ? embedModel : undefined,
    };
  }

  if (embedding.length) {
    const [name, cfg] = embedding[0];
    const which = cfg?.embed ? 'embed' : 'sparse_embed';
    const model = cfg?.[which]?.model;
    return {
      kind: 'document',
      evidence: `field "${name}" has type string with an ${which} configuration, not semantic_text`,
      embedModel: typeof model === 'string' ? model : undefined,
    };
  }

  const names = entries.map(([name]) => name);
  const hasReserved = names.some(n => RESERVED_VECTOR_FIELDS.has(n));
  const nonReservedTyped = entries.filter(
    ([name, cfg]) => !RESERVED_VECTOR_FIELDS.has(name) && cfg?.type && cfg.type !== 'string',
  );
  // Metadata fields alone do not make a document schema, so an index whose
  // only vector fields are the reserved ones is a vectors index however many
  // filterable metadata fields sit beside them.
  if (hasReserved) {
    return {
      kind: 'vectors',
      evidence: `the schema declares only the reserved vector fields ${names.filter(n => RESERVED_VECTOR_FIELDS.has(n)).join(' and ')} and no text field`,
    };
  }

  const sample = (nonReservedTyped.length ? nonReservedTyped : entries)
    .slice(0, 4)
    .map(([name, cfg]) => `${name}:${cfg?.type ?? 'untyped'}`)
    .join(', ');
  return { kind: 'unknown', evidence: `no recognised field types (saw: ${sample})` };
}

/**
 * Refuse the two kinds the Records API cannot serve.
 *
 * Returns for 'legacy-integrated' (the supported kind) and for 'unknown'.
 *
 * 'unknown' means the schema block did not match anything we recognise. That
 * is ABSENCE OF EVIDENCE, and this repo does not refuse on it. Concretely:
 * the API version is pinned, but `schema.fields` is a young and moving part of
 * that surface, and a field type we have not seen would otherwise take out
 * every index that has one. A classifier that fails closed on unfamiliarity is
 * a classifier that breaks the connector on Pinecone's next release.
 *
 * So 'unknown' PROCEEDS and lets Pinecone decide. The classifier's value in
 * that case is in the ERROR, not the gate — see explainRecordsApiFailure.
 */
export function assertRecordsApiUsable(
  verdict: IndexKindVerdict,
  indexName: string,
  operation: 'search' | 'upsert',
): void {
  if (verdict.kind === 'legacy-integrated' || verdict.kind === 'unknown') return;

  const tool = operation === 'search' ? 'search-records' : 'upsert-records';

  if (verdict.kind === 'document') {
    throw new UserError(
      `Index "${indexName}" is a document index: ${verdict.evidence}. ` +
        `${tool} uses Pinecone's legacy Records API (POST /records/namespaces/{namespace}/${operation}), which a document index rejects with HTTP 400. ` +
        `Document indexes are served by the Documents API (/namespaces/{namespace}/documents/*), which this connector does not call. ` +
        `Use an index created by create-index-for-model, or reach this one with Pinecone's own client.`,
    );
  }

  throw new UserError(
    `Index "${indexName}" is a vectors index: ${verdict.evidence}, so no embedding model is attached and there is nothing to turn query text into a vector. ` +
      `${tool} requires an integrated-embedding index; against this one Pinecone answers HTTP 400. ` +
      `Create an index with create-index-for-model, which attaches the model, or work with this one through Pinecone's own client using precomputed vectors — this connector sends text only.`,
  );
}

/**
 * Attach the classifier's evidence to an upstream 400 we chose not to pre-empt.
 *
 * This is the whole payoff of letting 'unknown' through: the caller gets the
 * real cause instead of a bare upstream 400, without the classifier having
 * refused an index it simply did not recognise.
 */
export function explainRecordsApiFailure(
  verdict: IndexKindVerdict,
  indexName: string,
  operation: 'search' | 'upsert',
  upstreamMessage: string,
): string {
  const verb = operation === 'search' ? 'search' : 'upsert';
  return (
    `Pinecone refused this ${verb} with HTTP 400: ${upstreamMessage}. ` +
    `This connector could not determine the type of index "${indexName}" beforehand — describe-index returned ${verdict.evidence} — ` +
    `so it attempted the call rather than guessing. If this index was created through the Documents API, this connector cannot ${verb} it.`
  );
}

// ---------------------------------------------------------------------------
// Upsert body
// ---------------------------------------------------------------------------

/** Pinecone's documented per-request record limit for the Records upsert endpoint. */
export const PINECONE_UPSERT_MAX_RECORDS = 1000;
/** Pinecone's documented request-body size limit for the same endpoint. */
export const PINECONE_UPSERT_MAX_BYTES = 2 * 1024 * 1024;

/** How many offending record positions a validation message names before summarising. */
const MAX_REPORTED_POSITIONS = 5;

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * Refuse a batch larger than Pinecone accepts, rather than chunking it.
 *
 * Auto-chunking means k independent, non-atomic HTTP requests. A failure on
 * chunk 3 of 5 leaves 2000 records written and 3000 not, with no rollback —
 * the only honest answer is "partially applied, reconcile by id", which is a
 * mess the user now owns. This repo's rule is that a partial must never read
 * as complete; it is not a licence to CREATE a partial whenever one can be
 * labelled. Here the tool can decline to create the state at all: the limit is
 * known up front, the caller is holding the records, and re-calling with 1000
 * at a time is trivial. A refusal has no side effect to clean up.
 *
 * Enforced TWICE on purpose — `.max()` on the Zod array (the message a model
 * sees first) and again here, so a REST route or any future caller cannot
 * route around it.
 */
export function assertUpsertBatchSize(count: number): void {
  if (count <= PINECONE_UPSERT_MAX_RECORDS) return;
  const calls = Math.ceil(count / PINECONE_UPSERT_MAX_RECORDS);
  throw new UserError(
    `${count} records exceeds Pinecone's per-request limit of ${PINECONE_UPSERT_MAX_RECORDS} for this endpoint. Nothing was sent. ` +
      `Split this into ${calls} calls of at most ${PINECONE_UPSERT_MAX_RECORDS} records. ` +
      `This is refused rather than split automatically because a Records upsert is not atomic across the body: a failure part-way through ` +
      `several chunks would leave some records written and some not, with no way to roll back.`,
  );
}

/**
 * Check every record carries an id and the field the index embeds.
 *
 * Pre-validated rather than left to Pinecone's 400, for one reason that
 * outweighs the usual "do not reimplement the server's validation": a Records
 * upsert is NOT atomic across the NDJSON body, so a 400 triggered by record
 * 500 of 900 can leave the first 499 written with no rollback — the caller
 * then has to diff ids to find out what landed. We hold the expected field
 * name for free (from a describe we already made), and the single commonest
 * mistake is a model sending `text` to an index whose field_map says
 * `chunk_text`. Checking it locally converts the most likely partial write
 * into no write at all.
 *
 * It is also not over-refusal: in a legacy integrated index the field_map
 * field IS the thing that gets embedded, so a record without it has nothing to
 * index and Pinecone refuses it too. We enforce the same rule earlier, with
 * the field name in the message.
 *
 * Skipped by the caller when the verdict is 'unknown' — we do not know the
 * field name there, and guessing would be a refusal built on absence of
 * evidence.
 */
export function assertRecordsCarryTextField(
  records: ReadonlyArray<Record<string, unknown>>,
  textField: string,
  indexName: string,
): void {
  const missingId: number[] = [];
  const bothIds: number[] = [];
  const missingText: number[] = [];

  records.forEach((record, i) => {
    const hasUnderscoreId = record?._id !== undefined && record._id !== null && record._id !== '';
    const hasPlainId = record?.id !== undefined && record.id !== null && record.id !== '';
    if (hasUnderscoreId && hasPlainId) bothIds.push(i);
    else if (!hasUnderscoreId && !hasPlainId) missingId.push(i);
    const text = record?.[textField];
    if (text === undefined || text === null || text === '') missingText.push(i);
  });

  const positions = (xs: number[]) =>
    xs.length <= MAX_REPORTED_POSITIONS
      ? xs.join(', ')
      : `${xs.slice(0, MAX_REPORTED_POSITIONS).join(', ')} and ${xs.length - MAX_REPORTED_POSITIONS} more`;

  // The same "nothing was sent" sentence on every branch: it is the fact that
  // makes a refusal here better than the upstream 400 it replaces.
  const nothingSent =
    `Nothing was sent. Pinecone applies an upsert body record by record, so a rejection part-way through would have left the earlier records written.`;

  if (missingId.length) {
    throw new UserError(
      `${missingId.length} of ${records.length} records have no id (first at position${missingId.length > 1 ? 's' : ''} ${positions(missingId)}). ` +
        `Every record needs an "_id" field. ${nothingSent}`,
    );
  }
  if (bothIds.length) {
    throw new UserError(
      `${bothIds.length} of ${records.length} records carry both "_id" and "id" (first at position${bothIds.length > 1 ? 's' : ''} ${positions(bothIds)}). ` +
        `Pinecone accepts either spelling but refuses a record that has both. ${nothingSent}`,
    );
  }
  if (missingText.length) {
    const sample = records[missingText[0]];
    const keys = sample ? Object.keys(sample).map(k => `"${k}"`).join(', ') : 'none';
    throw new UserError(
      `${missingText.length} of ${records.length} records are missing the text field "${textField}" that index "${indexName}" embeds ` +
        `(first at position${missingText.length > 1 ? 's' : ''} ${positions(missingText)}). ` +
        `Record ${missingText[0]} has keys: ${keys}. The field name comes from the index's own embed.field_map — rename your text field to "${textField}". ${nothingSent}`,
    );
  }
}

/**
 * Build the NDJSON request body.
 *
 * One compact JSON.stringify per record joined with newlines, plus a trailing
 * newline (the conventional NDJSON terminator; some parsers require the last
 * line to be terminated and all of them ignore the resulting empty line).
 * Embedded newlines inside a record's values cannot break the framing because
 * JSON.stringify escapes them — that escaping is what makes this safe, so
 * there is deliberately no separate scan for them.
 *
 * Byte length is measured with Buffer.byteLength, never `body.length`: an
 * embedding corpus is the one payload guaranteed to be multibyte-heavy, and
 * `.length` counts UTF-16 code units, so it under-measures exactly the bodies
 * most likely to be over the limit — letting them through to a 413 that says
 * nothing about size.
 */
export function buildUpsertNdjson(records: ReadonlyArray<Record<string, unknown>>): { body: string; bytes: number } {
  const body = `${records.map(r => JSON.stringify(r)).join('\n')}\n`;
  return { body, bytes: Buffer.byteLength(body, 'utf8') };
}

/** Refuse an over-size body before it becomes an opaque upstream 413. */
export function assertUpsertBodySize(bytes: number, recordCount: number): void {
  if (bytes <= PINECONE_UPSERT_MAX_BYTES) return;
  const calls = Math.ceil(bytes / PINECONE_UPSERT_MAX_BYTES);
  const perCall = Math.max(1, Math.floor(recordCount / calls));
  throw new UserError(
    `That batch encodes to ${formatBytes(bytes)}; Pinecone's body limit for this endpoint is ${formatBytes(PINECONE_UPSERT_MAX_BYTES)}. Nothing was sent. ` +
      `Split it into at least ${calls} calls (roughly ${perCall} records each at the current average record size).`,
  );
}
