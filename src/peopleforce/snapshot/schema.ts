// src/peopleforce/snapshot/schema.ts
// Postgres schema for PeopleForce Learning & Development time-series snapshots.
//
// Why this exists: the PeopleForce public API exposes NO history and NO
// date-range filtering, so trend dashboards (skills over time, participation
// over time, L&D activity in a period) are impossible from the API alone. The
// collector periodically captures the *current* state stamped with `captured_at`;
// querying across stamps reconstructs the trend the API won't give you. Every
// table is append-only — one batch of rows per snapshot run. Start collecting
// now, because history cannot be backfilled.
//
// Tables use `CREATE TABLE IF NOT EXISTS` so the collector is safe to run against
// an existing DB (mirrors the migration style in src/db.ts).

import type { SnapshotDb } from './collect.js';

export const SNAPSHOT_DDL: string[] = [
  // One row per collector run — success/failure + per-table counts for observability.
  `CREATE TABLE IF NOT EXISTS pf_snapshot_run (
    id           SERIAL PRIMARY KEY,
    captured_at  TIMESTAMPTZ NOT NULL,
    status       VARCHAR(20) NOT NULL,
    counts       JSONB,
    error        TEXT,
    started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at  TIMESTAMPTZ
  );`,
  // Roster snapshot — the join table for teams/departments over time.
  `CREATE TABLE IF NOT EXISTS pf_employee_snapshot (
    captured_at  TIMESTAMPTZ NOT NULL,
    employee_id  VARCHAR(64) NOT NULL,
    full_name    TEXT,
    email        TEXT,
    active       BOOLEAN,
    department   TEXT,
    division     TEXT,
    position     TEXT
  );`,
  // Skills portfolio — the ONLY way to get skills-over-time (API carries no timestamps).
  `CREATE TABLE IF NOT EXISTS pf_employee_skill_snapshot (
    captured_at  TIMESTAMPTZ NOT NULL,
    employee_id  VARCHAR(64) NOT NULL,
    skill_id     VARCHAR(64),
    skill_name   TEXT,
    level        TEXT
  );`,
  // Tenant custom fields (Dev Sprint / courses / L&D spend, when a tenant records them).
  `CREATE TABLE IF NOT EXISTS pf_employee_custom_field_snapshot (
    captured_at  TIMESTAMPTZ NOT NULL,
    employee_id  VARCHAR(64) NOT NULL,
    field_name   TEXT NOT NULL,
    field_value  TEXT
  );`,
  // Objectives (OKRs) — development activities, dev sprints & courses live here as prose.
  `CREATE TABLE IF NOT EXISTS pf_objective_snapshot (
    captured_at  TIMESTAMPTZ NOT NULL,
    objective_id VARCHAR(64) NOT NULL,
    title        TEXT,
    owner_id     VARCHAR(64),
    owner_email  TEXT,
    owner_name   TEXT,
    progress     INTEGER,
    status       TEXT,
    starts_on    DATE,
    ends_on      DATE
  );`,
  `CREATE TABLE IF NOT EXISTS pf_kpi_snapshot (
    captured_at         TIMESTAMPTZ NOT NULL,
    kpi_id              VARCHAR(64) NOT NULL,
    title               TEXT,
    kpi_type            TEXT,
    owner_id            VARCHAR(64),
    owner_email         TEXT,
    scope               TEXT,
    progress_percentage INTEGER,
    status              TEXT
  );`,
  `CREATE INDEX IF NOT EXISTS idx_pf_emp_skill_captured ON pf_employee_skill_snapshot(captured_at);`,
  `CREATE INDEX IF NOT EXISTS idx_pf_emp_skill_name ON pf_employee_skill_snapshot(skill_name, captured_at);`,
  `CREATE INDEX IF NOT EXISTS idx_pf_objective_captured ON pf_objective_snapshot(captured_at);`,
  `CREATE INDEX IF NOT EXISTS idx_pf_custom_field_captured ON pf_employee_custom_field_snapshot(captured_at, field_name);`,
  `CREATE INDEX IF NOT EXISTS idx_pf_employee_captured ON pf_employee_snapshot(captured_at);`,
  `CREATE INDEX IF NOT EXISTS idx_pf_kpi_captured ON pf_kpi_snapshot(captured_at);`,
];

/** Idempotently create every snapshot table + index. Safe to call on each run. */
export async function ensureSnapshotTables(db: SnapshotDb): Promise<void> {
  for (const ddl of SNAPSHOT_DDL) await db.query(ddl);
}
