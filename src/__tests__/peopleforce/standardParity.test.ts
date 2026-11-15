import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  PeopleForceClient,
  collectEmployeeAbsences,
  formatEmployeeAbsences,
  formatHolidayList,
  formatSalaries,
  ABSENCE_PAGE_LIMIT,
} from '../../peopleforce/apiHelpers.js';
import {
  PeopleForceV4Client,
  formatLeaveBalanceList,
  formatPerson,
  v4CustomFieldLines,
} from '../../peopleforce-v4/apiHelpers.js';

// What these assert is the request that reaches PeopleForce (version, path,
// filters) and how partial or ambiguous answers are worded.

let urls: URL[] = [];
let respond: (url: URL) => unknown;
const realFetch = globalThis.fetch;

beforeEach(() => {
  urls = [];
  globalThis.fetch = (async (input: any) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    urls.push(url);
    return new Response(JSON.stringify(respond(url)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const pf = () => new PeopleForceClient('key', 'https://app.peopleforce.io/api/public/v2');

describe('salaries', () => {
  test('read from the v3 employee salaries endpoint', async () => {
    respond = () => ({ data: [] });
    await pf().listEmployeeSalaries(42);
    assert.equal(urls[0].pathname, '/api/public/v3/employees/42/salaries');
  });

  test('listed newest first with currency and period', () => {
    const out = formatSalaries([
      { id: 1, effective_on: '2025-01-01', amount: '1000.00', currency_code: 'EUR', per: 'month' },
      { id: 2, effective_on: '2026-01-01', amount: '1200.00', currency_code: 'EUR', per: 'month', compensation_component: { name: 'Base' } },
    ]);
    assert.ok(out.indexOf('1200.00 EUR per month') < out.indexOf('1000.00 EUR per month'));
    assert.match(out, /Component: Base/);
  });
});

describe('holidays', () => {
  test('a working-day exception is not presented as a day off', () => {
    const out = formatHolidayList([{ name: 'Transferred Saturday', occurs_on: '2026-03-07', working: true, holiday_policy_id: 3 }]);
    assert.match(out, /working day — not a day off/);
    assert.match(out, /\[policy 3\]/);
  });
});

describe('collectEmployeeAbsences', () => {
  test('keeps only leave and holidays overlapping the range, and asks v3 for approved leave of that employee', async () => {
    respond = (url) => url.pathname.endsWith('/leave_requests')
      ? { data: [
          { id: 1, starts_on: '2026-06-28', ends_on: '2026-07-02', leave_type: 'Vacation', state: 'approved' },
          { id: 2, starts_on: '2026-08-01', ends_on: '2026-08-05', leave_type: 'Vacation', state: 'approved' },
        ], metadata: { pagination: { page: 1, pages: 1 } } }
      : { data: [
          { name: 'Independence Day', occurs_on: '2026-07-04' },
          { name: 'Christmas', occurs_on: '2026-12-25' },
        ], metadata: { pagination: { page: 1, pages: 1 } } };
    const a = await collectEmployeeAbsences(pf(), { employeeId: 7, from: '2026-07-01', to: '2026-07-31' });
    assert.deepEqual(a.leave.map((l) => l.id), [1]);
    assert.deepEqual(a.holidays.map((h) => h.name), ['Independence Day']);
    const leaveUrl = urls.find((u) => u.pathname.endsWith('/leave_requests'))!;
    assert.equal(leaveUrl.pathname, '/api/public/v3/leave_requests');
    assert.equal(leaveUrl.searchParams.get('employee_id'), '7');
    assert.deepEqual(leaveUrl.searchParams.getAll('states[]'), ['approved']);
    const out = formatEmployeeAbsences(a);
    assert.ok(out.indexOf('Vacation') < out.indexOf('Independence Day'), 'date order');
  });

  test('says it is partial when a source has more pages than it reads', async () => {
    respond = (url) => url.pathname.endsWith('/leave_requests')
      ? { data: [{ id: 1, starts_on: '2020-01-01', ends_on: '2020-01-01' }], metadata: { pagination: { page: 1, pages: 50 } } }
      : { data: [], metadata: { pagination: { page: 1, pages: 1 } } };
    const a = await collectEmployeeAbsences(pf(), { employeeId: 7, from: '2026-01-01', to: '2026-01-31' });
    assert.equal(urls.filter((u) => u.pathname.endsWith('/leave_requests')).length, ABSENCE_PAGE_LIMIT);
    assert.match(formatEmployeeAbsences(a), /Partial: leave requests \(stopped after 10 of 50 pages\)/);
  });
});

describe('v4 time off', () => {
  test('leave requests send v4 filters as bracket arrays and the on-or-after date', async () => {
    respond = () => ({ data: [], metadata: { page: 1 } });
    await new PeopleForceV4Client('key').listLeaveRequests({ employeeIds: [1, 2], states: ['approved'], endsOnOrAfter: '2026-07-01' });
    const u = urls[0];
    assert.equal(u.pathname, '/api/v4/leave_requests');
    assert.deepEqual(u.searchParams.getAll('employee_ids[]'), ['1', '2']);
    assert.deepEqual(u.searchParams.getAll('states[]'), ['approved']);
    assert.equal(u.searchParams.get('ends_on'), '2026-07-01');
  });

  test('an omitted balance reads as unknown, not zero', () => {
    const out = formatLeaveBalanceList([{ employee: { full_name: 'A B' }, leave_type: { name: 'Vacation', unit: 'days' } }]);
    assert.match(out, /Vacation \| unknown/);
  });
});

describe('v4 custom directory fields', () => {
  test('rendered by display name, empty values dropped', () => {
    const lines = v4CustomFieldLines({ f_1: { name: 'Shirt size', value: 'M' }, f_2: { name: 'Empty one', value: '' } });
    assert.deepEqual(lines, ['Shirt size: M']);
  });

  test('formatPerson shows them in their own block', () => {
    const out = formatPerson({ id: 1, full_name: 'A B', fields: { f_1: { name: 'Team code', value: 'X1' } } } as any);
    assert.match(out, /Custom fields:\n {2}Team code: X1/);
  });
});
