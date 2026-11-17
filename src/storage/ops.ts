// The Storage MCP's tool bodies, with the pool injected so they run against a
// fake in tests. server.ts only registers them. Every argument check that
// depends on another argument or on the collection lives here, not in Zod:
// a Zod refusal surfaces as a bare InvalidParams that explains nothing.
import { UserError } from 'fastmcp';
import { nanoid } from 'nanoid';
import {
  SCALAR_TYPES,
  convertValue,
  fieldOf,
  fieldsProblems,
  validateRecord,
  valueProblem,
  type FieldDef,
  type FieldType,
  type Fields,
} from './fieldSchema.js';
import { MigrationError, keyFieldProblem, keyOf, planMigration, type MigrationOp, type MigrationPlan } from './migrations.js';
import {
  UNIQUE_VIOLATION,
  applyMigration,
  collectionStats,
  countMatches,
  deleteCollection,
  deleteRecords,
  findRecords,
  getCollection,
  getRecord,
  insertCollection,
  insertRecords,
  listCollections,
  listMigrations,
  loadAllRecords,
  recordsByKeys,
  storagePool,
  updateRecord,
  userUsage,
  withUserWriteLock,
  type Collection,
  type Condition,
  type FindQuery,
  type Queryable,
  type RecordRow,
  type StoragePool,
  type WhereOp,
} from './store.js';

export interface StorageOpsDeps {
  pool: () => StoragePool | null;
  newId: () => string;
  now: () => number;
}

export const defaultStorageOpsDeps: StorageOpsDeps = {
  pool: storagePool,
  newId: () => nanoid(16),
  now: () => Date.now(),
};

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Quotas, read per call so an env change needs only a restart. */
export function storageLimits() {
  return {
    maxCollections: envInt('STORAGE_MAX_COLLECTIONS', 50),
    maxRecords: envInt('STORAGE_MAX_RECORDS', 10_000),
    maxRecordBytes: envInt('STORAGE_MAX_RECORD_BYTES', 64 * 1024),
    maxUserBytes: envInt('STORAGE_MAX_USER_BYTES', 50 * 1024 * 1024),
  };
}

/** How many failures or issues a refusal lists before summarising the rest. */
const LIST_CAP = 20;

/**
 * A UserError that also carries the HTTP status the REST plane answers with
 * (404 for a missing collection or record, 503 without a database). The MCP
 * side ignores it; on REST every other UserError is the caller's mistake, 400.
 */
function statusError(status: 404 | 503, message: string): UserError {
  return Object.assign(new UserError(message), { code: status });
}

/**
 * The pool, or an error that says why there is none. Never an empty answer:
 * "no collections" and "no database" must not look the same.
 */
function requirePool(deps: StorageOpsDeps): StoragePool {
  const pool = deps.pool();
  if (!pool) {
    throw statusError(503, 'Storage is unavailable: this service has no database connection (DATABASE_URL and REDIS_URL must both be set).');
  }
  return pool;
}

function requireUser(userId: number | undefined): number {
  if (typeof userId !== 'number') throw new UserError('Storage needs a signed-in user; this session has none.');
  return userId;
}

async function requireCollection(q: Queryable, userId: number, name: string, forUpdate = false): Promise<Collection> {
  const collection = await getCollection(q, userId, name, forUpdate);
  if (!collection) {
    throw statusError(404, `There is no collection "${name}". Call listCollections to see the ones that exist.`);
  }
  return collection;
}

const bytesOf = (data: unknown): number => Buffer.byteLength(JSON.stringify(data), 'utf8');

function capped(lines: string[]): string {
  const shown = lines.slice(0, LIST_CAP).map((l) => `  - ${l}`);
  if (lines.length > LIST_CAP) shown.push(`  - …and ${lines.length - LIST_CAP} more`);
  return shown.join('\n');
}

/** A record as the model sees it: system fields (leading _) first, then its data. */
function present(row: RecordRow, collection: Collection, now: number): Record<string, unknown> {
  const exactAgeDays = (now - Date.parse(row.updatedAt)) / 86_400_000;
  const system: Record<string, unknown> = { _id: row.id };
  if (collection.keyField) system._key = row.key;
  system._createdAt = row.createdAt;
  system._updatedAt = row.updatedAt;
  system._ageDays = Math.round(exactAgeDays * 10) / 10;
  // Against the unrounded age: 30.04 days is stale under ttlDays 30, though it displays as 30.
  if (collection.ttlDays) system._stale = exactAgeDays > collection.ttlDays;
  return { ...system, ...row.data };
}

function describeShape(c: { description: string; fields: Fields; keyField: string | null; ttlDays: number | null }) {
  return { description: c.description, keyField: c.keyField, ttlDays: c.ttlDays, fields: c.fields };
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export async function opListCollections(userId: number | undefined, deps = defaultStorageOpsDeps) {
  const uid = requireUser(userId);
  const collections = await listCollections(requirePool(deps), uid);
  return {
    count: collections.length,
    collections: collections.map((c) => ({
      name: c.name,
      description: c.description,
      version: c.version,
      keyField: c.keyField,
      ttlDays: c.ttlDays,
      fields: Object.keys(c.fields),
      records: c.records,
      bytes: c.bytes,
      lastWriteAt: c.lastWriteAt,
    })),
    limits: storageLimits(),
  };
}

export async function opDescribeCollection(userId: number | undefined, args: { collection: string }, deps = defaultStorageOpsDeps) {
  const uid = requireUser(userId);
  const pool = requirePool(deps);
  const c = await requireCollection(pool, uid, args.collection);
  const [stats, migrations] = await Promise.all([collectionStats(pool, c.id), listMigrations(pool, c.id, 10)]);
  return {
    name: c.name,
    version: c.version,
    ...describeShape(c),
    records: stats.records,
    bytes: stats.bytes,
    createdAt: c.createdAt,
    schemaChangedAt: c.updatedAt,
    lastWriteAt: c.lastWriteAt,
    recentMigrations: migrations,
    ...(c.version > 1 + migrations.length ? { note: `Showing the last ${migrations.length} migrations of ${c.version - 1}.` } : {}),
  };
}

export async function opCreateCollection(
  userId: number | undefined,
  args: { collection: string; description: string; fields: Fields; keyField?: string; ttlDays?: number },
  deps = defaultStorageOpsDeps,
) {
  const uid = requireUser(userId);
  const pool = requirePool(deps);
  const problems = fieldsProblems(args.fields);
  if (args.keyField) {
    const problem = keyFieldProblem(args.fields, args.keyField);
    if (problem) problems.push(problem);
  }
  if (problems.length) throw new UserError(`The collection was not created:\n${capped(problems)}`);

  const limits = storageLimits();
  try {
    return await withUserWriteLock(pool, uid, async (q) => {
      const usage = await userUsage(q, uid);
      if (usage.collections >= limits.maxCollections) {
        throw new UserError(`You already have ${usage.collections} collections, the limit is ${limits.maxCollections}. Reuse one, or drop one you no longer need.`);
      }
      const c = await insertCollection(q, uid, {
        name: args.collection,
        description: args.description,
        fields: args.fields,
        keyField: args.keyField ?? null,
        ttlDays: args.ttlDays ?? null,
      });
      return { created: c.name, version: c.version, ...describeShape(c) };
    });
  } catch (err: any) {
    if (err?.code === UNIQUE_VIOLATION) {
      throw new UserError(`A collection named "${args.collection}" already exists. Call describeCollection to see its schema, and migrateCollection to change it.`);
    }
    throw err;
  }
}

const MIGRATION_SAMPLES = 3;

function migrationReport(c: Collection, plan: MigrationPlan, recordsTotal: number) {
  return {
    recordsTotal,
    recordsChanged: plan.changed.length,
    failureCount: plan.failures.length,
    failures: plan.failures.slice(0, LIST_CAP),
    ...(plan.failures.length > LIST_CAP ? { failuresNote: `Showing ${LIST_CAP} of ${plan.failures.length} failures.` } : {}),
    samples: plan.changed.slice(0, MIGRATION_SAMPLES).map(({ id, before, after }) => ({ id, before, after })),
    ...(plan.changed.length > MIGRATION_SAMPLES
      ? { samplesNote: `Showing ${MIGRATION_SAMPLES} of ${plan.changed.length} changed records.` }
      : {}),
    schemaBefore: describeShape(c),
    schemaAfter: describeShape(plan.shape),
  };
}

function plan(c: Collection, records: RecordRow[], ops: MigrationOp[], maxRecordBytes: number): MigrationPlan {
  let result: MigrationPlan;
  try {
    result = planMigration(c, records, ops);
  } catch (err) {
    if (err instanceof MigrationError) throw new UserError(`The migration was refused: ${err.message}`);
    throw err;
  }
  for (const change of result.changed) {
    const bytes = bytesOf(change.after);
    if (bytes > maxRecordBytes) result.failures.push({ id: change.id, reason: `would be ${bytes} bytes, over the ${maxRecordBytes}-byte record limit` });
  }
  return result;
}

/**
 * Why the user's byte quota refuses this plan, or null. A migration can grow
 * every record (a default on each one), so it is held to the same total that
 * inserts and updates are.
 */
async function migrationQuotaProblem(q: Queryable, userId: number, records: RecordRow[], result: MigrationPlan): Promise<string | null> {
  const before = new Map(records.map((r) => [r.id, r.bytes]));
  const delta = result.changed.reduce((n, c) => n + bytesOf(c.after) - (before.get(c.id) ?? 0), 0);
  if (delta <= 0) return null;
  const { maxUserBytes } = storageLimits();
  const usage = await userUsage(q, userId);
  return usage.bytes + delta > maxUserBytes
    ? `it would grow your storage by ${delta} bytes to ${usage.bytes + delta}, over the ${maxUserBytes}-byte limit`
    : null;
}

export async function opMigrateCollection(
  userId: number | undefined,
  args: { collection: string; reason: string; operations: MigrationOp[]; dryRun: boolean },
  deps = defaultStorageOpsDeps,
) {
  const uid = requireUser(userId);
  const pool = requirePool(deps);
  const { maxRecordBytes } = storageLimits();

  if (args.dryRun) {
    const c = await requireCollection(pool, uid, args.collection);
    const records = await loadAllRecords(pool, c.id);
    const result = plan(c, records, args.operations, maxRecordBytes);
    const quota = await migrationQuotaProblem(pool, uid, records, result);
    let status = 'DRY RUN — nothing was changed. Call again with dryRun: false to apply it.';
    if (result.failures.length) {
      status = 'DRY RUN — nothing was changed. Applying this migration would be REFUSED: some records cannot be migrated (see failures). Give a default, or fix those records first.';
    } else if (quota) {
      status = `DRY RUN — nothing was changed. Applying this migration would be REFUSED: ${quota}.`;
    }
    return {
      status,
      collection: c.name,
      currentVersion: c.version,
      ...migrationReport(c, result, records.length),
    };
  }

  return withUserWriteLock(pool, uid, async (q) => {
    const c = await requireCollection(q, uid, args.collection, true);
    const records = await loadAllRecords(q, c.id);
    const result = plan(c, records, args.operations, maxRecordBytes);
    if (result.failures.length) {
      const lines = result.failures.map((f) => `record ${f.id}: ${f.reason}`);
      throw new UserError(`The migration was not applied — ${result.failures.length} of ${records.length} record(s) cannot be migrated. Nothing was changed.\n${capped(lines)}`);
    }
    const quota = await migrationQuotaProblem(q, uid, records, result);
    if (quota) throw new UserError(`The migration was not applied — ${quota}. Nothing was changed.`);
    const version = await applyMigration(q, c, result.shape, result.changed, args.operations, args.reason);
    return {
      status: `Applied. "${c.name}" is now version ${version}.`,
      collection: c.name,
      previousVersion: c.version,
      version,
      ...migrationReport(c, result, records.length),
    };
  });
}

export async function opDropCollection(userId: number | undefined, args: { collection: string; confirm: string }, deps = defaultStorageOpsDeps) {
  const uid = requireUser(userId);
  if (args.confirm !== args.collection) {
    throw new UserError(`Not dropped: confirm must repeat the collection name exactly ("${args.collection}"), got "${args.confirm}".`);
  }
  const pool = requirePool(deps);
  return withUserWriteLock(pool, uid, async (q) => {
    const c = await requireCollection(q, uid, args.collection);
    const stats = await collectionStats(q, c.id);
    const deleted = await deleteCollection(q, c.id);
    if (deleted === 0) throw new UserError(`"${args.collection}" was not dropped: it no longer exists (deleted concurrently?).`);
    return { dropped: c.name, recordsDeleted: stats.records };
  });
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export async function opInsertRecords(
  userId: number | undefined,
  args: { collection: string; records: unknown[]; onConflict: 'error' | 'update' },
  deps = defaultStorageOpsDeps,
) {
  const uid = requireUser(userId);
  const pool = requirePool(deps);
  const limits = storageLimits();
  // Everything from the schema read to the insert holds the user's write
  // lock: a concurrent migration cannot change the schema under the
  // validation, and two inserts cannot both pass the same quota totals.
  return withUserWriteLock(pool, uid, async (q) => {
    const c = await requireCollection(q, uid, args.collection);
    const upsert = args.onConflict === 'update';
    if (upsert && !c.keyField) {
      throw new UserError(`onConflict "update" needs a keyField, and "${c.name}" has none. Set one with migrateCollection (setOptions), or insert with onConflict "error".`);
    }

    const issues: string[] = [];
    const rows: Array<{ id: string; key: string | null; data: Record<string, unknown>; bytes: number }> = [];
    const batchKeys = new Map<string, number>();
    args.records.forEach((record, i) => {
      const validation = validateRecord(c.fields, record);
      if (!validation.ok) {
        issues.push(`records[${i}]: ${validation.issues.join('; ')}`);
        return;
      }
      const bytes = bytesOf(validation.data);
      if (bytes > limits.maxRecordBytes) {
        issues.push(`records[${i}]: ${bytes} bytes, over the ${limits.maxRecordBytes}-byte record limit`);
        return;
      }
      const key = keyOf(validation.data, c.keyField);
      if (c.keyField && key === null) {
        // An empty key would be stored as NULL, which UNIQUE never compares
        // equal: duplicates would slip in and the record could not be found by key.
        issues.push(`records[${i}]: keyField "${c.keyField}" must not be empty`);
        return;
      }
      if (key !== null) {
        const first = batchKeys.get(key);
        if (first !== undefined) {
          issues.push(`records[${i}]: ${c.keyField} ${JSON.stringify(key)} repeats records[${first}] in this batch`);
          return;
        }
        batchKeys.set(key, i);
      }
      rows.push({ id: deps.newId(), key, data: validation.data, bytes });
    });
    if (issues.length) {
      throw new UserError(`Nothing was written — ${issues.length} of ${args.records.length} record(s) do not match the schema of "${c.name}" (call describeCollection to see it):\n${capped(issues)}`);
    }

    const existing = await recordsByKeys(q, c.id, [...batchKeys.keys()]);
    if (existing.length && !upsert) {
      throw new UserError(`Nothing was written — ${existing.length} record(s) already exist with these ${c.keyField} values: ${existing.slice(0, 10).map((e) => JSON.stringify(e.key)).join(', ')}${existing.length > 10 ? ', …' : ''}. Use onConflict "update" to replace them.`);
    }

    const stats = await collectionStats(q, c.id);
    const usage = await userUsage(q, uid);
    const newCount = stats.records + rows.length - existing.length;
    if (newCount > limits.maxRecords) {
      throw new UserError(`Nothing was written — "${c.name}" would hold ${newCount} records, the limit is ${limits.maxRecords}.`);
    }
    const newBytes = usage.bytes + rows.reduce((n, r) => n + r.bytes, 0) - existing.reduce((n, e) => n + e.bytes, 0);
    if (newBytes > limits.maxUserBytes) {
      throw new UserError(`Nothing was written — your storage would use ${newBytes} bytes, the limit is ${limits.maxUserBytes}. Delete records or collections you no longer need.`);
    }

    const written = await insertRecords(q, c.id, rows, upsert);
    const created = written.filter((w) => w.inserted).length;
    return {
      collection: c.name,
      created,
      updated: written.length - created,
      records: written.map((w) => (c.keyField ? { _id: w.id, _key: w.key } : { _id: w.id })),
    };
  });
}

/** Exactly one of id / key, and key only on a collection that has a keyField. */
function recordRef(c: Collection, args: { id?: string; key?: string }): { id: string } | { key: string } {
  if ((args.id === undefined) === (args.key === undefined)) {
    throw new UserError('Give exactly one of id or key.');
  }
  if (args.key !== undefined) {
    if (!c.keyField) throw new UserError(`"${c.name}" has no keyField, so records can only be addressed by id.`);
    return { key: args.key };
  }
  return { id: args.id as string };
}

function describeRef(ref: { id: string } | { key: string }): string {
  return 'id' in ref ? `id ${JSON.stringify(ref.id)}` : `key ${JSON.stringify(ref.key)}`;
}

export async function opGetRecord(userId: number | undefined, args: { collection: string; id?: string; key?: string }, deps = defaultStorageOpsDeps) {
  const uid = requireUser(userId);
  const pool = requirePool(deps);
  const c = await requireCollection(pool, uid, args.collection);
  const ref = recordRef(c, args);
  const row = await getRecord(pool, c.id, ref);
  if (!row) throw statusError(404, `No record with ${describeRef(ref)} in "${c.name}".`);
  return present(row, c, deps.now());
}

export async function opUpdateRecord(
  userId: number | undefined,
  args: { collection: string; id?: string; key?: string; set?: Record<string, unknown>; unset?: string[] },
  deps = defaultStorageOpsDeps,
) {
  const uid = requireUser(userId);
  const pool = requirePool(deps);
  const set = args.set ?? {};
  const unset = args.unset ?? [];
  if (Object.keys(set).length === 0 && unset.length === 0) throw new UserError('Nothing to update: give set, unset, or both.');
  const both = unset.filter((f) => Object.hasOwn(set, f));
  if (both.length) throw new UserError(`${both.join(', ')} appear in both set and unset.`);

  // The read-modify-write holds the user's write lock, so a concurrent update
  // of another field cannot be overwritten by this one's stale copy.
  return withUserWriteLock(pool, uid, async (q) => {
    const c = await requireCollection(q, uid, args.collection);
    const ref = recordRef(c, args);
    const unknownUnset = unset.filter((f) => !fieldOf(c.fields, f));
    if (unknownUnset.length) throw new UserError(`unset names field(s) the schema does not have: ${unknownUnset.join(', ')}.`);

    const current = await getRecord(q, c.id, ref);
    if (!current) throw statusError(404, `No record with ${describeRef(ref)} in "${c.name}".`);
    const merged: Record<string, unknown> = { ...current.data, ...set };
    for (const f of unset) delete merged[f];
    const validation = validateRecord(c.fields, merged);
    if (!validation.ok) throw new UserError(`Not updated — the result would not match the schema:\n${capped(validation.issues)}`);

    const limits = storageLimits();
    const bytes = bytesOf(validation.data);
    if (bytes > limits.maxRecordBytes) throw new UserError(`Not updated — the record would be ${bytes} bytes, over the ${limits.maxRecordBytes}-byte limit.`);
    const usage = await userUsage(q, uid);
    if (usage.bytes - current.bytes + bytes > limits.maxUserBytes) {
      throw new UserError(`Not updated — your storage would exceed its ${limits.maxUserBytes}-byte limit.`);
    }
    const key = keyOf(validation.data, c.keyField);
    if (c.keyField && key === null) {
      throw new UserError(`Not updated — keyField "${c.keyField}" must not be empty: the record could no longer be found by key.`);
    }
    if (key !== null && key !== current.key) {
      const clash = await recordsByKeys(q, c.id, [key]);
      if (clash.length) throw new UserError(`Not updated — record ${clash[0].id} already has ${c.keyField} ${JSON.stringify(key)}.`);
    }

    const row = await updateRecord(q, c.id, current.id, validation.data, key, bytes);
    if (!row) throw statusError(404, `Not updated — the record with ${describeRef(ref)} no longer exists (deleted concurrently?).`);
    return present(row, c, deps.now());
  });
}

export async function opDeleteRecords(
  userId: number | undefined,
  args: { collection: string; ids?: string[]; keys?: string[] },
  deps = defaultStorageOpsDeps,
) {
  const uid = requireUser(userId);
  if ((args.ids === undefined) === (args.keys === undefined)) throw new UserError('Give exactly one of ids or keys.');
  const pool = requirePool(deps);
  return withUserWriteLock(pool, uid, async (q) => {
    const c = await requireCollection(q, uid, args.collection);
    if (args.keys !== undefined && !c.keyField) throw new UserError(`"${c.name}" has no keyField, so records can only be deleted by id.`);
    const requested = (args.ids ?? args.keys) as string[];
    const deleted = await deleteRecords(q, c.id, args.ids ? { ids: args.ids } : { keys: requested });
    const found = new Set(deleted.map((d) => (args.ids ? d.id : d.key)));
    const notFound = requested.filter((r) => !found.has(r));
    return {
      collection: c.name,
      deleted: deleted.length,
      deletedIds: deleted.map((d) => d.id),
      notFound,
    };
  });
}

// ---------------------------------------------------------------------------
// findRecords
// ---------------------------------------------------------------------------

const RANGE_TYPES: ReadonlySet<FieldType> = new Set(['number', 'integer', 'datetime', 'string', 'url']);
const TEXT_TYPES: ReadonlySet<FieldType> = new Set(['string', 'url']);

/** Converts a where value to the field's type, refusing what cannot be. */
function whereValue(field: string, def: FieldDef, value: unknown): unknown {
  // Enums are dropped here: filtering on a value outside the enum is a valid
  // question with an empty answer, not an error.
  const loose: FieldDef = { ...def, enum: undefined };
  const converted = convertValue(value, def.type);
  const problem = converted.ok ? valueProblem(loose, converted.value) : converted.reason;
  if (problem !== null || !converted.ok) throw new UserError(`where on "${field}" (${def.type}): ${problem}`);
  return converted.value;
}

function toCondition(c: Collection, w: { field: string; op: WhereOp; value?: unknown }): Condition {
  const def = fieldOf(c.fields, w.field);
  if (!def) throw new UserError(`where names "${w.field}", which is not a field of "${c.name}". Fields: ${Object.keys(c.fields).join(', ')}.`);
  const refuse = (allowed: string): never => {
    throw new UserError(`where on "${w.field}" (${def.type}): op "${w.op}" is not supported; use ${allowed}.`);
  };
  if (w.op === 'exists') {
    if (w.value !== undefined && typeof w.value !== 'boolean') throw new UserError(`where on "${w.field}": exists takes true or false (default true).`);
    return { field: w.field, type: def.type, op: 'exists', value: w.value ?? true };
  }
  if (w.value === undefined) throw new UserError(`where on "${w.field}": op "${w.op}" needs a value.`);
  if (def.type === 'json') refuse('exists (json fields are not queryable; search them with the top-level contains text)');
  if (def.type === 'string[]' || def.type === 'number[]') {
    if (w.op !== 'contains') refuse('contains (an element) or exists');
    const element: FieldDef = { ...def, type: def.type === 'string[]' ? 'string' : 'number', enum: undefined };
    return { field: w.field, type: def.type, op: 'contains', value: whereValue(w.field, element, w.value) };
  }
  if (w.op === 'contains') {
    if (!TEXT_TYPES.has(def.type)) refuse('eq, ne, gt, gte, lt, lte, in or exists');
    if (typeof w.value !== 'string') throw new UserError(`where on "${w.field}": contains takes a string.`);
    return { field: w.field, type: def.type, op: 'contains', value: w.value };
  }
  if (w.op === 'in') {
    if (!Array.isArray(w.value) || w.value.length === 0 || w.value.length > 100) {
      throw new UserError(`where on "${w.field}": in takes an array of 1-100 values.`);
    }
    return { field: w.field, type: def.type, op: 'in', value: w.value.map((v) => whereValue(w.field, def, v)) };
  }
  if ((w.op === 'gt' || w.op === 'gte' || w.op === 'lt' || w.op === 'lte') && !RANGE_TYPES.has(def.type)) refuse('eq, ne, in or exists');
  return { field: w.field, type: def.type, op: w.op, value: whereValue(w.field, def, w.value) };
}

/**
 * A keyset cursor: the last record returned (its sort value and id), the sort
 * it belongs to, the schema version it was read under (a migration can change
 * the sort field's type), and how many records came before, for the note.
 */
interface Cursor {
  v: number;
  by: string;
  dir: 'asc' | 'desc';
  k: string | null;
  id: string;
  n: number;
}

function decodeCursor(cursor: string): Cursor {
  try {
    const p = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Number.isInteger(p?.v) && typeof p.by === 'string' && (p.dir === 'asc' || p.dir === 'desc')
      && (p.k === null || typeof p.k === 'string') && typeof p.id === 'string' && Number.isInteger(p.n) && p.n >= 0
    ) return p;
  } catch { /* fall through */ }
  throw new UserError('cursor is not one this tool returned. Pass nextCursor from a previous findRecords call unchanged, or omit it.');
}

const encodeCursor = (cursor: Cursor): string => Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

export async function opFindRecords(
  userId: number | undefined,
  args: {
    collection: string;
    where?: Array<{ field: string; op: WhereOp; value?: unknown }>;
    contains?: string;
    updatedWithinDays?: number;
    orderBy?: string;
    order: 'asc' | 'desc';
    limit: number;
    cursor?: string;
  },
  deps = defaultStorageOpsDeps,
) {
  const uid = requireUser(userId);
  const pool = requirePool(deps);
  const c = await requireCollection(pool, uid, args.collection);
  const conditions = (args.where ?? []).map((w) => toCondition(c, w));

  const orderByName = args.orderBy ?? '_updatedAt';
  let orderBy: FindQuery['orderBy'] = '_updatedAt';
  if (args.orderBy && args.orderBy !== '_updatedAt') {
    if (args.orderBy === '_createdAt') orderBy = '_createdAt';
    else {
      const def = fieldOf(c.fields, args.orderBy);
      if (!def) throw new UserError(`orderBy "${args.orderBy}" is not a field of "${c.name}"; use a field name, _updatedAt or _createdAt.`);
      if (!SCALAR_TYPES.has(def.type)) throw new UserError(`orderBy "${args.orderBy}" is ${def.type}; only single-value fields can be sorted on.`);
      orderBy = { field: args.orderBy, type: def.type };
    }
  }

  const cursor = args.cursor ? decodeCursor(args.cursor) : null;
  if (cursor && (cursor.by !== orderByName || cursor.dir !== args.order)) {
    throw new UserError(`cursor belongs to a query sorted by ${cursor.by} ${cursor.dir}, not ${orderByName} ${args.order}. Keep orderBy and order unchanged while paging, or omit cursor to start over.`);
  }
  if (cursor && cursor.v !== c.version) {
    throw new UserError(`"${c.name}" was migrated (version ${cursor.v} → ${c.version}) since this cursor was issued. Run the query again without cursor.`);
  }
  const seen = cursor?.n ?? 0;
  const query: FindQuery = {
    conditions,
    text: args.contains,
    updatedWithinDays: args.updatedWithinDays,
    orderBy,
    order: args.order,
    // One extra row says whether another page exists, whatever total did meanwhile.
    limit: args.limit + 1,
    after: cursor ? { sortKey: cursor.k, id: cursor.id } : undefined,
  };
  const page = await findRecords(pool, c.id, query);
  const more = page.records.length > args.limit;
  const records = page.records.slice(0, args.limit);
  const total = records.length === 0 && cursor ? await countMatches(pool, c.id, query) : page.total;
  const last = records.at(-1);
  const nextCursor = more && last
    ? encodeCursor({ v: c.version, by: orderByName, dir: args.order, k: last.sortKey, id: last.id, n: seen + records.length })
    : null;
  const now = deps.now();
  return {
    collection: c.name,
    total,
    returned: records.length,
    nextCursor,
    ...(nextCursor ? { note: `Showing ${seen + 1}-${seen + records.length} of ${total} matches. Pass nextCursor to continue.` } : {}),
    records: records.map((r) => present(r, c, now)),
  };
}
