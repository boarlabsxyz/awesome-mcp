// src/__tests__/peopleforceSnapshot.test.ts
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { PeopleForceClient, customFieldEntries } from '../peopleforce/apiHelpers.js';
import {
  employeeRows,
  customFieldRows,
  employeeSkillRows,
  objectiveRows,
  kpiRows,
  kbArticleRows,
  employeeDimRows,
  employeeTableCellRows,
} from '../peopleforce/snapshot/rows.js';
import { insertRows, fetchAllPages, runSnapshot, SnapshotDb } from '../peopleforce/snapshot/collect.js';
import { resolveOwners, ownerKey, normalizeName } from '../peopleforce/snapshot/resolve.js';
import { classifyObjectives, deriveCompletion, textHash, CLASSIFIER_VERSION } from '../peopleforce/snapshot/classify.js';

const CAP = '2026-08-08T00:00:00.000Z';

// -----------------------------------------------------------------------------
// customFieldEntries — structured normalizer shared with the display formatter
// -----------------------------------------------------------------------------

describe('customFieldEntries', () => {
  test('returns {name,value} pairs and strips HTML from values', () => {
    assert.deepEqual(customFieldEntries([{ name: 'Dev Sprint', value: '<strong>S1</strong>' }]), [
      { name: 'Dev Sprint', value: 'S1' },
    ]);
  });
  test('handles the name->value map shape and drops blanks', () => {
    assert.deepEqual(customFieldEntries({ 'Dev Sprint': 'S2', Empty: '' }), [{ name: 'Dev Sprint', value: 'S2' }]);
  });
});

// -----------------------------------------------------------------------------
// Row transforms (pure)
// -----------------------------------------------------------------------------

describe('snapshot row transforms', () => {
  test('employeeRows maps refs and skips id-less records', () => {
    const rows = employeeRows(
      [
        { id: 1, full_name: 'Ada', email: 'ada@x.io', active: true, department: { id: 2, name: 'Eng' }, position: 'Dev' },
        { full_name: 'No ID' },
      ],
      CAP,
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      captured_at: CAP,
      employee_id: '1',
      full_name: 'Ada',
      email: 'ada@x.io',
      active: true,
      department: 'Eng',
      division: null,
      position: 'Dev',
    });
  });

  test('customFieldRows flattens tenant fields per employee', () => {
    const rows = customFieldRows(
      [
        { id: 1, custom_fields: [{ name: 'Dev Sprint', value: 'S1' }, { name: 'Blank', value: '' }] },
        { id: 2, custom_field_values: { Course: 'Scrum' } as any },
        { custom_fields: [{ name: 'Orphan', value: 'x' }] }, // no id -> skipped
      ],
      CAP,
    );
    assert.deepEqual(rows, [
      { captured_at: CAP, employee_id: '1', field_name: 'Dev Sprint', field_value: 'S1' },
      { captured_at: CAP, employee_id: '2', field_name: 'Course', field_value: 'Scrum' },
    ]);
  });

  test('employeeSkillRows expands per-employee skills', () => {
    const rows = employeeSkillRows(
      [{ employeeId: 9, skills: [{ level: 'expert', skill: { id: 3, name: 'React' } }] }],
      CAP,
    );
    assert.deepEqual(rows, [
      { captured_at: CAP, employee_id: '9', skill_id: '3', skill_name: 'React', level: 'expert' },
    ]);
  });

  test('objectiveRows surfaces owner id/email/name and progress', () => {
    const rows = objectiveRows(
      [{ id: 5, title: 'Course', owner: { id: 2, first_name: 'Dasha', last_name: 'Nori', email: 'd@x.io' }, progress: 50, status: 'on_track', starts_on: '2026-01-01', ends_on: '2026-06-30' }],
      CAP,
    );
    assert.deepEqual(rows[0], {
      captured_at: CAP,
      objective_id: '5',
      title: 'Course',
      owner_id: '2',
      owner_email: 'd@x.io',
      owner_name: 'Dasha Nori',
      progress: 50,
      status: 'on_track',
      starts_on: '2026-01-01',
      ends_on: '2026-06-30',
    });
  });

  test('kpiRows resolves scope from department/division/location', () => {
    const rows = kpiRows(
      [{ id: 7, title: 'KPI', kpi_type: 'department', department: { id: 1, name: 'Eng' }, progress_percentage: 80, status: 'behind' }],
      CAP,
    );
    assert.equal(rows[0].scope, 'Eng');
    assert.equal(rows[0].progress_percentage, 80);
  });
});

// -----------------------------------------------------------------------------
// insertRows — parameterized SQL builder
// -----------------------------------------------------------------------------

function fakeDb() {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const db: SnapshotDb & { calls: typeof calls } = {
    calls,
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      // RETURNING id (run-log) — not used here, but keep shape sane.
      return { rows: [{ id: 1 }] };
    },
  };
  return db;
}

describe('insertRows', () => {
  test('builds one multi-row parameterized insert and coalesces undefined to null', async () => {
    const db = fakeDb();
    const n = await insertRows(db, 't', ['a', 'b'], [{ a: 1, b: 2 }, { a: 3, b: undefined }]);
    assert.equal(n, 2);
    const call = db.calls.find((c) => c.text.startsWith('INSERT INTO t'));
    assert.ok(call);
    assert.match(call!.text, /\(\$1, \$2\), \(\$3, \$4\)/);
    assert.deepEqual(call!.params, [1, 2, 3, null]);
  });

  test('no rows -> no query, returns 0', async () => {
    const db = fakeDb();
    const n = await insertRows(db, 't', ['a'], []);
    assert.equal(n, 0);
    assert.equal(db.calls.length, 0);
  });
});

// -----------------------------------------------------------------------------
// fetchAllPages + runSnapshot — orchestration against a stubbed API + fake DB
// -----------------------------------------------------------------------------

function stubApi(handler: (url: string) => unknown) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    const body = handler(url);
    return {
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }) as any;
  return () => {
    globalThis.fetch = original;
  };
}

describe('runSnapshot', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    if (restore) restore();
    restore = null;
  });

  test('fetchAllPages walks to the reported last page', async () => {
    restore = stubApi((url) => {
      const page = Number(new URL(url).searchParams.get('page') || '1');
      return { data: [{ id: page }], metadata: { pagination: { page, pages: 3 } } };
    });
    const client = new PeopleForceClient('k');
    const all = await fetchAllPages((page) => client.listObjectives({ page }));
    assert.deepEqual(all.map((o: any) => o.id), [1, 2, 3]);
  });

  test('captures employees, custom fields, skills, objectives and KPIs into the DB', async () => {
    restore = stubApi((url) => {
      if (/\/employees\/\d+\/skills/.test(url)) {
        return { data: [{ level: 'expert', skill: { id: 1, name: 'React' } }] };
      }
      if (/\/employees\/\d+\/tables\//.test(url)) {
        return {
          internal_name: 'dev_sprint',
          name: 'Dev Sprint',
          rows: [{ id: 1, columns: { ds_name: 'Int Mar-Apr', attendance: [{ value: 'Launch WS' }, { value: 'peer 1' }] } }],
        };
      }
      if (/\/employee_tables(\?|$)/.test(url)) {
        return { data: [{ EmployeeTable: { internal_name: 'dev_sprint', name: 'Dev Sprint' } }], metadata: { pagination: { page: 1, pages: 1 } } };
      }
      if (/\/employees(\?|$)/.test(url)) {
        return {
          data: [{ id: 101, full_name: 'Ada', custom_fields: [{ name: 'Dev Sprint', value: 'S1' }] }],
          metadata: { pagination: { page: 1, pages: 1 } },
        };
      }
      if (/\/performance\/objectives/.test(url)) {
        return { data: [{ id: 5, title: 'Course', owner: { id: 2, email: 'a@b.io' }, progress: 50 }], metadata: { pagination: { page: 1, pages: 1 } } };
      }
      if (/key_performance_indicators/.test(url)) {
        return { data: [{ id: 7, title: 'KPI', kpi_type: 'individual', progress_percentage: 80 }], metadata: { pagination: { page: 1, pages: 1 } } };
      }
      return { data: [] };
    });

    const client = new PeopleForceClient('k');
    const db = fakeDb();
    const result = await runSnapshot({ client, db, capturedAt: CAP });

    assert.deepEqual(result.counts, {
      employees: 1,
      custom_fields: 1,
      employee_skills: 1,
      objectives: 1,
      kpis: 1,
      kb_articles: 0,
      table_cells: 3, // ds_name (1) + attendance (2 chips expanded)
      employee_dim: 1,
      owner_resolutions: 1,
      owners_unresolved: 1,
    });
    // Tables ensured + rows inserted.
    assert.ok(db.calls.some((c) => /CREATE TABLE IF NOT EXISTS pf_employee_skill_snapshot/.test(c.text)));
    const skillInsert = db.calls.find((c) => c.text.startsWith('INSERT INTO pf_employee_skill_snapshot'));
    assert.ok(skillInsert, 'expected a skills insert');
    assert.ok(skillInsert!.params?.includes('React'));
    // Attendance chips landed as expanded cell rows.
    const cellInsert = db.calls.find((c) => c.text.startsWith('INSERT INTO pf_employee_table_cell_snapshot'));
    assert.ok(cellInsert, 'expected a table-cell insert');
    assert.ok(cellInsert!.params?.includes('Launch WS'));
    assert.ok(cellInsert!.params?.includes('peer 1'));
  });
});

describe('employeeTableCellRows', () => {
  test('flattens rows and expands multi-select cells to one row per value', () => {
    const rows = employeeTableCellRows(
      [
        {
          employeeId: 101,
          table: {
            internal_name: 'dev_sprint_participation',
            name: 'Dev Sprint participation',
            rows: [
              {
                id: 11,
                columns: {
                  ds_name: 'Int Mar-Apr 26',
                  coach: { id: 2, full_name: 'Tania Shum' },
                  attendance: [{ id: 1, value: 'Launch WS' }, { id: 2, value: 'peer 1' }, { id: 3, value: 'Retro' }],
                  note: '',
                },
              },
            ],
          },
        },
      ],
      CAP,
    );
    // ds_name(1) + coach(1) + attendance(3) = 5; empty note dropped
    assert.equal(rows.length, 5);
    const attendance = rows.filter((r) => r.column_name === 'attendance').map((r) => r.value);
    assert.deepEqual(attendance, ['Launch WS', 'peer 1', 'Retro']);
    assert.deepEqual(rows.find((r) => r.column_name === 'coach')!.value, 'Tania Shum');
    assert.equal(rows[0].employee_id, '101');
    assert.equal(rows[0].table_internal_name, 'dev_sprint_participation');
    assert.equal(rows[0].row_id, '11');
  });
});

// -----------------------------------------------------------------------------
// Feature A — KB article rows
// -----------------------------------------------------------------------------

describe('kbArticleRows', () => {
  test('maps article with category and author, keeps created_at', () => {
    const rows = kbArticleRows(
      [{ id: 3, title: 'Onboarding 101', category: { id: 1, name: 'HR' }, created_by: { id: 9, first_name: 'Nelly', last_name: 'S' }, created_at: '2024-02-01T00:00:00Z' }],
      CAP,
    );
    assert.deepEqual(rows[0], {
      captured_at: CAP,
      article_id: '3',
      title: 'Onboarding 101',
      category_id: '1',
      category_name: 'HR',
      author_id: '9',
      author_name: 'Nelly S',
      created_at: '2024-02-01T00:00:00Z',
      updated_at: null,
    });
  });
});

// -----------------------------------------------------------------------------
// Feature B — employee dimension + owner resolution
// -----------------------------------------------------------------------------

describe('employeeDimRows', () => {
  test('produces upsertable current-state rows keyed by employee_id', () => {
    const rows = employeeDimRows([{ id: 1, full_name: 'Ada', email: 'ada@x.io', department: { id: 2, name: 'Eng' }, active: true }], CAP);
    assert.deepEqual(rows[0], {
      employee_id: '1', full_name: 'Ada', email: 'ada@x.io', department: 'Eng',
      division: null, position: null, active: true, updated_at: CAP,
    });
  });
});

describe('resolveOwners', () => {
  const emps = [
    { employee_id: '1', full_name: 'Dasha Nori', email: 'dasha@x.io' },
    { employee_id: '2', full_name: 'Kate Chapman', email: 'kate@x.io' },
    { employee_id: '3', full_name: 'Kate Chapman', email: 'kate2@x.io' }, // duplicate name
  ];

  test('ownerKey/normalizeName normalize case, whitespace and punctuation', () => {
    assert.equal(normalizeName('  Dasha,  NORI '), 'dasha nori');
    assert.equal(ownerKey({ email: 'A@B.io' }), 'email:a@b.io');
    assert.equal(ownerKey({ name: 'Dasha Nori' }), 'name:dasha nori');
    assert.equal(ownerKey({}), null);
  });

  test('matches by id, email, and unique normalized name; leaves ambiguous/unknown unresolved', () => {
    const { resolutions, unmatched } = resolveOwners(
      [
        { email: 'dasha@x.io' },            // email -> 1
        { name: '  DASHA   nori ' },         // name -> 1
        { name: 'Kate Chapman' },            // ambiguous -> unresolved
        { employee_id: '2', email: 'x@y' },  // id -> 2
        { name: 'Nobody Here' },             // unresolved
      ],
      emps,
    );
    const byKey = Object.fromEntries(resolutions.map((r) => [r.owner_key, r]));
    assert.equal(byKey['email:dasha@x.io'].method, 'email');
    assert.equal(byKey['email:dasha@x.io'].employee_id, '1');
    assert.equal(byKey['name:dasha nori'].method, 'name');
    assert.equal(byKey['name:dasha nori'].employee_id, '1');
    assert.equal(byKey['name:kate chapman'].method, 'unresolved');
    assert.equal(byKey['email:x@y'].method, 'id');
    assert.equal(byKey['email:x@y'].employee_id, '2');
    assert.equal(unmatched.length, 2);
  });

  test('never re-resolves a manual-override key', () => {
    const manual = new Set(['email:dasha@x.io']);
    const { resolutions } = resolveOwners([{ email: 'dasha@x.io' }], emps, manual);
    assert.equal(resolutions.length, 0);
  });
});

// -----------------------------------------------------------------------------
// Feature C — objective LLM classifier
// -----------------------------------------------------------------------------

describe('classifier helpers', () => {
  test('deriveCompletion maps progress to a status', () => {
    assert.equal(deriveCompletion(100), 'completed');
    assert.equal(deriveCompletion(40), 'in_progress');
    assert.equal(deriveCompletion(0), 'not_started');
    assert.equal(deriveCompletion(null), null);
  });
  test('textHash is stable and content-sensitive', () => {
    assert.equal(textHash('x'), textHash('x'));
    assert.notEqual(textHash('x'), textHash('y'));
  });
});

function classifyFakeDb() {
  const inserted = new Set<string>();
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const db: SnapshotDb & { inserted: Set<string>; calls: typeof calls } = {
    inserted,
    calls,
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      if (/CREATE TABLE|CREATE INDEX/.test(text)) return { rows: [] };
      if (/SELECT 1 FROM pf_objective_classification/.test(text)) {
        const key = `${params![0]}|${params![1]}|${params![2]}`;
        return { rows: inserted.has(key) ? [{ one: 1 }] : [] };
      }
      if (/INSERT INTO pf_objective_classification/.test(text)) {
        inserted.add(`${params![0]}|${params![1]}|${params![2]}`);
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  return db;
}

describe('classifyObjectives', () => {
  const objectives = [
    { objective_id: '1', title: 'Complete the Scrum course', progress: 100 },
    { objective_id: '2', title: 'Ship feature X', progress: 50 },
    { objective_id: '3', title: 'maybe a course?', progress: 0 },
  ];

  test('classifies each objective once, flags low confidence, and is idempotent', async () => {
    const db = classifyFakeDb();
    let calls = 0;
    const classifier = async ({ text }: { objectiveId: string; text: string }) => {
      calls++;
      return {
        is_learning: /course/i.test(text),
        activity_type: 'course' as const,
        provider: null,
        confidence: text.includes('maybe') ? 0.4 : 0.9,
      };
    };

    const res = await classifyObjectives({ db, classifier, modelId: 'test-model', classifiedAt: CAP, objectives });
    assert.deepEqual(res, { classified: 3, skipped: 0, needsReview: 1 });
    assert.equal(calls, 3);

    // completion derived from progress, not the LLM
    const insert1 = db.calls.find((c) => /INSERT INTO pf_objective_classification/.test(c.text) && c.params![0] === '1');
    assert.equal(insert1!.params![8], 'completed'); // completion column
    const insert2 = db.calls.find((c) => /INSERT INTO pf_objective_classification/.test(c.text) && c.params![0] === '2');
    assert.equal(insert2!.params![8], 'in_progress');

    // second run: everything cached, no new classifier calls
    const res2 = await classifyObjectives({ db, classifier, modelId: 'test-model', classifiedAt: CAP, objectives });
    assert.deepEqual(res2, { classified: 0, skipped: 3, needsReview: 0 });
    assert.equal(calls, 3);
  });

  test('CLASSIFIER_VERSION is part of the cache key', () => {
    assert.equal(typeof CLASSIFIER_VERSION, 'number');
  });
});
