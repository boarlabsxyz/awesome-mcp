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

  test('renders employees with names, ids, and departments', () => {
    const out = formatEmployeeList([
      { id: 42, first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', department: { id: 1, name: 'R&D' } },
    ]);
    assert.match(out, /# Employees/);
    assert.match(out, /Ada Lovelace/);
    assert.match(out, /ID: 42/);
    assert.match(out, /Department: R&D/);
  });

  test('renders position as a string', () => {
    const out = formatEmployeeList([{ id: 1, first_name: 'A', last_name: 'B', position: 'Engineer' }]);
    assert.match(out, /Position: Engineer/);
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
  test('renders single employee with position object and status', () => {
    const out = formatEmployee({
      id: 7,
      first_name: 'Grace',
      last_name: 'Hopper',
      position: { name: 'Rear Admiral' },
      status: 'active',
      hired_at: '1949-05-01',
    });
    assert.match(out, /# Grace Hopper/);
    assert.match(out, /Position: Rear Admiral/);
    assert.match(out, /Status: active/);
    assert.match(out, /Hired: 1949-05-01/);
  });

  test('includes terminated_at when present', () => {
    const out = formatEmployee({ id: 1, first_name: 'A', last_name: 'B', terminated_at: '2026-01-01' });
    assert.match(out, /Terminated: 2026-01-01/);
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
});

describe('formatLeaveRequestList', () => {
  test('handles empty list', () => {
    assert.equal(formatLeaveRequestList([]), 'No leave requests found.');
  });

  test('renders leave request with employee and leave_type object', () => {
    const out = formatLeaveRequestList([
      {
        id: 9,
        employee: { first_name: 'Ada', last_name: 'Lovelace' },
        leave_type: { id: 1, name: 'Vacation' },
        starts_on: '2026-08-01',
        ends_on: '2026-08-05',
        state: 'approved',
        duration: 5,
        description: 'Beach',
      },
    ]);
    assert.match(out, /Ada Lovelace — Vacation/);
    assert.match(out, /Starts: 2026-08-01/);
    assert.match(out, /Ends: 2026-08-05/);
    assert.match(out, /State: approved/);
    assert.match(out, /Duration: 5/);
    assert.match(out, /Description: Beach/);
  });

  test('renders leave_type as a string', () => {
    const out = formatLeaveRequestList([
      { id: 1, employee: { first_name: 'A', last_name: 'B' }, leave_type: 'Sick', starts_on: '2026-01-01' },
    ]);
    assert.match(out, /A B — Sick/);
  });

  test('falls back to "Leave" when leave_type missing', () => {
    const out = formatLeaveRequestList([{ id: 1, employee: { first_name: 'A', last_name: 'B' } }]);
    assert.match(out, /A B — Leave/);
  });

  test('renders pagination when meta present', () => {
    const out = formatLeaveRequestList(
      [{ id: 1, employee: { first_name: 'A', last_name: 'B' } }],
      { page: 1, total_pages: 3, total_count: 30 },
    );
    assert.match(out, /Page 1 of 3 \(30 total\)/);
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

  test('listEmployees serializes query params (snake_case)', async () => {
    stub = stubFetch(() => ({ body: { data: [{ id: 1 }], meta: { page: 1 } } }));
    const c = new PeopleForceClient('t', 'https://x.example.com');
    const res = await c.listEmployees({ page: 2, per_page: 50, status: 'active', departmentId: 7 });
    const url = new URL(stub.calls[0].url);
    assert.equal(url.pathname, '/employees');
    assert.equal(url.searchParams.get('page'), '2');
    assert.equal(url.searchParams.get('per_page'), '50');
    assert.equal(url.searchParams.get('status'), 'active');
    assert.equal(url.searchParams.get('department_id'), '7');
    assert.deepEqual(res.data, [{ id: 1 }]);
  });

  test('getEmployee URL-encodes the id and hits the singular path', async () => {
    stub = stubFetch(() => ({ body: { data: { id: 'x/y' } } }));
    const c = new PeopleForceClient('t', 'https://x.example.com');
    await c.getEmployee('x/y');
    assert.match(stub.calls[0].url, /\/employees\/x%2Fy$/);
  });

  test('listDepartments passes pagination', async () => {
    stub = stubFetch(() => ({ body: { data: [] } }));
    const c = new PeopleForceClient('t', 'https://x.example.com');
    await c.listDepartments({ page: 3, per_page: 10 });
    const url = new URL(stub.calls[0].url);
    assert.equal(url.searchParams.get('page'), '3');
    assert.equal(url.searchParams.get('per_page'), '10');
  });

  test('listLeaveRequests uses /leave_requests and starts_on_from/to + state', async () => {
    stub = stubFetch(() => ({ body: { data: [] } }));
    const c = new PeopleForceClient('t', 'https://x.example.com');
    await c.listLeaveRequests({
      employeeId: 42,
      state: 'approved',
      startsFrom: '2026-01-01',
      startsTo: '2026-12-31',
    });
    const url = new URL(stub.calls[0].url);
    assert.equal(url.pathname, '/leave_requests');
    assert.equal(url.searchParams.get('employee_id'), '42');
    assert.equal(url.searchParams.get('state'), 'approved');
    assert.equal(url.searchParams.get('starts_on_from'), '2026-01-01');
    assert.equal(url.searchParams.get('starts_on_to'), '2026-12-31');
  });

  test('createLeaveRequest POSTs the leave_requests contract', async () => {
    stub = stubFetch(() => ({ status: 201, body: { data: { id: 99 } } }));
    const c = new PeopleForceClient('t', 'https://x.example.com');
    const res = await c.createLeaveRequest({
      employeeId: 42,
      leaveType: 3,
      startsOn: '2026-08-01',
      endsOn: '2026-08-05',
      description: 'Beach',
    });
    assert.equal(stub.calls[0].method, 'POST');
    assert.match(stub.calls[0].url, /\/leave_requests$/);
    const body = JSON.parse(stub.calls[0].body as string);
    assert.deepEqual(body, {
      employee_id: 42,
      leave_type: 3,
      starts_on: '2026-08-01',
      ends_on: '2026-08-05',
      description: 'Beach',
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
    // getEmployee happens to hit the same request path; type says { data } but 204 → undefined
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
