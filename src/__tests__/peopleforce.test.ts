// src/__tests__/peopleforce.test.ts
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { UserError } from 'fastmcp';
import { peopleForceServer } from '../peopleforce/server.js';
import {
  PeopleForceClient,
  formatEmployeeList,
  formatEmployee,
  formatDepartmentList,
  formatLeaveRequestList,
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
