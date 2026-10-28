import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UserError } from 'fastmcp';
import {
  opListUsers,
  opRetryLoops,
  opToolUsage,
  opTopErrors,
  opUsageOverview,
  opUserActivity,
  resolveUserId,
  type AdminOpsDeps,
} from '../../admin-mcp/ops.js';
import type { AdminUser } from '../../usage/adminUsers.js';

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

function deps(over: Partial<AdminOpsDeps> = {}): AdminOpsDeps {
  return {
    pool: () => makePool([]),
    getUserByEmail: async () => undefined,
    getAllUsers: async () => [],
    listUsers: async () => [],
    ...over,
  };
}

const filter = { days: 7 };

describe('without a database', () => {
  it('every usage tool says so instead of answering empty', async () => {
    const noDb = deps({ pool: () => null });
    for (const run of [
      () => opUsageOverview(filter, noDb),
      () => opToolUsage({ ...filter, sortBy: 'calls', limit: 10 }, noDb),
      () => opTopErrors(filter, noDb),
      () => opRetryLoops(filter, noDb),
      () => opUserActivity({ user: '5', limit: 10 }, noDb),
    ]) {
      await assert.rejects(run(), (e: any) => e instanceof UserError && /no database/.test(e.message));
    }
  });
});

describe('getUsageOverview', () => {
  it('passes the filter through and states the scope it answered for', async () => {
    const pool = makePool([
      [/count\(\*\) FILTER \(WHERE NOT e\.ok\) AS errors\s+FROM tool_call_events e WHERE/, [{ calls: '10', users: '2', errors: '1' }]],
      [/to_char/, [{ day: '2026-10-27', mcp_slug: 'clickup', calls: '6' }, { day: '2026-10-28', mcp_slug: 'github', calls: '4' }]],
    ]);
    const out = await opUsageOverview({ days: 30, slug: 'clickup', surface: 'mcp' }, deps({ pool: () => pool }));
    assert.match(out, /last 30 days, service clickup, MCP calls only/);
    assert.match(out, /Calls: 10 · Active users: 2 · Errors: 1 \(10%\)/);
    assert.match(out, /clickup: 6/);
    assert.match(out, /2026-10-28: 4/);
    assert.deepEqual(pool.calls[0].params, [30, 'clickup', 'mcp']);
  });

  it('says plainly when there were no calls', async () => {
    assert.match(await opUsageOverview(filter, deps()), /No recorded calls in this period\./);
  });
});

const toolRow = (tool: string, calls: number, errors: number, users: number, lastUsed: string) => ({
  mcp_slug: 'clickup', tool, surface: 'mcp', calls: String(calls), users: String(users), errors: String(errors),
  last_used: lastUsed,
  user_list: Array.from({ length: users }, (_, i) => ({ userId: i + 1, email: i === 0 ? null : `u${i + 1}@example.com`, calls: users - i })),
});

describe('listToolUsage', () => {
  const pool = () => makePool([[/jsonb_agg/, [
    toolRow('getTask', 50, 1, 2, '2026-10-20T00:00:00Z'),
    toolRow('searchTasks', 20, 10, 7, '2026-10-28T00:00:00Z'),
    toolRow('updateTask', 5, 0, 1, '2026-10-25T00:00:00Z'),
  ]]]);

  it('sorts as asked and says how many tools exist when it shows fewer', async () => {
    const out = await opToolUsage({ ...filter, sortBy: 'errorRate', limit: 2 }, deps({ pool }));
    assert.match(out, /Showing 2 of 3 tools, sorted by errorRate\./);
    assert.ok(out.indexOf('searchTasks') < out.indexOf('getTask'));
    assert.doesNotMatch(out, /updateTask/);
  });

  it('names the users, marks deleted accounts, and counts the ones not listed', async () => {
    const out = await opToolUsage({ ...filter, sortBy: 'calls', limit: 10 }, deps({ pool }));
    assert.match(out, /users \(7\): user #1 \(account deleted\) \(7\), u2@example\.com \(6\)/);
    assert.match(out, /and 2 more/);
  });

  it('sorts by last use', async () => {
    const out = await opToolUsage({ ...filter, sortBy: 'lastUsed', limit: 10 }, deps({ pool }));
    assert.ok(out.indexOf('searchTasks') < out.indexOf('updateTask'));
    assert.ok(out.indexOf('updateTask') < out.indexOf('getTask'));
  });
});

describe('listTopErrors and listRetryLoops', () => {
  it('render their rows and say when there are none', async () => {
    const pool = () => makePool([
      [/AND NOT e\.ok/, [{ mcp_slug: 'redmine', tool: 'listTimeEntries', error_kind: 'UserError', message: 'Redmine refused (403)', calls: '5', users: '2', last_seen: '2026-10-27T00:00:00Z' }]],
      [/WITH ordered AS/, [{ user_id: 3, email: 'bob@example.com', mcp_slug: 'clickup', tool: 'searchTasks', calls: '6', errors: '4', started: '2026-10-27T10:00:00Z', ended: '2026-10-27T10:01:00Z' }]],
    ]);
    const errors = await opTopErrors(filter, deps({ pool }));
    assert.match(errors, /redmine \/ listTimeEntries — UserError: Redmine refused \(403\)/);
    const loops = await opRetryLoops(filter, deps({ pool }));
    assert.match(loops, /bob@example\.com \[id 3\] — clickup \/ searchTasks: 6 calls, 4 failed/);
    assert.match(loops, /a batch .* looks the same/);

    assert.match(await opTopErrors(filter, deps()), /No failed calls in this period\./);
    assert.match(await opRetryLoops(filter, deps()), /No loops in this period\./);
  });
});

describe('getUserActivity', () => {
  it('accepts an email, a numeric id, and refuses anything else with a way forward', async () => {
    const d = deps({ getUserByEmail: async (e) => (e === 'ana@example.com' ? { id: 12 } : undefined) });
    assert.equal(await resolveUserId('ana@example.com', d), 12);
    assert.equal(await resolveUserId(' 42 ', d), 42);
    await assert.rejects(resolveUserId('nobody@example.com', d), /No user with the email nobody@example\.com\. Use listUsers/);
    await assert.rejects(resolveUserId('ana', d), /neither a numeric user id nor an email/);
    await assert.rejects(resolveUserId('0', d), /not a valid user id/);
    await assert.rejects(resolveUserId('2147483648', d), /not a valid user id/);
  });

  it('finds an account whatever the capitalisation of the address', async () => {
    const d = deps({
      getUserByEmail: async (e) => (e === 'ana@example.com' ? { id: 12 } : undefined),
      getAllUsers: async () => [{ id: 12, email: 'ana@example.com' }, { id: 13, email: 'Bob@Example.com' }],
    });
    assert.equal(await resolveUserId('Ana@Example.COM', d), 12);
    assert.equal(await resolveUserId('bob@example.com', d), 13);
  });

  it('explains a file-store user that has no numeric id', async () => {
    await assert.rejects(
      resolveUserId('legacy@example.com', deps({ getUserByEmail: async () => ({}) })),
      /file-based user store/,
    );
  });

  it('groups calls by session, shows search values, and gives the paging cursor', async () => {
    const event = (id: number, sessionId: string | null, extra: any = {}) => ({
      id, ts: '2026-10-27T10:00:00Z', mcp_slug: 'clickup', tool: 'searchTasks', surface: 'mcp',
      session_id: sessionId, instance_id: null, client_name: 'claude-ai', client_version: '1.0',
      duration_ms: 120, ok: true, error_kind: null, error_message: null,
      arg_keys: ['query', 'listIds'], arg_preview: { query: 'Sprint 12', listIds: { type: 'array', length: 3 } }, arg_bytes: 50,
      ...extra,
    });
    const pool = makePool([
      [/FROM tool_call_events/, [event(9, 's1'), event(8, 's1', { ok: false, error_kind: 'UserError', error_message: 'No list matches' }), event(7, 's2')]],
      [/FROM users/, [{ id: 12, email: 'ana@example.com', name: 'Ana' }]],
    ]);
    const out = await opUserActivity({ user: '12', limit: 3 }, deps({ pool: () => pool }));
    assert.match(out, /Activity for ana@example\.com \[id 12\]/);
    assert.equal((out.match(/— session s1/g) ?? []).length, 1);
    assert.match(out, /— session s2/);
    assert.match(out, /query="Sprint 12", listIds=\[array, 3\]/);
    assert.match(out, /→ UserError: No list matches/);
    assert.match(out, /before=7/);
  });
});

describe('listUsers', () => {
  const users: AdminUser[] = [
    { id: 1, email: 'ana@example.com', name: 'Ana', authMethod: 'google', createdAt: '2026-09-01T00:00:00Z', connectionCount: 1, connections: [{ mcpSlug: 'google-docs', instanceName: 'Docs (work)', googleEmail: 'ana@work.com' }], connectionsUnavailable: false },
    { id: 2, email: 'bob@example.com', name: null, authMethod: 'password', createdAt: undefined, connectionCount: 0, connections: [], connectionsUnavailable: true },
    { id: 3, email: 'cy@other.org', name: 'Cy', authMethod: 'google', createdAt: undefined, connectionCount: 0, connections: [], connectionsUnavailable: false },
  ];

  it('filters by email or name and renders connections', async () => {
    const out = await opListUsers({ query: 'EXAMPLE', limit: 100 }, deps({ listUsers: async () => users }));
    assert.match(out, /Users matching "EXAMPLE"/);
    assert.match(out, /2 user\(s\)/);
    assert.match(out, /google-docs "Docs \(work\)" \(ana@work\.com\)/);
    assert.doesNotMatch(out, /cy@other\.org/);
  });

  it('never presents unreadable connections as none', async () => {
    const out = await opListUsers({ query: 'bob', limit: 100 }, deps({ listUsers: async () => users }));
    assert.match(out, /COULD NOT BE READ/);
  });

  it('says how many matched when it shows fewer', async () => {
    const out = await opListUsers({ limit: 1 }, deps({ listUsers: async () => users }));
    assert.match(out, /Showing 1 of 3\./);
  });
});
