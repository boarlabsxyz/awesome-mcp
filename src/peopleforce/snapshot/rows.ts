// src/peopleforce/snapshot/rows.ts
// Pure transforms: PeopleForce API objects -> flat snapshot rows. No DB and no
// network here, so every mapping is unit-testable in isolation.

import {
  PeopleForceEmployee,
  PeopleForceEmployeeSkill,
  PeopleForceObjective,
  PeopleForceKpi,
  PeopleForceKnowledgeArticle,
  PeopleForceEmployeeShort,
  PeopleForceEmployeeTableData,
  PeopleForceTableCellValue,
  fullName,
  refName,
  customFieldEntries,
} from '../apiHelpers.js';

export interface EmployeeRow {
  captured_at: string;
  employee_id: string;
  full_name: string | null;
  email: string | null;
  active: boolean | null;
  department: string | null;
  division: string | null;
  position: string | null;
}
export interface EmployeeSkillRow {
  captured_at: string;
  employee_id: string;
  skill_id: string | null;
  skill_name: string | null;
  level: string | null;
}
export interface CustomFieldRow {
  captured_at: string;
  employee_id: string;
  field_name: string;
  field_value: string;
}
export interface ObjectiveRow {
  captured_at: string;
  objective_id: string;
  title: string | null;
  owner_id: string | null;
  owner_email: string | null;
  owner_name: string | null;
  progress: number | null;
  status: string | null;
  starts_on: string | null;
  ends_on: string | null;
}
export interface KpiRow {
  captured_at: string;
  kpi_id: string;
  title: string | null;
  kpi_type: string | null;
  owner_id: string | null;
  owner_email: string | null;
  scope: string | null;
  progress_percentage: number | null;
  status: string | null;
}
export interface KbArticleRow {
  captured_at: string;
  article_id: string;
  title: string | null;
  category_id: string | null;
  category_name: string | null;
  author_id: string | null;
  author_name: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** Coerce a value to a non-empty string or null (empty/absent -> null column). */
function str(v: unknown): string | null {
  return v === undefined || v === null || v === '' ? null : String(v);
}

/** Owner display name, mapping the "Unknown" sentinel to null. */
function ownerName(o?: PeopleForceEmployeeShort | null): string | null {
  if (!o) return null;
  const n = fullName(o);
  return n === 'Unknown' ? null : n;
}

export function employeeRows(employees: PeopleForceEmployee[], capturedAt: string): EmployeeRow[] {
  return employees
    .filter((e) => e.id !== undefined && e.id !== null)
    .map((e) => ({
      captured_at: capturedAt,
      employee_id: String(e.id),
      full_name: ownerName(e as PeopleForceEmployeeShort),
      email: str(e.email),
      active: typeof e.active === 'boolean' ? e.active : null,
      department: refName(e.department) ?? null,
      division: refName(e.division) ?? null,
      position: refName(e.position) ?? null,
    }));
}

export interface EmployeeDimRow {
  employee_id: string;
  full_name: string | null;
  email: string | null;
  department: string | null;
  division: string | null;
  position: string | null;
  active: boolean | null;
  updated_at: string;
}

/** Current-state dimension rows (for upsert), keyed by employee_id. */
export function employeeDimRows(employees: PeopleForceEmployee[], updatedAt: string): EmployeeDimRow[] {
  return employees
    .filter((e) => e.id !== undefined && e.id !== null)
    .map((e) => ({
      employee_id: String(e.id),
      full_name: ownerName(e as PeopleForceEmployeeShort),
      email: str(e.email),
      department: refName(e.department) ?? null,
      division: refName(e.division) ?? null,
      position: refName(e.position) ?? null,
      active: typeof e.active === 'boolean' ? e.active : null,
      updated_at: updatedAt,
    }));
}

export function customFieldRows(employees: PeopleForceEmployee[], capturedAt: string): CustomFieldRow[] {
  const rows: CustomFieldRow[] = [];
  for (const e of employees) {
    if (e.id === undefined || e.id === null) continue;
    for (const { name, value } of customFieldEntries(e.custom_fields ?? e.custom_field_values)) {
      rows.push({ captured_at: capturedAt, employee_id: String(e.id), field_name: name, field_value: value });
    }
  }
  return rows;
}

export function employeeSkillRows(
  perEmployee: Array<{ employeeId: string | number; skills: PeopleForceEmployeeSkill[] }>,
  capturedAt: string,
): EmployeeSkillRow[] {
  const rows: EmployeeSkillRow[] = [];
  for (const { employeeId, skills } of perEmployee) {
    for (const s of skills) {
      rows.push({
        captured_at: capturedAt,
        employee_id: String(employeeId),
        skill_id: str(s.skill?.id),
        skill_name: s.skill?.name ?? null,
        level: str(s.level),
      });
    }
  }
  return rows;
}

export function objectiveRows(objectives: PeopleForceObjective[], capturedAt: string): ObjectiveRow[] {
  return objectives
    .filter((o) => o.id !== undefined && o.id !== null)
    .map((o) => ({
      captured_at: capturedAt,
      objective_id: String(o.id),
      title: str(o.title),
      owner_id: str(o.owner?.id),
      owner_email: str(o.owner?.email),
      owner_name: ownerName(o.owner),
      progress: typeof o.progress === 'number' ? o.progress : null,
      status: str(o.status),
      starts_on: str(o.starts_on),
      ends_on: str(o.ends_on),
    }));
}

export interface EmployeeTableCellRow {
  captured_at: string;
  employee_id: string;
  table_internal_name: string;
  table_name: string | null;
  row_id: string | null;
  column_name: string;
  value: string;
}

/** Expand a table cell into its value(s): multi-select → many, ref → name, empty → none. */
function cellValues(value: PeopleForceTableCellValue): string[] {
  if (value === null || value === undefined || value === '') return [];
  if (Array.isArray(value)) {
    return value.map((v) => v?.value).filter((v): v is string => Boolean(v));
  }
  if (typeof value === 'boolean') return [value ? 'yes' : 'no'];
  if (typeof value === 'object') {
    const rec = value as { value?: string; full_name?: string; email?: string };
    const v = rec.value ?? rec.full_name ?? rec.email;
    return v ? [String(v)] : [JSON.stringify(value)];
  }
  return [String(value)];
}

/**
 * Flatten each employee's custom-table rows into one cell row per (row, column,
 * value). Multi-select cells fan out to one row per value so attendance/
 * participation counts are a plain GROUP BY.
 */
export function employeeTableCellRows(
  tables: Array<{ employeeId: string | number; table: PeopleForceEmployeeTableData }>,
  capturedAt: string,
): EmployeeTableCellRow[] {
  const out: EmployeeTableCellRow[] = [];
  for (const { employeeId, table } of tables) {
    const internal = table.internal_name;
    if (!internal) continue;
    for (const row of table.rows ?? []) {
      const cols = row.columns ?? {};
      for (const [column_name, value] of Object.entries(cols)) {
        for (const v of cellValues(value)) {
          out.push({
            captured_at: capturedAt,
            employee_id: String(employeeId),
            table_internal_name: internal,
            table_name: table.name ?? null,
            row_id: row.id !== undefined && row.id !== null ? String(row.id) : null,
            column_name,
            value: v,
          });
        }
      }
    }
  }
  return out;
}

export function kbArticleRows(articles: PeopleForceKnowledgeArticle[], capturedAt: string): KbArticleRow[] {
  return articles
    .filter((a) => a.id !== undefined && a.id !== null)
    .map((a) => ({
      captured_at: capturedAt,
      article_id: String(a.id),
      title: str(a.title),
      category_id: str(a.category && typeof a.category === 'object' ? a.category.id : undefined),
      category_name: refName(a.category) ?? null,
      author_id: str(a.created_by?.id),
      author_name: ownerName(a.created_by),
      created_at: str(a.created_at),
      updated_at: str(a.updated_at),
    }));
}

export function kpiRows(kpis: PeopleForceKpi[], capturedAt: string): KpiRow[] {
  return kpis
    .filter((k) => k.id !== undefined && k.id !== null)
    .map((k) => ({
      captured_at: capturedAt,
      kpi_id: String(k.id),
      title: str(k.title),
      kpi_type: str(k.kpi_type),
      owner_id: str(k.owner?.id),
      owner_email: str(k.owner?.email),
      scope: refName(k.department) ?? refName(k.division) ?? refName(k.location) ?? null,
      progress_percentage: typeof k.progress_percentage === 'number' ? k.progress_percentage : null,
      status: str(k.status),
    }));
}
