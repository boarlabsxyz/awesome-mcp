// Parameter schemas for the Storage MCP tools, exported so the REST routes
// validate with the same ones. Cross-argument rules (exactly one of id/key,
// confirm matching the name, …) are checked in ops.ts, not here.
import { z } from 'zod';
import { fieldsSchema } from './fieldSchema.js';
import { migrationOpSchema } from './migrations.js';

// The parameter is `collection`, not `name`: `name` is in the analytics
// PREVIEW_KEYS allowlist, and nothing a user stores should reach usage rows.
const collection = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
  .describe('Collection name: starts with a letter, then letters, digits, _ or - (max 64 chars).');

export const listCollectionsSchema = z.object({});

export const describeCollectionSchema = z.object({ collection });

export const createCollectionSchema = z.object({
  collection,
  description: z.string().min(1).max(1000).describe('What this collection is for, so a later conversation knows when to use it.'),
  fields: fieldsSchema,
  keyField: z.string().min(1).max(64).optional()
    .describe('A required string, url, integer or number field that uniquely identifies a record (e.g. profileUrl). Enables getRecord/updateRecord by key and insertRecords with onConflict "update".'),
  ttlDays: z.number().int().min(1).max(3650).optional()
    .describe('After this many days without an update a record reads as _stale: true, meaning re-fetch it from the source.'),
});

export const migrateCollectionSchema = z.object({
  collection,
  reason: z.string().min(1).max(1000).describe('Why the schema must change. Stored in the migration history that describeCollection shows.'),
  operations: z.array(migrationOpSchema).min(1).max(20).describe('Applied in order, all or nothing.'),
  dryRun: z.boolean().default(true).describe('Default true: report what would change and change nothing. Pass false to apply.'),
});

const record = z.record(z.unknown());

export const insertRecordsSchema = z.object({
  collection,
  records: z.array(record).min(1).max(500).describe('Records to insert, each matching the collection schema. All or nothing: one invalid record rejects the batch.'),
  onConflict: z.enum(['error', 'update']).default('error')
    .describe('When a record\'s keyField value already exists: "error" (default) rejects the batch, "update" replaces that record\'s data.'),
});

const recordId = z.string().min(1).max(64).optional().describe('The record\'s _id.');
const recordKey = z.string().min(1).max(2000).optional().describe('The record\'s keyField value (only on collections with a keyField).');

export const getRecordSchema = z.object({ collection, id: recordId, key: recordKey });

export const updateRecordSchema = z.object({
  collection,
  id: recordId,
  key: recordKey,
  set: record.optional().describe('Fields to set, merged over the current record. The result must match the schema.'),
  unset: z.array(z.string().min(1).max(64)).max(50).optional().describe('Optional fields to remove.'),
});

export const WHERE_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'exists'] as const;

export const findRecordsSchema = z.object({
  collection,
  where: z.array(z.object({
    field: z.string().min(1).max(64),
    op: z.enum(WHERE_OPS),
    value: z.unknown().optional().describe('Compared as the field\'s type. in: an array. contains: a substring (string/url fields, case-insensitive) or one element (array fields). exists: true/false.'),
  })).max(20).optional().describe('Conditions, all of which must hold.'),
  contains: z.string().min(1).max(200).optional()
    .describe('Case-insensitive text search across the whole record, field names included.'),
  updatedWithinDays: z.number().int().min(1).max(3650).optional().describe('Only records updated within this many days.'),
  orderBy: z.string().min(1).max(64).optional().describe('A single-value field, _updatedAt (default) or _createdAt.'),
  order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional().describe('nextCursor from a previous call, to get the next page.'),
});

export const deleteRecordsSchema = z.object({
  collection,
  ids: z.array(z.string().min(1).max(64)).min(1).max(500).optional(),
  keys: z.array(z.string().min(1).max(2000)).min(1).max(500).optional(),
});

export const dropCollectionSchema = z.object({
  collection,
  confirm: z.string().describe('Repeat the collection name exactly. Guards against dropping the wrong one.'),
});
