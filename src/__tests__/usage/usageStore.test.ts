import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import {
  __setUsagePoolForTests,
  __pendingUsageEvents,
  __resetUsageBufferForTests,
  buildInsert,
  flushUsageEvents,
  pruneUsageEvents,
  readUsageRetentionDays,
  recordToolCall,
  stripNul,
  FLUSH_BATCH_SIZE,
  MAX_BUFFERED_EVENTS,
  type ToolCallEvent,
} from '../../usage/usageStore.js';

function makeFakePool(opts: { failInserts?: boolean; rejectNul?: boolean } = {}) {
  const inserted: unknown[][] = [];
  const queries: Array<{ text: string; params: any[] }> = [];
  return {
    inserted,
    queries,
    query: async (text: string, params: any[] = []) => {
      queries.push({ text, params });
      if (/^INSERT INTO tool_call_events/.test(text)) {
        if (opts.failInserts) throw new Error('db down');
        // What Postgres does: a NUL anywhere in TEXT or JSONB fails the statement.
        if (opts.rejectNul && JSON.stringify(params).includes('\\u0000')) {
          throw new Error('invalid byte sequence for encoding "UTF8": 0x00');
        }
        const width = 16;
        for (let i = 0; i < params.length; i += width) inserted.push(params.slice(i, i + width));
        return { rows: [], rowCount: params.length / width };
      }
      if (/^DELETE FROM tool_call_events/.test(text)) return { rows: [], rowCount: 7 };
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

function event(over: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return { mcpSlug: 'clickup', tool: 'getTask', surface: 'mcp', durationMs: 12.6, ok: true, ...over };
}

const ENV_KEYS = ['USAGE_TRACKING', 'USAGE_RETENTION_DAYS'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  __resetUsageBufferForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  __setUsagePoolForTests(null);
  __resetUsageBufferForTests();
});

describe('recordToolCall + flushUsageEvents', () => {
  it('buffers events and writes them in one multi-row insert', async () => {
    const pool = makeFakePool();
    __setUsagePoolForTests(pool);
    recordToolCall(event({ tool: 'a' }));
    recordToolCall(event({ tool: 'b', ok: false, errorKind: 'UserError' }));
    assert.equal(pool.queries.length, 0, 'recording must not touch the database');

    await flushUsageEvents();
    assert.equal(pool.queries.length, 1);
    assert.equal(pool.inserted.length, 2);
    assert.equal(pool.inserted[0][5], 'a');
    assert.equal(pool.inserted[1][10], false);
    assert.equal(pool.inserted[1][11], 'UserError');
    assert.equal(__pendingUsageEvents().length, 0);
  });

  it('rounds the duration to an integer', async () => {
    const pool = makeFakePool();
    __setUsagePoolForTests(pool);
    recordToolCall(event({ durationMs: 12.6 }));
    await flushUsageEvents();
    assert.equal(pool.inserted[0][9], 13);
  });

  it('flushes on its own once a full batch is buffered', async () => {
    const pool = makeFakePool();
    __setUsagePoolForTests(pool);
    for (let i = 0; i < FLUSH_BATCH_SIZE; i++) recordToolCall(event());
    await flushUsageEvents();
    assert.equal(pool.inserted.length, FLUSH_BATCH_SIZE);
  });

  it('drops the OLDEST events when the buffer is full', () => {
    // A pool must exist for events to be buffered at all, but its query is
    // never awaited here, so the buffer is inspected before any flush runs.
    __setUsagePoolForTests({ query: () => new Promise(() => {}) });
    for (let i = 0; i < MAX_BUFFERED_EVENTS + 10; i++) recordToolCall(event({ tool: `t${i}` }));
    const pending = __pendingUsageEvents();
    assert.ok(pending.length <= MAX_BUFFERED_EVENTS);
    assert.ok(!pending.some((e) => e.tool === 't0'), 'the oldest event should have been dropped');
    assert.equal(pending[pending.length - 1].tool, `t${MAX_BUFFERED_EVENTS + 9}`);
  });

  it('a failed write drops the batch and never throws', async () => {
    __setUsagePoolForTests(makeFakePool({ failInserts: true }));
    recordToolCall(event());
    await assert.doesNotReject(flushUsageEvents());
    assert.equal(__pendingUsageEvents().length, 0);
  });

  it('records nothing when USAGE_TRACKING=off', async () => {
    const pool = makeFakePool();
    __setUsagePoolForTests(pool);
    process.env.USAGE_TRACKING = 'off';
    recordToolCall(event());
    await flushUsageEvents();
    assert.equal(pool.queries.length, 0);
  });

  it('records nothing without a database', () => {
    recordToolCall(event());
    assert.equal(__pendingUsageEvents().length, 0);
  });
});

describe('buildInsert', () => {
  it('numbers placeholders across rows and serialises the preview', () => {
    const { text, params } = buildInsert([
      event({ argPreview: { query: 'x' }, argKeys: ['query'] }),
      event(),
    ]);
    assert.match(text, /^INSERT INTO tool_call_events \(ts, user_id, .*arg_bytes\) VALUES \(\$1, .*\$16\), \(\$17, .*\$32\)$/);
    assert.equal(params.length, 32);
    assert.equal(params[14], '{"query":"x"}');
    assert.deepEqual(params[13], ['query']);
    assert.equal(params[30], null);
  });
});

describe('retention', () => {
  it('defaults to 30 days and accepts 0 to disable', () => {
    assert.equal(readUsageRetentionDays(), 30);
    process.env.USAGE_RETENTION_DAYS = '7';
    assert.equal(readUsageRetentionDays(), 7);
    process.env.USAGE_RETENTION_DAYS = '0';
    assert.equal(readUsageRetentionDays(), 0);
    process.env.USAGE_RETENTION_DAYS = 'nonsense';
    assert.equal(readUsageRetentionDays(), 30);
  });

  it('deletes rows older than the configured window', async () => {
    const pool = makeFakePool();
    __setUsagePoolForTests(pool);
    process.env.USAGE_RETENTION_DAYS = '14';
    assert.equal(await pruneUsageEvents(), 7);
    assert.deepEqual(pool.queries[0].params, [14]);
  });

  it('does not delete anything when retention is 0', async () => {
    const pool = makeFakePool();
    __setUsagePoolForTests(pool);
    process.env.USAGE_RETENTION_DAYS = '0';
    assert.equal(await pruneUsageEvents(), 0);
    assert.equal(pool.queries.length, 0);
  });
});

describe('NUL characters', () => {
  it('a NUL in one event does not cost the rest of the batch', async () => {
    const pool = makeFakePool({ rejectNul: true });
    __setUsagePoolForTests(pool);
    recordToolCall(event({ tool: 'clean' }));
    recordToolCall(event({ tool: 'rest', surface: 'rest', argKeys: ['a\u0000b'] }));
    recordToolCall(event({ tool: 'preview', argPreview: { query: 'x\u0000y', ['k\u0000']: 1 } }));
    recordToolCall(event({ tool: 'err', ok: false, errorMessage: 'bad\u0000' }));
    await flushUsageEvents();

    assert.equal(pool.inserted.length, 4);
    assert.deepEqual(pool.inserted[1][13], ['ab']);
    assert.equal(pool.inserted[2][14], '{"query":"xy","k":1}');
    assert.equal(pool.inserted[3][12], 'bad');
  });

  it('stripNul handles nested values and leaves dates and numbers alone', () => {
    const ts = new Date(0);
    assert.deepEqual(stripNul({ a: ['x\u0000'], b: { 'c\u0000': 'd' }, ts, n: 1 }), { a: ['x'], b: { c: 'd' }, ts, n: 1 });
  });
});
