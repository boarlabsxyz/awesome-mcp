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
  // Recruitment (v3) — under test below
  deriveRecruitmentBaseUrl,
  deriveCareersBaseUrl,
  appendQueryParams,
  formatVacancyList,
  formatVacancy,
  formatPipelineList,
  formatCandidateList,
  formatCandidate,
  formatApplicationList,
  formatCandidateNotes,
  formatCandidateExperiences,
  formatCandidateEducations,
  formatMovementList,
  formatPublishedVacancy,
  formatCandidateDossier,
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

// =============================================================================
// Recruitment (v3) — uncommitted tools
// =============================================================================

// -----------------------------------------------------------------------------
// Base-URL derivation
// -----------------------------------------------------------------------------

describe('deriveRecruitmentBaseUrl', () => {
  const KEY = 'PEOPLEFORCE_RECRUITMENT_BASE_URL';
  let saved: string | undefined;
  beforeEach(() => { saved = process.env[KEY]; delete process.env[KEY]; });
  afterEach(() => { if (saved === undefined) delete process.env[KEY]; else process.env[KEY] = saved; });

  test('swaps the /api/public/v2 segment for /v3', () => {
    assert.equal(
      deriveRecruitmentBaseUrl('https://app.peopleforce.io/api/public/v2'),
      'https://app.peopleforce.io/api/public/v3',
    );
  });

  test('falls back to the public v3 base when no /v2 marker is present', () => {
    assert.equal(
      deriveRecruitmentBaseUrl('https://x.example.com'),
      'https://app.peopleforce.io/api/public/v3',
    );
  });

  test('honors the env override and strips trailing slashes', () => {
    process.env[KEY] = 'https://custom.example.com/rec///';
    assert.equal(deriveRecruitmentBaseUrl('https://whatever/api/public/v2'), 'https://custom.example.com/rec');
  });
});

describe('deriveCareersBaseUrl', () => {
  const KEY = 'PEOPLEFORCE_CAREERS_BASE_URL';
  let saved: string | undefined;
  beforeEach(() => { saved = process.env[KEY]; delete process.env[KEY]; });
  afterEach(() => { if (saved === undefined) delete process.env[KEY]; else process.env[KEY] = saved; });

  test('derives /api/careers/v1 from the origin', () => {
    assert.equal(
      deriveCareersBaseUrl('https://app.peopleforce.io/api/public/v2'),
      'https://app.peopleforce.io/api/careers/v1',
    );
  });

  test('falls back to the public careers base when the URL is unparseable', () => {
    assert.equal(deriveCareersBaseUrl('not-a-url'), 'https://app.peopleforce.io/api/careers/v1');
  });

  test('honors the env override and strips trailing slashes', () => {
    process.env[KEY] = 'https://custom.example.com/careers/';
    assert.equal(deriveCareersBaseUrl('https://whatever'), 'https://custom.example.com/careers');
  });
});

// -----------------------------------------------------------------------------
// appendQueryParams
// -----------------------------------------------------------------------------

describe('appendQueryParams', () => {
  function paramsFor(query: any): string {
    const url = new URL('https://x.example.com/');
    appendQueryParams(url, query);
    return url.search;
  }

  test('no-op when query is undefined', () => {
    assert.equal(paramsFor(undefined), '');
  });

  test('sets scalar values and coerces numbers to strings', () => {
    const url = new URL('https://x.example.com/');
    appendQueryParams(url, { page: 2, email: 'a@b.com' });
    assert.equal(url.searchParams.get('page'), '2');
    assert.equal(url.searchParams.get('email'), 'a@b.com');
  });

  test('skips undefined and null values', () => {
    const url = new URL('https://x.example.com/');
    appendQueryParams(url, { a: undefined, b: null, c: 'keep' });
    assert.equal(url.searchParams.has('a'), false);
    assert.equal(url.searchParams.has('b'), false);
    assert.equal(url.searchParams.get('c'), 'keep');
  });

  test('expands arrays into repeated key[] entries', () => {
    const url = new URL('https://x.example.com/');
    appendQueryParams(url, { status: ['opened', 'closed'] });
    assert.deepEqual(url.searchParams.getAll('status[]'), ['opened', 'closed']);
    assert.equal(url.searchParams.has('status'), false);
  });

  test('does not double-append the bracket suffix for keys already ending in []', () => {
    const url = new URL('https://x.example.com/');
    appendQueryParams(url, { 'skills[]': ['ts', 'go'] });
    assert.deepEqual(url.searchParams.getAll('skills[]'), ['ts', 'go']);
    assert.equal(url.searchParams.has('skills[][]'), false);
  });

  test('drops empty arrays entirely', () => {
    assert.equal(paramsFor({ status: [] }), '');
  });

  test('skips null/undefined items inside an array', () => {
    const url = new URL('https://x.example.com/');
    appendQueryParams(url, { ids: [1, null, 2, undefined] as any });
    assert.deepEqual(url.searchParams.getAll('ids[]'), ['1', '2']);
  });

  test('passes literal bracket filter keys through untouched', () => {
    const url = new URL('https://x.example.com/');
    appendQueryParams(url, { 'created_at[gte]': '2026-01-01' });
    assert.equal(url.searchParams.get('created_at[gte]'), '2026-01-01');
  });
});

// -----------------------------------------------------------------------------
// PeopleForceClient — recruitment (v3) + careers routing (fetch-mocked)
// -----------------------------------------------------------------------------

describe('PeopleForceClient — recruitment routing', () => {
  let stub: ReturnType<typeof stubFetch> | null = null;
  // A /api/public/v2 base makes v3 derivation deterministic on the same host.
  const V2 = 'https://x.example.com/api/public/v2';

  afterEach(() => {
    if (stub) { stub.restore(); stub = null; }
  });

  test('constructor derives v3 recruitment + careers bases from a v2 base', () => {
    const c = new PeopleForceClient('t', V2);
    assert.equal(c.recruitmentBaseUrl, 'https://x.example.com/api/public/v3');
    assert.equal(c.careersBaseUrl, 'https://x.example.com/api/careers/v1');
  });

  test('listVacancies hits the v3 host and serializes status[]/tag_ids[]', async () => {
    stub = stubFetch(() => ({ body: { data: [] } }));
    const c = new PeopleForceClient('t', V2);
    await c.listVacancies({ page: 2, status: ['opened', 'closed'], tagIds: [7, 9] });
    const url = new URL(stub.calls[0].url);
    assert.equal(url.origin, 'https://x.example.com');
    assert.equal(url.pathname, '/api/public/v3/recruitment/vacancies');
    assert.equal(url.searchParams.get('page'), '2');
    assert.deepEqual(url.searchParams.getAll('status[]'), ['opened', 'closed']);
    assert.deepEqual(url.searchParams.getAll('tag_ids[]'), ['7', '9']);
  });

  test('getVacancy hits the singular v3 path and URL-encodes the id', async () => {
    stub = stubFetch(() => ({ body: { data: { id: 'a/b' } } }));
    const c = new PeopleForceClient('t', V2);
    await c.getVacancy('a/b');
    assert.match(stub.calls[0].url, /\/api\/public\/v3\/recruitment\/vacancy\/a%2Fb$/);
  });

  test('listCandidates serializes array filters and literal bracket date filters', async () => {
    stub = stubFetch(() => ({ body: { data: [] } }));
    const c = new PeopleForceClient('t', V2);
    await c.listCandidates({
      page: 1,
      pipelineStageId: 55,
      skills: ['ts', 'go'],
      vacancyIds: [3],
      email: 'a@b.com',
      createdAtGte: '2026-01-01',
      updatedAtLte: '2026-07-01',
    });
    const url = new URL(stub.calls[0].url);
    assert.equal(url.pathname, '/api/public/v3/recruitment/candidates');
    assert.equal(url.searchParams.get('pipeline_stage_id'), '55');
    assert.deepEqual(url.searchParams.getAll('skills[]'), ['ts', 'go']);
    assert.deepEqual(url.searchParams.getAll('vacancy_ids[]'), ['3']);
    assert.equal(url.searchParams.get('email'), 'a@b.com');
    assert.equal(url.searchParams.get('created_at[gte]'), '2026-01-01');
    assert.equal(url.searchParams.get('updated_at[lte]'), '2026-07-01');
    // Unset optional filters are never serialized.
    assert.equal(url.searchParams.has('created_at[lte]'), false);
  });

  test('candidate-nested list endpoints hit the right v3 paths', async () => {
    stub = stubFetch(() => ({ body: { data: [] } }));
    const c = new PeopleForceClient('t', V2);
    await c.listCandidateNotes(42);
    await c.listCandidateExperiences(42);
    await c.listCandidateEducations(42);
    assert.deepEqual(
      stub.calls.map((r) => new URL(r.url).pathname),
      [
        '/api/public/v3/recruitment/candidates/42/notes',
        '/api/public/v3/recruitment/candidates/42/experiences',
        '/api/public/v3/recruitment/candidates/42/educations',
      ],
    );
  });

  test('listVacancyApplications nests under the vacancy', async () => {
    stub = stubFetch(() => ({ body: { data: [] } }));
    const c = new PeopleForceClient('t', V2);
    await c.listVacancyApplications({ vacancyId: 3, page: 2 });
    const url = new URL(stub.calls[0].url);
    assert.equal(url.pathname, '/api/public/v3/recruitment/vacancies/3/applications');
    assert.equal(url.searchParams.get('page'), '2');
  });

  test('moveVacancyApplication PUTs the pipeline_stage_id contract', async () => {
    stub = stubFetch(() => ({ body: { data: { id: 1 } } }));
    const c = new PeopleForceClient('t', V2);
    await c.moveVacancyApplication({ vacancyId: 3, applicationId: 8, pipelineStageId: 55, performAutomations: true });
    assert.equal(stub.calls[0].method, 'PUT');
    assert.match(stub.calls[0].url, /\/recruitment\/vacancies\/3\/applications\/8\/move$/);
    assert.deepEqual(JSON.parse(stub.calls[0].body as string), {
      pipeline_stage_id: 55,
      perform_automations: true,
    });
  });

  test('disqualifyVacancyApplication POSTs to the nested vacancy/application path', async () => {
    stub = stubFetch(() => ({ body: { data: { id: 1 } } }));
    const c = new PeopleForceClient('t', V2);
    await c.disqualifyVacancyApplication({ vacancyId: 3, applicationId: 8, disqualifyReasonId: 2, comment: 'nope' });
    assert.equal(stub.calls[0].method, 'POST');
    assert.match(stub.calls[0].url, /\/recruitment\/vacancies\/3\/applications\/8\/disqualify$/);
    // vacancy + application live in the path now, not the body.
    assert.deepEqual(JSON.parse(stub.calls[0].body as string), {
      disqualify_reason_id: 2,
      comment: 'nope',
    });
  });

  test('addCandidateNote POSTs the note body under the candidate', async () => {
    stub = stubFetch(() => ({ body: { data: { id: 1 } } }));
    const c = new PeopleForceClient('t', V2);
    await c.addCandidateNote({ candidateId: 42, body: 'Strong on system design' });
    assert.equal(stub.calls[0].method, 'POST');
    assert.match(stub.calls[0].url, /\/recruitment\/candidates\/42\/notes$/);
    assert.deepEqual(JSON.parse(stub.calls[0].body as string), { body: 'Strong on system design' });
  });

  test('getPublishedVacancy routes to the careers API host', async () => {
    stub = stubFetch(() => ({ body: { data: { id: 9 } } }));
    const c = new PeopleForceClient('t', V2);
    await c.getPublishedVacancy(9);
    const url = new URL(stub.calls[0].url);
    assert.equal(url.pathname, '/api/careers/v1/vacancies/9');
  });

  test('recruitment calls carry the same auth headers', async () => {
    stub = stubFetch(() => ({ body: { data: [] } }));
    const c = new PeopleForceClient('mykey', V2);
    await c.listRecruitmentPipelines();
    assert.equal(stub.calls[0].headers['X-API-KEY'], 'mykey');
    assert.equal(stub.calls[0].headers.Authorization, 'Bearer mykey');
    assert.equal(new URL(stub.calls[0].url).pathname, '/api/public/v3/recruitment/pipelines');
  });
});

// -----------------------------------------------------------------------------
// getCandidateDossier — best-effort composite
// -----------------------------------------------------------------------------

describe('getCandidateDossier', () => {
  let stub: ReturnType<typeof stubFetch> | null = null;
  const V2 = 'https://x.example.com/api/public/v2';

  afterEach(() => {
    if (stub) { stub.restore(); stub = null; }
  });

  test('assembles profile + notes + experiences + educations with no errors', async () => {
    stub = stubFetch((rec) => {
      const p = new URL(rec.url).pathname;
      if (p.endsWith('/recruitment/candidate/42')) return { body: { data: { id: 42, full_name: 'Ada' } } };
      if (p.endsWith('/notes')) return { body: { data: [{ id: 1, body: 'note' }] } };
      if (p.endsWith('/experiences')) return { body: { data: [{ id: 2, company: 'Acme' }] } };
      if (p.endsWith('/educations')) return { body: { data: [{ id: 3, school: 'MIT' }] } };
      return { body: { data: [] } };
    });
    const c = new PeopleForceClient('t', V2);
    const d = await c.getCandidateDossier({ candidateId: 42 });
    assert.equal(d.candidate?.full_name, 'Ada');
    assert.equal(d.notes.length, 1);
    assert.equal(d.experiences.length, 1);
    assert.equal(d.educations.length, 1);
    assert.equal(d.application, undefined);
    assert.deepEqual(d.errors, []);
  });

  test('records a partial failure instead of throwing', async () => {
    stub = stubFetch((rec) => {
      const p = new URL(rec.url).pathname;
      if (p.endsWith('/notes')) return { status: 500, body: 'boom' };
      if (p.endsWith('/recruitment/candidate/42')) return { body: { data: { id: 42 } } };
      return { body: { data: [] } };
    });
    const c = new PeopleForceClient('t', V2);
    const d = await c.getCandidateDossier({ candidateId: 42 });
    assert.ok(d.candidate);
    assert.deepEqual(d.notes, []);
    assert.deepEqual(d.errors, ['notes']);
  });

  test('matches the application on the given vacancy by candidate id', async () => {
    stub = stubFetch((rec) => {
      const p = new URL(rec.url).pathname;
      if (p.endsWith('/recruitment/candidate/42')) return { body: { data: { id: 42 } } };
      if (p.endsWith('/vacancies/3/applications')) {
        return { body: { data: [{ id: 900, candidate_id: 99 }, { id: 901, candidate: { id: 42 } }] } };
      }
      return { body: { data: [] } };
    });
    const c = new PeopleForceClient('t', V2);
    const d = await c.getCandidateDossier({ candidateId: 42, vacancyId: 3 });
    assert.equal(d.application?.id, 901);
    assert.deepEqual(d.errors, []);
  });

  test('records "application (no match…)" when no application matches the candidate', async () => {
    stub = stubFetch((rec) => {
      const p = new URL(rec.url).pathname;
      if (p.endsWith('/recruitment/candidate/42')) return { body: { data: { id: 42 } } };
      if (p.endsWith('/vacancies/3/applications')) return { body: { data: [{ id: 900, candidate_id: 99 }] } };
      return { body: { data: [] } };
    });
    const c = new PeopleForceClient('t', V2);
    const d = await c.getCandidateDossier({ candidateId: 42, vacancyId: 3 });
    assert.equal(d.application, undefined);
    assert.ok(d.errors.some((e) => /^application \(no match/.test(e)));
  });
});

// -----------------------------------------------------------------------------
// Recruitment formatters
// -----------------------------------------------------------------------------

describe('formatVacancyList / formatVacancy', () => {
  test('empty list without pagination', () => {
    assert.equal(formatVacancyList([]), 'No vacancies found.');
  });

  test('empty list surfaces pagination context', () => {
    const out = formatVacancyList([], { page: 4, pages: 2, count: 30, items: 25 });
    assert.match(out, /Page 4 of 2 \(30 total, 25 per page\)/);
    assert.match(out, /No vacancies on this page\./);
  });

  test('prefers title over name and renders status/department/count', () => {
    const out = formatVacancyList([
      { id: 5, title: 'Senior Engineer', name: 'ignored', status: 'opened', department: { id: 1, name: 'R&D' }, candidates_count: 12 },
    ]);
    assert.match(out, /Senior Engineer/);
    assert.doesNotMatch(out, /ignored/);
    assert.match(out, /Status: opened/);
    assert.match(out, /Department: R&D/);
    assert.match(out, /Candidates: 12/);
  });

  test('formatVacancy renders pipeline stages joined by arrows and the description', () => {
    const out = formatVacancy({
      id: 5,
      title: 'Senior Engineer',
      state: 'opened',
      pipeline: { id: 1, name: 'Default', stages: [{ id: 1, name: 'Applied' }, { id: 2, name: 'Interview' }] },
      description_plain: 'Build things.',
    });
    assert.match(out, /Status: opened/);
    assert.match(out, /Pipeline stages: Applied → Interview/);
    assert.match(out, /## Description/);
    assert.match(out, /Build things\./);
  });
});

describe('formatPipelineList', () => {
  test('renders stages with their ids', () => {
    const out = formatPipelineList([
      { id: 1, name: 'Engineering', stages: [{ id: 10, name: 'Applied' }, { id: 11, name: 'Hired' }] },
    ]);
    assert.match(out, /Engineering/);
    assert.match(out, /Applied \(ID: 10\) → Hired \(ID: 11\)/);
  });

  test('empty list', () => {
    assert.equal(formatPipelineList([]), 'No pipelines found.');
  });
});

describe('formatCandidateList / formatCandidate', () => {
  test('list prefers pipeline_stage over stage', () => {
    const out = formatCandidateList([
      { id: 7, full_name: 'Ada Lovelace', email: 'ada@x.com', pipeline_stage: { name: 'Interview' }, stage: { name: 'Applied' } },
    ]);
    assert.match(out, /Ada Lovelace/);
    assert.match(out, /Email: ada@x.com/);
    assert.match(out, /Stage: Interview/);
    assert.doesNotMatch(out, /Stage: Applied/);
  });

  test('candidate detail renders phone/salary/skills/disqualified', () => {
    const out = formatCandidate({
      id: 7,
      full_name: 'Ada Lovelace',
      phone_number: '+15550001111',
      expected_salary: 120000,
      skills: [{ id: 1, name: 'TypeScript' }, 'Go'],
      disqualified: false,
    });
    assert.match(out, /Phone: \+15550001111/);
    assert.match(out, /Salary expectation: 120000/);
    assert.match(out, /Skills: TypeScript, Go/);
    assert.match(out, /Disqualified: no/);
  });

  test('empty candidate list', () => {
    assert.equal(formatCandidateList([]), 'No candidates found.');
  });
});

describe('formatApplicationList', () => {
  test('renders candidate name, stage and disqualify reason', () => {
    const out = formatApplicationList([
      {
        id: 900,
        candidate: { id: 42, full_name: 'Grace Hopper' },
        pipeline_stage: { name: 'Interview' },
        disqualified: true,
        disqualify_reason: { id: 2, name: 'Withdrew' },
      },
    ]);
    assert.match(out, /Grace Hopper/);
    assert.match(out, /Application ID: 900/);
    assert.match(out, /Candidate ID: 42/);
    assert.match(out, /Stage: Interview/);
    assert.match(out, /Disqualified: yes/);
    assert.match(out, /Disqualify reason: Withdrew/);
  });

  test('falls back to State when no stage is present', () => {
    const out = formatApplicationList([{ id: 1, candidate: { full_name: 'A B' }, state: 'active' }]);
    assert.match(out, /State: active/);
  });

  test('empty list', () => {
    assert.equal(formatApplicationList([]), 'No applications found.');
  });
});

describe('candidate note/experience/education formatters', () => {
  test('formatCandidateNotes prefers created_by author and body text', () => {
    const out = formatCandidateNotes([
      { id: 1, body: 'Strong hire', created_by: { full_name: 'Interviewer X' }, created_at: '2026-07-01' },
    ]);
    assert.match(out, /# Candidate Notes/);
    assert.match(out, /Interviewer X — 2026-07-01/);
    assert.match(out, /Strong hire/);
  });

  test('formatCandidateNotes JSON-dumps a note with no recognizable text', () => {
    const out = formatCandidateNotes([{ id: 1, foo: 'bar' } as any]);
    assert.match(out, /```json/);
    assert.match(out, /"foo": "bar"/);
  });

  test('formatCandidateNotes empty', () => {
    assert.equal(formatCandidateNotes([]), 'No notes recorded for this candidate.');
  });

  test('formatCandidateExperiences renders "role @ company" and the period', () => {
    const out = formatCandidateExperiences([
      { id: 1, position: 'Engineer', company: 'Acme', starts_on: '2020-01-01', ends_on: '2023-01-01' },
    ]);
    assert.match(out, /Engineer @ Acme/);
    assert.match(out, /2020-01-01 – 2023-01-01/);
  });

  test('formatCandidateExperiences renders an open-ended period as "present"', () => {
    const out = formatCandidateExperiences([{ id: 1, title: 'Lead', company_name: 'Beta', starts_on: '2024-01-01' }]);
    assert.match(out, /Lead @ Beta/);
    assert.match(out, /2024-01-01 – present/);
  });

  test('formatCandidateEducations renders "degree, field @ institution"', () => {
    const out = formatCandidateEducations([
      { id: 1, degree: 'BSc', field_of_study: 'CS', institution: 'MIT', starts_on: '2016', ends_on: '2020' },
    ]);
    assert.match(out, /BSc, CS @ MIT/);
    assert.match(out, /2016 – 2020/);
  });

  test('education/experience empties', () => {
    assert.equal(formatCandidateExperiences([]), 'No work experience recorded for this candidate.');
    assert.equal(formatCandidateEducations([]), 'No education recorded for this candidate.');
  });
});

describe('formatMovementList', () => {
  test('renders candidate name and from → to stages', () => {
    const out = formatMovementList([
      {
        id: 1,
        candidate: { id: 42, full_name: 'Ada Lovelace' },
        from_stage: { name: 'Applied' },
        to_stage: { name: 'Interview' },
        moved_by: { full_name: 'Recruiter Y' },
        created_at: '2026-07-10',
      },
    ]);
    assert.match(out, /Ada Lovelace: Applied → Interview/);
    assert.match(out, /Moved by: Recruiter Y/);
    assert.match(out, /When: 2026-07-10/);
  });

  test('uses "?" placeholders for missing stages', () => {
    const out = formatMovementList([{ id: 1, candidate: { full_name: 'A B' } }]);
    assert.match(out, /A B: \? → \?/);
  });

  test('empty list', () => {
    assert.equal(formatMovementList([]), 'No movements found.');
  });
});

describe('formatPublishedVacancy', () => {
  test('unwraps a { data } envelope and renders the description', () => {
    const out = formatPublishedVacancy({ data: { id: 9, title: 'Backend Engineer', description_plain: 'Do backend.' } });
    assert.match(out, /# Backend Engineer/);
    assert.match(out, /## Description/);
    assert.match(out, /Do backend\./);
  });

  test('accepts a bare vacancy object (no envelope)', () => {
    const out = formatPublishedVacancy({ id: 9, name: 'Role', location: { id: 1, name: 'Remote' } });
    assert.match(out, /# Role/);
    assert.match(out, /Location: Remote/);
  });

  test('JSON-dumps when there is no description', () => {
    const out = formatPublishedVacancy({ id: 9, title: 'Role', foo: 'bar' } as any);
    assert.match(out, /```json/);
    assert.match(out, /"foo": "bar"/);
  });

  test('handles an empty payload', () => {
    assert.equal(formatPublishedVacancy({}), 'No published job description found.');
    assert.equal(formatPublishedVacancy({ data: {} }), 'No published job description found.');
  });
});

describe('formatCandidateDossier', () => {
  test('stitches profile, application, notes, experience and education sections', () => {
    const out = formatCandidateDossier({
      candidate: { id: 42, full_name: 'Ada Lovelace' },
      application: { id: 901, pipeline_stage: { name: 'Interview' }, disqualified: false },
      notes: [{ id: 1, body: 'Strong hire' }],
      experiences: [{ id: 2, position: 'Engineer', company: 'Acme' }],
      educations: [{ id: 3, degree: 'BSc', institution: 'MIT' }],
      errors: [],
    });
    assert.match(out, /# Ada Lovelace/);
    assert.match(out, /## Current Application/);
    assert.match(out, /Application ID: 901/);
    assert.match(out, /Stage: Interview/);
    assert.match(out, /# Candidate Notes/);
    assert.match(out, /Strong hire/);
    assert.match(out, /Engineer @ Acme/);
    assert.match(out, /BSc.*MIT/);
  });

  test('notes the profile is unavailable and surfaces load errors', () => {
    const out = formatCandidateDossier({
      candidate: undefined,
      notes: [],
      experiences: [],
      educations: [],
      errors: ['notes', 'experiences'],
    });
    assert.match(out, /profile unavailable/);
    assert.match(out, /could not load notes, experiences\./);
  });
});
