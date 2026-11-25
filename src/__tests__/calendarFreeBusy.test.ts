import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { UserError } from 'fastmcp';

// queryFreeBusy driven against a stub client, with the tool body captured by
// patching FastMCP.addTool before importing the server (the calendarWriteTools
// pattern). The contract that matters most: a calendar Google could not read is
// reported as unknown, never as free.

const toolMap = new Map<string, { execute: (...args: any[]) => any; parameters: any }>();
const FastMCPModule = await import('fastmcp');
const origAddTool = FastMCPModule.FastMCP.prototype.addTool;
FastMCPModule.FastMCP.prototype.addTool = function (tool: any) {
  toolMap.set(tool.name, tool);
  return origAddTool.call(this, tool);
};
const calendarModule = await import('../google-calendar/server.js');
FastMCPModule.FastMCP.prototype.addTool = origAddTool;

const noopLog = { info: () => {}, error: () => {}, warn: () => {} };

function mkErr(code: number, message = 'boom'): any {
  const e: any = new Error(message);
  e.code = code;
  return e;
}

/** A calendar_v3.Calendar-shaped stub: only freebusy.query is reached. */
function mkCalendar(impl: (params: any) => Promise<any>) {
  return { freebusy: { query: mock.fn(impl) } } as any;
}

async function run(args: any, calendar: any) {
  const tool = toolMap.get('queryFreeBusy')!;
  return tool.execute(tool.parameters.parse(args), { session: { googleCalendar: calendar }, log: noopLog });
}

const DAY = 24 * 60 * 60 * 1000;

describe('queryFreeBusy', () => {
  it('is registered as read-only', () => {
    const tool: any = toolMap.get('queryFreeBusy');
    assert.ok(tool);
    assert.deepEqual(tool.annotations, { readOnlyHint: true });
  });

  it('defaults to the primary calendar and a 7-day range from now', async () => {
    const calendar = mkCalendar(async () => ({ data: { calendars: { primary: { busy: [] } } } }));
    const before = Date.now();
    const out = await run({}, calendar);
    const after = Date.now();

    assert.equal(calendar.freebusy.query.mock.callCount(), 1);
    const body = calendar.freebusy.query.mock.calls[0].arguments[0].requestBody;
    assert.deepEqual(body.items, [{ id: 'primary' }]);
    assert.equal(body.timeZone, undefined);
    const min = Date.parse(body.timeMin);
    assert.ok(min >= before - 1000 && min <= after + 1000);
    assert.equal(Date.parse(body.timeMax) - min, 7 * DAY);
    assert.ok(out.startsWith(`Free/busy from ${body.timeMin} → ${body.timeMax}`));
  });

  it('defaults timeMax to 7 days after a given timeMin and passes timeZone through', async () => {
    const calendar = mkCalendar(async () => ({ data: { calendars: { primary: { busy: [] } } } }));
    const out = await run({ timeMin: '2026-03-02T00:00:00Z', timeZone: 'Europe/Berlin' }, calendar);
    const body = calendar.freebusy.query.mock.calls[0].arguments[0].requestBody;
    assert.equal(body.timeMin, '2026-03-02T00:00:00Z');
    assert.equal(body.timeMax, '2026-03-09T00:00:00.000Z');
    assert.equal(body.timeZone, 'Europe/Berlin');
    assert.match(out, /time zone: Europe\/Berlin/);
  });

  it('renders busy blocks per calendar in request order', async () => {
    // Response keys in the opposite order to the request: the output must follow the request.
    const calendar = mkCalendar(async () => ({
      data: {
        calendars: {
          'bob@example.com': { busy: [{ start: '2026-03-02T13:00:00Z', end: '2026-03-02T14:00:00Z' }] },
          'alice@example.com': {
            busy: [
              { start: '2026-03-02T09:00:00Z', end: '2026-03-02T10:00:00Z' },
              { start: '2026-03-02T11:00:00Z', end: '2026-03-02T11:30:00Z' },
            ],
          },
        },
      },
    }));
    const out: string = await run({
      calendarIds: ['alice@example.com', 'bob@example.com'],
      timeMin: '2026-03-02T00:00:00Z',
      timeMax: '2026-03-03T00:00:00Z',
    }, calendar);

    const body = calendar.freebusy.query.mock.calls[0].arguments[0].requestBody;
    assert.deepEqual(body.items, [{ id: 'alice@example.com' }, { id: 'bob@example.com' }]);

    const alice = out.indexOf('**alice@example.com**');
    const bob = out.indexOf('**bob@example.com**');
    assert.ok(alice >= 0 && bob > alice, 'alice (requested first) must render before bob');
    const aliceSection = out.slice(alice, bob);
    const bobSection = out.slice(bob);
    assert.match(aliceSection, /2026-03-02T09:00:00Z – 2026-03-02T10:00:00Z/);
    assert.match(aliceSection, /2026-03-02T11:00:00Z – 2026-03-02T11:30:00Z/);
    assert.match(bobSection, /2026-03-02T13:00:00Z – 2026-03-02T14:00:00Z/);
    assert.doesNotMatch(out, /Free for the whole range/);
  });

  it('reports a calendar with errors as unknown, never free', async () => {
    const calendar = mkCalendar(async () => ({
      data: {
        calendars: {
          primary: { busy: [] },
          'ghost@example.com': { busy: [], errors: [{ domain: 'global', reason: 'notFound' }] },
        },
      },
    }));
    const out: string = await run({ calendarIds: ['primary', 'ghost@example.com'] }, calendar);
    const ghostSection = out.slice(out.indexOf('**ghost@example.com**'));
    assert.match(ghostSection, /Unknown: Google could not read this calendar \(notFound\)/);
    assert.doesNotMatch(ghostSection, /Free/);
  });

  it('reports a calendar missing from the response as unknown, never free', async () => {
    const calendar = mkCalendar(async () => ({ data: { calendars: {} } }));
    const out: string = await run({ calendarIds: ['someone@example.com'] }, calendar);
    assert.match(out, /Unknown/);
    assert.doesNotMatch(out, /Free for/);
  });

  it('reports a calendar with no busy blocks and no errors as free', async () => {
    const calendar = mkCalendar(async () => ({ data: { calendars: { primary: { busy: [] } } } }));
    const out: string = await run({}, calendar);
    assert.match(out, /\*\*primary\*\*\n {3}Free for the whole range/);
    assert.doesNotMatch(out, /Unknown/);
  });

  describe('local refusals never call Google', () => {
    const cases: Array<[string, any]> = [
      ['empty calendarIds', { calendarIds: [] }],
      ['more than 50 ids', { calendarIds: Array.from({ length: 51 }, (_, i) => `c${i}@example.com`) }],
      ['timeMax equal to timeMin', { timeMin: '2026-03-02T00:00:00Z', timeMax: '2026-03-02T00:00:00Z' }],
      ['timeMax before timeMin', { timeMin: '2026-03-02T00:00:00Z', timeMax: '2026-03-01T00:00:00Z' }],
      ['unparseable timeMin', { timeMin: 'next tuesday' }],
      ['unparseable timeMax', { timeMax: 'soon' }],
    ];
    for (const [label, args] of cases) {
      it(`refuses ${label}`, async () => {
        const calendar = mkCalendar(async () => ({ data: { calendars: {} } }));
        await assert.rejects(() => run(args, calendar), UserError);
        assert.equal(calendar.freebusy.query.mock.callCount(), 0);
      });
    }

    it('accepts exactly 50 ids', async () => {
      const calendar = mkCalendar(async () => ({ data: { calendars: {} } }));
      await run({ calendarIds: Array.from({ length: 50 }, (_, i) => `c${i}@example.com`) }, calendar);
      assert.equal(calendar.freebusy.query.mock.callCount(), 1);
    });
  });

  it('maps 403 to a permission UserError', async () => {
    const calendar = mkCalendar(async () => { throw mkErr(403); });
    await assert.rejects(() => run({}, calendar), (e: any) => e instanceof UserError && /Permission denied/.test(e.message));
  });

  it('maps 404 to a UserError', async () => {
    const calendar = mkCalendar(async () => { throw mkErr(404); });
    await assert.rejects(() => run({}, calendar), (e: any) => e instanceof UserError && /not found/.test(e.message));
  });

  it('maps any other failure to "Failed to query free/busy"', async () => {
    const calendar = mkCalendar(async () => { throw mkErr(500, 'backend down'); });
    await assert.rejects(() => run({}, calendar), (e: any) => e instanceof UserError && /Failed to query free\/busy: backend down/.test(e.message));
  });
});

describe('performQueryFreeBusy (REST data)', () => {
  it('answers in request order, with unread or missing calendars as busy null, never free', async () => {
    const { performQueryFreeBusy, queryFreeBusySchema } = calendarModule as any;
    const calendar = mkCalendar(async () => ({
      data: {
        calendars: {
          'a@x.test': { busy: [{ start: '2026-01-01T10:00:00Z', end: '2026-01-01T11:00:00Z' }] },
          'b@x.test': { errors: [{ reason: 'notFound' }] },
        },
      },
    }));
    const r = await performQueryFreeBusy(calendar, queryFreeBusySchema.parse({
      calendarIds: ['c@x.test', 'a@x.test', 'b@x.test'],
      timeMin: '2026-01-01T00:00:00Z', timeMax: '2026-01-02T00:00:00Z', timeZone: 'Europe/Berlin',
    }));
    assert.equal(r.timeZone, 'Europe/Berlin');
    assert.deepEqual(r.calendars.map((c: any) => c.id), ['c@x.test', 'a@x.test', 'b@x.test']);
    assert.deepEqual(r.calendars[0], { id: 'c@x.test', busy: null, errors: ['notReturned'] });
    assert.deepEqual(r.calendars[1].busy, [{ start: '2026-01-01T10:00:00Z', end: '2026-01-01T11:00:00Z' }]);
    assert.deepEqual(r.calendars[2], { id: 'b@x.test', busy: null, errors: ['notFound'] });
  });

  it('rethrows a Google failure untouched so the route keeps its code', async () => {
    const { performQueryFreeBusy, queryFreeBusySchema } = calendarModule as any;
    const calendar = mkCalendar(async () => { throw mkErr(404); });
    await assert.rejects(performQueryFreeBusy(calendar, queryFreeBusySchema.parse({})), (e: any) => e.code === 404);
  });
});
