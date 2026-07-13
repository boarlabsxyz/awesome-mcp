// src/__tests__/peopleforce.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { UserError } from 'fastmcp';
import { peopleForceServer } from '../peopleforce/server.js';
import {
  formatEmployeeList,
  formatEmployee,
  formatDepartmentList,
  formatAbsenceList,
  getPeopleForceClient,
} from '../peopleforce/apiHelpers.js';

test('peopleforce server is registered', () => {
  assert.ok(peopleForceServer, 'server should be defined');
});

describe('formatEmployeeList', () => {
  test('handles empty list', () => {
    assert.equal(formatEmployeeList([]), 'No employees found.');
  });

  test('renders employees with names, ids, and departments', () => {
    const out = formatEmployeeList([
      { id: 42, first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', department: { id: 1, name: 'R&D' } },
    ]);
    assert.match(out, /# Employees/);
    assert.match(out, /Ada Lovelace/);
    assert.match(out, /ID: 42/);
    assert.match(out, /Department: R&D/);
  });

  test('renders pagination when meta is present', () => {
    const out = formatEmployeeList(
      [{ id: 1, first_name: 'A', last_name: 'B' }],
      { page: 2, total_pages: 5, total_count: 100 },
    );
    assert.match(out, /Page 2 of 5 \(100 total\)/);
  });
});

describe('formatEmployee', () => {
  test('renders single employee with position and status', () => {
    const out = formatEmployee({
      id: 7,
      first_name: 'Grace',
      last_name: 'Hopper',
      position: { name: 'Rear Admiral' },
      status: 'active',
    });
    assert.match(out, /# Grace Hopper/);
    assert.match(out, /Position: Rear Admiral/);
    assert.match(out, /Status: active/);
  });

  test('falls back to Unknown when no name is provided', () => {
    const out = formatEmployee({ id: 1 });
    assert.match(out, /# Unknown/);
  });
});

describe('formatDepartmentList', () => {
  test('renders departments with employee counts', () => {
    const out = formatDepartmentList([
      { id: 1, name: 'Engineering', employees_count: 24 },
      { id: 2, name: 'People Ops', employees_count: 5 },
    ]);
    assert.match(out, /Engineering/);
    assert.match(out, /Employees: 24/);
    assert.match(out, /People Ops/);
  });
});

describe('formatAbsenceList', () => {
  test('handles empty list', () => {
    assert.equal(formatAbsenceList([]), 'No absences found.');
  });

  test('renders absence with employee and policy', () => {
    const out = formatAbsenceList([
      {
        id: 9,
        employee: { first_name: 'Ada', last_name: 'Lovelace' },
        policy: { id: 1, name: 'Vacation' },
        start_date: '2026-08-01',
        end_date: '2026-08-05',
        status: 'approved',
      },
    ]);
    assert.match(out, /Ada Lovelace — Vacation/);
    assert.match(out, /Start: 2026-08-01/);
    assert.match(out, /Status: approved/);
  });
});

describe('getPeopleForceClient', () => {
  test('throws UserError when session has no token', () => {
    assert.throws(() => getPeopleForceClient(undefined), UserError);
    assert.throws(() => getPeopleForceClient({} as any), UserError);
  });
});
