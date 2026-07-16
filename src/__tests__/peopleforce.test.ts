// src/__tests__/peopleforce.test.ts
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { UserError } from 'fastmcp';
import { peopleForceServer, isoDate, createLeaveRequestSchema } from '../peopleforce/server.js';
import {
  PeopleForceClient,
  formatEmployeeList,
  formatEmployee,
  formatDepartmentList,
  formatLeaveRequestList,
  formatLeaveTypeList,
  formatLocationList,
  formatNamedList,
  formatLeaveBalances,
  formatEmployeeSkills,
  formatTaskList,
  formatUnknownItemList,
  getPeopleForceClient,
  mapPeopleForceError,
  withPeopleForceClient,
} from '../peopleforce/apiHelpers.js';

// -----------------------------------------------------------------------------
// Server registration
// -----------------------------------------------------------------------------

test('peopleforce server is registered', () => {
  assert.ok(peopleForceServer, 'server should be defined');
});

// -----------------------------------------------------------------------------
// createLeaveRequest Zod validation (regression: previously accepted impossible
// dates and never checked startsOn <= endsOn)
// -----------------------------------------------------------------------------

describe('isoDate — calendar-aware validator', () => {
  test('rejects impossible day (Feb 31)', () => {
    const r = isoDate.safeParse('2026-02-31');
    assert.equal(r.success, false);
    if (!r.success) assert.match(r.error.issues[0].message, /valid calendar date/i);
  });

  test('rejects month 13', () => {
    assert.equal(isoDate.safeParse('2026-13-01').success, false);
  });

  test('rejects non-leap-year Feb 29 (2026 is not a leap year)', () => {
    assert.equal(isoDate.safeParse('2026-02-29').success, false);
  });

  test('accepts leap-year Feb 29 (2028)', () => {
    assert.equal(isoDate.safeParse('2028-02-29').success, true);
  });

  test('accepts normal dates', () => {
    assert.equal(isoDate.safeParse('2026-07-15').success, true);
    assert.equal(isoDate.safeParse('2026-12-31').success, true);
  });

  test('rejects wrong format (no dashes)', () => {
    assert.equal(isoDate.safeParse('20260715').success, false);
  });
});

describe('createLeaveRequestSchema — cross-field ordering', () => {
  test('rejects endsOn before startsOn', () => {
    const r = createLeaveRequestSchema.safeParse({
      employeeId: 1,
      leaveTypeId: 1,
      startsOn: '2026-08-05',
      endsOn: '2026-08-01',
    });
    assert.equal(r.success, false);
    if (!r.success) {
      assert.ok(
        r.error.issues.some((i) => /endsOn.*on or after startsOn/i.test(i.message)),
        `expected ordering error, got: ${JSON.stringify(r.error.issues)}`,
      );
    }
  });

  test('accepts a single-day request (startsOn == endsOn)', () => {
    const r = createLeaveRequestSchema.safeParse({
      employeeId: 1,
      leaveTypeId: 1,
      startsOn: '2026-08-05',
      endsOn: '2026-08-05',
    });
    assert.equal(r.success, true);
  });

  test('accepts a valid multi-day request', () => {
    const r = createLeaveRequestSchema.safeParse({
      employeeId: 1,
      leaveTypeId: 1,
      startsOn: '2026-08-01',
      endsOn: '2026-08-05',
      comment: 'Beach',
    });
    assert.equal(r.success, true);
  });

  test('impossible date on startsOn still bubbles up (regression: 2026-02-31)', () => {
    const r = createLeaveRequestSchema.safeParse({
      employeeId: 1,
      leaveTypeId: 1,
      startsOn: '2026-02-31',
      endsOn: '2026-03-05',
    });
    assert.equal(r.success, false);
  });
});

// -----------------------------------------------------------------------------
// Formatters
// -----------------------------------------------------------------------------

describe('formatEmployeeList', () => {
  test('handles empty list', () => {
    assert.equal(formatEmployeeList([]), 'No employees found.');
  });

  test('prefers full_name when present', () => {
    const out = formatEmployeeList([
      { id: 42, full_name: 'Ada Lovelace', first_name: 'X', last_name: 'Y', department: { id: 1, name: 'R&D' } },
    ]);
    assert.match(out, /Ada Lovelace/);
    // full_name wins over first+last composition
    assert.doesNotMatch(out, /X Y/);
  });

  test('renders name from first + last when no full_name', () => {
    const out = formatEmployeeList([
      { id: 42, first_name: 'Grace', last_name: 'Hopper' },
    ]);
    assert.match(out, /Grace Hopper/);
  });

  test('renders position as an object OR a string', () => {
    const asObject = formatEmployeeList([{ id: 1, first_name: 'A', last_name: 'B', position: { id: 9, name: 'Engineer' } }]);
    assert.match(asObject, /Position: Engineer/);
    const asString = formatEmployeeList([{ id: 2, first_name: 'C', last_name: 'D', position: 'Manager' }]);
    assert.match(asString, /Position: Manager/);
  });

  test('renders status from `active` boolean', () => {
    const active = formatEmployeeList([{ id: 1, first_name: 'A', last_name: 'B', active: true }]);
    assert.match(active, /Status: active/);
    const inactive = formatEmployeeList([{ id: 2, first_name: 'C', last_name: 'D', active: false }]);
    assert.match(inactive, /Status: inactive/);
  });

  test('renders pagination with the API-native shape', () => {
    const out = formatEmployeeList(
      [{ id: 1, first_name: 'A', last_name: 'B' }],
      { page: 2, pages: 3, count: 121, items: 50 },
    );
    assert.match(out, /Page 2 of 3 \(121 total, 50 per page\)/);
  });

  test('empty list surfaces pagination context when supplied', () => {
    const out = formatEmployeeList([], { page: 5, pages: 3, count: 121, items: 50 });
    assert.match(out, /Page 5 of 3 \(121 total, 50 per page\)/);
    assert.match(out, /No employees on this page\./);
  });

  test('empty list without pagination keeps the terse message', () => {
    assert.equal(formatEmployeeList([]), 'No employees found.');
  });
});

describe('formatEmployee', () => {
  test('renders rich employee profile', () => {
    const out = formatEmployee({
      id: 7,
      employee_number: '10241',
      active: true,
      full_name: 'Grace Hopper',
      first_name: 'Grace',
      last_name: 'Hopper',
      email: 'grace@example.com',
      personal_email: 'grace@home.com',
      mobile_number: '+15550001111',
      hired_on: '1949-05-01',
      probation_ends_on: '1949-08-01',
      position: { id: 1, name: 'Rear Admiral' },
      department: { id: 2, name: 'Cryptology' },
      division: { id: 3, name: 'Navy' },
      employment_type: { id: 4, name: 'Contractor' },
      location: { id: 5, name: 'Washington, DC' },
      reporting_to: { id: 6, name: 'Adm. Smith' },
    });
    assert.match(out, /# Grace Hopper/);
    assert.match(out, /Employee #: 10241/);
    assert.match(out, /Status: active/);
    assert.match(out, /Email: grace@example.com/);
    assert.match(out, /Personal email: grace@home.com/);
    assert.match(out, /Mobile: \+15550001111/);
    assert.match(out, /Position: Rear Admiral/);
    assert.match(out, /Department: Cryptology/);
    assert.match(out, /Division: Navy/);
    assert.match(out, /Employment type: Contractor/);
    assert.match(out, /Location: Washington, DC/);
    assert.match(out, /Reports to: Adm\. Smith/);
    assert.match(out, /Hired: 1949-05-01/);
    assert.match(out, /Probation ends: 1949-08-01/);
  });

  test('renders status: inactive for active=false', () => {
    const out = formatEmployee({ id: 1, first_name: 'A', last_name: 'B', active: false });
    assert.match(out, /Status: inactive/);
  });

  test('falls back to Unknown when no name is provided', () => {
    const out = formatEmployee({ id: 1 });
    assert.match(out, /# Unknown/);
  });
});

describe('formatDepartmentList', () => {
  test('handles empty list', () => {
    assert.equal(formatDepartmentList([]), 'No departments found.');
  });

  test('renders departments with employee counts and description', () => {
    const out = formatDepartmentList([
      { id: 1, name: 'Engineering', description: 'Builds things', employees_count: 24 },
      { id: 2, name: 'People Ops', employees_count: 5 },
    ]);
    assert.match(out, /Engineering/);
    assert.match(out, /Description: Builds things/);
    assert.match(out, /Employees: 24/);
    assert.match(out, /People Ops/);
  });

  test('renders pagination line when metadata is present', () => {
    const out = formatDepartmentList(
      [{ id: 1, name: 'X' }],
      { page: 1, pages: 1, count: 10, items: 50 },
    );
    assert.match(out, /Page 1 of 1 \(10 total, 50 per page\)/);
  });

  test('empty list surfaces pagination context when supplied', () => {
    const out = formatDepartmentList([], { page: 4, pages: 3, count: 121, items: 50 });
    assert.match(out, /Page 4 of 3 \(121 total, 50 per page\)/);
    assert.match(out, /No departments on this page\./);
  });
});

describe('formatLeaveRequestList', () => {
  test('handles empty list', () => {
    assert.equal(formatLeaveRequestList([]), 'No leave requests found.');
  });

  test('renders leave request with the native API shape', () => {
    const out = formatLeaveRequestList([
      {
        id: 9,
        employee_id: 111,
        employee: { id: 111, first_name: 'Ada', last_name: 'Lovelace' },
        leave_type: 'Vacation',
        starts_on: '2026-08-01',
        ends_on: '2026-08-05',
        state: 'approved',
        amount: '32.0',
        tracking_time_in: 'hours',
        comment: 'Beach',
      },
    ]);
    assert.match(out, /Ada Lovelace — Vacation/);
    assert.match(out, /Employee ID: 111/);
    assert.match(out, /Starts: 2026-08-01/);
    assert.match(out, /Ends: 2026-08-05/);
    assert.match(out, /State: approved/);
    assert.match(out, /Amount: 32\.0 \(hours\)/);
    assert.match(out, /Comment: Beach/);
  });

  test('omits placeholder "-" comments', () => {
    const out = formatLeaveRequestList([
      { id: 1, employee: { first_name: 'A', last_name: 'B' }, leave_type: 'Sick', comment: '-' },
    ]);
    assert.doesNotMatch(out, /Comment:/);
  });

  test('falls back to "Leave" when leave_type missing', () => {
    const out = formatLeaveRequestList([{ id: 1, employee: { first_name: 'A', last_name: 'B' } }]);
    assert.match(out, /A B — Leave/);
  });

  test('renders pagination with the API-native shape', () => {
    const out = formatLeaveRequestList(
      [{ id: 1, employee: { first_name: 'A', last_name: 'B' } }],
      { page: 1, pages: 13, count: 1245, items: 100 },
    );
    assert.match(out, /Page 1 of 13 \(1245 total, 100 per page\)/);
  });

  test('empty list surfaces pagination context when supplied', () => {
    const out = formatLeaveRequestList([], { page: 14, pages: 13, count: 1245, items: 100 });
    assert.match(out, /Page 14 of 13 \(1245 total, 100 per page\)/);
    assert.match(out, /No leave requests on this page\./);
  });
});

describe('formatNamedList + lookup formatters', () => {
  test('formatNamedList handles empty', () => {
    assert.equal(formatNamedList('Positions', []), 'No positions found.');
  });

  test('formatNamedList emits id + name and optional extras', () => {
    const out = formatNamedList(
      'Locations',
      [{ id: 1, name: 'London' } as any],
      undefined,
      (item: any) => (item.country ? [`Country: ${item.country}`] : []),
    );
    assert.match(out, /London/);
    assert.match(out, /ID: 1/);
  });

  test('formatLeaveTypeList includes unit', () => {
    const out = formatLeaveTypeList([{ id: 22159, name: 'Vacation', unit: 'hours' }]);
    assert.match(out, /Vacation/);
    assert.match(out, /Unit: hours/);
  });

  test('formatLocationList includes country + time zone', () => {
    const out = formatLocationList([
      { id: 29304, name: 'Alanya', country_code: 'TR', time_zone: 'Istanbul', address: 'Main St' },
    ]);
    assert.match(out, /Alanya/);
    assert.match(out, /Country: TR/);
    assert.match(out, /Time zone: Istanbul/);
    assert.match(out, /Address: Main St/);
  });

  test('formatLeaveBalances handles empty', () => {
    assert.equal(formatLeaveBalances([]), 'No leave balances found.');
  });

  test('formatLeaveBalances shows balance + unit + effective_on', () => {
    const out = formatLeaveBalances([
      { id: 1, balance: 12, effective_on: '2026-01-01', leave_type: { id: 22159, name: 'Vacation', unit: 'days' } },
    ]);
    assert.match(out, /Vacation/);
    assert.match(out, /Balance: 12 days/);
    assert.match(out, /Effective on: 2026-01-01/);
    assert.match(out, /Leave type ID: 22159/);
  });

  test('formatLeaveBalances falls back to policy name when leave_type missing', () => {
    const out = formatLeaveBalances([
      { id: 1, balance: 0, leave_type_policy: { id: 1, name: 'Sabbatical' } },
    ]);
    assert.match(out, /Sabbatical/);
  });

  test('formatLeaveBalances renders explicit zero as "0", not "unknown"', () => {
    const out = formatLeaveBalances([
      { id: 1, balance: 0, leave_type: { id: 22159, name: 'Vacation', unit: 'days' } },
    ]);
    assert.match(out, /Balance: 0 days/);
    assert.doesNotMatch(out, /unknown/);
  });

  test('formatLeaveBalances renders omitted balance as "unknown" (not 0)', () => {
    const out = formatLeaveBalances([
      { id: 1, leave_type: { id: 22159, name: 'Vacation', unit: 'days' } },
    ]);
    assert.match(out, /Balance: unknown/);
    assert.doesNotMatch(out, /Balance: 0/);
  });

  test('formatEmployeeSkills handles empty', () => {
    assert.equal(formatEmployeeSkills([]), 'No skills recorded for this employee.');
  });

  test('formatEmployeeSkills shows level', () => {
    const out = formatEmployeeSkills([
      { id: 1, level: 'proficient', skill: { id: 130638, name: 'C#' } },
    ]);
    assert.match(out, /C#/);
    assert.match(out, /Level: proficient/);
    assert.match(out, /Skill ID: 130638/);
  });

  test('formatTaskList shows title, assignee, associated entity, completion', () => {
    const out = formatTaskList([
      {
        id: 7240433,
        title: 'ping if no reply',
        type: 'Tasks::Applicant',
        starts_on: '2026-07-15',
        ends_on: '2026-07-20',
        completed: false,
        assigned_to: { id: 1, full_name: 'Yana Nakonechna' },
        associated_to: { id: 2, type: 'Candidate', full_name: 'Oleh Kobzar' },
      },
    ]);
    assert.match(out, /ping if no reply — Yana Nakonechna/);
    assert.match(out, /Type: Tasks::Applicant/);
    assert.match(out, /Starts: 2026-07-15/);
    assert.match(out, /Completed: no/);
    assert.match(out, /Associated with: Oleh Kobzar \(Candidate\)/);
  });

  test('formatTaskList renders completed=true as "yes"', () => {
    const out = formatTaskList([
      { id: 1, title: 'X', completed: true, completed_at: '2026-01-05' },
    ]);
    assert.match(out, /Completed: yes \(2026-01-05\)/);
  });

  test('formatTaskList renders omitted completed as "unknown" (not "no")', () => {
    const out = formatTaskList([{ id: 1, title: 'X' }]);
    assert.match(out, /Completed: unknown/);
    assert.doesNotMatch(out, /Completed: no/);
  });

  test('formatUnknownItemList dumps records as JSON', () => {
    const out = formatUnknownItemList('Notes', [{ id: 5, body: 'foo' } as any]);
    assert.match(out, /# Notes/);
    assert.match(out, /```json/);
    assert.match(out, /"body": "foo"/);
  });

  test('formatUnknownItemList handles empty', () => {
    assert.equal(formatUnknownItemList('Notes', []), 'No notes recorded.');
  });

  test('formatNamedList surfaces pagination on empty page', () => {
    const out = formatNamedList('Positions', [], { page: 3, pages: 2, count: 95, items: 50 });
    assert.match(out, /Page 3 of 2 \(95 total, 50 per page\)/);
    assert.match(out, /No positions on this page\./);
  });

  test('formatTaskList surfaces pagination on empty page', () => {
    const out = formatTaskList([], { page: 9, pages: 9, count: 402, items: 50 });
    assert.match(out, /Page 9 of 9 \(402 total, 50 per page\)/);
    assert.match(out, /No tasks on this page\./);
  });
});

// -----------------------------------------------------------------------------
// PeopleForceClient — fetch-mocked
// -----------------------------------------------------------------------------

type Recorded = { url: string; method: string; headers: Record<string, string>; body?: string };

function stubFetch(handler: (rec: Recorded) => { status?: number; body?: unknown; contentType?: string | null }) {
  const calls: Recorded[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const rec: Recorded = {
      url: typeof input === 'string' ? input : input.toString(),
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body,
    };
    calls.push(rec);
    const res = handler(rec);
    const status = res.status ?? 200;
    const contentType = res.contentType === undefined ? 'application/json' : res.contentType;
    const bodyText = res.body === undefined ? '' : typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null),
      },
      json: async () => (bodyText ? JSON.parse(bodyText) : undefined),
      text: async () => bodyText,
    } as any as Response;
  }) as any;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

describe('PeopleForceClient', () => {
  let stub: ReturnType<typeof stubFetch> | null = null;

  afterEach(() => {
    if (stub) {
      stub.restore();
      stub = null;
    }
  });

  test('strips trailing slashes from baseUrl', () => {
    const c = new PeopleForceClient('tok', 'https://example.com/api///');
    assert.equal(c.baseUrl, 'https://example.com/api');
  });

  test('sends X-API-KEY and Bearer headers', async () => {
    stub = stubFetch(() => ({ body: { data: [] } }));
    const c = new PeopleForceClient('mykey', 'https://x.example.com');
    await c.listEmployees();
    assert.equal(stub.calls[0].headers['X-API-KEY'], 'mykey');
    assert.equal(stub.calls[0].headers.Authorization, 'Bearer mykey');
  });

  test('listEmployees only serializes page + status (no perPage / departmentId)', async () => {
    stub = stubFetch(() => ({
      body: { data: [{ id: 1 }], metadata: { pagination: { page: 2, pages: 3, count: 121, items: 50 } } },
    }));
    const c = new PeopleForceClient('t', 'https://x.example.com');
    const res = await c.listEmployees({ page: 2, status: 'active' });
    const url = new URL(stub.calls[0].url);
    assert.equal(url.pathname, '/employees');
    assert.equal(url.searchParams.get('page'), '2');
    assert.equal(url.searchParams.get('status'), 'active');
    // Guard against regressions: no fake filters should ever be sent.
    assert.equal(url.searchParams.get('per_page'), null);
    assert.equal(url.searchParams.get('department_id'), null);
    assert.deepEqual(res.data, [{ id: 1 }]);
    assert.equal(res.metadata?.pagination?.count, 121);
  });

  test('getEmployee URL-encodes the id and hits the singular path', async () => {
    stub = stubFetch(() => ({ body: { data: { id: 'x/y' } } }));
    const c = new PeopleForceClient('t', 'https://x.example.com');
    await c.getEmployee('x/y');
    assert.match(stub.calls[0].url, /\/employees\/x%2Fy$/);
  });

  test('listDepartments only serializes page', async () => {
    stub = stubFetch(() => ({ body: { data: [] } }));
    const c = new PeopleForceClient('t', 'https://x.example.com');
    await c.listDepartments({ page: 3 });
    const url = new URL(stub.calls[0].url);
    assert.equal(url.searchParams.get('page'), '3');
    assert.equal(url.searchParams.get('per_page'), null);
  });

  test('listLeaveRequests hits /leave_requests and only serializes page + state', async () => {
    stub = stubFetch(() => ({ body: { data: [] } }));
    const c = new PeopleForceClient('t', 'https://x.example.com');
    await c.listLeaveRequests({ page: 2, state: 'approved' });
    const url = new URL(stub.calls[0].url);
    assert.equal(url.pathname, '/leave_requests');
    assert.equal(url.searchParams.get('page'), '2');
    assert.equal(url.searchParams.get('state'), 'approved');
    // Guard against regressions: no fake filters should ever be sent.
    assert.equal(url.searchParams.get('employee_id'), null);
    assert.equal(url.searchParams.get('starts_on_from'), null);
    assert.equal(url.searchParams.get('starts_on_to'), null);
  });

  test('createLeaveRequest POSTs the leave_requests contract with leave_type_id + comment', async () => {
    stub = stubFetch(() => ({ status: 201, body: { data: { id: 99 } } }));
    const c = new PeopleForceClient('t', 'https://x.example.com');
    const res = await c.createLeaveRequest({
      employeeId: 42,
      leaveTypeId: 3,
      startsOn: '2026-08-01',
      endsOn: '2026-08-05',
      comment: 'Beach',
    });
    assert.equal(stub.calls[0].method, 'POST');
    assert.match(stub.calls[0].url, /\/leave_requests$/);
    const body = JSON.parse(stub.calls[0].body as string);
    assert.deepEqual(body, {
      employee_id: 42,
      leave_type_id: 3,
      starts_on: '2026-08-01',
      ends_on: '2026-08-05',
      comment: 'Beach',
    });
    assert.equal(res.data.id, 99);
  });

  test('non-2xx response throws Error carrying status + body', async () => {
    stub = stubFetch(() => ({ status: 422, body: 'boom', contentType: 'text/plain' }));
    const c = new PeopleForceClient('t', 'https://x.example.com');
    await assert.rejects(
      () => c.listEmployees(),
      (err: any) => {
        assert.equal(err.status, 422);
        assert.match(err.message, /422/);
        assert.match(err.message, /boom/);
        return true;
      },
    );
  });

  test('returns undefined body when 204 no-content', async () => {
    stub = stubFetch(() => ({ status: 204, contentType: null }));
    const c = new PeopleForceClient('t', 'https://x.example.com');
    const res = await c.getEmployee(1);
    assert.equal(res as unknown, undefined);
  });

  // === Reference / lookup endpoints ===

  test('listLeaveTypes hits /leave_types with page only', async () => {
    stub = stubFetch(() => ({ body: { data: [{ id: 22159, name: 'Vacation', unit: 'hours' }] } }));
    const c = new PeopleForceClient('t', 'https://x.example.com');
    await c.listLeaveTypes({ page: 2 });
    const url = new URL(stub.calls[0].url);
    assert.equal(url.pathname, '/leave_types');
    assert.equal(url.searchParams.get('page'), '2');
  });

  test('listPositions / listDivisions / listLocations hit the right paths', async () => {
    stub = stubFetch(() => ({ body: { data: [] } }));
    const c = new PeopleForceClient('t', 'https://x.example.com');
    await c.listPositions();
    await c.listDivisions();
    await c.listLocations();
    await c.listEmploymentTypes();
    await c.listJobLevels();
    await c.listSkills();
    await c.listCompetencies();
    await c.listTasks();
    assert.deepEqual(
      stub.calls.map((r) => new URL(r.url).pathname),
      ['/positions', '/divisions', '/locations', '/employment_types', '/job_levels', '/skills', '/competencies', '/tasks'],
    );
  });

  test('getLeaveRequest URL-encodes the id', async () => {
    stub = stubFetch(() => ({ body: { data: { id: 1 } } }));
    const c = new PeopleForceClient('t', 'https://x.example.com');
    await c.getLeaveRequest('a/b');
    assert.match(stub.calls[0].url, /\/leave_requests\/a%2Fb$/);
  });

  test('employee-nested endpoints URL-encode the employee id', async () => {
    stub = stubFetch(() => ({ body: { data: [] } }));
    const c = new PeopleForceClient('t', 'https://x.example.com');
    await c.listEmployeeLeaveBalances('132045');
    await c.listEmployeeSkills('132045');
    await c.listEmployeeDocuments('132045');
    await c.listEmployeeNotes('132045');
    await c.listEmployeeEmergencyContacts('132045');
    const paths = stub.calls.map((r) => new URL(r.url).pathname);
    assert.deepEqual(paths, [
      '/employees/132045/leave_balances',
      '/employees/132045/skills',
      '/employees/132045/documents',
      '/employees/132045/notes',
      '/employees/132045/emergency_contacts',
    ]);
  });
});

// -----------------------------------------------------------------------------
// Error mapping + session helpers
// -----------------------------------------------------------------------------

describe('getPeopleForceClient', () => {
  test('throws UserError when session has no token', () => {
    assert.throws(() => getPeopleForceClient(undefined), UserError);
    assert.throws(() => getPeopleForceClient({} as any), UserError);
  });

  test('returns a client wired with the session token + baseUrl', () => {
    const c = getPeopleForceClient({ peopleForceAccessToken: 'tok', peopleForceBaseUrl: 'https://x.example.com' } as any);
    assert.equal(c.baseUrl, 'https://x.example.com');
  });
});

describe('mapPeopleForceError', () => {
  const log = { info: () => {}, error: () => {} };

  test('401 → not-authorized UserError', () => {
    assert.throws(
      () => mapPeopleForceError('Failed', { status: 401, message: 'nope' }, log),
      (err: any) => err instanceof UserError && /not authorized/.test(err.message),
    );
  });

  test('403 → not-authorized UserError', () => {
    assert.throws(
      () => mapPeopleForceError('Failed', { status: 403, message: 'nope' }, log),
      (err: any) => err instanceof UserError && /not authorized/.test(err.message),
    );
  });

  test('404 → not-found UserError', () => {
    assert.throws(
      () => mapPeopleForceError('Failed', { status: 404 }, log),
      (err: any) => err instanceof UserError && /not found/.test(err.message),
    );
  });

  test('429 → rate-limited UserError', () => {
    assert.throws(
      () => mapPeopleForceError('Failed', { status: 429 }, log),
      (err: any) => err instanceof UserError && /rate limited/.test(err.message),
    );
  });

  test('other errors surface the original message', () => {
    assert.throws(
      () => mapPeopleForceError('Failed', { message: 'network kaput' }, log),
      (err: any) => err instanceof UserError && /network kaput/.test(err.message),
    );
  });
});

describe('withPeopleForceClient', () => {
  let stub: ReturnType<typeof stubFetch> | null = null;
  const log = { info: () => {}, error: () => {} };
  const session = { peopleForceAccessToken: 'tok', peopleForceBaseUrl: 'https://x.example.com' } as any;

  beforeEach(() => {
    stub = null;
  });

  afterEach(() => {
    if (stub) stub.restore();
  });

  test('passes the client to the callback and returns its result', async () => {
    stub = stubFetch(() => ({ body: { data: [{ id: 1 }] } }));
    const out = await withPeopleForceClient('X', session, log, async (client) => {
      const res = await client.listDepartments();
      return res.data.length;
    });
    assert.equal(out, 1);
  });

  test('translates API errors via mapPeopleForceError', async () => {
    stub = stubFetch(() => ({ status: 404, body: 'missing' }));
    await assert.rejects(
      () => withPeopleForceClient('Failed', session, log, (client) => client.getEmployee(9)),
      (err: any) => err instanceof UserError && /not found/.test(err.message),
    );
  });

  test('surfaces missing-token as a UserError from getPeopleForceClient', async () => {
    await assert.rejects(
      () => withPeopleForceClient('X', undefined, log, async () => 1),
      UserError,
    );
  });
});
