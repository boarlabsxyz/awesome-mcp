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
} from '../peopleforce/snapshot/rows.js';
import { insertRows, fetchAllPages, runSnapshot, SnapshotDb } from '../peopleforce/snapshot/collect.js';

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
    });
    // Tables ensured + rows inserted.
    assert.ok(db.calls.some((c) => /CREATE TABLE IF NOT EXISTS pf_employee_skill_snapshot/.test(c.text)));
    const skillInsert = db.calls.find((c) => c.text.startsWith('INSERT INTO pf_employee_skill_snapshot'));
    assert.ok(skillInsert, 'expected a skills insert');
    assert.ok(skillInsert!.params?.includes('React'));
  });
});
