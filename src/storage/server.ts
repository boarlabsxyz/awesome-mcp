// src/storage/server.ts
// The Storage MCP: collections with enforced schemas, kept in this platform's
// own Postgres, so Claude can store structured data between conversations.
// The schema changes only through migrations that say what happens to the
// records already there. Data is per user (session.userId).
import { FastMCP } from 'fastmcp';
import { instrumentServer } from '../usage/instrumentServer.js';
import { requireAdminForEveryTool } from '../admin-mcp/adminGuard.js';
import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import { registerListRestEndpoints } from '../sharedTools/listRestEndpoints.js';
import { registerMintRestBearerForCurl } from '../sharedTools/mintRestBearerForCurl.js';
import {
  createCollectionSchema,
  deleteRecordsSchema,
  describeCollectionSchema,
  dropCollectionSchema,
  findRecordsSchema,
  getRecordSchema,
  insertRecordsSchema,
  listCollectionsSchema,
  migrateCollectionSchema,
  updateRecordSchema,
} from './schemas.js';
import {
  opCreateCollection,
  opDeleteRecords,
  opDescribeCollection,
  opDropCollection,
  opFindRecords,
  opGetRecord,
  opInsertRecords,
  opListCollections,
  opMigrateCollection,
  opUpdateRecord,
} from './ops.js';
import type { Fields } from './fieldSchema.js';

// Admins only (ADMIN_ONLY_MCPS, src/auth/admin.ts): the guard re-checks the
// caller on every call, since FastMCP authenticates once per session.
export const storageServer = requireAdminForEveryTool(instrumentServer(new FastMCP<UserSession>({
  name: 'Storage MCP',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'storage'),
}), 'storage'), 'The Storage MCP is for administrators only. Your account is not in ADMIN_EMAILS.');

// Required once any Storage REST catalog entry is `live`: a script moving
// records in bulk needs a short-lived bearer (or it falls back to the
// permanent dashboard API key) and a way to discover the endpoints.
// src/__tests__/sharedToolsRegistration.test.ts enforces this.
registerMintRestBearerForCurl(storageServer);
registerListRestEndpoints(storageServer);

const json = (value: unknown): string => JSON.stringify(value, null, 2);

// Descriptions are plain string literals: scripts/buildMcpToolsDoc.mjs reads them from source.

storageServer.addTool({
  name: 'listCollections',
  annotations: { readOnlyHint: true },
  description:
    'List your storage collections: name, description, schema version, field names, record count, size and last write, plus your quotas. ' +
    'Call this FIRST, before researching anything you may have stored earlier, and before creating a collection: reuse an existing one rather than making a near-duplicate.',
  parameters: listCollectionsSchema,
  execute: async (_args, { session }) => json(await opListCollections(session?.userId)),
});

storageServer.addTool({
  name: 'describeCollection',
  annotations: { readOnlyHint: true },
  description:
    'The full schema of one collection: every field with its type, whether it is required, and what it holds; the keyField and ttlDays; record count; and the last 10 migrations with the reason given for each. ' +
    'Read this before inserting or querying, so records match the schema and queries use the right field names.',
  parameters: describeCollectionSchema,
  execute: async (args, { session }) => json(await opDescribeCollection(session?.userId, args)),
});

storageServer.addTool({
  name: 'createCollection',
  annotations: { readOnlyHint: false },
  description:
    'Create a collection with a fixed schema. Every record written later must match it exactly: unknown fields are rejected, and the schema changes only through migrateCollection. ' +
    'Give every field a type and a description of what it holds. Use a json field for nested data you only need to keep, not query. ' +
    'Set keyField to a natural identifier (a profile URL, an email) so a later conversation can look a record up and update it instead of duplicating it. ' +
    'Set ttlDays when the data goes stale (e.g. 30 for scraped profiles): older records then read as _stale: true, meaning fetch them again from the source.',
  parameters: createCollectionSchema,
  execute: async (args, { session }) => json(await opCreateCollection(session?.userId, { ...args, fields: args.fields as Fields })),
});

storageServer.addTool({
  name: 'migrateCollection',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description:
    'The only way to change a collection\'s schema. Operations, applied in order: addField, renameField, removeField (deletes that data), changeField (type, required, description, enum), setOptions (description, keyField, ttlDays). ' +
    'Each change must say what happens to the records already stored: adding a required field to a non-empty collection needs a default, and a type change converts every value or aborts. ' +
    'Defaults to dryRun: true, which changes nothing and shows the records that would change, before and after (a few samples), and any that cannot migrate. Apply with dryRun: false. ' +
    'The migration is all or nothing, and its reason is kept in the history describeCollection shows. ' +
    'Records keep their _updatedAt: reshaping data does not refresh it, so _stale is unchanged. A changeField that changes the type keeps the old description unless you pass a new one.',
  parameters: migrateCollectionSchema,
  execute: async (args, { session }) => json(await opMigrateCollection(session?.userId, args)),
});

storageServer.addTool({
  name: 'insertRecords',
  annotations: { readOnlyHint: false },
  description:
    'Insert up to 500 records into a collection. Each must match the schema (call describeCollection first); one invalid record rejects the whole batch, with the problem in each listed. ' +
    'With onConflict "update", a record whose keyField value already exists replaces that record\'s data and refreshes its _updatedAt — the way to refresh stale data. ' +
    'Returns the _id of every record written and how many were created and updated.',
  parameters: insertRecordsSchema,
  execute: async (args, { session }) => json(await opInsertRecords(session?.userId, args)),
});

storageServer.addTool({
  name: 'getRecord',
  annotations: { readOnlyHint: true },
  description:
    'Get one record by _id or by its keyField value (give one, not both). The record comes with _createdAt, _updatedAt and _ageDays, and _stale when the collection has ttlDays.',
  parameters: getRecordSchema,
  execute: async (args, { session }) => json(await opGetRecord(session?.userId, args)),
});

storageServer.addTool({
  name: 'findRecords',
  annotations: { readOnlyHint: true },
  description:
    'Query a collection. where takes conditions on schema fields (eq, ne, gt, gte, lt, lte, in, contains, exists), all of which must hold; contains searches the text of whole records. ' +
    'Filter by freshness with updatedWithinDays; sort by a field, _updatedAt (default) or _createdAt. ' +
    'string and url fields compare and sort as text ("10" before "4"); to compare numbers, migrate the field to number or integer. ' +
    'Returns the total number of matches, one page of records (limit, default 25, max 100) and a nextCursor when there are more. ' +
    'Paging is stable: records written meanwhile do not shift later pages, but total is counted on each call and can change between pages. Keep orderBy and order unchanged while paging. Each record carries _ageDays, and _stale when the collection has ttlDays: re-fetch stale records from their source and update them.',
  parameters: findRecordsSchema,
  execute: async (args, { session }) => json(await opFindRecords(session?.userId, args)),
});

storageServer.addTool({
  name: 'updateRecord',
  annotations: { readOnlyHint: false },
  description:
    'Update one record, by _id or by keyField value (give one, not both): set merges fields over the record, unset removes optional fields. The result must match the schema. Refreshes the record\'s _updatedAt.',
  parameters: updateRecordSchema,
  execute: async (args, { session }) => json(await opUpdateRecord(session?.userId, args)),
});

storageServer.addTool({
  name: 'deleteRecords',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description:
    'Delete up to 500 records, by ids or by keys (keyField values): give one of the two, not both. Cannot be undone. Reports how many were deleted and which of the given ids or keys did not exist.',
  parameters: deleteRecordsSchema,
  execute: async (args, { session }) => json(await opDeleteRecords(session?.userId, args)),
});

storageServer.addTool({
  name: 'dropCollection',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description:
    'Delete a collection with all its records and migration history. Cannot be undone. confirm must repeat the collection name exactly.',
  parameters: dropCollectionSchema,
  execute: async (args, { session }) => json(await opDropCollection(session?.userId, args)),
});
