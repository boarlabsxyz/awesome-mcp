// src/__tests__/peopleforce-v4/apiHelpers.test.ts
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { UserError } from 'fastmcp';
import {
  PeopleForceV4Client,
  resolveV4BaseUrl,
  rangeParams,
  formatPaginationFooter,
  formatPerson,
  formatPersonList,
  formatSurveyResponseList,
  formatComplianceDocument,
  emptyListNote,
  mapPeopleForceV4Error,
  getPeopleForceV4Client,
} from '../../peopleforce-v4/apiHelpers.js';

// --- fetch stub -------------------------------------------------------------

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
let calls: Call[] = [];
let respond: () => { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  respond = () => ({ status: 200, json: { data: [], metadata: { page: 1 } } });
  globalThis.fetch = (async (input: any, init: any = {}) => {
    calls.push({
      url: typeof input === 'string' ? input : input.toString(),
      method: init.method,
      headers: init.headers ?? {},
      body: init.body,
    });
    const r = respond();
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.json,
      text: async () => r.text ?? JSON.stringify(r.json ?? ''),
      headers: new Headers({ 'content-type': 'application/json', ...(r.headers ?? {}) }),
    } as any as Response;
  }) as any;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const client = () => new PeopleForceV4Client('sa-key', 'https://x.example.com/api/v4');
const lastUrl = () => new URL(calls[calls.length - 1].url);

// --- base URL ---------------------------------------------------------------

describe('resolveV4BaseUrl', () => {
  test('defaults to the v4 base, which is NOT under /api/public', () => {
    const prev = process.env.PEOPLEFORCE_V4_BASE_URL;
    delete process.env.PEOPLEFORCE_V4_BASE_URL;
    try {
      assert.equal(resolveV4BaseUrl(), 'https://app.peopleforce.io/api/v4');
    } finally {
      if (prev !== undefined) process.env.PEOPLEFORCE_V4_BASE_URL = prev;
    }
  });

  test('strips trailing slashes from an override', () => {
    assert.equal(resolveV4BaseUrl('https://t.example.com/api/v4///'), 'https://t.example.com/api/v4');
  });
});

// --- request building -------------------------------------------------------

describe('PeopleForceV4Client — request building', () => {
  test('sends X-API-KEY and no bearer (v4 documents one header)', async () => {
    await client().listPeople();
    assert.equal(calls[0].headers['X-API-KEY'], 'sa-key');
    assert.equal(calls[0].headers.Authorization, undefined);
  });

  test('people list hits /people, not /employees', async () => {
    await client().listPeople();
    assert.equal(lastUrl().pathname, '/api/v4/people');
  });

  test('paging knobs map to page/per_page/offset', async () => {
    await client().listPeople({ page: 3, perPage: 100, offset: 10 });
    const q = lastUrl().searchParams;
    assert.equal(q.get('page'), '3');
    assert.equal(q.get('per_page'), '100');
    assert.equal(q.get('offset'), '10');
  });

  test('array filters serialize as repeated bracket keys', async () => {
    await client().listPeople({ emails: ['a@b.com', 'c@d.com'], ids: [1, 2] });
    const q = lastUrl().searchParams;
    assert.deepEqual(q.getAll('emails[]'), ['a@b.com', 'c@d.com']);
    assert.deepEqual(q.getAll('ids[]'), ['1', '2']);
  });

  test('date ranges become literal bracket keys', async () => {
    await client().listPeople({ hiredOn: { gte: '2026-01-01', lte: '2026-06-30' } });
    const q = lastUrl().searchParams;
    assert.equal(q.get('hired_on[gte]'), '2026-01-01');
    assert.equal(q.get('hired_on[lte]'), '2026-06-30');
  });

  test('rangeParams drops an absent bound rather than sending an empty one', () => {
    assert.deepEqual(rangeParams('ends_on', { gte: '2026-01-01' }), { 'ends_on[gte]': '2026-01-01' });
    assert.deepEqual(rangeParams('ends_on', undefined), {});
  });

  test('terminated people use their own path + terminated_on range', async () => {
    await client().listTerminatedPeople({ terminatedOn: { gte: '2026-01-01' } });
    assert.equal(lastUrl().pathname, '/api/v4/people/terminated');
    assert.equal(lastUrl().searchParams.get('terminated_on[gte]'), '2026-01-01');
  });

  test('nested person resources build the documented paths', async () => {
    const c = client();
    await c.listPersonSalaries(42);
    assert.equal(lastUrl().pathname, '/api/v4/people/42/compensation/salaries');
    await c.listPersonLifecycles(42);
    assert.equal(lastUrl().pathname, '/api/v4/people/42/lifecycles');
    await c.listPersonAssets(42);
    assert.equal(lastUrl().pathname, '/api/v4/people/42/assets');
  });

  test('perform/pulse/compliance namespaces are preserved', async () => {
    const c = client();
    await c.listObjectives();
    assert.equal(lastUrl().pathname, '/api/v4/perform/objectives');
    await c.listReviewResponses();
    assert.equal(lastUrl().pathname, '/api/v4/perform/review_responses');
    await c.listEngagementSurveys();
    assert.equal(lastUrl().pathname, '/api/v4/pulse/engagement_surveys');
    await c.listComplianceCases();
    assert.equal(lastUrl().pathname, '/api/v4/compliance/compliance_cases');
  });

  test('writes send a JSON body with the documented snake_case keys', async () => {
    respond = () => ({ status: 201, json: { id: 7, name: 'Ops' } });
    await client().createDepartment({ name: 'Ops', parent_id: 3, manager_id: undefined });
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].body!), { name: 'Ops', parent_id: 3 });
  });

  test('a non-2xx carries status + Retry-After through to the caller', async () => {
    respond = () => ({ status: 429, text: 'slow down', headers: { 'retry-after': '30' } });
    await assert.rejects(
      () => client().listPeople(),
      (err: any) => err.status === 429 && err.retryAfter === '30',
    );
  });
});

// --- formatters -------------------------------------------------------------

describe('pagination + empty lists', () => {
  test('footer reads v4 field names, not the pre-v4 ones', () => {
    const footer = formatPaginationFooter({ page: 2, per_page: 50, total_pages: 7, total_count: 340 });
    assert.match(footer, /Page 2 of 7/);
    assert.match(footer, /340 total/);
    assert.match(footer, /50 per page/);
  });

  test('a v3-shaped payload does not silently render as a total', () => {
    // { pages, count, items } are the PRE-v4 names; reading them off a v4
    // response yields undefined, so nothing must be asserted about totals.
    const footer = formatPaginationFooter({ page: 1 } as any);
    assert.equal(footer.includes('total'), false);
  });

  test('an empty list explains the role-population ambiguity instead of saying "none"', () => {
    const note = emptyListNote('people');
    assert.match(note, /No people returned/);
    assert.match(note, /outside the service account role's population are omitted/);
    assert.match(note, /Roles & permissions/);
  });

  test('formatPersonList renders the empty note, not an empty string', () => {
    assert.match(formatPersonList([]), /No people returned/);
  });
});

describe('formatPerson — absent vs empty', () => {
  const granted = {
    id: 1,
    full_name: 'Ada Lovelace',
    status: 'active',
    email: 'ada@example.com',
    personal_email: '',
    work_phone_number: '',
    mobile_number: '',
    date_of_birth: '',
    hired_on: '2020-01-01',
    probation_ends_on: '',
    position: { id: 2, name: 'Engineer' },
    job_level: null,
    location: null,
    employment_type: null,
    division: null,
    department: { id: 3, name: 'R&D' },
    reporting_to: null,
    legal_entity: null,
    gender: null,
  };

  test('renders the fields the role granted', () => {
    const out = formatPerson(granted);
    assert.match(out, /Ada Lovelace \(ID: 1\)/);
    assert.match(out, /Position: Engineer/);
    assert.match(out, /Department: R&D/);
    assert.match(out, /Hired on: 2020-01-01/);
  });

  test('a fully granted record carries no withheld-fields warning', () => {
    assert.equal(formatPerson(granted).includes('Not returned by v4'), false);
  });

  test('names the fields v4 omitted, so a gap is not read as "no value"', () => {
    // hired_on and department are ABSENT here, not empty — the role did not
    // grant them. Rendering nothing would assert this person has no department.
    const { hired_on, department, ...withheld } = granted as any;
    const out = formatPerson(withheld);
    assert.match(out, /Not returned by v4 for this person/);
    assert.match(out, /hired_on/);
    assert.match(out, /department/);
    assert.match(out, /NOT "this person has no value"/);
  });

  test('termination details are rendered when present', () => {
    const out = formatPerson({
      ...granted,
      status: 'inactive',
      termination_effective_on: '2026-03-31',
      termination_reason: { id: 9, name: 'Resignation' },
    });
    assert.match(out, /Terminated on: 2026-03-31/);
    assert.match(out, /Termination reason: Resignation/);
  });
});

describe('formatters that must not over-claim', () => {
  test('an anonymous survey response is reported as anonymous, not as an unknown employee', () => {
    const out = formatSurveyResponseList([{ id: 1, survey_id: 2, user_id: null, anonymous: true, status: 'finished' }]);
    assert.match(out, /anonymous/);
    assert.equal(out.includes('employee #'), false);
  });

  test('an attributed response names the employee', () => {
    const out = formatSurveyResponseList([{ id: 1, survey_id: 2, user_id: 55, anonymous: false }]);
    assert.match(out, /employee #55/);
  });

  test('an attachment URL is rendered with its expiry', () => {
    const out = formatComplianceDocument({
      id: 3,
      status: 'verified',
      attachment: { url: 'https://files.example.com/a.pdf', expires_at: '2026-09-18T10:00:00Z' },
    });
    assert.match(out, /https:\/\/files\.example\.com\/a\.pdf \(expires 2026-09-18T10:00:00Z\)/);
  });
});

// --- session + errors -------------------------------------------------------

describe('getPeopleForceV4Client', () => {
  test('tells an unconnected caller which key type to use', () => {
    assert.throws(() => getPeopleForceV4Client(undefined), (err: any) => {
      assert.ok(err instanceof UserError);
      assert.match(err.message, /Service account/);
      return true;
    });
  });

  test('never falls back to the v2/v3 token on the session', () => {
    // A session carrying only the Company key must NOT satisfy the v4 client:
    // that key cannot call /api/v4 at all, so using it would turn a clear
    // "not connected" into a 401 from the provider.
    const session: any = { peopleForceAccessToken: 'company-key' };
    assert.throws(() => getPeopleForceV4Client(session), /not connected/);
  });
});

describe('mapPeopleForceV4Error', () => {
  const log = { info: () => {}, error: () => {} };
  const mapped = (status: number, extra: Record<string, unknown> = {}) => {
    try {
      mapPeopleForceV4Error('Error listing people', { status, message: 'x', ...extra }, log);
    } catch (err: any) {
      return err.message as string;
    }
    throw new Error('expected a throw');
  };

  test('401 points at the key TYPE, the most likely first-run cause', () => {
    assert.match(mapped(401), /Service account/);
    assert.match(mapped(401), /Company or\s+Career key cannot call API v4/);
  });

  test('403 points at the role, not the key', () => {
    assert.match(mapped(403), /role does not grant this action/);
  });

  test('404 refuses to claim the record does not exist', () => {
    // v4 returns 404 both for a missing record AND for one outside the role's
    // population. Reporting a bare "not found" sends the caller hunting for a
    // deleted row that is merely invisible.
    const msg = mapped(404);
    assert.match(msg, /does not exist OR it falls outside the population/);
  });

  test('429 surfaces Retry-After and the documented limit', () => {
    const msg = mapped(429, { retryAfter: '30' });
    assert.match(msg, /300 requests\/minute/);
    assert.match(msg, /Retry after 30s/);
  });

  test('422 includes the validation body so the caller can fix the payload', () => {
    assert.match(mapped(422, { body: '{"detail":["name is required"]}' }), /name is required/);
  });
});
