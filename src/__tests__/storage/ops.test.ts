import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { UserError } from 'fastmcp';
import {
  opCreateCollection,
  opDeleteRecords,
  opDropCollection,
  opFindRecords,
  opGetRecord,
  opInsertRecords,
  opListCollections,
  opMigrateCollection,
  opUpdateRecord,
  type StorageOpsDeps,
} from '../../storage/ops.js';
import { buildFindSql, likePattern } from '../../storage/store.js';

// Answers each query with the rows registered for the first pattern it matches.
function makePool(responses: Array<[RegExp, any[] | ((params: any[]) => any[])]>) {
  const calls: Array<{ text: string; params: any[] }> = [];
  return {
    calls,
    query: async (text: string, params: any[] = []) => {
      calls.push({ text, params });
      const hit = responses.find(([re]) => re.test(text));
      const rows = hit ? (typeof hit[1] === 'function' ? hit[1](params) : hit[1]) : [];
      return { rows, rowCount: rows.length };
    },
  };
}

type Pool = ReturnType<typeof makePool>;

function deps(pool: Pool | null): StorageOpsDeps {
  let n = 0;
  return { pool: () => pool, newId: () => `id${++n}`, now: () => Date.parse('2026-11-04T00:00:00Z') };
}

const collectionRow = {
  id: 9,
  name: 'people',
  description: 'People researched on LinkedIn',
  fields: {
    profileUrl: { type: 'url', required: true, description: 'LinkedIn URL' },
    name: { type: 'string', required: true, description: 'Full name' },
    followers: { type: 'integer', required: false, description: 'Followers' },
    skills: { type: 'string[]', required: false, description: 'Skills' },
  },
  key_field: 'profileUrl',
  ttl_days: 30,
  version: 1,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
};

const recordRow = (id: string, data: Record<string, unknown>, updatedAt = '2026-10-01T00:00:00Z') => ({
  id,
  key: data.profileUrl,
  data,
  bytes: 50,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: updatedAt,
  total: 1,
});

const SELECT_COLLECTION = /FROM storage_collections WHERE user_id/;
const ada = { profileUrl: 'https://l.in/ada', name: 'Ada' };

const savedEnv = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith('STORAGE_')) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

async function rejects(p: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(p, (e: any) => e instanceof UserError && pattern.test(e.message));
}

describe('without a database or a user', () => {
  it('says so instead of answering empty', async () => {
    await rejects(opListCollections(1, deps(null)), /no database connection/);
    await rejects(opListCollections(undefined, deps(makePool([]))), /signed-in user/);
  });
});

describe('collections', () => {
  it('a missing collection points at listCollections', async () => {
    await rejects(opGetRecord(1, { collection: 'nope', id: 'x' }, deps(makePool([]))), /listCollections/);
  });

  it('refuses a bad schema before touching the database', async () => {
    const pool = makePool([]);
    await rejects(
      opCreateCollection(1, { collection: 'c', description: 'd', fields: { name: { type: 'json', required: false, description: 'x' } }, keyField: 'name' }, deps(pool)),
      /a key must be a string/,
    );
    assert.equal(pool.calls.length, 0);
  });

  it('enforces the collection quota', async () => {
    process.env.STORAGE_MAX_COLLECTIONS = '2';
    const pool = makePool([[/AS collections/, [{ collections: 2, bytes: 0 }]]]);
    await rejects(
      opCreateCollection(1, { collection: 'c', description: 'd', fields: { a: { type: 'string', required: false, description: 'x' } } }, deps(pool)),
      /limit is 2/,
    );
  });

  it('turns a duplicate name into a pointer at describeCollection', async () => {
    const pool = makePool([[/AS collections/, [{ collections: 0, bytes: 0 }]]]);
    pool.query = (async (text: string) => {
      if (/INSERT INTO storage_collections/.test(text)) throw Object.assign(new Error('dup'), { code: '23505' });
      return { rows: [{ collections: 0, bytes: 0 }], rowCount: 1 };
    }) as any;
    await rejects(
      opCreateCollection(1, { collection: 'c', description: 'd', fields: { a: { type: 'string', required: false, description: 'x' } } }, deps(pool)),
      /already exists.*describeCollection/,
    );
  });

  it('dropCollection needs the name repeated', async () => {
    const pool = makePool([]);
    await rejects(opDropCollection(1, { collection: 'people', confirm: 'People' }, deps(pool)), /repeat the collection name/);
    assert.equal(pool.calls.length, 0);
  });
});

describe('insertRecords', () => {
  const base = (): Array<[RegExp, any]> => [
    [SELECT_COLLECTION, [collectionRow]],
    [/AS collections/, [{ collections: 1, bytes: 0 }]],
    [/count\(\*\) AS records/, [{ records: 0, bytes: 0 }]],
  ];

  it('is all or nothing: one bad record rejects the batch with per-index issues', async () => {
    const pool = makePool(base());
    await rejects(
      opInsertRecords(1, { collection: 'people', records: [ada, { profileUrl: 'https://l.in/x', name: 'X', title: 'CTO' }], onConflict: 'error' }, deps(pool)),
      /Nothing was written[\s\S]*records\[1\]: unknown field\(s\) "title"/,
    );
    assert.ok(!pool.calls.some((c) => /INSERT INTO storage_records/.test(c.text)));
  });

  it('refuses a key repeated inside the batch', async () => {
    await rejects(
      opInsertRecords(1, { collection: 'people', records: [ada, ada], onConflict: 'update' }, deps(makePool(base()))),
      /repeats records\[0\]/,
    );
  });

  it('refuses existing keys unless onConflict is update', async () => {
    const pool = makePool([...base(), [/key = ANY/, [{ id: 'old', key: ada.profileUrl, bytes: 40 }]]]);
    await rejects(opInsertRecords(1, { collection: 'people', records: [ada], onConflict: 'error' }, deps(pool)), /onConflict "update"/);
  });

  it('upserts and reports created vs updated from the database answer', async () => {
    const pool = makePool([
      ...base(),
      [/key = ANY/, [{ id: 'old', key: ada.profileUrl, bytes: 40 }]],
      [/INSERT INTO storage_records/, [{ id: 'old', key: ada.profileUrl, inserted: false }, { id: 'id2', key: 'https://l.in/bo', inserted: true }]],
    ]);
    const result = await opInsertRecords(1, { collection: 'people', records: [ada, { profileUrl: 'https://l.in/bo', name: 'Bo' }], onConflict: 'update' }, deps(pool));
    assert.equal(result.created, 1);
    assert.equal(result.updated, 1);
    const insert = pool.calls.find((c) => /INSERT INTO storage_records/.test(c.text))!;
    assert.match(insert.text, /ON CONFLICT \(collection_id, key\) DO UPDATE/);
  });

  it('enforces the record-count quota, counting upserts as no growth', async () => {
    process.env.STORAGE_MAX_RECORDS = '1';
    const pool = makePool([[SELECT_COLLECTION, [collectionRow]], [/AS collections/, [{ collections: 1, bytes: 0 }]], [/count\(\*\) AS records/, [{ records: 1, bytes: 50 }]]]);
    await rejects(opInsertRecords(1, { collection: 'people', records: [ada], onConflict: 'error' }, deps(pool)), /would hold 2 records, the limit is 1/);
  });

  it('enforces the per-record size limit', async () => {
    process.env.STORAGE_MAX_RECORD_BYTES = '20';
    await rejects(opInsertRecords(1, { collection: 'people', records: [ada], onConflict: 'error' }, deps(makePool(base()))), /record limit/);
  });
});

describe('records by id or key', () => {
  it('needs exactly one of id and key', async () => {
    const pool = makePool([[SELECT_COLLECTION, [collectionRow]]]);
    await rejects(opGetRecord(1, { collection: 'people' }, deps(pool)), /exactly one of id or key/);
    await rejects(opGetRecord(1, { collection: 'people', id: 'a', key: 'b' }, deps(pool)), /exactly one of id or key/);
  });

  it('presents system fields, age and staleness', async () => {
    const pool = makePool([[SELECT_COLLECTION, [collectionRow]], [/FROM storage_records WHERE collection_id = \$1 AND key/, [recordRow('r1', ada)]]]);
    const record = await opGetRecord(1, { collection: 'people', key: ada.profileUrl }, deps(pool));
    assert.equal(record._id, 'r1');
    assert.equal(record._key, ada.profileUrl);
    assert.equal(record._ageDays, 34);
    assert.equal(record._stale, true);
    assert.equal(record.name, 'Ada');
  });

  it('updateRecord validates the merged record and reports not-found instead of succeeding', async () => {
    const pool = makePool([[SELECT_COLLECTION, [collectionRow]], [/SELECT \* FROM storage_records/, [recordRow('r1', ada)]]]);
    await rejects(opUpdateRecord(1, { collection: 'people', id: 'r1', unset: ['name'] }, deps(pool)), /would not match the schema/);
    await rejects(opUpdateRecord(1, { collection: 'people', id: 'r1', set: { followers: 3 } }, deps(pool)), /no longer exists/);

    const empty = makePool([[SELECT_COLLECTION, [collectionRow]]]);
    await rejects(opUpdateRecord(1, { collection: 'people', id: 'gone', set: { followers: 3 } }, deps(empty)), /No record with id "gone"/);
  });

  it('deleteRecords reports what it did not find', async () => {
    const pool = makePool([[SELECT_COLLECTION, [collectionRow]], [/DELETE FROM storage_records/, [{ id: 'r1', key: ada.profileUrl }]]]);
    const result = await opDeleteRecords(1, { collection: 'people', ids: ['r1', 'r9'] }, deps(pool));
    assert.equal(result.deleted, 1);
    assert.deepEqual(result.notFound, ['r9']);
  });
});

describe('findRecords', () => {
  const find = { collection: 'people', order: 'desc' as const, limit: 25 };

  it('refuses unknown fields and ops that do not fit the type', async () => {
    const pool = makePool([[SELECT_COLLECTION, [collectionRow]]]);
    await rejects(opFindRecords(1, { ...find, where: [{ field: 'title', op: 'eq', value: 'x' }] }, deps(pool)), /not a field of "people"/);
    await rejects(opFindRecords(1, { ...find, where: [{ field: 'skills', op: 'eq', value: 'x' }] }, deps(pool)), /use contains/);
    await rejects(opFindRecords(1, { ...find, where: [{ field: 'followers', op: 'gt', value: 'many' }] }, deps(pool)), /followers/);
    await rejects(opFindRecords(1, { ...find, cursor: 'garbage' }, deps(pool)), /cursor/);
  });

  it('pages with a total and a cursor', async () => {
    const rows = [recordRow('r1', ada), recordRow('r2', { profileUrl: 'https://l.in/b', name: 'B' })].map((r) => ({ ...r, total: 5 }));
    const pool = makePool([[SELECT_COLLECTION, [collectionRow]], [/count\(\*\) OVER/, rows]]);
    const page = await opFindRecords(1, { ...find, limit: 2 }, deps(pool));
    assert.equal(page.total, 5);
    assert.equal(page.returned, 2);
    assert.ok(page.nextCursor);
    assert.match(page.note!, /1-2 of 5/);

    const last = makePool([[SELECT_COLLECTION, [collectionRow]], [/count\(\*\) OVER/, [{ ...rows[0], total: 5 }]]]);
    const end = await opFindRecords(1, { ...find, limit: 2, cursor: Buffer.from('{"o":4}').toString('base64url') }, deps(last));
    assert.equal(end.nextCursor, null);
  });

  it('converts where values to the field type', async () => {
    const pool = makePool([[SELECT_COLLECTION, [collectionRow]], [/count\(\*\) OVER/, []]]);
    await opFindRecords(1, { ...find, where: [{ field: 'followers', op: 'gte', value: '100' }] }, deps(pool));
    const sql = pool.calls.find((c) => /count\(\*\) OVER/.test(c.text))!;
    assert.ok(sql.params.includes(100));
  });
});

describe('buildFindSql', () => {
  it('binds field names as parameters, never into the SQL text', () => {
    const evil = "x'); DROP TABLE users; --";
    const { text, params } = buildFindSql(9, {
      conditions: [
        { field: evil, type: 'integer', op: 'gt', value: 3 },
        { field: 'skills', type: 'string[]', op: 'contains', value: 'ts' },
        { field: 'name', type: 'string', op: 'contains', value: '50%' },
      ],
      text: 'ada',
      updatedWithinDays: 30,
      orderBy: { field: evil, type: 'integer' },
      order: 'asc',
      limit: 10,
      offset: 20,
    });
    assert.ok(!text.includes('DROP'));
    assert.ok(params.includes(evil));
    assert.match(text, /\(r\.data ->> \$2\)::numeric > \$3::numeric/);
    assert.match(text, /@> \$5::jsonb/);
    assert.ok(params.includes('["ts"]'));
    assert.ok(params.includes('%50\\%%'));
    assert.match(text, /ORDER BY \(r\.data ->> \$\d+\)::numeric ASC NULLS LAST/);
  });

  it('escapes LIKE wildcards', () => {
    assert.equal(likePattern('a_b%c\\'), '%a\\_b\\%c\\\\%');
  });
});

describe('migrateCollection', () => {
  const op = { op: 'addField' as const, field: 'company', type: 'string' as const, required: true, description: 'Employer', default: 'unknown' };

  it('dry run plans without writing', async () => {
    const pool = makePool([[SELECT_COLLECTION, [collectionRow]], [/SELECT \* FROM storage_records/, [recordRow('r1', ada)]]]);
    const result = await opMigrateCollection(1, { collection: 'people', reason: 'track employer', operations: [op], dryRun: true }, deps(pool));
    assert.match(result.status, /DRY RUN — nothing was changed/);
    assert.equal(result.recordsChanged, 1);
    assert.ok(!pool.calls.some((c) => /^\s*(UPDATE|INSERT)/.test(c.text)));
  });

  it('applies: locks the collection, bumps the version, records the reason', async () => {
    const pool = makePool([[SELECT_COLLECTION, [collectionRow]], [/SELECT \* FROM storage_records/, [recordRow('r1', ada)]]]);
    const result = await opMigrateCollection(1, { collection: 'people', reason: 'track employer', operations: [op], dryRun: false }, deps(pool));
    assert.equal((result as any).version, 2);
    assert.ok(pool.calls.some((c) => /FOR UPDATE/.test(c.text)));
    const history = pool.calls.find((c) => /INSERT INTO storage_migrations/.test(c.text))!;
    assert.deepEqual(history.params.slice(1, 3), [2, 'track employer']);
  });

  it('refuses to apply when any record cannot migrate, writing nothing', async () => {
    const pool = makePool([[SELECT_COLLECTION, [collectionRow]], [/SELECT \* FROM storage_records/, [recordRow('r1', ada)]]]);
    await rejects(
      opMigrateCollection(1, { collection: 'people', reason: 'r', operations: [{ op: 'changeField', field: 'followers', required: true }], dryRun: false }, deps(pool)),
      /not applied[\s\S]*record r1/,
    );
    assert.ok(!pool.calls.some((c) => /UPDATE storage_collections/.test(c.text)));
  });

  it('turns a planner refusal into a UserError', async () => {
    const pool = makePool([[SELECT_COLLECTION, [collectionRow]], [/SELECT \* FROM storage_records/, [recordRow('r1', ada)]]]);
    await rejects(
      opMigrateCollection(1, { collection: 'people', reason: 'r', operations: [{ op: 'removeField', field: 'profileUrl' }], dryRun: true }, deps(pool)),
      /migration was refused.*keyField/,
    );
  });
});
