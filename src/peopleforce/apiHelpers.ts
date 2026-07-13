// src/peopleforce/apiHelpers.ts
// Bearer-token / API-Key HTTP client for the PeopleForce public REST API.
// Docs: https://apidoc.peopleforce.io/

import { UserError } from 'fastmcp';
import { UserSession } from '../userSession.js';

const DEFAULT_BASE_URL = process.env.PEOPLEFORCE_BASE_URL || 'https://app.peopleforce.io/api/public/v2';

export type PeopleForceEmployee = {
  id?: number | string;
  first_name?: string;
  last_name?: string;
  email?: string;
  position?: { name?: string } | string | null;
  department?: { id?: number | string; name?: string } | null;
  status?: string;
  hired_at?: string;
  terminated_at?: string | null;
};

export type PeopleForceDepartment = {
  id?: number | string;
  name?: string;
  description?: string;
  parent_id?: number | string | null;
  employees_count?: number;
};

export type PeopleForceAbsence = {
  id?: number | string;
  employee?: { id?: number | string; first_name?: string; last_name?: string } | null;
  policy?: { id?: number | string; name?: string } | null;
  start_date?: string;
  end_date?: string;
  status?: string;
  reason?: string;
  duration?: number;
};

export type PeopleForcePagination = {
  page?: number;
  per_page?: number;
  total_pages?: number;
  total_count?: number;
};

export class PeopleForceClient {
  public readonly baseUrl: string;

  constructor(private token: string, baseUrl?: string) {
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method,
        headers: {
          // PeopleForce accepts either `X-API-KEY: <key>` (personal API keys)
          // or `Authorization: Bearer <token>` (OAuth). Sending both is
          // harmless — the API picks whichever it recognizes.
          'X-API-KEY': this.token,
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new Error(`PeopleForce API ${method} ${path} timed out after 30000ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err: any = new Error(`PeopleForce API ${method} ${path} failed: ${res.status} ${text}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }
    if (res.status === 204) return undefined as unknown as T;
    if (res.headers.get('content-type')?.includes('application/json')) {
      return (await res.json()) as T;
    }
    return undefined as unknown as T;
  }

  // === Employees ===

  listEmployees(input: {
    page?: number;
    per_page?: number;
    status?: string;
    departmentId?: string | number;
  } = {}): Promise<{ data: PeopleForceEmployee[]; meta?: PeopleForcePagination }> {
    return this.request('GET', '/employees', undefined, {
      page: input.page,
      per_page: input.per_page,
      status: input.status,
      department_id: input.departmentId,
    });
  }

  getEmployee(id: string | number): Promise<{ data: PeopleForceEmployee }> {
    return this.request('GET', `/employees/${encodeURIComponent(String(id))}`);
  }

  // === Departments ===

  listDepartments(input: { page?: number; per_page?: number } = {}): Promise<{
    data: PeopleForceDepartment[];
    meta?: PeopleForcePagination;
  }> {
    return this.request('GET', '/departments', undefined, {
      page: input.page,
      per_page: input.per_page,
    });
  }

  // === Absences ===

  listAbsences(input: {
    page?: number;
    per_page?: number;
    employeeId?: string | number;
    status?: string;
    startFrom?: string;
    startTo?: string;
  } = {}): Promise<{ data: PeopleForceAbsence[]; meta?: PeopleForcePagination }> {
    return this.request('GET', '/absences', undefined, {
      page: input.page,
      per_page: input.per_page,
      employee_id: input.employeeId,
      status: input.status,
      start_date_from: input.startFrom,
      start_date_to: input.startTo,
    });
  }

  createAbsence(input: {
    employeeId: string | number;
    policyId: string | number;
    startDate: string;
    endDate: string;
    reason?: string;
  }): Promise<{ data: PeopleForceAbsence }> {
    return this.request('POST', '/absences', {
      employee_id: input.employeeId,
      policy_id: input.policyId,
      start_date: input.startDate,
      end_date: input.endDate,
      reason: input.reason,
    });
  }
}

// ==== Formatting helpers ====

function fullName(person: { first_name?: string; last_name?: string } | undefined | null): string {
  if (!person) return 'Unknown';
  const parts = [person.first_name, person.last_name].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : 'Unknown';
}

export function formatEmployeeList(
  employees: PeopleForceEmployee[],
  meta?: PeopleForcePagination,
): string {
  if (employees.length === 0) return 'No employees found.';
  const parts = ['# Employees', ''];
  if (meta) {
    const page = meta.page ?? 1;
    const totalPages = meta.total_pages ?? 1;
    const totalCount = meta.total_count ?? employees.length;
    parts.push(`Page ${page} of ${totalPages} (${totalCount} total)`);
    parts.push('');
  }
  employees.forEach((e, i) => {
    parts.push(`## ${i + 1}. ${fullName(e)}`);
    parts.push(`ID: ${e.id ?? ''}`);
    if (e.email) parts.push(`Email: ${e.email}`);
    const position = typeof e.position === 'string' ? e.position : e.position?.name;
    if (position) parts.push(`Position: ${position}`);
    if (e.department?.name) parts.push(`Department: ${e.department.name}`);
    if (e.status) parts.push(`Status: ${e.status}`);
    parts.push('');
  });
  return parts.join('\n').trimEnd();
}

export function formatEmployee(employee: PeopleForceEmployee): string {
  const parts = [`# ${fullName(employee)}`];
  if (employee.id !== undefined) parts.push(`ID: ${employee.id}`);
  if (employee.email) parts.push(`Email: ${employee.email}`);
  const position = typeof employee.position === 'string' ? employee.position : employee.position?.name;
  if (position) parts.push(`Position: ${position}`);
  if (employee.department?.name) parts.push(`Department: ${employee.department.name}`);
  if (employee.status) parts.push(`Status: ${employee.status}`);
  if (employee.hired_at) parts.push(`Hired: ${employee.hired_at}`);
  if (employee.terminated_at) parts.push(`Terminated: ${employee.terminated_at}`);
  return parts.join('\n');
}

export function formatDepartmentList(departments: PeopleForceDepartment[]): string {
  if (departments.length === 0) return 'No departments found.';
  const parts = ['# Departments', ''];
  departments.forEach((d, i) => {
    parts.push(`## ${i + 1}. ${d.name ?? 'Untitled'}`);
    parts.push(`ID: ${d.id ?? ''}`);
    if (d.description) parts.push(`Description: ${d.description}`);
    if (typeof d.employees_count === 'number') parts.push(`Employees: ${d.employees_count}`);
    parts.push('');
  });
  return parts.join('\n').trimEnd();
}

export function formatAbsenceList(
  absences: PeopleForceAbsence[],
  meta?: PeopleForcePagination,
): string {
  if (absences.length === 0) return 'No absences found.';
  const parts = ['# Absences', ''];
  if (meta) {
    const page = meta.page ?? 1;
    const totalPages = meta.total_pages ?? 1;
    const totalCount = meta.total_count ?? absences.length;
    parts.push(`Page ${page} of ${totalPages} (${totalCount} total)`);
    parts.push('');
  }
  absences.forEach((a, i) => {
    parts.push(`## ${i + 1}. ${fullName(a.employee ?? undefined)} — ${a.policy?.name ?? 'Absence'}`);
    parts.push(`ID: ${a.id ?? ''}`);
    if (a.start_date) parts.push(`Start: ${a.start_date}`);
    if (a.end_date) parts.push(`End: ${a.end_date}`);
    if (a.status) parts.push(`Status: ${a.status}`);
    if (typeof a.duration === 'number') parts.push(`Duration: ${a.duration}`);
    if (a.reason) parts.push(`Reason: ${a.reason}`);
    parts.push('');
  });
  return parts.join('\n').trimEnd();
}

// ==== Session + error helpers used by every PeopleForce tool executor ====

export type PeopleForceToolLog = {
  info: (msg: string) => void;
  error: (msg: string) => void;
};

export function getPeopleForceClient(session?: UserSession): PeopleForceClient {
  if (!session?.peopleForceAccessToken) {
    throw new UserError('PeopleForce not connected. Visit the dashboard to connect your PeopleForce account.');
  }
  return new PeopleForceClient(session.peopleForceAccessToken, session.peopleForceBaseUrl);
}

export function mapPeopleForceError(prefix: string, error: any, log: PeopleForceToolLog): never {
  log.error(`${prefix}: ${error?.message ?? error}`);
  if (error?.status === 401 || error?.status === 403) {
    throw new UserError(`${prefix}: not authorized. Check that your PeopleForce API key is valid.`);
  }
  if (error?.status === 404) {
    throw new UserError(`${prefix}: not found.`);
  }
  if (error?.status === 429) {
    throw new UserError(`${prefix}: rate limited by PeopleForce. Retry later.`);
  }
  throw new UserError(`${prefix}: ${error?.message ?? 'Unknown error'}`);
}

export async function withPeopleForceClient<T>(
  prefix: string,
  session: UserSession | undefined,
  log: PeopleForceToolLog,
  fn: (client: PeopleForceClient) => Promise<T>,
): Promise<T> {
  const client = getPeopleForceClient(session);
  try {
    return await fn(client);
  } catch (error: any) {
    mapPeopleForceError(prefix, error, log);
  }
}
