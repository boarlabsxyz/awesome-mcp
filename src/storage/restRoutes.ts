// src/storage/restRoutes.ts
// The Storage REST data plane (/api/v1/storage/*) as data: one descriptor per
// endpoint, which webServer.ts registers from a loop — the shape of
// src/pinecone/restRoutes.ts. Every request is validated with the MCP tool's
// own Zod schema and runs the same op* the tool runs, so the two surfaces
// cannot disagree about what is valid or what a write does.
//
// The point of this plane is a script in the sandbox (or a shell) moving
// records in bulk without passing them through Claude's context. Writes are
// insert and update only: deleteRecords, migrateCollection and dropCollection
// stay MCP-only, where the client can confirm them.
import type { ZodTypeAny } from 'zod';

import {
  opDescribeCollection,
  opFindRecords,
  opGetRecord,
  opInsertRecords,
  opListCollections,
  opUpdateRecord,
} from './ops.js';
import {
  describeCollectionSchema,
  findRecordsSchema,
  getRecordSchema,
  insertRecordsSchema,
  listCollectionsSchema,
  updateRecordSchema,
} from './schemas.js';

/** The parts of an Express request a descriptor reads. */
export interface StorageRestRequest {
  params: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  body?: unknown;
}

export interface StorageRestRoute {
  /** Express path. Array order is registration order. */
  path: string;
  method: 'get' | 'post';
  tool: string;
  schema: ZodTypeAny;
  /** The tool's arguments: the body, overridden by the path. */
  args: (req: StorageRestRequest) => Record<string, unknown>;
  run: (userId: number, args: any) => Promise<{ status: number; body: unknown }>;
  fallback: string;
}

const param = (req: StorageRestRequest, name: string): string => {
  const v = req.params[name];
  return Array.isArray(v) ? v.join('/') : (v ?? '');
};

/** A body object, or {} — spreading a non-object would throw. */
const bodyOf = (req: StorageRestRequest): Record<string, unknown> =>
  req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};

/**
 * The record the path names: `/records/{recordId}` is an id, or a keyField
 * value with `?by=key`. Any id/key in the body is dropped, so the path is the
 * only thing that picks the record.
 */
function recordRef(req: StorageRestRequest): { id: string } | { key: string } {
  const value = param(req, 'recordId');
  return req.query.by === 'key' ? { key: value } : { id: value };
}

const ok = (body: unknown) => ({ status: 200, body });

export const STORAGE_REST_ROUTES: ReadonlyArray<StorageRestRoute> = [
  {
    path: '/api/v1/storage/collections', method: 'get', tool: 'listCollections', schema: listCollectionsSchema,
    args: () => ({}),
    run: async (uid) => ok(await opListCollections(uid)),
    fallback: 'Failed to list storage collections',
  },
  {
    path: '/api/v1/storage/collections/:collection', method: 'get', tool: 'describeCollection', schema: describeCollectionSchema,
    args: (req) => ({ collection: param(req, 'collection') }),
    run: async (uid, a) => ok(await opDescribeCollection(uid, a)),
    fallback: 'Failed to describe the storage collection',
  },
  {
    path: '/api/v1/storage/collections/:collection/records/:recordId', method: 'get', tool: 'getRecord', schema: getRecordSchema,
    args: (req) => ({ collection: param(req, 'collection'), ...recordRef(req) }),
    run: async (uid, a) => ok(await opGetRecord(uid, a)),
    fallback: 'Failed to get the storage record',
  },
  {
    // A read despite the POST: the where conditions do not fit a query string.
    path: '/api/v1/storage/collections/:collection/find', method: 'post', tool: 'findRecords', schema: findRecordsSchema,
    args: (req) => ({ ...bodyOf(req), collection: param(req, 'collection') }),
    run: async (uid, a) => ok(await opFindRecords(uid, a)),
    fallback: 'Failed to query the storage collection',
  },
  {
    path: '/api/v1/storage/collections/:collection/records', method: 'post', tool: 'insertRecords', schema: insertRecordsSchema,
    args: (req) => ({ ...bodyOf(req), collection: param(req, 'collection') }),
    run: async (uid, a) => {
      const result = await opInsertRecords(uid, a);
      // 201 when the call created anything; an upsert that only replaced is 200.
      return { status: result.created > 0 ? 201 : 200, body: result };
    },
    fallback: 'Failed to insert storage records',
  },
  {
    path: '/api/v1/storage/collections/:collection/records/:recordId/update', method: 'post', tool: 'updateRecord', schema: updateRecordSchema,
    args: (req) => {
      const body = { ...bodyOf(req) };
      delete body.id;
      delete body.key;
      return { ...body, collection: param(req, 'collection'), ...recordRef(req) };
    },
    run: async (uid, a) => ok(await opUpdateRecord(uid, a)),
    fallback: 'Failed to update the storage record',
  },
];

/**
 * The HTTP answer for an error a route threw. Storage ops raise UserError for
 * every refusal; ops.ts tags the ones that are not the caller's mistake with a
 * status (404 missing collection/record, 503 no database), and every other
 * UserError is a 400 that says what to fix. Anything else is a 500. Narrowed
 * by name, not instanceof, so webServer.ts need not import FastMCP.
 */
export function storageErrorResponse(err: unknown, fallback: string): { status: number; body: { error: string } } {
  const e = err as { name?: string; message?: string; code?: unknown } | null;
  if (e?.name === 'UserError') {
    const status = e.code === 404 || e.code === 503 ? e.code : 400;
    return { status, body: { error: e.message || fallback } };
  }
  return { status: 500, body: { error: fallback } };
}
