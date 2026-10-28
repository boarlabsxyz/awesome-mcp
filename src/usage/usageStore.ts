// Buffered writer for tool_call_events (DDL in src/db.ts).
//
// The one rule: recording a call must never fail, slow down or change a tool
// call. So recordToolCall is a synchronous push into memory, writes happen in
// batches off the request path, a failed flush drops its batch with a log line,
// and a full buffer drops its OLDEST rows rather than growing without bound.
// The cost is that a crash loses at most one flush interval of analytics,
// which is the right trade for data nobody's request depends on.
import { isDatabaseAvailable, getPool } from '../db.js';

export type UsageSurface = 'mcp' | 'rest';

export interface ToolCallEvent {
  ts?: Date;
  userId?: number | null;
  instanceId?: string | null;
  sessionId?: string | null;
  mcpSlug: string;
  tool: string;
  surface: UsageSurface;
  clientName?: string | null;
  clientVersion?: string | null;
  durationMs: number;
  ok: boolean;
  errorKind?: string | null;
  errorMessage?: string | null;
  argKeys?: string[] | null;
  argPreview?: Record<string, unknown> | null;
  argBytes?: number | null;
}

type PoolLike = { query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
let testPool: PoolLike | null = null;
export function __setUsagePoolForTests(p: PoolLike | null): void {
  testPool = p;
}

export type UsagePool = PoolLike;

function currentPool(): PoolLike | null {
  if (testPool) return testPool;
  if (!isDatabaseAvailable()) return null;
  return getPool();
}

/** The pool the admin usage queries read from, or null when there is no database. */
export function usagePool(): PoolLike | null {
  return currentPool();
}

/** `USAGE_TRACKING=off` (or `false`/`0`) disables recording entirely. */
export function isUsageTrackingEnabled(): boolean {
  const raw = (process.env.USAGE_TRACKING ?? '').trim().toLowerCase();
  return !(raw === 'off' || raw === 'false' || raw === '0');
}

export const MAX_BUFFERED_EVENTS = 5000;
export const FLUSH_BATCH_SIZE = 200;
const FLUSH_INTERVAL_MS = 5000;

let buffer: ToolCallEvent[] = [];
let droppedSinceLastFlush = 0;
let flushing: Promise<void> | null = null;

export function recordToolCall(event: ToolCallEvent): void {
  try {
    if (!isUsageTrackingEnabled()) return;
    // No pool, no buffer: an MCP service booted without DATABASE_URL would
    // otherwise accumulate events that can never be written.
    if (!testPool && !isDatabaseAvailable()) return;
    buffer.push({ ...event, ts: event.ts ?? new Date() });
    if (buffer.length > MAX_BUFFERED_EVENTS) {
      const excess = buffer.length - MAX_BUFFERED_EVENTS;
      buffer.splice(0, excess);
      droppedSinceLastFlush += excess;
    }
    if (buffer.length >= FLUSH_BATCH_SIZE) void flushUsageEvents();
  } catch {
    // Never let analytics reach the caller.
  }
}

const COLUMNS = [
  'ts', 'user_id', 'instance_id', 'session_id', 'mcp_slug', 'tool', 'surface',
  'client_name', 'client_version', 'duration_ms', 'ok', 'error_kind',
  'error_message', 'arg_keys', 'arg_preview', 'arg_bytes',
] as const;

function rowValues(e: ToolCallEvent): unknown[] {
  return [
    e.ts ?? new Date(),
    e.userId ?? null,
    e.instanceId ?? null,
    e.sessionId ?? null,
    e.mcpSlug,
    e.tool,
    e.surface,
    e.clientName ?? null,
    e.clientVersion ?? null,
    Math.max(0, Math.round(e.durationMs)),
    e.ok,
    e.errorKind ?? null,
    e.errorMessage ?? null,
    e.argKeys ?? null,
    e.argPreview ? JSON.stringify(e.argPreview) : null,
    e.argBytes ?? null,
  ];
}

export function buildInsert(events: ToolCallEvent[]): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const tuples = events.map((e) => {
    const values = rowValues(e);
    const placeholders = values.map((v) => {
      params.push(v);
      return `$${params.length}`;
    });
    return `(${placeholders.join(', ')})`;
  });
  return {
    text: `INSERT INTO tool_call_events (${COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}`,
    params,
  };
}

async function flushOnce(): Promise<void> {
  const pool = currentPool();
  if (!pool) {
    buffer = [];
    return;
  }
  if (droppedSinceLastFlush > 0) {
    console.error(`[usage] buffer full, dropped ${droppedSinceLastFlush} oldest event(s)`);
    droppedSinceLastFlush = 0;
  }
  while (buffer.length > 0) {
    const batch = buffer.splice(0, FLUSH_BATCH_SIZE);
    try {
      const { text, params } = buildInsert(batch);
      await pool.query(text, params);
    } catch (err: any) {
      console.error(`[usage] failed to write ${batch.length} event(s), dropping them:`, err?.message || err);
    }
  }
}

/** Writes everything buffered. Concurrent callers share one in-flight flush. */
export function flushUsageEvents(): Promise<void> {
  if (flushing) return flushing;
  if (buffer.length === 0 && droppedSinceLastFlush === 0) return Promise.resolve();
  flushing = flushOnce()
    .catch(() => {})
    .finally(() => {
      flushing = null;
    });
  return flushing;
}

/** Test helper: what is waiting to be written. */
export function __pendingUsageEvents(): readonly ToolCallEvent[] {
  return buffer;
}

export function __resetUsageBufferForTests(): void {
  buffer = [];
  droppedSinceLastFlush = 0;
  flushing = null;
}

// ── Retention ────────────────────────────────────────────────────────────

/** `USAGE_RETENTION_DAYS` (default 30). `0` keeps events forever. */
export function readUsageRetentionDays(): number {
  const raw = (process.env.USAGE_RETENTION_DAYS ?? '').trim();
  if (raw === '') return 30;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 30;
  return Math.floor(n);
}

export async function pruneUsageEvents(): Promise<number> {
  const days = readUsageRetentionDays();
  if (days === 0) return 0;
  const pool = currentPool();
  if (!pool) return 0;
  const result = await pool.query(
    `DELETE FROM tool_call_events WHERE ts < now() - make_interval(days => $1)`,
    [days],
  );
  return result.rowCount ?? 0;
}

let flushTimer: NodeJS.Timeout | null = null;
let retentionTimer: NodeJS.Timeout | null = null;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Safe to call more than once; the second call is a no-op. */
export function startUsageFlushTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => void flushUsageEvents(), FLUSH_INTERVAL_MS);
  flushTimer.unref();
}

/** Safe to call more than once; the second call is a no-op. */
export function startUsageRetentionScheduler(): void {
  if (retentionTimer) return;
  if (!isDatabaseAvailable()) return;

  const runOnce = async () => {
    try {
      const deleted = await pruneUsageEvents();
      if (deleted > 0) console.error(`[usage] pruned ${deleted} event(s) older than ${readUsageRetentionDays()} day(s)`);
    } catch (err: any) {
      console.error('[usage] prune failure:', err?.message || err);
    }
  };

  retentionTimer = setInterval(runOnce, PRUNE_INTERVAL_MS);
  retentionTimer.unref();
  void runOnce();
}

export function stopUsageTimers(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
}
