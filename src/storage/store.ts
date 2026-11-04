// Every SQL statement the Storage MCP runs (DDL is in src/db.ts). Field names
// from the model only ever reach Postgres as bound parameters — `data->>$3` —
// never spliced into the SQL text.
import { getPool, isDatabaseAvailable } from '../db.js';
import type { FieldType, Fields } from './fieldSchema.js';
import type { CollectionShape, MigrationOp, PlannedChange } from './migrations.js';

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}
export interface StoragePool extends Queryable {
  connect?(): Promise<Queryable & { release(): void }>;
}

let testPool: StoragePool | null = null;

/** Test seam: route the store to a fake pool (null restores the real one). */
export function __setStoragePoolForTests(pool: StoragePool | null): void {
  testPool = pool;
}

/** The pool, or null when this service has no database. */
export function storagePool(): StoragePool | null {
  if (testPool) return testPool;
  if (!isDatabaseAvailable()) return null;
  return getPool() as unknown as StoragePool;
}

/** Runs fn in one transaction. A pool without connect() (a test fake) runs it directly. */
export async function withTransaction<T>(pool: StoragePool, fn: (q: Queryable) => Promise<T>): Promise<T> {
  if (!pool.connect) return fn(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Advisory-lock namespace for Storage writes (the two-key form keeps it apart from any other user of advisory locks). */
const STORAGE_LOCK_NAMESPACE = 0x5354; // 'ST'

/**
 * Runs fn in one transaction holding the user's Storage write lock. Every
 * write takes it, so one user's writes run one at a time: quota checks
 * cannot race (two inserts both passing the same totals), a write cannot
 * validate against a schema a concurrent migration is replacing, and an
 * update's read-modify-write cannot lose a concurrent change. Reads take no
 * lock. Users never wait on each other.
 */
export async function withUserWriteLock<T>(pool: StoragePool, userId: number, fn: (q: Queryable) => Promise<T>): Promise<T> {
  return withTransaction(pool, async (q) => {
    await q.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [STORAGE_LOCK_NAMESPACE, userId]);
    return fn(q);
  });
}

export interface Collection extends CollectionShape {
  id: number;
  name: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RecordRow {
  id: string;
  key: string | null;
  data: Record<string, unknown>;
  bytes: number;
  createdAt: string;
  updatedAt: string;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

function toCollection(row: any): Collection {
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description,
    fields: row.fields as Fields,
    keyField: row.key_field ?? null,
    ttlDays: row.ttl_days ?? null,
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toRecord(row: any): RecordRow {
  return {
    id: row.id,
    key: row.key ?? null,
    data: row.data,
    bytes: Number(row.bytes),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** Postgres unique-violation code, for "already exists" answers. */
export const UNIQUE_VIOLATION = '23505';

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export async function getCollection(q: Queryable, userId: number, name: string, forUpdate = false): Promise<Collection | null> {
  const { rows } = await q.query(
    `SELECT * FROM storage_collections WHERE user_id = $1 AND name = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [userId, name],
  );
  return rows[0] ? toCollection(rows[0]) : null;
}

export interface CollectionSummary extends Collection {
  records: number;
  bytes: number;
  lastWriteAt: string | null;
}

export async function listCollections(q: Queryable, userId: number): Promise<CollectionSummary[]> {
  const { rows } = await q.query(
    `SELECT c.*, count(r.id) AS records, coalesce(sum(r.bytes), 0) AS total_bytes, max(r.updated_at) AS last_write_at
       FROM storage_collections c
       LEFT JOIN storage_records r ON r.collection_id = c.id
      WHERE c.user_id = $1
      GROUP BY c.id
      ORDER BY c.name`,
    [userId],
  );
  return rows.map((row) => ({
    ...toCollection(row),
    records: Number(row.records),
    bytes: Number(row.total_bytes),
    lastWriteAt: row.last_write_at ? iso(row.last_write_at) : null,
  }));
}

/** What one user already holds, for the quota checks. */
export async function userUsage(q: Queryable, userId: number): Promise<{ collections: number; bytes: number }> {
  const { rows } = await q.query(
    `SELECT (SELECT count(*) FROM storage_collections WHERE user_id = $1) AS collections,
            (SELECT coalesce(sum(r.bytes), 0) FROM storage_records r
               JOIN storage_collections c ON c.id = r.collection_id WHERE c.user_id = $1) AS bytes`,
    [userId],
  );
  return { collections: Number(rows[0]?.collections ?? 0), bytes: Number(rows[0]?.bytes ?? 0) };
}

export async function collectionStats(q: Queryable, collectionId: number): Promise<{ records: number; bytes: number }> {
  const { rows } = await q.query(
    'SELECT count(*) AS records, coalesce(sum(bytes), 0) AS bytes FROM storage_records WHERE collection_id = $1',
    [collectionId],
  );
  return { records: Number(rows[0]?.records ?? 0), bytes: Number(rows[0]?.bytes ?? 0) };
}

export async function insertCollection(
  q: Queryable,
  userId: number,
  c: { name: string; description: string; fields: Fields; keyField: string | null; ttlDays: number | null },
): Promise<Collection> {
  const { rows } = await q.query(
    `INSERT INTO storage_collections (user_id, name, description, fields, key_field, ttl_days)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING *`,
    [userId, c.name, c.description, JSON.stringify(c.fields), c.keyField, c.ttlDays],
  );
  return toCollection(rows[0]);
}

export async function deleteCollection(q: Queryable, collectionId: number): Promise<number> {
  const { rowCount } = await q.query('DELETE FROM storage_collections WHERE id = $1', [collectionId]);
  return rowCount ?? 0;
}

export interface MigrationRow {
  version: number;
  reason: string;
  operations: MigrationOp[];
  recordsAffected: number;
  appliedAt: string;
}

export async function listMigrations(q: Queryable, collectionId: number, limit: number): Promise<MigrationRow[]> {
  const { rows } = await q.query(
    `SELECT version, reason, operations, records_affected, applied_at FROM storage_migrations
      WHERE collection_id = $1 ORDER BY version DESC LIMIT $2`,
    [collectionId, limit],
  );
  return rows.map((row) => ({
    version: Number(row.version),
    reason: row.reason,
    operations: row.operations,
    recordsAffected: Number(row.records_affected),
    appliedAt: iso(row.applied_at),
  }));
}

/**
 * Writes a planned migration: the changed records, the new shape, the version
 * bump and the history row. Must run inside withTransaction, with the
 * collection locked FOR UPDATE. Records keep their updated_at — a migration
 * reshapes data, it does not refresh it, and updated_at is what freshness
 * (_ageDays, _stale) is measured from.
 */
export async function applyMigration(
  q: Queryable,
  collection: Collection,
  shape: CollectionShape,
  changed: PlannedChange[],
  ops: MigrationOp[],
  reason: string,
): Promise<number> {
  if (changed.length > 0) {
    // Keys are cleared first, then set: records may swap keys, and setting
    // them one by one would trip UNIQUE (collection_id, key) midway.
    const ids = changed.map((c) => c.id);
    await q.query('UPDATE storage_records SET key = NULL WHERE collection_id = $1 AND id = ANY($2::text[])', [collection.id, ids]);
    const rows = changed.map((c) => {
      const json = JSON.stringify(c.after);
      return { id: c.id, data: c.after, key: c.key, bytes: Buffer.byteLength(json, 'utf8') };
    });
    await q.query(
      `UPDATE storage_records r SET data = x.data, key = x.key, bytes = x.bytes
         FROM jsonb_to_recordset($2::jsonb) AS x(id text, data jsonb, key text, bytes int)
        WHERE r.collection_id = $1 AND r.id = x.id`,
      [collection.id, JSON.stringify(rows)],
    );
  }
  const version = collection.version + 1;
  await q.query(
    `UPDATE storage_collections SET description = $2, fields = $3::jsonb, key_field = $4, ttl_days = $5,
            version = $6, updated_at = now() WHERE id = $1`,
    [collection.id, shape.description, JSON.stringify(shape.fields), shape.keyField, shape.ttlDays, version],
  );
  await q.query(
    `INSERT INTO storage_migrations (collection_id, version, reason, operations, records_affected)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [collection.id, version, reason, JSON.stringify(ops), changed.length],
  );
  return version;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export async function loadAllRecords(q: Queryable, collectionId: number): Promise<RecordRow[]> {
  const { rows } = await q.query(
    'SELECT * FROM storage_records WHERE collection_id = $1 ORDER BY created_at, id',
    [collectionId],
  );
  return rows.map(toRecord);
}

/** Existing records with any of these keys, for upsert and duplicate checks. */
export async function recordsByKeys(q: Queryable, collectionId: number, keys: string[]): Promise<Array<{ id: string; key: string; bytes: number }>> {
  if (keys.length === 0) return [];
  const { rows } = await q.query(
    'SELECT id, key, bytes FROM storage_records WHERE collection_id = $1 AND key = ANY($2::text[])',
    [collectionId, keys],
  );
  return rows.map((row) => ({ id: row.id, key: row.key, bytes: Number(row.bytes) }));
}

export interface NewRecord {
  id: string;
  key: string | null;
  data: Record<string, unknown>;
  bytes: number;
}

/**
 * Inserts records; with upsert, a record whose key exists replaces that
 * record's data. Returns each row's id and whether it was newly inserted
 * (xmax = 0 is Postgres's tell for an INSERT rather than an ON CONFLICT UPDATE).
 */
export async function insertRecords(
  q: Queryable,
  collectionId: number,
  records: NewRecord[],
  upsert: boolean,
): Promise<Array<{ id: string; key: string | null; inserted: boolean }>> {
  const conflict = upsert
    ? 'ON CONFLICT (collection_id, key) DO UPDATE SET data = EXCLUDED.data, bytes = EXCLUDED.bytes, updated_at = now()'
    : '';
  const { rows } = await q.query(
    `INSERT INTO storage_records (id, collection_id, key, data, bytes)
     SELECT x.id, $1, x.key, x.data, x.bytes
       FROM jsonb_to_recordset($2::jsonb) AS x(id text, key text, data jsonb, bytes int)
     ${conflict}
     RETURNING id, key, (xmax = 0) AS inserted`,
    [collectionId, JSON.stringify(records)],
  );
  return rows.map((row) => ({ id: row.id, key: row.key ?? null, inserted: row.inserted === true }));
}

export type RecordRef = { id: string } | { key: string };

export async function getRecord(q: Queryable, collectionId: number, ref: RecordRef): Promise<RecordRow | null> {
  const [column, value] = 'id' in ref ? ['id', ref.id] : ['key', ref.key];
  const { rows } = await q.query(
    `SELECT * FROM storage_records WHERE collection_id = $1 AND ${column} = $2`,
    [collectionId, value],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function updateRecord(
  q: Queryable,
  collectionId: number,
  id: string,
  data: Record<string, unknown>,
  key: string | null,
  bytes: number,
): Promise<RecordRow | null> {
  const { rows } = await q.query(
    `UPDATE storage_records SET data = $3::jsonb, key = $4, bytes = $5, updated_at = now()
      WHERE collection_id = $1 AND id = $2 RETURNING *`,
    [collectionId, id, JSON.stringify(data), key, bytes],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function deleteRecords(
  q: Queryable,
  collectionId: number,
  by: { ids: string[] } | { keys: string[] },
): Promise<Array<{ id: string; key: string | null }>> {
  const [column, values] = 'ids' in by ? ['id', by.ids] : ['key', by.keys];
  const { rows } = await q.query(
    `DELETE FROM storage_records WHERE collection_id = $1 AND ${column} = ANY($2::text[]) RETURNING id, key`,
    [collectionId, values],
  );
  return rows.map((row) => ({ id: row.id, key: row.key ?? null }));
}

// ---------------------------------------------------------------------------
// findRecords
// ---------------------------------------------------------------------------

export type WhereOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'exists';

/** One condition, already checked against the schema and with values converted to the field's type. */
export interface Condition {
  field: string;
  type: FieldType;
  op: WhereOp;
  value: unknown;
}

export interface FindQuery {
  conditions: Condition[];
  text?: string;
  updatedWithinDays?: number;
  orderBy: { field: string; type: FieldType } | '_updatedAt' | '_createdAt';
  order: 'asc' | 'desc';
  limit: number;
  offset: number;
}

/** Escapes LIKE wildcards so a search for "50%" matches the text "50%". */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const PG_CAST: Partial<Record<FieldType, string>> = {
  number: 'numeric',
  integer: 'numeric',
  datetime: 'timestamptz',
  boolean: 'boolean',
};

/** The SQL text for a condition; pushes its parameters onto params. */
function conditionSql(c: Condition, params: unknown[]): string {
  const p = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const f = p(c.field);
  if (c.op === 'exists') return c.value === false ? `NOT (r.data ? ${f})` : `(r.data ? ${f})`;
  if (c.type === 'string[]' || c.type === 'number[]') {
    // Only `contains` reaches here (ops.ts refuses the rest for arrays).
    return `(r.data -> ${f}) @> ${p(JSON.stringify([c.value]))}::jsonb`;
  }
  const cast = PG_CAST[c.type];
  const expr = cast ? `(r.data ->> ${f})::${cast}` : `(r.data ->> ${f})`;
  const typed = (value: unknown): string => (cast ? `${p(value)}::${cast}` : p(value));
  switch (c.op) {
    case 'eq': return `${expr} = ${typed(c.value)}`;
    case 'ne': return `${expr} IS DISTINCT FROM ${typed(c.value)}`;
    case 'gt': return `${expr} > ${typed(c.value)}`;
    case 'gte': return `${expr} >= ${typed(c.value)}`;
    case 'lt': return `${expr} < ${typed(c.value)}`;
    case 'lte': return `${expr} <= ${typed(c.value)}`;
    case 'in': return `${expr} = ANY(${p(c.value)}::${cast ?? 'text'}[])`;
    case 'contains': return `(r.data ->> ${f}) ILIKE ${p(likePattern(String(c.value)))}`;
  }
}

/** Builds the findRecords statement. Exported for tests. */
export function buildFindSql(collectionId: number, query: FindQuery): { text: string; params: unknown[] } {
  const params: unknown[] = [collectionId];
  const where = ['r.collection_id = $1'];
  for (const c of query.conditions) where.push(conditionSql(c, params));
  if (query.text) {
    params.push(likePattern(query.text));
    where.push(`r.data::text ILIKE $${params.length}`);
  }
  if (query.updatedWithinDays !== undefined) {
    params.push(query.updatedWithinDays);
    where.push(`r.updated_at >= now() - make_interval(days => $${params.length})`);
  }
  const dir = query.order === 'asc' ? 'ASC' : 'DESC';
  let orderExpr: string;
  if (query.orderBy === '_updatedAt') orderExpr = 'r.updated_at';
  else if (query.orderBy === '_createdAt') orderExpr = 'r.created_at';
  else {
    params.push(query.orderBy.field);
    const cast = PG_CAST[query.orderBy.type];
    orderExpr = cast ? `(r.data ->> $${params.length})::${cast}` : `(r.data ->> $${params.length})`;
  }
  params.push(query.limit);
  const limitParam = `$${params.length}`;
  params.push(query.offset);
  const offsetParam = `$${params.length}`;
  const text = `SELECT r.*, count(*) OVER () AS total FROM storage_records r
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderExpr} ${dir} NULLS LAST, r.id ${dir}
    LIMIT ${limitParam} OFFSET ${offsetParam}`;
  return { text, params };
}

export async function findRecords(q: Queryable, collectionId: number, query: FindQuery): Promise<{ records: RecordRow[]; total: number }> {
  const { text, params } = buildFindSql(collectionId, query);
  const { rows } = await q.query(text, params);
  return { records: rows.map(toRecord), total: rows.length ? Number(rows[0].total) : 0 };
}

/**
 * Total when a page comes back empty: count(*) OVER () has no row to ride on
 * past the last page, and "0 total" there would read as "no matches".
 */
export async function countMatches(q: Queryable, collectionId: number, query: FindQuery): Promise<number> {
  const { text, params } = buildFindSql(collectionId, { ...query, limit: 1, offset: 0 });
  const { rows } = await q.query(text, params);
  return rows.length ? Number(rows[0].total) : 0;
}
