// Runs the real PeopleForce v3 and v4 servers' compensation tools with a
// stubbed fetch: an unlisted caller is refused before any upstream call.
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

type Tool = { name: string; description?: string; execute: (...a: any[]) => any; parameters?: any };
const v3Tools = new Map<string, Tool>();
const v4Tools = new Map<string, Tool>();
const FastMCPModule = await import('fastmcp');
const origAddTool = FastMCPModule.FastMCP.prototype.addTool;
let sink = v3Tools;
FastMCPModule.FastMCP.prototype.addTool = function (tool: any) {
  sink.set(tool.name, tool);
  return origAddTool.call(this, tool);
};
const v3 = await import('../../peopleforce/server.js');
sink = v4Tools;
const v4 = await import('../../peopleforce-v4/server.js');
FastMCPModule.FastMCP.prototype.addTool = origAddTool;

const { COMPENSATION_RESTRICTED_MESSAGE } = await import('../../auth/compensationAccess.js');

const realFetch = globalThis.fetch;
let urls: string[] = [];
let status = 200;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  urls = [];
  status = 200;
  saved = { a: process.env.ADMIN_EMAILS, c: process.env.PEOPLEFORCE_COMPENSATION_EMAILS };
  delete process.env.ADMIN_EMAILS;
  process.env.PEOPLEFORCE_COMPENSATION_EMAILS = 'hr@example.com';
  globalThis.fetch = (async (input: any) => {
    urls.push(String(input));
    const body = String(input).includes('/v4/')
      ? { data: { id: 9, amount: '1234.00', currency_code: 'EUR', per: 'month', effective_on: '2026-01-01' } }
      : { data: [{ id: 1, effective_on: '2026-01-01', amount: '1234.00', currency_code: 'EUR', per: 'month' }] };
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (saved.a === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = saved.a;
  if (saved.c === undefined) delete process.env.PEOPLEFORCE_COMPENSATION_EMAILS; else process.env.PEOPLEFORCE_COMPENSATION_EMAILS = saved.c;
});

const log = { info() {}, error() {}, warn() {}, debug() {} };
const sess3 = (email?: string): any => ({ email, peopleForceAccessToken: 'k', peopleForceBaseUrl: 'https://x.example.com/api/public/v3' });
const sess4 = (email?: string): any => ({ email, peopleForceV4AccessToken: 'k', peopleForceV4BaseUrl: 'https://x.example.com/api/v4' });
const call = (tools: Map<string, Tool>, name: string, args: any, session: any) => {
  const t = tools.get(name)!;
  assert.ok(t, `${name} not registered`);
  return t.execute(t.parameters ? t.parameters.parse(args) : args, { log, session });
};

describe('v3 listEmployeeSalaries', () => {
  test('refuses an unlisted email with zero upstream calls', async () => {
    await assert.rejects(call(v3Tools, 'listEmployeeSalaries', { employeeId: 1 }, sess3('nobody@example.com')), { message: COMPENSATION_RESTRICTED_MESSAGE });
    await assert.rejects(call(v3Tools, 'listEmployeeSalaries', { employeeId: 1 }, sess3(undefined)), { message: COMPENSATION_RESTRICTED_MESSAGE });
    assert.equal(urls.length, 0);
  });
  test('returns the formatted salaries to a listed email', async () => {
    const out = await call(v3Tools, 'listEmployeeSalaries', { employeeId: 1 }, sess3('HR@example.com'));
    assert.match(String(out), /1234\.00 EUR per month/);
    assert.equal(urls.length, 1);
  });
  test('an upstream 403 names the key restriction, not an empty list', async () => {
    status = 403;
    await assert.rejects(call(v3Tools, 'listEmployeeSalaries', { employeeId: 1 }, sess3('hr@example.com')), /may not view compensation/);
  });
});

describe('v4 salary tools', () => {
  test('refuse an unlisted email with zero upstream calls', async () => {
    await assert.rejects(call(v4Tools, 'listPersonSalaries', { personId: 1 }, sess4('nobody@example.com')), { message: COMPENSATION_RESTRICTED_MESSAGE });
    await assert.rejects(call(v4Tools, 'getPersonSalary', { personId: 1, salaryId: 9 }, sess4('nobody@example.com')), { message: COMPENSATION_RESTRICTED_MESSAGE });
    assert.equal(urls.length, 0);
  });
  test('serve a listed email', async () => {
    await call(v4Tools, 'listPersonSalaries', { personId: 1 }, sess4('hr@example.com'));
    await call(v4Tools, 'getPersonSalary', { personId: 1, salaryId: 9 }, sess4('hr@example.com'));
    assert.equal(urls.length, 2);
  });
});

describe('exhaustiveness: every compensation-looking tool is gated', () => {
  const PATTERN = /salar|compensation|pay rate/i;
  const EXEMPT = new Map<string, string>([
    ['getCandidate', 'candidate salary expectation, not employee compensation'],
    ['getCandidateDossier', 'candidate salary expectation, not employee compensation'],
  ]);
  for (const [label, tools, guarded] of [
    ['v3', v3Tools, v3.PEOPLEFORCE_COMPENSATION_TOOLS],
    ['v4', v4Tools, v4.PEOPLEFORCE_V4_COMPENSATION_TOOLS],
  ] as const) {
    test(`${label}: matches are guarded or explicitly exempt`, () => {
      const ungated = [...tools.values()]
        .filter((t) => PATTERN.test(t.name) || PATTERN.test(t.description ?? ''))
        .map((t) => t.name)
        .filter((n) => !guarded.has(n) && !EXEMPT.has(n));
      assert.deepEqual(ungated, [], 'add these to the guarded set (or EXEMPT with a reason)');
      for (const n of guarded) assert.ok(tools.has(n), `guarded tool ${n} is not registered`);
    });
  }
});
