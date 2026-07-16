// src/peopleforce/apiHelpers.ts
// Bearer-token / API-Key HTTP client for the PeopleForce public REST API.
// Docs: https://apidoc.peopleforce.io/
//
// The API surface here mirrors what the public v2 API actually accepts,
// verified against a live workspace on 2026-07-16:
//   - Pagination is server-fixed (50/page for /employees + /departments,
//     100/page for /leave_requests). No `per_page`/`limit`/etc. override
//     works; only `page` navigates.
//   - Filter params that work: `status` (employees), `state` (leave requests).
//   - Filter params that DO NOT work despite looking obvious: `department_id`
//     on /employees, `employee_id` on /leave_requests, and any date-range
//     filter on /leave_requests. Nested endpoints like
//     /employees/{id}/leave_requests are 404. The response body wraps the
//     collection in { data, metadata: { pagination: { page, pages, count,
//     items } } }.

import { UserError } from 'fastmcp';
import { UserSession } from '../userSession.js';

const DEFAULT_BASE_URL = process.env.PEOPLEFORCE_BASE_URL || 'https://app.peopleforce.io/api/public/v2';

// Rich objects the API embeds inside employee records.
export type PeopleForceRef = {
  id?: number | string;
  name?: string;
} | null;

export type PeopleForceEmployee = {
  id?: number | string;
  active?: boolean;
  employee_number?: string;
  full_name?: string;
  first_name?: string;
  middle_name?: string;
  last_name?: string;
  email?: string;
  personal_email?: string;
  mobile_number?: string | null;
  work_phone_number?: string | null;
  date_of_birth?: string | null;
  probation_ends_on?: string | null;
  hired_on?: string | null;
  position?: PeopleForceRef | string;
  job_level?: PeopleForceRef;
  location?: (PeopleForceRef & { address?: string; time_zone?: string }) | null;
  employment_type?: PeopleForceRef;
  division?: PeopleForceRef;
  department?: PeopleForceRef;
  reporting_to?: PeopleForceRef;
  job_profile?: PeopleForceRef;
  avatar_url?: string | null;
};

export type PeopleForceDepartment = {
  id?: number | string;
  name?: string;
  description?: string;
  parent_id?: number | string | null;
  employees_count?: number;
};

export type PeopleForceLeaveRequest = {
  id?: number | string;
  employee_id?: number | string;
  leave_type_id?: number | string;
  /** PeopleForce returns leave_type as a plain string on list responses (e.g. "Vacation"). */
  leave_type?: string;
  state?: string;
  amount?: string;
  hours?: string;
  tracking_time_in?: string;
  on_demand?: boolean;
  starts_on?: string;
  ends_on?: string;
  comment?: string | null;
  attachment_url?: string | null;
  employee?: {
    id?: number | string;
    first_name?: string;
    last_name?: string;
    email?: string;
  } | null;
};

/** Pagination shape the API actually returns. Server-forced page size. */
export type PeopleForcePagination = {
  page?: number;
  pages?: number;
  count?: number;
  items?: number;
};

/** Envelope shape for list endpoints. */
export type PeopleForceListResponse<T> = {
  data: T[];
  metadata?: { pagination?: PeopleForcePagination };
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
    status?: string;
  } = {}): Promise<PeopleForceListResponse<PeopleForceEmployee>> {
    return this.request('GET', '/employees', undefined, {
      page: input.page,
      status: input.status,
    });
  }

  getEmployee(id: string | number): Promise<{ data: PeopleForceEmployee }> {
    return this.request('GET', `/employees/${encodeURIComponent(String(id))}`);
  }

  // === Departments ===

  listDepartments(input: { page?: number } = {}): Promise<PeopleForceListResponse<PeopleForceDepartment>> {
    return this.request('GET', '/departments', undefined, {
      page: input.page,
    });
  }

  // === Leave requests ===

  listLeaveRequests(input: {
    page?: number;
    state?: string;
  } = {}): Promise<PeopleForceListResponse<PeopleForceLeaveRequest>> {
    return this.request('GET', '/leave_requests', undefined, {
      page: input.page,
      state: input.state,
    });
  }

  createLeaveRequest(input: {
    employeeId: string | number;
    leaveTypeId: string | number;
    startsOn: string;
    endsOn: string;
    comment?: string;
  }): Promise<{ data: PeopleForceLeaveRequest }> {
    return this.request('POST', '/leave_requests', {
      employee_id: input.employeeId,
      leave_type_id: input.leaveTypeId,
      starts_on: input.startsOn,
      ends_on: input.endsOn,
      comment: input.comment,
    });
  }
}

// ==== Formatting helpers ====

function fullName(
  person: { full_name?: string; first_name?: string; last_name?: string } | undefined | null,
): string {
  if (!person) return 'Unknown';
  if (person.full_name) return person.full_name;
  const parts = [person.first_name, person.last_name].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : 'Unknown';
}

function refName(ref: PeopleForceRef | string | undefined): string | undefined {
  if (!ref) return undefined;
  if (typeof ref === 'string') return ref;
  return ref.name;
}

function renderPaginationLine(pagination?: PeopleForcePagination): string | null {
  if (!pagination) return null;
  const page = pagination.page ?? 1;
  const pages = pagination.pages ?? 1;
  const count = pagination.count;
  const items = pagination.items;
  const suffix = count !== undefined ? ` (${count} total, ${items ?? '?'} per page)` : '';
  return `Page ${page} of ${pages}${suffix}`;
}

export function formatEmployeeList(
  employees: PeopleForceEmployee[],
  pagination?: PeopleForcePagination,
): string {
  if (employees.length === 0) return 'No employees found.';
  const parts = ['# Employees', ''];
  const pag = renderPaginationLine(pagination);
  if (pag) { parts.push(pag); parts.push(''); }
  employees.forEach((e, i) => {
    parts.push(`## ${i + 1}. ${fullName(e)}`);
    parts.push(`ID: ${e.id ?? ''}`);
    if (e.email) parts.push(`Email: ${e.email}`);
    const position = refName(e.position);
    if (position) parts.push(`Position: ${position}`);
    const dept = refName(e.department);
    if (dept) parts.push(`Department: ${dept}`);
    if (typeof e.active === 'boolean') parts.push(`Status: ${e.active ? 'active' : 'inactive'}`);
    parts.push('');
  });
  return parts.join('\n').trimEnd();
}

export function formatEmployee(employee: PeopleForceEmployee): string {
  const parts = [`# ${fullName(employee)}`];
  if (employee.id !== undefined) parts.push(`ID: ${employee.id}`);
  if (employee.employee_number) parts.push(`Employee #: ${employee.employee_number}`);
  if (typeof employee.active === 'boolean') parts.push(`Status: ${employee.active ? 'active' : 'inactive'}`);
  if (employee.email) parts.push(`Email: ${employee.email}`);
  if (employee.personal_email) parts.push(`Personal email: ${employee.personal_email}`);
  if (employee.mobile_number) parts.push(`Mobile: ${employee.mobile_number}`);
  if (employee.work_phone_number) parts.push(`Work phone: ${employee.work_phone_number}`);
  const position = refName(employee.position);
  if (position) parts.push(`Position: ${position}`);
  const jobLevel = refName(employee.job_level);
  if (jobLevel) parts.push(`Job level: ${jobLevel}`);
  const dept = refName(employee.department);
  if (dept) parts.push(`Department: ${dept}`);
  const division = refName(employee.division);
  if (division) parts.push(`Division: ${division}`);
  const employment = refName(employee.employment_type);
  if (employment) parts.push(`Employment type: ${employment}`);
  const location = refName(employee.location);
  if (location) parts.push(`Location: ${location}`);
  const reportingTo = refName(employee.reporting_to);
  if (reportingTo) parts.push(`Reports to: ${reportingTo}`);
  if (employee.hired_on) parts.push(`Hired: ${employee.hired_on}`);
  if (employee.probation_ends_on) parts.push(`Probation ends: ${employee.probation_ends_on}`);
  if (employee.date_of_birth) parts.push(`Date of birth: ${employee.date_of_birth}`);
  return parts.join('\n');
}

export function formatDepartmentList(
  departments: PeopleForceDepartment[],
  pagination?: PeopleForcePagination,
): string {
  if (departments.length === 0) return 'No departments found.';
  const parts = ['# Departments', ''];
  const pag = renderPaginationLine(pagination);
  if (pag) { parts.push(pag); parts.push(''); }
  departments.forEach((d, i) => {
    parts.push(`## ${i + 1}. ${d.name ?? 'Untitled'}`);
    parts.push(`ID: ${d.id ?? ''}`);
    if (d.description) parts.push(`Description: ${d.description}`);
    if (typeof d.employees_count === 'number') parts.push(`Employees: ${d.employees_count}`);
    parts.push('');
  });
  return parts.join('\n').trimEnd();
}

export function formatLeaveRequestList(
  requests: PeopleForceLeaveRequest[],
  pagination?: PeopleForcePagination,
): string {
  if (requests.length === 0) return 'No leave requests found.';
  const parts = ['# Leave Requests', ''];
  const pag = renderPaginationLine(pagination);
  if (pag) { parts.push(pag); parts.push(''); }
  requests.forEach((r, i) => {
    const leaveType = r.leave_type ?? 'Leave';
    parts.push(`## ${i + 1}. ${fullName(r.employee ?? undefined)} — ${leaveType}`);
    parts.push(`ID: ${r.id ?? ''}`);
    if (r.employee_id) parts.push(`Employee ID: ${r.employee_id}`);
    if (r.starts_on) parts.push(`Starts: ${r.starts_on}`);
    if (r.ends_on) parts.push(`Ends: ${r.ends_on}`);
    if (r.state) parts.push(`State: ${r.state}`);
    if (r.amount) parts.push(`Amount: ${r.amount}${r.tracking_time_in ? ` (${r.tracking_time_in})` : ''}`);
    if (r.comment && r.comment !== '-') parts.push(`Comment: ${r.comment}`);
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
