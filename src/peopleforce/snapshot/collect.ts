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
  PeopleForceKnowledgeArticle,
  PeopleForceKnowledgeCategory,
  PeopleForceEmployeeTableListItem,
  PeopleForceEmployeeTableData,
  fullName,
} from '../apiHelpers.js';
import { ensureSnapshotTables } from './schema.js';
import {
  employeeRows, customFieldRows, employeeSkillRows, objectiveRows, kpiRows, kbArticleRows, employeeDimRows,
  employeeTableCellRows,
} from './rows.js';
import { resolveOwners, OwnerInput, ResolverEmployee } from './resolve.js';

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

/**
 * Batch upsert keyed on `conflictKey`; every other column is overwritten with the
 * incoming value. Used for the maintained (non-append-only) dimension and
 * owner-resolution tables.
 */
export async function upsertRows(
  db: SnapshotDb,
  table: string,
  columns: string[],
  conflictKey: string,
  rows: readonly object[],
  chunkSize = 500,
): Promise<number> {
  const setClause = columns
    .filter((c) => c !== conflictKey)
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(', ');
  let n = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const params: unknown[] = [];
    const tuples = chunk.map((row, ri) => {
      const rec = row as Record<string, unknown>;
      const placeholders = columns.map((_, ci) => `$${ri * columns.length + ci + 1}`);
      for (const col of columns) params.push(rec[col] ?? null);
      return `(${placeholders.join(', ')})`;
    });
    await db.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')} ` +
        `ON CONFLICT (${conflictKey}) DO UPDATE SET ${setClause}`,
      params,
    );
    n += chunk.length;
  }
  return n;
}

/**
 * Refresh the employee dimension and re-resolve objective/KPI owners to
 * employees, persisting the mapping. Manual-override resolution rows are left
 * untouched. Returns the count of still-unresolved owners (surface as an alert).
 */
export async function resolveAndPersistOwners(deps: {
  db: SnapshotDb;
  employees: PeopleForceEmployee[];
  owners: OwnerInput[];
  updatedAt: string;
  log?: SnapshotLog;
}): Promise<{ employees: number; resolutions: number; unmatched: number }> {
  const { db, employees, owners, updatedAt } = deps;
  const log = deps.log ?? NOOP_LOG;

  const empCount = await upsertRows(
    db, 'pf_employee_dim',
    ['employee_id', 'full_name', 'email', 'department', 'division', 'position', 'active', 'updated_at'],
    'employee_id',
    employeeDimRows(employees, updatedAt),
  );

  const dim: ResolverEmployee[] = employees
    .filter((e) => e.id !== undefined && e.id !== null)
    .map((e) => ({ employee_id: String(e.id), full_name: fullName(e), email: e.email ?? null }));

  const manualRes = await db.query(
    `SELECT owner_key FROM pf_owner_resolution WHERE manual_override = TRUE`,
  );
  const manualKeys = new Set<string>((manualRes.rows ?? []).map((r) => String(r.owner_key)));

  const { resolutions, unmatched } = resolveOwners(owners, dim, manualKeys);
  const resolutionRows = resolutions.map((r) => ({ ...r, manual_override: false, updated_at: updatedAt }));
  const resCount = await upsertRows(
    db, 'pf_owner_resolution',
    ['owner_key', 'owner_email', 'owner_name', 'employee_id', 'method', 'confidence', 'manual_override', 'updated_at'],
    'owner_key',
    resolutionRows,
  );

  if (unmatched.length) {
    log.error(`unresolved owners: ${unmatched.length} (review pf_owner_resolution WHERE method='unresolved')`);
  }
  return { employees: empCount, resolutions: resCount, unmatched: unmatched.length };
}

/**
 * Which custom tables to snapshot: the PEOPLEFORCE_SNAPSHOT_TABLES env
 * (comma-separated internal_names) if set, else every table discovered via
 * listEmployeeTables. Explicit config is recommended when a tenant has many
 * tables (row fetch is employees×tables calls).
 */
export async function discoverTableInternalNames(client: PeopleForceClient): Promise<string[]> {
  const configured = (process.env.PEOPLEFORCE_SNAPSHOT_TABLES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (configured.length) return configured;
  const defs = await fetchAllPages<PeopleForceEmployeeTableListItem>((page) => client.listEmployeeTables({ page }));
  return defs
    .map((d) => (d.EmployeeTable ?? d).internal_name)
    .filter((n): n is string => Boolean(n));
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

  // Knowledge Base articles — walk every category, then its articles. Articles
  // carry their own created_at, so this backfills "content authored" history.
  const categories = await fetchAllPages<PeopleForceKnowledgeCategory>((page) =>
    client.listKnowledgeBaseCategories({ page }),
  );
  const kbArticles: PeopleForceKnowledgeArticle[] = [];
  for (const c of categories) {
    if (c.id === undefined || c.id === null) continue;
    try {
      const arts = await fetchAllPages<PeopleForceKnowledgeArticle>((page) =>
        client.listKnowledgeBaseArticles({ categoryId: c.id as string | number, page }),
      );
      kbArticles.push(...arts);
    } catch (err: any) {
      log.error(`kb articles for category ${c.id}: ${err?.message ?? err}`);
    }
  }
  log.info(`kb articles: ${kbArticles.length}`);

  // Employee custom tables (e.g. "Dev Sprint participation") — the participation
  // data the API has no dedicated object for. Which tables to capture: the
  // PEOPLEFORCE_SNAPSHOT_TABLES env (comma-separated internal_names), else every
  // discovered table. Row fetch is employees×tables calls (like skills), so a
  // 404 = employee doesn't have the table (skipped); other errors are logged.
  const tableNames = await discoverTableInternalNames(client);
  const capturedTables: Array<{ employeeId: string | number; table: PeopleForceEmployeeTableData }> = [];
  if (tableNames.length) {
    log.info(`employee tables: [${tableNames.join(', ')}] (~${employees.length * tableNames.length} calls)`);
    for (const e of employees) {
      if (e.id === undefined || e.id === null) continue;
      for (const name of tableNames) {
        try {
          const data = await client.getEmployeeTable(e.id, name);
          if (data && (data.rows?.length ?? 0) > 0) capturedTables.push({ employeeId: e.id, table: data });
        } catch (err: any) {
          if (err?.status !== 404) log.error(`table ${name} for employee ${e.id}: ${err?.message ?? err}`);
        }
      }
    }
  }

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
  counts.kb_articles = await insertRows(
    db, 'pf_kb_article_snapshot',
    ['captured_at', 'article_id', 'title', 'category_id', 'category_name', 'author_id', 'author_name', 'created_at', 'updated_at'],
    kbArticleRows(kbArticles, capturedAt),
  );
  counts.table_cells = await insertRows(
    db, 'pf_employee_table_cell_snapshot',
    ['captured_at', 'employee_id', 'table_internal_name', 'table_name', 'row_id', 'column_name', 'value'],
    employeeTableCellRows(capturedTables, capturedAt),
  );

  // Employee dimension + owner resolution (from objective & KPI owners).
  const owners: OwnerInput[] = [...objectives, ...kpis].map((x) => ({
    employee_id: x.owner?.id != null ? String(x.owner.id) : null,
    email: x.owner?.email ?? null,
    name: x.owner ? fullName(x.owner) : null,
  }));
  const resolved = await resolveAndPersistOwners({ db, employees, owners, updatedAt: capturedAt, log });
  counts.employee_dim = resolved.employees;
  counts.owner_resolutions = resolved.resolutions;
  counts.owners_unresolved = resolved.unmatched;

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
