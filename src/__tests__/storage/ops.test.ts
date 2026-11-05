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

// Only the collection read; userUsage's subquery also says "FROM storage_collections WHERE user_id".
const SELECT_COLLECTION = /SELECT \* FROM storage_collections WHERE user_id/;
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

  const found = (id: string, sortKey: string | null) => ({ ...recordRow(id, { profileUrl: `https://l.in/${id}`, name: id }), total: 5, sort_key: sortKey });

  it('pages with a total and a keyset cursor from the last record returned', async () => {
    // limit 2 asks for 3 rows: the third only says another page exists.
    const pool = makePool([[SELECT_COLLECTION, [collectionRow]], [/count\(\*\) OVER/, [found('r1', 'k1'), found('r2', 'k2'), found('r3', 'k3')]]]);
    const page = await opFindRecords(1, { ...find, limit: 2 }, deps(pool));
    assert.equal(page.total, 5);
    assert.equal(page.returned, 2);
    assert.deepEqual(page.records.map((r) => r._id), ['r1', 'r2']);
    assert.match(page.note!, /1-2 of 5/);
    assert.equal(pool.calls.at(-1)!.params.at(-1), 3);

    const next = makePool([[SELECT_COLLECTION, [collectionRow]], [/count\(\*\) OVER/, [found('r3', 'k3')]]]);
    const end = await opFindRecords(1, { ...find, limit: 2, cursor: page.nextCursor! }, deps(next));
    const sql = next.calls.at(-1)!;
    assert.ok(sql.params.includes('r2') && sql.params.includes('k2'), 'continues after the last record returned');
    assert.equal(end.nextCursor, null);
    assert.equal(end.note, undefined);
  });

  it('refuses a cursor from another sort, an older schema version, or the old offset form', async () => {
    const pool = makePool([[SELECT_COLLECTION, [collectionRow]], [/count\(\*\) OVER/, [found('r1', 'k1'), found('r2', 'k2')]]]);
    const { nextCursor } = await opFindRecords(1, { ...find, limit: 1 }, deps(pool));
    await rejects(opFindRecords(1, { ...find, limit: 1, order: 'asc', cursor: nextCursor! }, deps(pool)), /Keep orderBy and order unchanged/);
    await rejects(opFindRecords(1, { ...find, limit: 1, orderBy: '_createdAt', cursor: nextCursor! }, deps(pool)), /sorted by _updatedAt desc/);
    const migrated = makePool([[SELECT_COLLECTION, [{ ...collectionRow, version: 2 }]]]);
    await rejects(opFindRecords(1, { ...find, limit: 1, cursor: nextCursor! }, deps(migrated)), /was migrated \(version 1 → 2\)/);
    await rejects(opFindRecords(1, { ...find, cursor: Buffer.from('{"o":4}').toString('base64url') }, deps(pool)), /cursor is not one/);
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
      after: { sortKey: '42', id: 'r7' },
    });
    assert.ok(!text.includes('DROP'));
    assert.ok(params.includes(evil));
    assert.match(text, /\(r\.data ->> \$2\)::numeric > \$3::numeric/);
    assert.match(text, /@> \$5::jsonb/);
    assert.ok(params.includes('["ts"]'));
    assert.ok(params.includes('%50\\%%'));
    assert.match(text, /\(r\.data ->> \$\d+\)::numeric AS sort_val/);
    assert.match(text, /ORDER BY m\.sort_val ASC NULLS LAST, m\.id ASC/);
  });

  it('pages by keyset in sort order, NULLS LAST, with total counted before the keyset filter', () => {
    const base = { conditions: [], orderBy: '_updatedAt' as const, limit: 26 };
    const desc = buildFindSql(9, { ...base, order: 'desc', after: { sortKey: '2026-10-01 00:00:00+00', id: 'r2' } });
    assert.match(desc.text, /WHERE \(m\.sort_val < \$3::timestamptz OR \(m\.sort_val = \$3::timestamptz AND m\.id < \$2\) OR m\.sort_val IS NULL\)/);
    assert.deepEqual(desc.params, [9, 'r2', '2026-10-01 00:00:00+00', 26]);
    assert.ok(desc.text.indexOf('count(*) OVER ()') < desc.text.indexOf(') m'), 'total is counted inside, before the keyset');

    const nullKey = buildFindSql(9, { ...base, orderBy: { field: 'name', type: 'string' }, order: 'asc', after: { sortKey: null, id: 'r5' } });
    assert.match(nullKey.text, /WHERE m\.sort_val IS NULL AND m\.id > \$3/);
    assert.ok(!/OFFSET/.test(nullKey.text));
  });

  it('escapes LIKE wildcards', () => {
    assert.equal(likePattern('a_b%c\\'), '%a\\_b\\%c\\\\%');
  });
});

describe('concurrency, freshness and keys', () => {
  const LOCK = /pg_advisory_xact_lock/;
  const recordPool = () => makePool([
    [SELECT_COLLECTION, [collectionRow]],
    [/SELECT \* FROM storage_records/, [recordRow('r1', ada)]],
    [/UPDATE storage_records SET data/, [recordRow('r1', ada)]],
    [/DELETE FROM storage_records/, [{ id: 'r1', key: ada.profileUrl }]],
    [/INSERT INTO storage_records/, [{ id: 'id1', key: 'https://l.in/new', inserted: true }]],
    [/DELETE FROM storage_collections/, [{}]],
  ]);

  it('every write takes the per-user lock before reading the schema', async () => {
    const writes: Array<(p: Pool) => Promise<unknown>> = [
      (p) => opInsertRecords(7, { collection: 'people', records: [{ profileUrl: 'https://l.in/new', name: 'N' }], onConflict: 'error' }, deps(p)),
      (p) => opUpdateRecord(7, { collection: 'people', id: 'r1', set: { followers: 1 } }, deps(p)),
      (p) => opDeleteRecords(7, { collection: 'people', ids: ['r1'] }, deps(p)),
      (p) => opMigrateCollection(7, { collection: 'people', reason: 'r', operations: [{ op: 'setOptions', ttlDays: 60 }], dryRun: false }, deps(p)),
      (p) => opDropCollection(7, { collection: 'people', confirm: 'people' }, deps(p)),
    ];
    for (const write of writes) {
      const pool = recordPool();
      await write(pool);
      const lockAt = pool.calls.findIndex((c) => LOCK.test(c.text));
      const schemaAt = pool.calls.findIndex((c) => SELECT_COLLECTION.test(c.text));
      assert.ok(lockAt >= 0 && lockAt < schemaAt, `lock before schema read in ${write}`);
      assert.deepEqual(pool.calls[lockAt].params[1], 7, 'locked per user');
    }
  });

  it('_stale compares the unrounded age with ttlDays', async () => {
    const thirtyDaysAndAnHour = new Date(Date.parse('2026-11-04T00:00:00Z') - (30 * 24 + 1) * 3_600_000).toISOString();
    const pool = makePool([[SELECT_COLLECTION, [collectionRow]], [/SELECT \* FROM storage_records/, [recordRow('r1', ada, thirtyDaysAndAnHour)]]]);
    const record = await opGetRecord(1, { collection: 'people', id: 'r1' }, deps(pool));
    assert.equal(record._ageDays, 30);
    assert.equal(record._stale, true);
  });

  it('every write that changed something marks the collection written, and lastWriteAt reports it', async () => {
    const TOUCH = /SET last_write_at = now\(\)|last_write_at = now\(\) WHERE id/;
    const writes: Array<(p: Pool) => Promise<unknown>> = [
      (p) => opInsertRecords(7, { collection: 'people', records: [{ profileUrl: 'https://l.in/new', name: 'N' }], onConflict: 'error' }, deps(p)),
      (p) => opUpdateRecord(7, { collection: 'people', id: 'r1', set: { followers: 1 } }, deps(p)),
      (p) => opDeleteRecords(7, { collection: 'people', ids: ['r1'] }, deps(p)),
      (p) => opMigrateCollection(7, { collection: 'people', reason: 'r', operations: [{ op: 'setOptions', ttlDays: 60 }], dryRun: false }, deps(p)),
    ];
    for (const write of writes) {
      const pool = recordPool();
      await write(pool);
      assert.ok(pool.calls.some((c) => TOUCH.test(c.text)), `touches the collection in ${write}`);
    }
    const nothingDeleted = makePool([[SELECT_COLLECTION, [collectionRow]]]);
    await opDeleteRecords(7, { collection: 'people', ids: ['gone'] }, deps(nothingDeleted));
    assert.ok(!nothingDeleted.calls.some((c) => TOUCH.test(c.text)), 'a delete that found nothing is not a write');

    const list = makePool([[/FROM storage_collections c/, [{ ...collectionRow, records: 0, total_bytes: 0, last_write: '2026-11-03T00:00:00Z' }]]]);
    const listed = await opListCollections(7, deps(list));
    assert.equal(listed.collections[0].lastWriteAt, '2026-11-03T00:00:00Z');
    assert.match(list.calls[0].text, /coalesce\(c\.last_write_at, max\(r\.updated_at\)\)/);
  });

  it('refuses an empty keyField value on insert and on update', async () => {
    const stringKey = { ...collectionRow, fields: { ...collectionRow.fields, profileUrl: { type: 'string', required: true, description: 'Key' } } };
    const pool = makePool([[SELECT_COLLECTION, [stringKey]], [/SELECT \* FROM storage_records/, [recordRow('r1', ada)]]]);
    await rejects(opInsertRecords(1, { collection: 'people', records: [{ profileUrl: '', name: 'X' }], onConflict: 'error' }, deps(pool)), /must not be empty/);
    await rejects(opUpdateRecord(1, { collection: 'people', id: 'r1', set: { profileUrl: '' } }, deps(pool)), /must not be empty/);
    assert.ok(!pool.calls.some((c) => /INSERT INTO storage_records|UPDATE storage_records SET data/.test(c.text)));
  });
});

describe('migrateCollection', () => {
  const op = { op: 'addField' as const, field: 'company', type: 'string' as const, required: true, description: 'Employer', default: 'unknown' };

  it('dry run plans without writing', async () => {
    const pool = makePool([[SELECT_COLLECTION, [collectionRow]], [/SELECT \* FROM storage_records/, [recordRow('r1', ada)]]]);
    const result = await opMigrateCollection(1, { collection: 'people', reason: 'track employer', operations: [op], dryRun: true }, deps(pool));
    assert.match(result.status, /DRY RUN — nothing was changed/);
    assert.equal(result.recordsChanged, 1);
    assert.equal(result.samplesNote, undefined);
    assert.ok(!pool.calls.some((c) => /^\s*(UPDATE|INSERT)/.test(c.text)));
  });

  it('says when the samples are a subset of the changed records', async () => {
    const four = ['a', 'b', 'c', 'd'].map((x) => recordRow(x, { profileUrl: `https://l.in/${x}`, name: x }));
    const pool = makePool([[SELECT_COLLECTION, [collectionRow]], [/SELECT \* FROM storage_records/, four]]);
    const result = await opMigrateCollection(1, { collection: 'people', reason: 'r', operations: [op], dryRun: true }, deps(pool));
    assert.equal(result.samples.length, 3);
    assert.equal(result.samplesNote, 'Showing 3 of 4 changed records.');
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

  it('holds a migration that grows records to the user byte quota, in the dry run and the apply', async () => {
    process.env.STORAGE_MAX_USER_BYTES = '100';
    const grow = { op: 'addField' as const, field: 'bio', type: 'string' as const, required: true, description: 'Bio', default: 'x'.repeat(80) };
    const pool = () => makePool([
      [SELECT_COLLECTION, [collectionRow]],
      [/SELECT \* FROM storage_records/, [recordRow('r1', ada)]],
      [/AS collections/, [{ collections: 1, bytes: 50 }]],
    ]);
    const dry = await opMigrateCollection(1, { collection: 'people', reason: 'r', operations: [grow], dryRun: true }, deps(pool()));
    assert.match(dry.status, /would be REFUSED: it would grow your storage/);
    const applied = pool();
    await rejects(opMigrateCollection(1, { collection: 'people', reason: 'r', operations: [grow], dryRun: false }, deps(applied)), /not applied.*100-byte limit/);
    assert.ok(!applied.calls.some((c) => /UPDATE storage_collections/.test(c.text)));
  });

  it('turns a planner refusal into a UserError', async () => {
    const pool = makePool([[SELECT_COLLECTION, [collectionRow]], [/SELECT \* FROM storage_records/, [recordRow('r1', ada)]]]);
    await rejects(
      opMigrateCollection(1, { collection: 'people', reason: 'r', operations: [{ op: 'removeField', field: 'profileUrl' }], dryRun: true }, deps(pool)),
      /migration was refused.*keyField/,
    );
  });
});
