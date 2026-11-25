import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  PeopleForceClient,
  collectEmployeeAbsences,
  formatEmployeeAbsences,
  formatHolidayList,
  formatSalaries,
  markCurrentSalaries,
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

  const TODAY = '2026-11-24';
  const hourly = (id: number, on: string, amount: string, extra: object = {}) =>
    ({ id, effective_on: on, amount, currency_code: 'USD', per: 'hour', ...extra });

  test('summarises the current rate and the previous one', () => {
    const out = formatSalaries([hourly(1, '2026-01-01', '22.00'), hourly(2, '2026-05-01', '28.00')], TODAY);
    assert.ok(out.includes('Current: 28.00 USD per hour, effective 2026-05-01 (previously 22.00 USD per hour, from 2026-01-01)'));
    assert.match(out, /## 1\. 28\.00 USD per hour \(current\)/);
    assert.doesNotMatch(out, /## 2\. .*\((current|scheduled)\)/);
  });

  test('a future-dated record is scheduled, not current', () => {
    const out = formatSalaries([hourly(1, '2026-01-01', '22.00'), hourly(2, '2027-01-01', '30.00')], TODAY);
    assert.match(out, /## 1\. 30\.00 USD per hour \(scheduled\)/);
    assert.match(out, /## 2\. 22\.00 USD per hour \(current\)/);
    assert.ok(out.includes('Current: 22.00 USD per hour, effective 2026-01-01'));
  });

  test('reports no current rate when everything is in the future', () => {
    const out = formatSalaries([hourly(1, '2027-06-01', '31.00'), hourly(2, '2027-01-01', '30.00')], TODAY);
    assert.ok(out.includes('No current rate: next 30.00 USD per hour from 2027-01-01'));
  });

  test('components are separate groups', () => {
    const base = { id: 1, name: 'Base' };
    const bonus = { id: 2, name: 'Bonus' };
    const out = formatSalaries([
      hourly(1, '2026-01-01', '22.00', { compensation_component: base }),
      hourly(2, '2026-06-01', '500.00', { compensation_component: bonus }),
    ], TODAY);
    assert.ok(out.includes('Current (Base): 22.00 USD per hour, effective 2026-01-01'));
    assert.ok(out.includes('Current (Bonus): 500.00 USD per hour, effective 2026-06-01'));
    assert.equal((out.match(/\(current\)/g) ?? []).length, 2);
  });

  test('a record without a component is its own group, apart from an explicit Base', () => {
    const out = formatSalaries([
      hourly(1, '2026-01-01', '22.00'),
      hourly(2, '2026-02-01', '25.00', { compensation_component: { id: 1, name: 'Base' } }),
    ], TODAY);
    assert.ok(out.includes('Current (no component): 22.00 USD per hour, effective 2026-01-01'));
    assert.ok(out.includes('Current (Base): 25.00 USD per hour, effective 2026-02-01'));
  });

  test('a single record has no previously clause', () => {
    const out = formatSalaries([hourly(1, '2026-01-01', '22.00')], TODAY);
    assert.ok(out.includes('Current: 22.00 USD per hour, effective 2026-01-01'));
    assert.doesNotMatch(out, /previously/);
  });

  test('previously cites only a rate dated before the current one, never a same-date record', () => {
    const out = formatSalaries([hourly(5, '2026-01-01', '1.00'), hourly(9, '2026-01-01', '2.00'), hourly(3, '2025-06-01', '0.50')], TODAY);
    assert.ok(out.includes('Current: 2.00 USD per hour, effective 2026-01-01 (previously 0.50 USD per hour, from 2025-06-01)'));
    assert.doesNotMatch(out, /previously [^)]*from 2026-01-01/);
  });

  test('a same-date record alone gives no previously clause', () => {
    const out = formatSalaries([hourly(5, '2026-01-01', '1.00'), hourly(9, '2026-01-01', '2.00')], TODAY);
    assert.ok(out.includes('Current: 2.00 USD per hour, effective 2026-01-01'));
    assert.doesNotMatch(out, /previously/);
  });

  test('equal dates are broken by id, higher id first and current', () => {
    const out = markCurrentSalaries([hourly(5, '2026-01-01', '1.00'), hourly(9, '2026-01-01', '2.00')], TODAY);
    assert.deepEqual(out.map((s) => [s.id, s.current]), [[9, true], [5, false]]);
  });

  test('markCurrentSalaries does not mutate its input and marks one current per group', () => {
    const input = [
      hourly(1, '2025-01-01', '1.00'), hourly(2, '2026-01-01', '2.00'), hourly(3, '2999-01-01', '3.00'),
      hourly(4, '2026-03-01', '4.00', { compensation_component: { id: 7, name: 'Bonus' } }),
      { id: 5, amount: '9.00' },
    ];
    const snapshot = JSON.stringify(input);
    const out = markCurrentSalaries(input, TODAY);
    assert.equal(JSON.stringify(input), snapshot);
    assert.ok(input.every((s) => !('current' in s)));
    assert.deepEqual(out.map((s) => s.id), [3, 4, 2, 1, 5]);
    assert.deepEqual(out.filter((s) => s.current).map((s) => s.id).sort(), [2, 4]);
  });

  test('a future-dated record is never current, even as the only one in its group', () => {
    const out = markCurrentSalaries([hourly(1, '2026-11-25', '30.00'), hourly(2, '2026-11-24', '22.00')], TODAY);
    assert.deepEqual(out.map((s) => [s.id, s.current]), [[1, false], [2, true]]);
    const solo = markCurrentSalaries([hourly(3, '2026-11-25', '30.00')], TODAY);
    assert.deepEqual(solo.map((s) => s.current), [false]);
  });

  test('groups by component id: same name with different ids stays apart, same id merges', () => {
    // Dates chosen so grouping by name would give a different answer.
    const out = markCurrentSalaries([
      hourly(1, '2026-03-01', '1.00', { compensation_component: { id: 1, name: 'Pay' } }),
      hourly(2, '2026-02-01', '2.00', { compensation_component: { id: 2, name: 'Pay' } }),
      hourly(3, '2026-01-01', '3.00', { compensation_component: { id: 1, name: 'Pay (renamed)' } }),
    ], TODAY);
    assert.deepEqual(out.map((s) => [s.id, s.current]), [[1, true], [2, true], [3, false]]);
  });

  test('a named component without an id stays apart from records with no component', () => {
    const out = markCurrentSalaries([
      hourly(1, '2026-01-01', '1.00', { compensation_component: { name: 'Base' } }),
      hourly(2, '2026-02-01', '2.00'),
    ], TODAY);
    assert.deepEqual(out.map((s) => [s.id, s.current]), [[2, true], [1, true]]);
  });

  test('an empty effective_on is never current', () => {
    assert.deepEqual(markCurrentSalaries([{ id: 1, effective_on: '', amount: '1.00' }], TODAY).map((s) => s.current), [false]);
  });

  test('a group is labelled with its newest name; same-named components are told apart by id', () => {
    const renamed = formatSalaries([
      hourly(1, '2025-01-01', '1.00', { compensation_component: { id: 1, name: 'Pay' } }),
      hourly(2, '2026-01-01', '2.00', { compensation_component: { id: 1, name: 'Salary' } }),
      hourly(3, '2026-01-01', '9.00', { compensation_component: { id: 5, name: 'Bonus' } }),
    ], TODAY);
    assert.ok(renamed.includes('Current (Salary): 2.00 USD per hour'));
    const clash = formatSalaries([
      hourly(1, '2026-01-01', '1.00', { compensation_component: { id: 1, name: 'Pay' } }),
      hourly(2, '2026-01-01', '2.00', { compensation_component: { id: 2, name: 'Pay' } }),
    ], TODAY);
    assert.ok(clash.includes('Current (Pay, id 1): 1.00 USD per hour'));
    assert.ok(clash.includes('Current (Pay, id 2): 2.00 USD per hour'));
  });

  test('a clashing label gets the id only where there is one', () => {
    const noId = formatSalaries([
      hourly(1, '2026-01-01', '1.00', { compensation_component: { name: 'Pay' } }),
      hourly(2, '2026-01-01', '2.00', { compensation_component: { id: 2, name: 'Pay' } }),
    ], TODAY);
    assert.ok(noId.includes('Current (Pay): 1.00 USD per hour'));
    assert.ok(noId.includes('Current (Pay, id 2): 2.00 USD per hour'));
    assert.doesNotMatch(noId, /id undefined/);
    const fallback = formatSalaries([
      hourly(1, '2026-01-01', '1.00', { compensation_component: { id: 5 } }),
      hourly(2, '2026-01-01', '2.00', { compensation_component: { name: 'component 5' } }),
    ], TODAY);
    assert.ok(fallback.includes('Current (component 5, id 5): 1.00 USD per hour'));
    assert.ok(fallback.includes('Current (component 5): 2.00 USD per hour'));
  });

  test('an empty component object is the same group as no component', () => {
    const out = formatSalaries([
      hourly(1, '2026-01-01', '1.00', { compensation_component: {} }),
      hourly(2, '2026-02-01', '2.00'),
    ], TODAY);
    assert.match(out, /^Current: 2\.00 USD per hour, effective 2026-02-01 \(previously 1\.00 USD per hour, from 2026-01-01\)$/m);
  });

  test('a group with only undated records adds no line and does not switch labels on', () => {
    const out = formatSalaries([
      { id: 9, amount: '5.00', currency_code: 'USD', per: 'hour', compensation_component: { id: 2, name: 'Bonus' } },
      hourly(1, '2026-01-01', '22.00'),
    ], TODAY);
    assert.match(out, /^Current: 22\.00 USD per hour, effective 2026-01-01$/m);
  });

  test('the next scheduled rate is never an undated record', () => {
    const out = formatSalaries([
      hourly(1, '2027-01-01', '30.00'),
      { id: 9, amount: '5.00', currency_code: 'USD', per: 'hour' },
    ], TODAY);
    assert.match(out, /^No current rate: next 30\.00 USD per hour from 2027-01-01$/m);
  });

  test('the next scheduled rate on a shared date is the highest id, as markCurrentSalaries picks', () => {
    for (const input of [
      [hourly(5, '2027-01-01', '1.00'), hourly(9, '2027-01-01', '2.00'), hourly(3, '2027-06-01', '3.00')],
      [hourly(3, '2027-06-01', '3.00'), hourly(9, '2027-01-01', '2.00'), hourly(5, '2027-01-01', '1.00')],
    ]) {
      const out = formatSalaries(input, TODAY);
      assert.match(out, /^No current rate: next 2\.00 USD per hour from 2027-01-01$/m);
    }
  });

  test('a same-day record that is not current is not marked scheduled', () => {
    const out = formatSalaries([hourly(1, TODAY, '1.00'), hourly(2, TODAY, '2.00')], TODAY);
    assert.match(out, /^## 1\. 2\.00 USD per hour \(current\)$/m);
    assert.match(out, /^## 2\. 1\.00 USD per hour$/m);
  });

  test('equal dates are ordered by id whatever the input order', () => {
    for (const input of [
      [hourly(5, '2026-01-01', '1.00'), hourly(9, '2026-01-01', '2.00'), hourly(7, '2026-01-01', '3.00')],
      [hourly(9, '2026-01-01', '2.00'), hourly(7, '2026-01-01', '3.00'), hourly(5, '2026-01-01', '1.00')],
    ]) {
      assert.deepEqual(markCurrentSalaries(input, TODAY).map((s) => s.id), [9, 7, 5]);
    }
    const out = formatSalaries([hourly(5, '2026-01-01', '1.00'), hourly(9, '2026-01-01', '2.00')], TODAY);
    assert.match(out, /^## 1\. 2\.00 USD per hour \(current\)$/m);
  });

  test('previously is the next-older dated record in the same group, past any scheduled or other-component one', () => {
    const base = { id: 1, name: 'Base' };
    const bonus = { id: 2, name: 'Bonus' };
    const out = formatSalaries([
      hourly(1, '2024-01-01', '10.00', { compensation_component: base }),
      hourly(2, '2025-01-01', '15.00', { compensation_component: base }),
      hourly(3, '2026-01-01', '20.00', { compensation_component: base }),
      hourly(4, '2027-01-01', '25.00', { compensation_component: base }),
      hourly(5, '2025-06-01', '99.00', { compensation_component: bonus }),
    ], TODAY);
    assert.ok(out.includes('Current (Base): 20.00 USD per hour, effective 2026-01-01 (previously 15.00 USD per hour, from 2025-01-01)'));
    assert.ok(out.includes('Current (Bonus): 99.00 USD per hour, effective 2025-06-01\n'));
  });

  test('an undated record is never cited as the previous rate', () => {
    const out = formatSalaries([
      { id: 9, amount: '5.00', currency_code: 'USD', per: 'hour' },
      hourly(1, '2026-01-01', '22.00'),
    ], TODAY);
    assert.ok(out.includes('Current: 22.00 USD per hour, effective 2026-01-01\n'));
    assert.doesNotMatch(out, /previously/);
    const withOlder = formatSalaries([
      hourly(1, '2025-01-01', '18.00'),
      { id: 9, amount: '5.00', currency_code: 'USD', per: 'hour' },
      hourly(2, '2026-01-01', '22.00'),
    ], TODAY);
    assert.ok(withOlder.includes('(previously 18.00 USD per hour, from 2025-01-01)'));
  });

  test('a component with an id but no name is labelled by its id', () => {
    const out = formatSalaries([
      hourly(1, '2026-01-01', '22.00', { compensation_component: { id: 42 } }),
      hourly(2, '2026-01-01', '500.00', { compensation_component: { id: 2, name: 'Bonus' } }),
    ], TODAY);
    assert.ok(out.includes('Current (component 42): 22.00 USD per hour, effective 2026-01-01'));
    assert.doesNotMatch(out, /undefined/);
  });

  test('every field of a record reaches the output', () => {
    const out = formatSalaries([hourly(1, '2026-01-01', '22.00', { comment: 'Annual review' })], TODAY);
    for (const needle of ['22.00', 'USD', 'hour', '2026-01-01', 'Annual review']) assert.ok(out.includes(needle), needle);
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

  test('drops leave belonging to someone else, in case PeopleForce ignores the employee filter', async () => {
    respond = (url) => url.pathname.endsWith('/leave_requests')
      ? { data: [
          { id: 1, employee_id: 7, starts_on: '2026-07-01', ends_on: '2026-07-01' },
          { id: 2, employee_id: 99, starts_on: '2026-07-01', ends_on: '2026-07-01' },
        ], metadata: { pagination: { page: 1, pages: 1 } } }
      : { data: [], metadata: { pagination: { page: 1, pages: 1 } } };
    const a = await collectEmployeeAbsences(pf(), { employeeId: '7', from: '2026-07-01', to: '2026-07-31' });
    assert.deepEqual(a.leave.map((l) => l.id), [1]);
  });

  test('a holiday whose day off was moved into the range counts; working-day exceptions are listed apart', async () => {
    respond = (url) => url.pathname.endsWith('/leave_requests')
      ? { data: [], metadata: { pagination: { page: 1, pages: 1 } } }
      : { data: [
          { name: 'Saturday holiday', occurs_on: '2026-03-07', compensated_on: '2026-03-09' },
          { name: 'Worked Sunday', occurs_on: '2026-03-08', working: true },
        ], metadata: { pagination: { page: 1, pages: 1 } } };
    const a = await collectEmployeeAbsences(pf(), { employeeId: 7, from: '2026-03-08', to: '2026-03-09' });
    const out = formatEmployeeAbsences(a);
    assert.match(out, /Saturday holiday \(day off moved to 2026-03-09\) \[public holiday\]/);
    assert.match(out, /Working-day exceptions[^\n]*\n- 2026-03-08 — Worked Sunday/);
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
