// src/__tests__/peopleforce-v4/tools.test.ts
//
// End-to-end-ish coverage of the tool → client hand-off.
//
// The unit tests next door prove the CLIENT builds the right query string, and
// the schemas prove the tool accepts the right arguments. Neither proves the
// two agree: the tools pass their parsed arguments straight through, so a zod
// key that does not match the client's input key (`ownerIds` vs `owner_ids`,
// `revieweeIds` vs `reviewerIds`) compiles, runs, returns a 200 — and silently
// drops the filter, answering a narrower question than the one asked. These
// tests execute the registered tools and assert what actually goes on the wire.

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Capture tools by patching addTool before importing the server (same idiom as
// src/__tests__/clickup/server.test.ts — FastMCP keeps tools in a private field).
const toolMap = new Map<string, { execute: (...args: any[]) => any; parameters: any }>();
const FastMCPModule = await import('fastmcp');
const origAddTool = FastMCPModule.FastMCP.prototype.addTool;
FastMCPModule.FastMCP.prototype.addTool = function (tool: any) {
  toolMap.set(tool.name, tool);
  return origAddTool.call(this, tool);
};
await import('../../peopleforce-v4/server.js');
FastMCPModule.FastMCP.prototype.addTool = origAddTool;

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; method: string; body?: string }> = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    calls.push({ url: input.toString(), method: init.method, body: init.body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [], metadata: { page: 1, per_page: 50, total_pages: 1, total_count: 0 } }),
      text: async () => '',
      headers: new Headers({ 'content-type': 'application/json' }),
    } as any as Response;
  }) as any;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const log = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };
const session: any = {
  peopleForceV4AccessToken: 'sa-key',
  peopleForceV4BaseUrl: 'https://x.example.com/api/v4',
};

async function run(toolName: string, args: Record<string, unknown>): Promise<URL> {
  const tool = toolMap.get(toolName);
  assert.ok(tool, `tool ${toolName} is not registered`);
  const parsed = tool!.parameters ? tool!.parameters.parse(args) : args;
  await tool!.execute(parsed, { log, session });
  return new URL(calls[calls.length - 1].url);
}

describe('registered tool surface', () => {
  test('registers every documented v4 tool', () => {
    for (const name of [
      'listPeople', 'getPerson', 'listTerminatedPeople', 'listBirthdays', 'listWorkAnniversaries',
      'listPersonAssets', 'listPersonSalaries', 'getPersonSalary', 'listPersonLifecycles',
      'listDepartments', 'getDepartment', 'listDivisions', 'getDivision', 'listWorkTypes', 'getWorkType',
      'listJobLevels', 'listLocations', 'listJobTitles',
      'listObjectives', 'getObjective', 'listReviewCycles', 'listReviewResponses',
      'listLifecycleSurveys', 'listLifecycleSurveyResponses', 'listEngagementSurveys', 'listEngagementSurveyResponses',
      'listComplianceCases', 'getComplianceCase', 'listComplianceCaseDocuments', 'getComplianceCaseDocument',
      'createPerson', 'updatePerson', 'createDepartment', 'updateDepartment', 'createLocation', 'updateLocation',
      'createDivision', 'updateDivision', 'createJobTitle', 'updateJobTitle',
      'createJobLevel', 'updateJobLevel', 'createWorkType', 'updateWorkType',
    ]) {
      assert.ok(toolMap.has(name), `missing tool: ${name}`);
    }
  });

  test('exposes no delete / terminate / activate tool', () => {
    // Deliberately unexposed: irreversible with no confirmation affordance
    // over MCP. If one is ever added it should be a decision, not a drift.
    const dangerous = [...toolMap.keys()].filter(n => /^(delete|terminate|activate)/i.test(n));
    assert.deepEqual(dangerous, []);
  });
});

describe('tool arguments reach the wire', () => {
  test('listPeople forwards every filter', async () => {
    const url = await run('listPeople', {
      status: 'terminated',
      managerId: 7,
      emails: ['a@b.com'],
      ids: [1, 2],
      personNumbers: ['P001'],
      legalEntityId: 4,
      hiredOn: { gte: '2026-01-01', lte: '2026-06-30' },
      page: 2,
      perPage: 100,
    });
    const q = url.searchParams;
    assert.equal(url.pathname, '/api/v4/people');
    assert.equal(q.get('status'), 'terminated');
    assert.equal(q.get('manager_id'), '7');
    assert.deepEqual(q.getAll('emails[]'), ['a@b.com']);
    assert.deepEqual(q.getAll('ids[]'), ['1', '2']);
    assert.deepEqual(q.getAll('person_numbers[]'), ['P001']);
    assert.equal(q.get('legal_entity_id'), '4');
    assert.equal(q.get('hired_on[gte]'), '2026-01-01');
    assert.equal(q.get('hired_on[lte]'), '2026-06-30');
    assert.equal(q.get('page'), '2');
    assert.equal(q.get('per_page'), '100');
  });

  test('listObjectives forwards its filters', async () => {
    const url = await run('listObjectives', {
      status: 'at_risk',
      states: ['opened', 'overdue'],
      objectiveTypes: ['department'],
      ownerIds: [11],
      departmentIds: [3],
      divisionIds: [5],
      locationIds: [6],
      teamIds: [9],
      endsOn: { lte: '2026-12-31' },
    });
    const q = url.searchParams;
    assert.equal(url.pathname, '/api/v4/perform/objectives');
    assert.equal(q.get('status'), 'at_risk');
    assert.deepEqual(q.getAll('states[]'), ['opened', 'overdue']);
    assert.deepEqual(q.getAll('objective_types[]'), ['department']);
    assert.deepEqual(q.getAll('owner_ids[]'), ['11']);
    assert.deepEqual(q.getAll('department_ids[]'), ['3']);
    assert.deepEqual(q.getAll('division_ids[]'), ['5']);
    assert.deepEqual(q.getAll('location_ids[]'), ['6']);
    assert.deepEqual(q.getAll('team_ids[]'), ['9']);
    assert.equal(q.get('ends_on[lte]'), '2026-12-31');
  });

  test('listReviewResponses does not confuse reviewee with reviewer', async () => {
    const url = await run('listReviewResponses', { revieweeIds: [42], reviewCycleIds: [7], reviewCycleType: 'manual' });
    const q = url.searchParams;
    assert.deepEqual(q.getAll('reviewee_ids[]'), ['42']);
    assert.deepEqual(q.getAll('review_cycle_ids[]'), ['7']);
    assert.equal(q.get('review_cycle_type'), 'manual');
  });

  test('compliance filters forward, including the boolean', async () => {
    const url = await run('listComplianceCases', {
      employeeIds: [3],
      statuses: ['pending'],
      documentStatuses: ['unverified'],
      documentPendingUpload: true,
    });
    const q = url.searchParams;
    assert.deepEqual(q.getAll('employee_ids[]'), ['3']);
    assert.deepEqual(q.getAll('statuses[]'), ['pending']);
    assert.deepEqual(q.getAll('document_statuses[]'), ['unverified']);
    assert.equal(q.get('document_pending_upload'), 'true');
  });

  test('survey response filters forward', async () => {
    const url = await run('listEngagementSurveyResponses', { surveyIds: [2], userIds: [8], fields: ['dev_sprint'] });
    const q = url.searchParams;
    assert.equal(url.pathname, '/api/v4/pulse/engagement_survey_responses');
    assert.deepEqual(q.getAll('survey_ids[]'), ['2']);
    assert.deepEqual(q.getAll('user_ids[]'), ['8']);
    assert.deepEqual(q.getAll('fields[]'), ['dev_sprint']);
  });

  test('person-scoped tools build the nested path', async () => {
    assert.equal((await run('listPersonSalaries', { personId: 42 })).pathname, '/api/v4/people/42/compensation/salaries');
    assert.equal((await run('listPersonLifecycles', { personId: 42 })).pathname, '/api/v4/people/42/lifecycles');
    assert.equal((await run('getPersonSalary', { personId: 42, salaryId: 9 })).pathname, '/api/v4/people/42/compensation/salaries/9');
  });

  test('getPerson forwards include_historical_values only when asked', async () => {
    assert.equal((await run('getPerson', { id: 1 })).searchParams.get('include_historical_values'), null);
    assert.equal((await run('getPerson', { id: 1, includeHistoricalValues: true })).searchParams.get('include_historical_values'), 'true');
  });

  test('writes send the documented snake_case body', async () => {
    await run('createPerson', { firstName: 'Ada', lastName: 'Lovelace', hiredOn: '2026-02-02' });
    assert.deepEqual(JSON.parse(calls[calls.length - 1].body!), {
      first_name: 'Ada',
      last_name: 'Lovelace',
      hired_on: '2026-02-02',
    });
    assert.equal(calls[calls.length - 1].method, 'POST');

    await run('updateDepartment', { id: 5, name: 'Ops', parentId: 2 });
    assert.deepEqual(JSON.parse(calls[calls.length - 1].body!), { name: 'Ops', parent_id: 2 });
    assert.equal(calls[calls.length - 1].method, 'PUT');

    await run('createWorkType', { name: 'Contractor' });
    assert.deepEqual(JSON.parse(calls[calls.length - 1].body!), { name: 'Contractor' });
  });
});

describe('unconnected session', () => {
  test('a tool called without a v4 key says which key type to paste', async () => {
    const tool = toolMap.get('listPeople')!;
    await assert.rejects(
      () => tool.execute({ page: 1 }, { log, session: { peopleForceAccessToken: 'company-key' } as any }),
      /Service account/,
    );
  });
});
