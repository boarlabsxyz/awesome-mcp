// src/pinecone/server.ts
// Pinecone MCP server — nine tools over a user's Pinecone vector indexes.
//
// The tool names and parameter shapes match Pinecone's own Developer MCP
// server (pinecone-io/pinecone-mcp), so a model that has used one works with
// the other. What differs is the deployment: theirs is STDIO-only and runs on
// the user's machine with PINECONE_API_KEY in the environment. There is no
// hosted remote Developer MCP, so this connector reimplements the nine tools
// against Pinecone's REST API — which is what buys remote Streamable HTTP,
// unified auth and the per-connection access rules below.
//
// Two differences from upstream worth knowing:
//
//   - The upstream `llm_provider` / `llm_model` parameters are NOT ported.
//     They attribute usage to a model vendor and would be prompt noise on
//     every tool here.
//   - Every data tool classifies the index before calling it. Upstream passes
//     Pinecone's bare HTTP 400 through when an index is the wrong kind; this
//     one names the index, the evidence and the API that would serve it. See
//     indexKind.ts for why that is affordable (the describe call is already
//     being made to find the index's host).
//
// Access rules (index allow/deny, namespace allow/deny, read-only) live in
// accessRules.ts. Unlike Browserbase's domain rules they are a real boundary
// within this connector's surface, because every tool that touches data names
// its index and namespace as a parameter — there is no equivalent of "the
// page navigated itself". They still do not limit the API key itself.

import { FastMCP } from 'fastmcp';

import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import { registerListRestEndpoints } from '../sharedTools/listRestEndpoints.js';
import { registerMintRestBearerForCurl } from '../sharedTools/mintRestBearerForCurl.js';
import type { UserSession } from '../userSession.js';

import { type PineconeRulesState } from './accessRules.js';
import { type PineconeToolLog, getPineconeClient, withPineconeClient } from './apiHelpers.js';
import {
  opCascadingSearch,
  opCreateIndexForModel,
  opDescribeIndex,
  opDescribeIndexStats,
  opListIndexes,
  opRerankDocuments,
  opSearchDocs,
  opSearchRecords,
  opUpsertRecords,
} from './ops.js';
import {
  cascadingSearchSchema,
  createIndexForModelSchema,
  describeIndexSchema,
  describeIndexStatsSchema,
  listIndexesSchema,
  rerankDocumentsSchema,
  searchDocsSchema,
  searchRecordsSchema,
  upsertRecordsSchema,
} from './schemas.js';

// Re-exported so a future REST plane validates against the same definitions
// the MCP tools do, rather than a second copy that can drift.
export {
  cascadingSearchSchema,
  createIndexForModelSchema,
  describeIndexSchema,
  describeIndexStatsSchema,
  listIndexesSchema,
  rerankDocumentsSchema,
  searchDocsSchema,
  searchRecordsSchema,
  upsertRecordsSchema,
};

export const pineconeServer = new FastMCP<UserSession>({
  name: 'Pinecone MCP Server',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'pinecone'),
});

// Required once any of this service's REST catalog entries is `live`:
// without them a caller has no way to mint a short-lived bearer or discover
// the endpoints, and is pushed onto the permanent dashboard API key instead.
// src/__tests__/sharedToolsRegistration.test.ts enforces this.
registerMintRestBearerForCurl(pineconeServer);
registerListRestEndpoints(pineconeServer);

/**
 * Re-read access rules from the database on each call.
 *
 * SSE sessions are long-lived, so a session-cached copy keeps serving rules
 * the user has already changed — and unlike Browserbase, one of these rules is
 * a write gate, where staleness means a write the user thought they had
 * switched off.
 *
 * Returns the discriminated state rather than swallowing the error, because
 * the three concerns disagree about what a failed read means: index and
 * namespace rules fail OPEN (the stored default is unrestricted, so failing
 * closed would protect nothing while breaking every call), while the read-only
 * switch fails CLOSED (a database blip must not silently un-flip it). The
 * policy lives in accessRules.ts, where it is testable; this function only
 * reports what it found.
 */
async function getRules(session?: UserSession): Promise<PineconeRulesState> {
  const instanceId = session?.pineconeInstanceId;
  // No instance id is not a failure — it is a session built without one, which
  // means there are no stored rules to apply.
  if (!instanceId) return { status: 'loaded', rules: undefined };
  try {
    const { getMcpConnectionByInstanceId } = await import('../mcpConnectionStore.js');
    const connection = await getMcpConnectionByInstanceId(instanceId);
    return { status: 'loaded', rules: (connection?.providerTokens as any)?.accessRules ?? undefined };
  } catch (error: any) {
    return { status: 'unavailable', detail: error?.message ?? 'the connection store could not be read' };
  }
}

/**
 * The API key, which also keys the index-host cache in indexCatalog.ts.
 *
 * Resolved through getPineconeClient so a missing token produces the same
 * "not connected, visit the dashboard" message here as it does everywhere
 * else, rather than a cache key of "undefined".
 */
function apiKeyOf(session?: UserSession): string {
  getPineconeClient(session);
  return session!.pineconeAccessToken as string;
}

// ==================== Index discovery ====================

pineconeServer.addTool({
  name: 'list-indexes',
  annotations: { readOnlyHint: true },
  description:
    'List the Pinecone indexes in this connection\'s project, with each index\'s configuration and readiness. ' +
    'Call this first to discover valid index names. ' +
    'An API key is scoped to one Pinecone project, so indexes in other projects are not listed. ' +
    'If this connection has index access rules, indexes they deny are hidden and the response says how many — hidden is not the same as nonexistent.',
  parameters: listIndexesSchema,
  execute: async (_args, { log, session }) => {
    const state = await getRules(session);
    return withPineconeClient('list-indexes', session, log as PineconeToolLog, client =>
      opListIndexes(client, state, log as PineconeToolLog),
    );
  },
});

pineconeServer.addTool({
  name: 'describe-index',
  annotations: { readOnlyHint: true },
  description:
    'Describe one Pinecone index: its configuration, its embedding model, and the field name its embed.field_map points at — the field upsert-records must populate. ' +
    'Check status.ready to confirm the index can accept upserts and searches. ' +
    'The response also states which kind of index it is, because search-records and upsert-records only work against integrated-embedding indexes (the ones create-index-for-model makes). ' +
    'This is also the tool to call when an index is missing from list-indexes: it reports which access rule hides it.',
  parameters: describeIndexSchema,
  execute: async (args, { log, session }) => {
    const state = await getRules(session);
    return withPineconeClient('describe-index', session, log as PineconeToolLog, client =>
      opDescribeIndex(client, state, args, log as PineconeToolLog),
    );
  },
});

pineconeServer.addTool({
  name: 'describe-index-stats',
  annotations: { readOnlyHint: true },
  description:
    'Report an index\'s record counts, broken down by namespace. This is how to discover which namespaces an index actually has — Pinecone has no separate list-namespaces here. ' +
    'The default namespace is the empty string "". ' +
    'Recently upserted records take a few seconds to appear.',
  parameters: describeIndexStatsSchema,
  execute: async (args, { log, session }) => {
    const state = await getRules(session);
    const apiKey = apiKeyOf(session);
    return withPineconeClient('describe-index-stats', session, log as PineconeToolLog, client =>
      opDescribeIndexStats(client, apiKey, state, args, log as PineconeToolLog),
    );
  },
});

// ==================== Search ====================

pineconeServer.addTool({
  name: 'search-records',
  annotations: { readOnlyHint: true },
  description:
    'Search one index for records semantically similar to a query text, optionally filtered by metadata and reranked. ' +
    'Pinecone embeds the query automatically, so this works only against integrated-embedding indexes — call describe-index if unsure. ' +
    'A document or vectors index is refused by name rather than as a bare upstream error; a schema this connector cannot classify is attempted anyway and Pinecone decides. ' +
    'Returns each hit\'s _id, _score and stored fields. ' +
    'To search several indexes and get one combined ranking, use cascading-search instead.',
  parameters: searchRecordsSchema,
  execute: async (args, { log, session }) => {
    const state = await getRules(session);
    const apiKey = apiKeyOf(session);
    return withPineconeClient('search-records', session, log as PineconeToolLog, client =>
      opSearchRecords(client, apiKey, state, args, log as PineconeToolLog),
    );
  },
});

pineconeServer.addTool({
  name: 'cascading-search',
  annotations: { readOnlyHint: true },
  description:
    'Search several indexes at once, deduplicate the hits by record id and rerank them into ONE combined ranking. Reranking is required — that fusion is the whole point. ' +
    'Works only against integrated-embedding indexes: a document or vectors index is refused by name, while a schema this connector cannot classify is attempted anyway. To search a single index, use search-records. ' +
    'If this connection\'s access rules deny any of the named indexes or namespaces, the whole call is refused rather than silently searching the rest: dropping a source would change the order and scores of everything that remains, and a ranking cannot be honestly labelled partial.',
  parameters: cascadingSearchSchema,
  execute: async (args, { log, session }) => {
    const state = await getRules(session);
    const apiKey = apiKeyOf(session);
    return withPineconeClient('cascading-search', session, log as PineconeToolLog, client =>
      opCascadingSearch(client, apiKey, state, args, log as PineconeToolLog),
    );
  },
});

pineconeServer.addTool({
  name: 'rerank-documents',
  annotations: { readOnlyHint: true },
  description:
    'Rerank a set of documents you supply against a query, using a dedicated reranking model. ' +
    'Use this for documents that did NOT come from a Pinecone search — externally sourced text, for example. ' +
    'To rerank the results of a single-index search, prefer the rerank parameter of search-records, which does it in one call. ' +
    'This tool reads no index, so index and namespace access rules do not apply to it.',
  parameters: rerankDocumentsSchema,
  execute: async (args, { log, session }) =>
    withPineconeClient('rerank-documents', session, log as PineconeToolLog, client =>
      opRerankDocuments(client, args, log as PineconeToolLog),
    ),
});

pineconeServer.addTool({
  name: 'search-docs',
  annotations: { readOnlyHint: true },
  description:
    'Search the official Pinecone documentation. Use it before writing Pinecone code or explaining Pinecone behaviour, rather than relying on assumptions. ' +
    'This reaches a public Pinecone documentation service and does not use your API key or touch your indexes, so it works even when the connection itself is misconfigured.',
  parameters: searchDocsSchema,
  // No withPineconeClient: this tool needs no credential at all, and requiring
  // one would gate the tool that explains how to fix a broken connection on
  // that connection working.
  execute: async (args, { log }) => opSearchDocs(args, log as PineconeToolLog),
});

// ==================== Writes ====================

pineconeServer.addTool({
  name: 'create-index-for-model',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  description:
    'Create a Pinecone index with integrated embedding, which automatically embeds the text field named in embed.fieldMap. ' +
    'That field name is fixed at creation and every record you later upsert must carry it, so choose it deliberately. ' +
    'If an index with the same name already exists it is returned unchanged rather than erroring. ' +
    'The index may take a few seconds to become ready; the response says which. ' +
    'Refused when this connection is set to read-only. If an index allowlist is configured, add the new name to it on the dashboard FIRST — an allowlist entry for a name that does not exist yet denies nothing.',
  parameters: createIndexForModelSchema,
  execute: async (args, { log, session }) => {
    const state = await getRules(session);
    const apiKey = apiKeyOf(session);
    return withPineconeClient('create-index-for-model', session, log as PineconeToolLog, client =>
      opCreateIndexForModel(client, apiKey, state, args, log as PineconeToolLog),
    );
  },
});

pineconeServer.addTool({
  name: 'upsert-records',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  description:
    'Insert or update records in an integrated-embedding index. A record whose _id already exists is OVERWRITTEN. ' +
    'Every record needs an _id and the text field named by the index\'s embed.field_map — call describe-index first to confirm that field name; this tool checks it locally and sends nothing if any record is missing it. ' +
    'At most 1000 records per call: a larger batch is refused rather than split, because an upsert is not atomic across the body and a failure part-way through several chunks would leave some records written and some not. ' +
    'Embedding is asynchronous, so the records will not be searchable for a few seconds. ' +
    'Refused when this connection is set to read-only.',
  parameters: upsertRecordsSchema,
  execute: async (args, { log, session }) => {
    const state = await getRules(session);
    const apiKey = apiKeyOf(session);
    return withPineconeClient('upsert-records', session, log as PineconeToolLog, client =>
      opUpsertRecords(client, apiKey, state, args, log as PineconeToolLog),
    );
  },
});
