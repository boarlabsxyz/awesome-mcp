// Read side of tool_call_events, for the /admin Usage tab.
//
// Every function takes the pool and a validated filter object, and returns
// plain JSON-ready rows. Filters are bound as parameters, never interpolated.
import { z } from 'zod';
import type { UsagePool } from './usageStore.js';

export const usageFilterSchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
  slug: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
  surface: z.enum(['mcp', 'rest']).optional(),
});
export type UsageFilter = z.infer<typeof usageFilterSchema>;

export const timelineQuerySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type TimelineQuery = z.infer<typeof timelineQuerySchema>;

/** The shared WHERE clause. Column references are qualified with `e.`. */
export function filterClause(f: UsageFilter, params: unknown[]): string {
  params.push(f.days);
  const parts = [`e.ts >= now() - make_interval(days => $${params.length})`];
  if (f.slug) {
    params.push(f.slug);
    parts.push(`e.mcp_slug = $${params.length}`);
  }
  if (f.surface) {
    params.push(f.surface);
    parts.push(`e.surface = $${params.length}`);
  }
  return parts.join(' AND ');
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
/**
 * Rows in the whole result before LIMIT, read from a `count(*) OVER () AS total`
 * column: a capped list must state its total, and the returned row count is not it.
 */
const totalOf = (rows: Array<Record<string, unknown>>): number => (rows.length ? num(rows[0].total) : 0);

export async function usageOverview(pool: UsagePool, f: UsageFilter) {
  const params: unknown[] = [];
  const where = filterClause(f, params);

  const [totals, daily, clients, users, slugs] = await Promise.all([
    pool.query(
      `SELECT count(*) AS calls,
              count(DISTINCT e.user_id) AS users,
              count(*) FILTER (WHERE NOT e.ok) AS errors
         FROM tool_call_events e WHERE ${where}`,
      params,
    ),
    pool.query(
      // Bucket by UTC calendar day and return the date as text. date_trunc on a
      // timestamptz truncates in the session's TimeZone, so a database east of
      // UTC would put every bar a day early on a page that buckets by UTC date.
      `SELECT to_char(date_trunc('day', e.ts AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
              e.mcp_slug, count(*) AS calls
         FROM tool_call_events e WHERE ${where}
        GROUP BY 1, 2 ORDER BY 1, 2`,
      params,
    ),
    pool.query(
      `SELECT coalesce(e.client_name, '(unknown)') AS client, e.surface,
              count(*) AS calls, count(DISTINCT e.user_id) AS users,
              count(*) OVER () AS total
         FROM tool_call_events e WHERE ${where}
        GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20`,
      params,
    ),
    pool.query(
      `SELECT e.user_id, u.email, count(*) AS calls,
              count(*) FILTER (WHERE NOT e.ok) AS errors,
              count(DISTINCT e.tool) AS tools, max(e.ts) AS last_seen,
              count(*) OVER () AS total
         FROM tool_call_events e LEFT JOIN users u ON u.id = e.user_id
        WHERE ${where} AND e.user_id IS NOT NULL
        GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 25`,
      params,
    ),
    // Unfiltered by slug, so the service dropdown always lists every option.
    pool.query(
      `SELECT DISTINCT e.mcp_slug FROM tool_call_events e
        WHERE e.ts >= now() - make_interval(days => $1) ORDER BY 1`,
      [f.days],
    ),
  ]);

  const t = totals.rows[0] ?? {};
  const calls = num(t.calls);
  return {
    totals: {
      calls,
      users: num(t.users),
      errors: num(t.errors),
      errorRate: calls ? num(t.errors) / calls : 0,
    },
    daily: daily.rows.map((r) => ({ day: r.day as string, slug: r.mcp_slug as string, calls: num(r.calls) })),
    clients: clients.rows.map((r) => ({
      client: r.client as string,
      surface: r.surface as string,
      calls: num(r.calls),
      users: num(r.users),
    })),
    clientsTotal: totalOf(clients.rows),
    topUsers: users.rows.map((r) => ({
      userId: num(r.user_id),
      email: (r.email as string | null) ?? null,
      calls: num(r.calls),
      errors: num(r.errors),
      tools: num(r.tools),
      lastSeen: iso(r.last_seen),
    })),
    topUsersTotal: totalOf(users.rows),
    slugs: slugs.rows.map((r) => r.mcp_slug as string),
  };
}

/** How many of a tool's users are listed by name; `users` still counts them all. */
export const TOOL_USER_LIST_MAX = 50;

export interface ToolUser {
  userId: number;
  email: string | null;
  calls: number;
}

/** The most tools usageToolStats returns; ranked by calls before the cut. */
export const TOOL_STATS_MAX = 500;

/**
 * Per-tool counts plus WHO used each tool, busiest users first. At most
 * TOOL_STATS_MAX tools, the most-called; `total` counts them all.
 */
export async function usageToolStats(pool: UsagePool, f: UsageFilter) {
  const params: unknown[] = [];
  const where = filterClause(f, params);
  const { rows } = await pool.query(
    `WITH per_user AS (
       SELECT e.mcp_slug, e.tool, e.surface, e.user_id,
              count(*) AS calls,
              count(*) FILTER (WHERE NOT e.ok) AS errors,
              max(e.ts) AS last_used
         FROM tool_call_events e WHERE ${where}
        GROUP BY 1, 2, 3, 4
     )
     SELECT p.mcp_slug, p.tool, p.surface,
            sum(p.calls) AS calls,
            count(p.user_id) AS users,
            sum(p.errors) AS errors,
            max(p.last_used) AS last_used,
            count(*) OVER () AS total,
            coalesce(
              jsonb_agg(jsonb_build_object('userId', p.user_id, 'email', u.email, 'calls', p.calls)
                        ORDER BY p.calls DESC, p.user_id)
                FILTER (WHERE p.user_id IS NOT NULL),
              '[]'::jsonb
            ) AS user_list
       FROM per_user p LEFT JOIN users u ON u.id = p.user_id
      GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT ${TOOL_STATS_MAX}`,
    params,
  );
  const tools = rows.map((r) => {
    const calls = num(r.calls);
    const list = (Array.isArray(r.user_list) ? r.user_list : []) as Array<Record<string, unknown>>;
    return {
      slug: r.mcp_slug as string,
      tool: r.tool as string,
      surface: r.surface as string,
      calls,
      users: num(r.users),
      userList: list.slice(0, TOOL_USER_LIST_MAX).map((u): ToolUser => ({
        userId: num(u.userId),
        email: (u.email as string | null) ?? null,
        calls: num(u.calls),
      })),
      errors: num(r.errors),
      errorRate: calls ? num(r.errors) / calls : 0,
      lastUsed: iso(r.last_used),
    };
  });
  return { tools, total: totalOf(rows) };
}

export async function usageTopErrors(pool: UsagePool, f: UsageFilter) {
  const params: unknown[] = [];
  const where = filterClause(f, params);
  const { rows } = await pool.query(
    `SELECT e.mcp_slug, e.tool, e.error_kind,
            left(coalesce(e.error_message, ''), 200) AS message,
            count(*) AS calls, count(DISTINCT e.user_id) AS users, max(e.ts) AS last_seen,
            count(*) OVER () AS total
       FROM tool_call_events e WHERE ${where} AND NOT e.ok
      GROUP BY 1, 2, 3, 4 ORDER BY 5 DESC LIMIT 50`,
    params,
  );
  const errors = rows.map((r) => ({
    slug: r.mcp_slug as string,
    tool: r.tool as string,
    kind: (r.error_kind as string | null) ?? null,
    message: r.message as string,
    calls: num(r.calls),
    users: num(r.users),
    lastSeen: iso(r.last_seen),
  }));
  return { errors, total: totalOf(rows) };
}

/** A run of calls to one tool, by one user in one session, with gaps under this. */
export const LOOP_GAP_SECONDS = 60;
/** How many calls make a run worth showing. */
export const LOOP_MIN_CALLS = 4;

/**
 * Runs of repeated calls to the same tool — often a model retrying because a
 * response or a tool description confused it, though a legitimate batch
 * (getTask over ten tasks) looks the same, which is why runs containing a
 * failure are listed first. MCP only: REST calls carry no session id and come
 * from scripts, so a loop over one endpoint is a for-loop, not a retry. A run
 * breaks on any gap longer than LOOP_GAP_SECONDS.
 */
export async function usageRetryLoops(pool: UsagePool, f: UsageFilter) {
  const params: unknown[] = [];
  const where = filterClause(f, params);
  params.push(LOOP_GAP_SECONDS);
  const gapParam = `$${params.length}`;
  params.push(LOOP_MIN_CALLS);
  const minParam = `$${params.length}`;
  const { rows } = await pool.query(
    `WITH ordered AS (
       SELECT e.user_id, coalesce(e.session_id, '') AS sid, e.mcp_slug, e.tool, e.ts, e.ok,
              CASE WHEN e.ts - lag(e.ts) OVER w <= make_interval(secs => ${gapParam})
                   THEN 0 ELSE 1 END AS starts_run
         FROM tool_call_events e
        WHERE ${where} AND e.user_id IS NOT NULL AND e.surface = 'mcp'
       WINDOW w AS (PARTITION BY e.user_id, coalesce(e.session_id, ''), e.mcp_slug, e.tool ORDER BY e.ts)
     ), runs AS (
       SELECT *, sum(starts_run) OVER (
                PARTITION BY user_id, sid, mcp_slug, tool ORDER BY ts
              ) AS run_id
         FROM ordered
     )
     SELECT r.user_id, u.email, r.mcp_slug, r.tool, count(*) AS calls,
            count(*) FILTER (WHERE NOT r.ok) AS errors,
            min(r.ts) AS started, max(r.ts) AS ended,
            count(*) OVER () AS total
       FROM runs r LEFT JOIN users u ON u.id = r.user_id
      GROUP BY r.user_id, u.email, r.sid, r.mcp_slug, r.tool, r.run_id
     HAVING count(*) >= ${minParam}
      ORDER BY (count(*) FILTER (WHERE NOT r.ok) > 0) DESC, max(r.ts) DESC LIMIT 50`,
    params,
  );
  const loops = rows.map((r) => ({
    userId: num(r.user_id),
    email: (r.email as string | null) ?? null,
    slug: r.mcp_slug as string,
    tool: r.tool as string,
    calls: num(r.calls),
    errors: num(r.errors),
    started: iso(r.started),
    ended: iso(r.ended),
  }));
  return { loops, total: totalOf(rows) };
}

export async function usageUserTimeline(pool: UsagePool, userId: number, q: TimelineQuery) {
  const params: unknown[] = [userId];
  let cursor = '';
  if (q.before) {
    params.push(q.before);
    cursor = ` AND e.id < $${params.length}`;
  }
  params.push(q.limit);
  const [events, user] = await Promise.all([
    pool.query(
      `SELECT e.id, e.ts, e.mcp_slug, e.tool, e.surface, e.session_id, e.instance_id,
              e.client_name, e.client_version, e.duration_ms, e.ok, e.error_kind,
              e.error_message, e.arg_keys, e.arg_preview, e.arg_bytes
         FROM tool_call_events e
        WHERE e.user_id = $1${cursor}
        ORDER BY e.id DESC LIMIT $${params.length}`,
      params,
    ),
    pool.query(`SELECT id, email, name FROM users WHERE id = $1`, [userId]),
  ]);
  const rows = events.rows.map((r) => ({
    id: num(r.id),
    ts: iso(r.ts),
    slug: r.mcp_slug as string,
    tool: r.tool as string,
    surface: r.surface as string,
    sessionId: (r.session_id as string | null) ?? null,
    instanceId: (r.instance_id as string | null) ?? null,
    client: (r.client_name as string | null) ?? null,
    clientVersion: (r.client_version as string | null) ?? null,
    durationMs: num(r.duration_ms),
    ok: Boolean(r.ok),
    errorKind: (r.error_kind as string | null) ?? null,
    errorMessage: (r.error_message as string | null) ?? null,
    argKeys: (r.arg_keys as string[] | null) ?? [],
    argPreview: (r.arg_preview as Record<string, unknown> | null) ?? null,
    argBytes: numOrNull(r.arg_bytes),
  }));
  const u = user.rows[0];
  return {
    user: u ? { id: num(u.id), email: u.email as string, name: (u.name as string | null) ?? null } : { id: userId, email: null, name: null },
    events: rows,
    // A full page means there may be more; the cursor is the oldest id shown.
    nextBefore: rows.length === q.limit ? rows[rows.length - 1].id : null,
  };
}
