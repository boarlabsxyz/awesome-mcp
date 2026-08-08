// src/peopleforce/snapshot/rows.ts
// Pure transforms: PeopleForce API objects -> flat snapshot rows. No DB and no
// network here, so every mapping is unit-testable in isolation.

import {
  PeopleForceEmployee,
  PeopleForceEmployeeSkill,
  PeopleForceObjective,
  PeopleForceKpi,
  PeopleForceEmployeeShort,
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
