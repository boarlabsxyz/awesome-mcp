// src/peopleforce/snapshot/collect.ts
// Scheduled collector: snapshot PeopleForce L&D state into Postgres so trend
// dashboards can accumulate history the API itself doesn't retain.
//
// Run it on a schedule (nightly is plenty — the data changes slowly):
//   PEOPLEFORCE_API_KEY=xxx DATABASE_URL=postgres://… npm run snapshot:peopleforce
//
// See ./README.md for scheduling and the Grafana queries each table powers.

import pg from 'pg';
import { fileURLToPath } from 'node:url';

import {
  PeopleForceClient,
  PeopleForceListResponse,
  PeopleForceEmployee,
  PeopleForceEmployeeSkill,
} from '../apiHelpers.js';
import { ensureSnapshotTables } from './schema.js';
import { employeeRows, customFieldRows, employeeSkillRows, objectiveRows, kpiRows } from './rows.js';

/** Minimal DB surface the collector needs — a pg Pool/PoolClient satisfies it. */
export interface SnapshotDb {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface SnapshotLog {
  info: (msg: string) => void;
  error: (msg: string) => void;
}

const NOOP_LOG: SnapshotLog = { info: () => {}, error: () => {} };

// Safety cap so a pagination-metadata glitch can't loop forever.
const MAX_PAGES = Number(process.env.PEOPLEFORCE_SNAPSHOT_MAX_PAGES || 1000);

/**
 * Walk every page of a paginated list endpoint. Stops at the reported last page
 * when pagination metadata is present, otherwise when a page comes back empty.
 */
export async function fetchAllPages<T>(
  fetchPage: (page: number) => Promise<PeopleForceListResponse<T>>,
): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  for (;;) {
    const res = await fetchPage(page);
    const data = res.data ?? [];
    all.push(...data);
    const totalPages = res.metadata?.pagination?.pages;
    const done = totalPages !== undefined ? page >= totalPages : data.length === 0;
    if (done || page >= MAX_PAGES) break;
    page++;
  }
  return all;
}

/**
 * Batch-insert plain scalar rows. Builds one multi-row parameterized INSERT per
 * chunk. Only handles scalar columns (text/number/bool/null) — every snapshot
 * table is scalar-only by design, so there's no JSONB/array serialization to do.
 */
export async function insertRows(
  db: SnapshotDb,
  table: string,
  columns: string[],
  rows: readonly object[],
  chunkSize = 500,
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const params: unknown[] = [];
    const tuples = chunk.map((row, ri) => {
      const rec = row as Record<string, unknown>;
      const placeholders = columns.map((_, ci) => `$${ri * columns.length + ci + 1}`);
      for (const col of columns) params.push(rec[col] ?? null);
      return `(${placeholders.join(', ')})`;
    });
    await db.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`, params);
    inserted += chunk.length;
  }
  return inserted;
}

export interface SnapshotResult {
  capturedAt: string;
  counts: Record<string, number>;
}

/**
 * Capture one full snapshot: fetch employees + per-employee skills + objectives
 * + KPIs, transform to rows stamped with `capturedAt`, and insert. Ensures the
 * tables first, so a fresh DB works with no separate migration step.
 */
export async function runSnapshot(deps: {
  client: PeopleForceClient;
  db: SnapshotDb;
  capturedAt: string;
  log?: SnapshotLog;
}): Promise<SnapshotResult> {
  const { client, db, capturedAt } = deps;
  const log = deps.log ?? NOOP_LOG;

  await ensureSnapshotTables(db);

  // Roster first — custom fields ride on it and per-employee skills need the IDs.
  const employees = await fetchAllPages<PeopleForceEmployee>((page) => client.listEmployees({ page }));
  log.info(`employees: ${employees.length}`);

  // Per-employee skills. The public API has no bulk endpoint, so this is N calls;
  // sequential keeps us well under rate limits and a nightly cadence hides the
  // latency. A single employee's failure is logged, not fatal.
  const perEmployeeSkills: Array<{ employeeId: string | number; skills: PeopleForceEmployeeSkill[] }> = [];
  for (const e of employees) {
    if (e.id === undefined || e.id === null) continue;
    try {
      const res = await client.listEmployeeSkills(e.id);
      perEmployeeSkills.push({ employeeId: e.id, skills: res.data ?? [] });
    } catch (err: any) {
      log.error(`skills for employee ${e.id}: ${err?.message ?? err}`);
    }
  }

  const objectives = await fetchAllPages((page) => client.listObjectives({ page }));
  log.info(`objectives: ${objectives.length}`);
  const kpis = await fetchAllPages((page) => client.listKeyPerformanceIndicators({ page }));
  log.info(`kpis: ${kpis.length}`);

  const counts: Record<string, number> = {};
  counts.employees = await insertRows(
    db, 'pf_employee_snapshot',
    ['captured_at', 'employee_id', 'full_name', 'email', 'active', 'department', 'division', 'position'],
    employeeRows(employees, capturedAt),
  );
  counts.custom_fields = await insertRows(
    db, 'pf_employee_custom_field_snapshot',
    ['captured_at', 'employee_id', 'field_name', 'field_value'],
    customFieldRows(employees, capturedAt),
  );
  counts.employee_skills = await insertRows(
    db, 'pf_employee_skill_snapshot',
    ['captured_at', 'employee_id', 'skill_id', 'skill_name', 'level'],
    employeeSkillRows(perEmployeeSkills, capturedAt),
  );
  counts.objectives = await insertRows(
    db, 'pf_objective_snapshot',
    ['captured_at', 'objective_id', 'title', 'owner_id', 'owner_email', 'owner_name', 'progress', 'status', 'starts_on', 'ends_on'],
    objectiveRows(objectives, capturedAt),
  );
  counts.kpis = await insertRows(
    db, 'pf_kpi_snapshot',
    ['captured_at', 'kpi_id', 'title', 'kpi_type', 'owner_id', 'owner_email', 'scope', 'progress_percentage', 'status'],
    kpiRows(kpis, capturedAt),
  );

  return { capturedAt, counts };
}

/** CLI entrypoint: wire env -> client + pool, record the run, snapshot. */
async function main(): Promise<void> {
  const token = process.env.PEOPLEFORCE_API_KEY;
  const databaseUrl = process.env.DATABASE_URL;
  if (!token) {
    console.error('[pf-snapshot] PEOPLEFORCE_API_KEY is required');
    process.exit(1);
  }
  if (!databaseUrl) {
    console.error('[pf-snapshot] DATABASE_URL is required');
    process.exit(1);
  }

  const log: SnapshotLog = {
    info: (m) => console.error(`[pf-snapshot] ${m}`),
    error: (m) => console.error(`[pf-snapshot] ERROR ${m}`),
  };
  const client = new PeopleForceClient(token, process.env.PEOPLEFORCE_BASE_URL);
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const conn = await pool.connect();
  const capturedAt = new Date().toISOString();

  let runId: number | undefined;
  try {
    await ensureSnapshotTables(conn);
    const run = await conn.query(
      'INSERT INTO pf_snapshot_run (captured_at, status) VALUES ($1, $2) RETURNING id',
      [capturedAt, 'running'],
    );
    runId = run.rows[0]?.id;

    const result = await runSnapshot({ client, db: conn, capturedAt, log });

    await conn.query(
      'UPDATE pf_snapshot_run SET status = $1, counts = $2::jsonb, finished_at = NOW() WHERE id = $3',
      ['success', JSON.stringify(result.counts), runId],
    );
    log.info(`snapshot ${capturedAt} ok: ${JSON.stringify(result.counts)}`);
  } catch (err: any) {
    log.error(err?.message ?? String(err));
    if (runId !== undefined) {
      await conn
        .query('UPDATE pf_snapshot_run SET status = $1, error = $2, finished_at = NOW() WHERE id = $3', [
          'failed',
          String(err?.message ?? err),
          runId,
        ])
        .catch(() => {});
    }
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
}

// Run only when executed directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
