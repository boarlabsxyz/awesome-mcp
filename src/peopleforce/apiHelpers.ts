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

export type PeopleForceNamed = {
  id?: number | string;
  name?: string;
};

export type PeopleForceLeaveType = {
  id?: number | string;
  name?: string;
  /** "hours" or "days". */
  unit?: string;
  hex_color?: string;
};

export type PeopleForceLocation = {
  id?: number | string;
  name?: string;
  country_code?: string;
  address?: string;
  time_zone?: string;
  holiday_policy_id?: number | string | null;
};

export type PeopleForceLeaveBalance = {
  id?: number | string;
  effective_on?: string;
  /** Numeric balance in the leave_type.unit (hours or days). */
  balance?: number;
  leave_type?: PeopleForceLeaveType | null;
  leave_type_policy?: { id?: number | string; name?: string } | null;
};

export type PeopleForceEmployeeSkill = {
  id?: number | string;
  /** "beginner" | "intermediate" | "proficient" | "expert" | etc. */
  level?: string;
  skill?: PeopleForceNamed | null;
};

export type PeopleForceTask = {
  id?: number | string;
  title?: string;
  type?: string;
  starts_on?: string | null;
  ends_on?: string | null;
  completed_at?: string | null;
  completed?: boolean;
  description_plain?: string | null;
  associated_to?: { id?: number | string; type?: string; full_name?: string; email?: string } | null;
  assigned_to?: { id?: number | string; full_name?: string; email?: string } | null;
  created_by?: { id?: number | string; full_name?: string; email?: string } | null;
};

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

  getLeaveRequest(id: string | number): Promise<{ data: PeopleForceLeaveRequest }> {
    return this.request('GET', `/leave_requests/${encodeURIComponent(String(id))}`);
  }

  // === Reference / lookup data ===

  listLeaveTypes(input: { page?: number } = {}): Promise<PeopleForceListResponse<PeopleForceLeaveType>> {
    return this.request('GET', '/leave_types', undefined, { page: input.page });
  }

  listPositions(input: { page?: number } = {}): Promise<PeopleForceListResponse<PeopleForceNamed>> {
    return this.request('GET', '/positions', undefined, { page: input.page });
  }

  listDivisions(input: { page?: number } = {}): Promise<PeopleForceListResponse<PeopleForceNamed>> {
    return this.request('GET', '/divisions', undefined, { page: input.page });
  }

  listLocations(input: { page?: number } = {}): Promise<PeopleForceListResponse<PeopleForceLocation>> {
    return this.request('GET', '/locations', undefined, { page: input.page });
  }

  listEmploymentTypes(input: { page?: number } = {}): Promise<PeopleForceListResponse<PeopleForceNamed>> {
    return this.request('GET', '/employment_types', undefined, { page: input.page });
  }

  listJobLevels(input: { page?: number } = {}): Promise<PeopleForceListResponse<PeopleForceNamed>> {
    return this.request('GET', '/job_levels', undefined, { page: input.page });
  }

  listSkills(input: { page?: number } = {}): Promise<PeopleForceListResponse<PeopleForceNamed>> {
    return this.request('GET', '/skills', undefined, { page: input.page });
  }

  listCompetencies(input: { page?: number } = {}): Promise<PeopleForceListResponse<PeopleForceNamed>> {
    return this.request('GET', '/competencies', undefined, { page: input.page });
  }

  listTasks(input: { page?: number } = {}): Promise<PeopleForceListResponse<PeopleForceTask>> {
    return this.request('GET', '/tasks', undefined, { page: input.page });
  }

  // === Employee-nested ===

  listEmployeeLeaveBalances(employeeId: string | number): Promise<PeopleForceListResponse<PeopleForceLeaveBalance>> {
    return this.request('GET', `/employees/${encodeURIComponent(String(employeeId))}/leave_balances`);
  }

  listEmployeeSkills(employeeId: string | number): Promise<PeopleForceListResponse<PeopleForceEmployeeSkill>> {
    return this.request('GET', `/employees/${encodeURIComponent(String(employeeId))}/skills`);
  }

  /**
   * Employee-scoped list endpoints whose payload shape isn't documented and
   * that returned zero rows on the reference workspace we probed. We forward
   * the response as `unknown[]` so the tool layer can dump the JSON verbatim
   * without inventing a schema — safer than guessing keys the API might not
   * emit.
   */
  listEmployeeDocuments(employeeId: string | number): Promise<PeopleForceListResponse<Record<string, unknown>>> {
    return this.request('GET', `/employees/${encodeURIComponent(String(employeeId))}/documents`);
  }

  listEmployeeNotes(employeeId: string | number): Promise<PeopleForceListResponse<Record<string, unknown>>> {
    return this.request('GET', `/employees/${encodeURIComponent(String(employeeId))}/notes`);
  }

  listEmployeeEmergencyContacts(employeeId: string | number): Promise<PeopleForceListResponse<Record<string, unknown>>> {
    return this.request('GET', `/employees/${encodeURIComponent(String(employeeId))}/emergency_contacts`);
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

/**
 * Generic formatter for `{ id, name }` reference lookups (leave_types,
 * positions, divisions, employment_types, job_levels, skills, competencies).
 * Optional `extras` picks additional per-item lines out of arbitrary keys
 * without forcing each caller to write a dedicated formatter.
 */
export function formatNamedList(
  title: string,
  items: PeopleForceNamed[],
  pagination?: PeopleForcePagination,
  extras?: (item: PeopleForceNamed) => string[],
): string {
  if (items.length === 0) return `No ${title.toLowerCase()} found.`;
  const parts = [`# ${title}`, ''];
  const pag = renderPaginationLine(pagination);
  if (pag) { parts.push(pag); parts.push(''); }
  items.forEach((item, i) => {
    parts.push(`## ${i + 1}. ${item.name ?? 'Untitled'}`);
    parts.push(`ID: ${item.id ?? ''}`);
    if (extras) for (const line of extras(item)) parts.push(line);
    parts.push('');
  });
  return parts.join('\n').trimEnd();
}

export function formatLeaveTypeList(
  types: PeopleForceLeaveType[],
  pagination?: PeopleForcePagination,
): string {
  return formatNamedList('Leave Types', types, pagination, (t) => {
    const lt = t as PeopleForceLeaveType;
    return lt.unit ? [`Unit: ${lt.unit}`] : [];
  });
}

export function formatLocationList(
  locations: PeopleForceLocation[],
  pagination?: PeopleForcePagination,
): string {
  return formatNamedList('Locations', locations, pagination, (item) => {
    const loc = item as PeopleForceLocation;
    const lines: string[] = [];
    if (loc.country_code) lines.push(`Country: ${loc.country_code}`);
    if (loc.time_zone) lines.push(`Time zone: ${loc.time_zone}`);
    if (loc.address) lines.push(`Address: ${loc.address}`);
    return lines;
  });
}

export function formatLeaveBalances(balances: PeopleForceLeaveBalance[]): string {
  if (balances.length === 0) return 'No leave balances found.';
  const parts = ['# Leave Balances', ''];
  balances.forEach((b, i) => {
    const name = b.leave_type?.name ?? b.leave_type_policy?.name ?? 'Balance';
    const unit = b.leave_type?.unit ? ` ${b.leave_type.unit}` : '';
    parts.push(`## ${i + 1}. ${name}`);
    parts.push(`Balance: ${b.balance ?? 0}${unit}`);
    if (b.effective_on) parts.push(`Effective on: ${b.effective_on}`);
    if (b.leave_type?.id !== undefined) parts.push(`Leave type ID: ${b.leave_type.id}`);
    parts.push('');
  });
  return parts.join('\n').trimEnd();
}

export function formatEmployeeSkills(skills: PeopleForceEmployeeSkill[]): string {
  if (skills.length === 0) return 'No skills recorded for this employee.';
  const parts = ['# Employee Skills', ''];
  skills.forEach((s, i) => {
    const name = s.skill?.name ?? 'Unknown skill';
    parts.push(`## ${i + 1}. ${name}`);
    if (s.level) parts.push(`Level: ${s.level}`);
    if (s.skill?.id !== undefined) parts.push(`Skill ID: ${s.skill.id}`);
    parts.push('');
  });
  return parts.join('\n').trimEnd();
}

export function formatTaskList(
  tasks: PeopleForceTask[],
  pagination?: PeopleForcePagination,
): string {
  if (tasks.length === 0) return 'No tasks found.';
  const parts = ['# Tasks', ''];
  const pag = renderPaginationLine(pagination);
  if (pag) { parts.push(pag); parts.push(''); }
  tasks.forEach((t, i) => {
    const assignee = t.assigned_to?.full_name ?? 'Unassigned';
    parts.push(`## ${i + 1}. ${t.title ?? 'Untitled'} — ${assignee}`);
    parts.push(`ID: ${t.id ?? ''}`);
    if (t.type) parts.push(`Type: ${t.type}`);
    if (t.starts_on) parts.push(`Starts: ${t.starts_on}`);
    if (t.ends_on) parts.push(`Ends: ${t.ends_on}`);
    parts.push(`Completed: ${t.completed ? 'yes' : 'no'}${t.completed_at ? ` (${t.completed_at})` : ''}`);
    if (t.associated_to?.full_name) parts.push(`Associated with: ${t.associated_to.full_name} (${t.associated_to.type ?? 'entity'})`);
    if (t.description_plain) parts.push(`Description: ${t.description_plain}`);
    parts.push('');
  });
  return parts.join('\n').trimEnd();
}

/**
 * Fallback formatter for endpoints whose payload shape is undocumented and
 * that we couldn't verify against the reference workspace (returned 0 items).
 * Dumps each record as fenced JSON so no field is silently dropped.
 */
export function formatUnknownItemList(title: string, items: Record<string, unknown>[]): string {
  if (items.length === 0) return `No ${title.toLowerCase()} recorded.`;
  const parts = [`# ${title}`, ''];
  items.forEach((it, i) => {
    parts.push(`## ${i + 1}. ${it.id !== undefined ? `ID: ${it.id}` : 'Item'}`);
    parts.push('```json');
    parts.push(JSON.stringify(it, null, 2));
    parts.push('```');
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
