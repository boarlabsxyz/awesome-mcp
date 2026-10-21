// src/pinecone/restRoutes.ts
// The Pinecone REST data plane (/api/v1/pinecone/*) as data: one descriptor per
// endpoint, which webServer.ts registers from a loop. Same shape and the same
// reasons as src/github/restRoutes.ts — a table plus one generic handler keeps
// the validation, status and error contract in one place, and a descriptor is
// a plain function of (context, request), so every route's argument mapping
// and response shape is testable against a stubbed client.
//
// Every request is validated with the MCP tool's own Zod schema, and every
// upstream call goes through the same perform* the tool's op goes through, so
// the two surfaces cannot ask Pinecone different questions.
//
// ---------------------------------------------------------------------------
// TWO THINGS THAT LOOK LIKE OVERSIGHTS AND ARE NOT.
//
// 1. SEARCH IS A POST. `search-records` and `cascading-search` only read, but
//    their bodies carry a metadata filter and rerank options that do not fit a
//    query string. The catalog marks them reads in prose for that reason.
//
// 2. NAMESPACE IS IN THE BODY, NEVER THE PATH. The original reasoning for
//    this was WRONG and is worth recording: it claimed the default namespace
//    was the empty string, so a path parameter could not express it. In fact
//    Pinecone reserves `__default__` and refuses `''` outright, so a path
//    would have worked. The body stays because it is where a namespace sits
//    beside the filter and rerank options it is used with, and because moving
//    it now would break every caller — not because a path cannot carry it.
// ---------------------------------------------------------------------------

import type { ZodTypeAny } from 'zod';

import { qstr } from '../util/queryParams.js';

import * as ops from './ops.js';
import * as restOps from './restOps.js';
import type { PineconeRestContext } from './restOps.js';
import * as schemas from './schemas.js';

/** The parts of an Express request a descriptor reads. */
export interface PineconeRestRequest {
  params: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  body?: unknown;
}

export interface PineconeReadRoute {
  /** Express path. Array order is registration order. */
  path: string;
  method: 'get' | 'post';
  tool: string;
  schema: ZodTypeAny;
  args: (req: PineconeRestRequest) => Record<string, unknown>;
  json: (ctx: PineconeRestContext, args: any) => Promise<unknown>;
  /** `?format=text` — exactly what the MCP tool returns. */
  text: (ctx: PineconeRestContext, args: any) => Promise<string>;
  fallback: string;
}

export interface PineconeWriteRoute {
  path: string;
  tool: string;
  schema: ZodTypeAny;
  /** Path params, which override same-named body keys. */
  params: (req: PineconeRestRequest) => Record<string, unknown>;
  run: (ctx: PineconeRestContext, args: any) => Promise<{ status: number; body: unknown }>;
  fallback: string;
}

const param = (req: PineconeRestRequest, name: string): string => {
  const v = req.params[name];
  return Array.isArray(v) ? v.join('/') : (v ?? '');
};

/** A body object, or {} — spreading a non-object would throw. */
const bodyOf = (req: PineconeRestRequest): Record<string, unknown> =>
  req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};

/** The log slice ops.ts takes. REST has no per-call channel; failures go to the route's catch. */
const QUIET = { info: () => {}, error: () => {} };

// Static paths before parameterized ones: `/indexes/:indexName` would
// otherwise swallow nothing here (the other GETs sit under /docs/), but the
// rule is kept so a later addition under /indexes/ cannot be shadowed.
export const PINECONE_READ_ROUTES: ReadonlyArray<PineconeReadRoute> = [
  {
    path: '/api/v1/pinecone/indexes', method: 'get', tool: 'list-indexes', schema: schemas.listIndexesSchema,
    args: () => ({}),
    json: ctx => restOps.performListIndexes(ctx),
    text: ctx => ops.opListIndexes(ctx.client, ctx.rules, QUIET),
    fallback: 'Failed to list Pinecone indexes',
  },
  {
    path: '/api/v1/pinecone/docs/search', method: 'get', tool: 'search-docs', schema: schemas.searchDocsSchema,
    args: req => ({ query: qstr(req.query.q) || undefined }),
    // No context: this endpoint reaches a public Pinecone documentation
    // service and sends no credential. See docsProxy.ts.
    json: (_ctx, a) => restOps.performSearchDocs(a),
    text: (_ctx, a) => ops.opSearchDocs(a, QUIET),
    fallback: 'Failed to search the Pinecone documentation',
  },
  {
    path: '/api/v1/pinecone/indexes/:indexName', method: 'get', tool: 'describe-index', schema: schemas.describeIndexSchema,
    args: req => ({ name: param(req, 'indexName') }),
    json: (ctx, a) => restOps.performDescribeIndex(ctx, a.name),
    text: (ctx, a) => ops.opDescribeIndex(ctx.client, ctx.rules, a, QUIET),
    fallback: 'Failed to describe the Pinecone index',
  },
  {
    path: '/api/v1/pinecone/indexes/:indexName/stats', method: 'get', tool: 'describe-index-stats', schema: schemas.describeIndexStatsSchema,
    args: req => ({ name: param(req, 'indexName') }),
    json: (ctx, a) => restOps.performDescribeIndexStats(ctx, a.name),
    text: (ctx, a) => ops.opDescribeIndexStats(ctx.client, ctx.apiKey, ctx.rules, a, QUIET),
    fallback: 'Failed to read Pinecone index stats',
  },
  {
    // POST, but a read: the body carries the filter and rerank options.
    path: '/api/v1/pinecone/indexes/:indexName/search', method: 'post', tool: 'search-records', schema: schemas.searchRecordsSchema,
    args: req => ({ ...bodyOf(req), name: param(req, 'indexName') }),
    json: (ctx, a) => restOps.performSearchRecords(ctx, a),
    text: (ctx, a) => ops.opSearchRecords(ctx.client, ctx.apiKey, ctx.rules, a, QUIET),
    fallback: 'Failed to search the Pinecone index',
  },
  {
    path: '/api/v1/pinecone/search/cascading', method: 'post', tool: 'cascading-search', schema: schemas.cascadingSearchSchema,
    args: req => bodyOf(req),
    json: (ctx, a) => restOps.performCascadingSearch(ctx, a),
    text: (ctx, a) => ops.opCascadingSearch(ctx.client, ctx.apiKey, ctx.rules, a, QUIET),
    fallback: 'Failed to run the cascading search',
  },
  {
    path: '/api/v1/pinecone/rerank', method: 'post', tool: 'rerank-documents', schema: schemas.rerankDocumentsSchema,
    args: req => bodyOf(req),
    json: (ctx, a) => restOps.performRerankDocuments(ctx, a),
    text: (ctx, a) => ops.opRerankDocuments(ctx.client, a, QUIET),
    fallback: 'Failed to rerank the documents',
  },
];

export const PINECONE_WRITE_ROUTES: ReadonlyArray<PineconeWriteRoute> = [
  {
    path: '/api/v1/pinecone/indexes', tool: 'create-index-for-model', schema: schemas.createIndexForModelSchema,
    params: () => ({}),
    run: async (ctx, a) => {
      const result = await restOps.performCreateIndexForModel(ctx, a);
      // 200, not 201, when the index already existed: nothing was created, and
      // a 201 would invite a caller to believe it owns a fresh index.
      return { status: result.created ? 201 : 200, body: result };
    },
    fallback: 'Failed to create the Pinecone index',
  },
  {
    // DESTRUCTIVE, exposed with explicit sign-off: a record whose _id already
    // exists is overwritten, and this plane accepts the permanent dashboard
    // API key. It earns its place on the large-body limb of the gate — bulk
    // loading a corpus without it passing through the model is the reason the
    // data plane exists.
    path: '/api/v1/pinecone/indexes/:indexName/upsert', tool: 'upsert-records', schema: schemas.upsertRecordsSchema,
    params: req => ({ name: param(req, 'indexName') }),
    run: async (ctx, a) => ({ status: 200, body: await restOps.performUpsertRecords(ctx, a) }),
    fallback: 'Failed to upsert records',
  },
];

/**
 * Build a write route's args: body first, path params over it, so a URL and a
 * mismatched body cannot disagree about which index is written.
 */
export function writeArgs(route: PineconeWriteRoute, req: PineconeRestRequest): Record<string, unknown> {
  return { ...bodyOf(req), ...route.params(req) };
}
