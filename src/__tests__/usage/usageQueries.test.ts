import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  filterClause,
  usageFilterSchema,
  timelineQuerySchema,
  usageOverview,
  usageToolStats,
  usageTopErrors,
  usageRetryLoops,
  usageUserTimeline,
  LOOP_GAP_SECONDS,
  LOOP_MIN_CALLS,
  TOOL_USER_LIST_MAX,
} from '../../usage/usageQueries.js';

// Answers each query with the rows registered for the first pattern it matches.
function makePool(responses: Array<[RegExp, any[]]>) {
  const calls: Array<{ text: string; params: any[] }> = [];
  return {
    calls,
    query: async (text: string, params: any[] = []) => {
      calls.push({ text, params });
      const hit = responses.find(([re]) => re.test(text));
      return { rows: hit ? hit[1] : [], rowCount: hit ? hit[1].length : 0 };
    },
  };
}

describe('usageFilterSchema', () => {
  it('defaults to 7 days and coerces query-string numbers', () => {
    assert.deepEqual(usageFilterSchema.parse({}), { days: 7 });
    assert.equal(usageFilterSchema.parse({ days: '30' }).days, 30);
  });

  it('refuses out-of-range days, odd slugs and unknown surfaces', () => {
    for (const bad of [{ days: '0' }, { days: '91' }, { days: 'x' }, { slug: "x'; DROP" }, { surface: 'grpc' }]) {
      assert.equal(usageFilterSchema.safeParse(bad).success, false, JSON.stringify(bad));
    }
  });

  it('bounds the timeline page size', () => {
    assert.equal(timelineQuerySchema.parse({}).limit, 100);
    assert.equal(timelineQuerySchema.safeParse({ limit: '501' }).success, false);
  });
});

describe('filterClause', () => {
  it('binds every filter as a parameter', () => {
    const params: unknown[] = [];
    const sql = filterClause({ days: 14, slug: 'clickup', surface: 'rest' }, params);
    assert.deepEqual(params, [14, 'clickup', 'rest']);
    assert.match(sql, /make_interval\(days => \$1\)/);
    assert.match(sql, /e\.mcp_slug = \$2/);
    assert.match(sql, /e\.surface = \$3/);
    assert.doesNotMatch(sql, /clickup|rest'/);
  });

  it('continues numbering after existing parameters', () => {
    const params: unknown[] = ['already'];
    assert.match(filterClause({ days: 7 }, params), /\$2/);
  });
});

describe('usageOverview', () => {
  it('maps totals, the daily series, clients, users and slugs', async () => {
    const pool = makePool([
      [/count\(\*\) FILTER \(WHERE NOT e\.ok\) AS errors\s+FROM tool_call_events e WHERE/, [{ calls: '10', users: '3', errors: '2' }]],
      [/date_trunc/, [{ day: '2026-10-20', mcp_slug: 'clickup', calls: '4' }]],
      [/client_name/, [{ client: 'claude-ai', surface: 'mcp', calls: '9', users: '3' }]],
      [/LEFT JOIN users/, [{ user_id: 5, email: 'a@b.c', calls: '7', errors: '1', tools: '2', last_seen: '2026-10-21T10:00:00Z' }]],
      [/SELECT DISTINCT e\.mcp_slug/, [{ mcp_slug: 'clickup' }, { mcp_slug: 'github' }]],
    ]);
    const out = await usageOverview(pool, { days: 7 });
    assert.deepEqual(out.totals, { calls: 10, users: 3, errors: 2, errorRate: 0.2 });
    assert.deepEqual(out.daily, [{ day: '2026-10-20', slug: 'clickup', calls: 4 }]);
    assert.deepEqual(out.clients, [{ client: 'claude-ai', surface: 'mcp', calls: 9, users: 3 }]);
    assert.equal(out.topUsers[0].email, 'a@b.c');
    assert.equal(out.topUsers[0].calls, 7);
    assert.deepEqual(out.slugs, ['clickup', 'github']);
  });

  it('buckets days in UTC whatever the database time zone is', async () => {
    const pool = makePool([]);
    await usageOverview(pool, { days: 7 });
    const daily = pool.calls.find((c) => /date_trunc/.test(c.text))!;
    assert.match(daily.text, /date_trunc\('day', e\.ts AT TIME ZONE 'UTC'\)/);
    assert.match(daily.text, /to_char\(/);
  });

  it('reports a zero error rate, not NaN, when there are no calls', async () => {
    const out = await usageOverview(makePool([]), { days: 7 });
    assert.equal(out.totals.errorRate, 0);
  });

  it('lists every service in the dropdown even when filtered to one', async () => {
    const pool = makePool([]);
    await usageOverview(pool, { days: 30, slug: 'clickup' });
    const distinct = pool.calls.find((c) => /SELECT DISTINCT e\.mcp_slug/.test(c.text))!;
    assert.deepEqual(distinct.params, [30]);
  });
});

describe('usageToolStats', () => {
  it('computes the error rate and lists who used each tool', async () => {
    const pool = makePool([[/jsonb_agg/, [{
      mcp_slug: 'google-docs', tool: 'readGoogleDoc', surface: 'mcp', calls: '8', users: '2',
      errors: '2', last_used: '2026-10-21T00:00:00Z',
      user_list: [{ userId: 5, email: 'a@b.c', calls: 6 }, { userId: 9, email: null, calls: 2 }],
    }]]]);
    const [row] = await usageToolStats(pool, { days: 7 });
    assert.equal(row.errorRate, 0.25);
    assert.equal(row.users, 2);
    assert.deepEqual(row.userList, [
      { userId: 5, email: 'a@b.c', calls: 6 },
      { userId: 9, email: null, calls: 2 },
    ]);
    assert.equal('p50Ms' in row, false);
  });

  it('caps the named list but keeps the full user count', async () => {
    const list = Array.from({ length: TOOL_USER_LIST_MAX + 5 }, (_, i) => ({ userId: i + 1, email: null, calls: 1 }));
    const pool = makePool([[/jsonb_agg/, [{ mcp_slug: 's', tool: 't', surface: 'mcp', calls: '60', users: String(list.length), errors: '0', last_used: null, user_list: list }]]]);
    const [row] = await usageToolStats(pool, { days: 7 });
    assert.equal(row.userList.length, TOOL_USER_LIST_MAX);
    assert.equal(row.users, TOOL_USER_LIST_MAX + 5);
  });

  it('answers an empty list, not null, for a tool with no known users', async () => {
    const pool = makePool([[/jsonb_agg/, [{ mcp_slug: 's', tool: 't', surface: 'mcp', calls: '1', users: '0', errors: '0', last_used: null, user_list: null }]]]);
    const [row] = await usageToolStats(pool, { days: 7 });
    assert.deepEqual(row.userList, []);
  });
});

describe('usageTopErrors', () => {
  it('only reads failures', async () => {
    const pool = makePool([]);
    await usageTopErrors(pool, { days: 7 });
    assert.match(pool.calls[0].text, /AND NOT e\.ok/);
  });
});

describe('usageRetryLoops', () => {
  it('binds the gap and minimum run length after the filters', async () => {
    const pool = makePool([]);
    await usageRetryLoops(pool, { days: 7, slug: 'clickup' });
    assert.deepEqual(pool.calls[0].params, [7, 'clickup', LOOP_GAP_SECONDS, LOOP_MIN_CALLS]);
    assert.match(pool.calls[0].text, /make_interval\(secs => \$3\)/);
    assert.match(pool.calls[0].text, /HAVING count\(\*\) >= \$4/);
  });

  it('only counts MCP calls and lists runs with failures first', async () => {
    const pool = makePool([]);
    await usageRetryLoops(pool, { days: 7 });
    assert.match(pool.calls[0].text, /e\.surface = 'mcp'/);
    assert.match(pool.calls[0].text, /ORDER BY \(count\(\*\) FILTER \(WHERE NOT r\.ok\) > 0\) DESC, max\(r\.ts\) DESC/);
  });
});

describe('usageUserTimeline', () => {
  const event = (id: number) => ({
    id, ts: '2026-10-21T00:00:00Z', mcp_slug: 'clickup', tool: 'getTask', surface: 'mcp',
    session_id: 's1', instance_id: 'i1', client_name: 'claude-ai', client_version: '1',
    duration_ms: 12, ok: true, error_kind: null, error_message: null,
    arg_keys: ['taskId'], arg_preview: null, arg_bytes: 20,
  });

  it('returns a cursor only when the page is full', async () => {
    const full = makePool([[/FROM tool_call_events/, [event(9), event(8)]], [/FROM users/, [{ id: 5, email: 'a@b.c', name: 'A' }]]]);
    const page = await usageUserTimeline(full, 5, { limit: 2 });
    assert.equal(page.nextBefore, 8);
    assert.equal(page.user.email, 'a@b.c');
    assert.deepEqual(page.events[0].argKeys, ['taskId']);

    const short = makePool([[/FROM tool_call_events/, [event(9)]]]);
    assert.equal((await usageUserTimeline(short, 5, { limit: 2 })).nextBefore, null);
  });

  it('pages backwards with the before cursor', async () => {
    const pool = makePool([]);
    await usageUserTimeline(pool, 5, { before: 100, limit: 50 });
    const q = pool.calls.find((c) => /FROM tool_call_events/.test(c.text))!;
    assert.deepEqual(q.params, [5, 100, 50]);
    assert.match(q.text, /e\.id < \$2/);
  });

  it('still answers for a user id that no longer exists', async () => {
    const out = await usageUserTimeline(makePool([]), 77, { limit: 10 });
    assert.deepEqual(out.user, { id: 77, email: null, name: null });
  });
});
