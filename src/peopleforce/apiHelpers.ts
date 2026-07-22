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

// Recruitment lives on the v3 API, not v2 (verified against the developer portal
// on 2026-07-22: every /recruitment/* path is under /api/public/v3). The public
// Careers API (published job descriptions) is a separate namespace on the same
// host. Both use the same X-API-KEY / Bearer auth as v2.
const DEFAULT_RECRUITMENT_BASE_URL = 'https://app.peopleforce.io/api/public/v3';
const DEFAULT_CAREERS_BASE_URL = 'https://app.peopleforce.io/api/careers/v1';

/**
 * Derive the v3 recruitment base from the resolved v2 base by swapping the
 * version segment. Honors an explicit `PEOPLEFORCE_RECRUITMENT_BASE_URL`
 * override. The stored base is effectively always `.../api/public/v2` (the
 * per-connection base is not persisted), so the swap is safe; if a custom base
 * without the `/v2` marker is in play we fall back to the public v3 base rather
 * than guessing. Exported for unit tests.
 */
export function deriveRecruitmentBaseUrl(v2Base: string): string {
  const override = process.env.PEOPLEFORCE_RECRUITMENT_BASE_URL;
  if (override) return override.replace(/\/+$/, '');
  if (v2Base.includes('/api/public/v2')) {
    return v2Base.replace('/api/public/v2', '/api/public/v3');
  }
  return DEFAULT_RECRUITMENT_BASE_URL;
}

/**
 * Derive the Careers API base (`/api/careers/v1`) from the resolved base's
 * origin. Honors `PEOPLEFORCE_CAREERS_BASE_URL`. Exported for unit tests.
 */
export function deriveCareersBaseUrl(v2Base: string): string {
  const override = process.env.PEOPLEFORCE_CAREERS_BASE_URL;
  if (override) return override.replace(/\/+$/, '');
  try {
    return `${new URL(v2Base).origin}/api/careers/v1`;
  } catch {
    return DEFAULT_CAREERS_BASE_URL;
  }
}

/**
 * Query values accepted by the client. Arrays are serialized as repeated
 * bracketed keys (`skills[]=a&skills[]=b`), which is what the PeopleForce v3
 * filters expect. Literal bracket keys (`created_at[gte]`) pass through as-is.
 */
export type PeopleForceQueryValue = string | number | undefined | null | Array<string | number>;
export type PeopleForceQueryParams = Record<string, PeopleForceQueryValue>;

/** Append query params onto a URL, expanding arrays into repeated `key[]` entries. */
export function appendQueryParams(url: URL, query?: PeopleForceQueryParams): void {
  if (!query) return;
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      const key = k.endsWith('[]') ? k : `${k}[]`;
      for (const item of v) {
        if (item === undefined || item === null) continue;
        url.searchParams.append(key, String(item));
      }
    } else {
      url.searchParams.set(k, String(v));
    }
  }
}

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

// === Recruitment (v3) ===
// Response bodies for the v3 recruitment endpoints are not published (the portal
// renders them client-side), so these types are best-effort: they list the
// fields the docs/webhooks strongly imply, with alternates where the wire name
// is uncertain. The formatters render whatever is present and JSON-dump records
// they don't recognize, so nothing is silently dropped if a shape differs.

export type PeopleForceStage = {
  id?: number | string;
  name?: string;
  /** Alternate labels seen on the wire for the same concept. */
  title?: string;
  label?: string;
  /** e.g. "hired", "disqualified", "interview" — the terminal/kind marker. */
  kind?: string;
  position?: number;
};

export type PeopleForcePipeline = {
  id?: number | string;
  name?: string;
  stages?: PeopleForceStage[];
};

export type PeopleForceVacancy = {
  id?: number | string;
  title?: string;
  name?: string;
  status?: string;
  state?: string;
  description?: string;
  description_plain?: string;
  department?: PeopleForceRef | string;
  division?: PeopleForceRef | string;
  location?: PeopleForceRef | string;
  pipeline?: PeopleForcePipeline | null;
  stages?: PeopleForceStage[];
  /** Real v3 field; `candidates_count` kept as a legacy alias. */
  applications_count?: number;
  candidates_count?: number;
  created_at?: string;
};

export type PeopleForceCandidateRef = {
  id?: number | string;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
};

export type PeopleForceCandidate = {
  id?: number | string;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  /** v3 returns an array of phone strings; the scalar aliases are legacy fallbacks. */
  phone_numbers?: string[];
  phone?: string;
  phone_number?: string;
  location?: PeopleForceRef | string;
  source?: PeopleForceRef | string;
  /** v3 salary is `desired_salary` (+ `currency_code`); the *_expectation names are legacy. */
  desired_salary?: string | number;
  currency_code?: string;
  salary_expectation?: string | number;
  expected_salary?: string | number;
  skills?: Array<PeopleForceNamed | string> | string;
  stage?: PeopleForceStage | string;
  pipeline_stage?: PeopleForceStage | string;
  vacancy?: PeopleForceRef | string;
  disqualified?: boolean;
  created_at?: string;
  updated_at?: string;
};

export type PeopleForceApplication = {
  id?: number | string;
  candidate?: PeopleForceCandidateRef | null;
  candidate_id?: number | string;
  /** Some responses key the candidate as "applicant" instead of "candidate". */
  applicant?: PeopleForceCandidateRef | null;
  applicant_id?: number | string;
  vacancy?: PeopleForceRef | null;
  vacancy_id?: number | string;
  /** v3 current-stage field is `pipeline_state` {id,name}; the others are fallbacks. */
  pipeline_state?: PeopleForceStage | string;
  stage?: PeopleForceStage | string;
  pipeline_stage?: PeopleForceStage | string;
  applicant_state?: PeopleForceStage | string;
  state?: string;
  disqualified?: boolean;
  /** v3 marks disqualification with a timestamp rather than a boolean. */
  disqualified_at?: string | null;
  disqualify_reason?: PeopleForceRef | string;
  created_at?: string;
};

/** The candidate reference an application carries, under whichever key. */
function applicationCandidate(a: PeopleForceApplication): PeopleForceCandidateRef | null | undefined {
  return a.candidate ?? a.applicant;
}

/** The candidate id an application carries, under whichever key. */
function applicationCandidateId(a: PeopleForceApplication): number | string | undefined {
  return applicationCandidate(a)?.id ?? a.candidate_id ?? a.applicant_id;
}

export type PeopleForceCandidateNote = {
  id?: number | string;
  /** v3 note text field; body/text/content kept as legacy fallbacks. */
  comment?: string;
  body?: string;
  text?: string;
  content?: string;
  author?: PeopleForceRef | { full_name?: string } | string;
  created_by?: { full_name?: string } | null;
  created_at?: string;
};

export type PeopleForceCandidateExperience = {
  id?: number | string;
  company?: string;
  company_name?: string;
  position?: string;
  title?: string;
  starts_on?: string;
  ends_on?: string;
  description?: string;
};

export type PeopleForceCandidateEducation = {
  id?: number | string;
  /** v3 uses school/name/subject/from_year/to_year; the others are legacy fallbacks. */
  school?: string;
  name?: string;
  subject?: string;
  from_year?: number | string;
  to_year?: number | string;
  description?: string;
  institution?: string;
  degree?: string;
  field_of_study?: string;
  starts_on?: string;
  ends_on?: string;
};

/**
 * A pipeline movement as v3 returns it: the destination `stage`, the
 * `vacancy_application` it belongs to (carrying `applicant_id`/`vacancy_id`),
 * who moved it (`created_by`) and when (`entered_at`). The from/to/candidate
 * fields are legacy fallbacks kept for older/webhook shapes.
 */
export type PeopleForceMovement = {
  id?: number | string;
  vacancy_application?: { id?: number | string; applicant_id?: number | string; vacancy_id?: number | string } | null;
  stage?: PeopleForceStage | string;
  created_by?: { full_name?: string } | null;
  entered_at?: string;
  candidate?: PeopleForceCandidateRef | null;
  vacancy?: PeopleForceRef | null;
  from_stage?: PeopleForceStage | string;
  to_stage?: PeopleForceStage | string;
  moved_by?: { full_name?: string } | null;
  created_at?: string;
};

/** Composite payload assembled by {@link PeopleForceClient.getCandidateDossier}. */
export type PeopleForceCandidateDossier = {
  candidate?: PeopleForceCandidate;
  notes: PeopleForceCandidateNote[];
  experiences: PeopleForceCandidateExperience[];
  educations: PeopleForceCandidateEducation[];
  /** Present only when a vacancyId was supplied and a matching application was found. */
  application?: PeopleForceApplication;
  /** Human-readable notes about any sub-fetch that failed (dossier is best-effort). */
  errors: string[];
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
  /** v3 base for the Recruitment API (candidates, vacancies, applications). */
  public readonly recruitmentBaseUrl: string;
  /** Public Careers API base (published job descriptions). */
  public readonly careersBaseUrl: string;

  constructor(private token: string, baseUrl?: string) {
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.recruitmentBaseUrl = deriveRecruitmentBaseUrl(this.baseUrl);
    this.careersBaseUrl = deriveCareersBaseUrl(this.baseUrl);
  }

  private request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: PeopleForceQueryParams,
  ): Promise<T> {
    return this.requestAt<T>(this.baseUrl, method, path, body, query);
  }

  private async requestAt<T>(
    base: string,
    method: string,
    path: string,
    body?: unknown,
    query?: PeopleForceQueryParams,
  ): Promise<T> {
    const url = new URL(`${base}${path}`);
    appendQueryParams(url, query);
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

  // === Recruitment (v3) — vacancies ===

  listVacancies(input: {
    page?: number;
    status?: string[];
    tagIds?: Array<string | number>;
  } = {}): Promise<PeopleForceListResponse<PeopleForceVacancy>> {
    return this.requestAt(this.recruitmentBaseUrl, 'GET', '/recruitment/vacancies', undefined, {
      page: input.page,
      'status[]': input.status,
      'tag_ids[]': input.tagIds,
    });
  }

  getVacancy(id: string | number): Promise<{ data: PeopleForceVacancy }> {
    return this.requestAt(this.recruitmentBaseUrl, 'GET', `/recruitment/vacancies/${encodeURIComponent(String(id))}`);
  }

  listRecruitmentPipelines(input: { page?: number } = {}): Promise<PeopleForceListResponse<PeopleForcePipeline>> {
    return this.requestAt(this.recruitmentBaseUrl, 'GET', '/recruitment/pipelines', undefined, { page: input.page });
  }

  // === Recruitment (v3) — candidates ===

  listCandidates(input: {
    page?: number;
    pipelineStageId?: string | number;
    skills?: string[];
    vacancyIds?: Array<string | number>;
    email?: string;
    createdAtGte?: string;
    createdAtLte?: string;
    updatedAtGte?: string;
    updatedAtLte?: string;
  } = {}): Promise<PeopleForceListResponse<PeopleForceCandidate>> {
    return this.requestAt(this.recruitmentBaseUrl, 'GET', '/recruitment/candidates', undefined, {
      page: input.page,
      pipeline_stage_id: input.pipelineStageId,
      'skills[]': input.skills,
      'vacancy_ids[]': input.vacancyIds,
      email: input.email,
      'created_at[gte]': input.createdAtGte,
      'created_at[lte]': input.createdAtLte,
      'updated_at[gte]': input.updatedAtGte,
      'updated_at[lte]': input.updatedAtLte,
    });
  }

  getCandidate(id: string | number): Promise<{ data: PeopleForceCandidate }> {
    return this.requestAt(this.recruitmentBaseUrl, 'GET', `/recruitment/candidates/${encodeURIComponent(String(id))}`);
  }

  listCandidateNotes(candidateId: string | number): Promise<PeopleForceListResponse<PeopleForceCandidateNote>> {
    return this.requestAt(this.recruitmentBaseUrl, 'GET', `/recruitment/candidates/${encodeURIComponent(String(candidateId))}/notes`);
  }

  listCandidateExperiences(candidateId: string | number): Promise<PeopleForceListResponse<PeopleForceCandidateExperience>> {
    return this.requestAt(this.recruitmentBaseUrl, 'GET', `/recruitment/candidates/${encodeURIComponent(String(candidateId))}/experiences`);
  }

  listCandidateEducations(candidateId: string | number): Promise<PeopleForceListResponse<PeopleForceCandidateEducation>> {
    return this.requestAt(this.recruitmentBaseUrl, 'GET', `/recruitment/candidates/${encodeURIComponent(String(candidateId))}/educations`);
  }

  listCandidateMovements(input: { page?: number } = {}): Promise<PeopleForceListResponse<PeopleForceMovement>> {
    return this.requestAt(this.recruitmentBaseUrl, 'GET', '/recruitment/movements', undefined, { page: input.page });
  }

  // === Recruitment (v3) — applications ===

  listVacancyApplications(input: {
    vacancyId: string | number;
    page?: number;
  }): Promise<PeopleForceListResponse<PeopleForceApplication>> {
    return this.requestAt(
      this.recruitmentBaseUrl,
      'GET',
      `/recruitment/vacancies/${encodeURIComponent(String(input.vacancyId))}/applications`,
      undefined,
      { page: input.page },
    );
  }

  getVacancyApplication(input: {
    vacancyId: string | number;
    applicationId: string | number;
  }): Promise<{ data: PeopleForceApplication }> {
    return this.requestAt(
      this.recruitmentBaseUrl,
      'GET',
      `/recruitment/vacancies/${encodeURIComponent(String(input.vacancyId))}/applications/${encodeURIComponent(String(input.applicationId))}`,
    );
  }

  moveVacancyApplication(input: {
    vacancyId: string | number;
    applicationId: string | number;
    pipelineStageId: string | number;
    performAutomations?: boolean;
  }): Promise<{ data?: PeopleForceApplication }> {
    return this.requestAt(
      this.recruitmentBaseUrl,
      'PUT',
      `/recruitment/vacancies/${encodeURIComponent(String(input.vacancyId))}/applications/${encodeURIComponent(String(input.applicationId))}/move`,
      {
        pipeline_stage_id: input.pipelineStageId,
        perform_automations: input.performAutomations,
      },
    );
  }

  disqualifyVacancyApplication(input: {
    vacancyId: string | number;
    applicationId: string | number;
    disqualifyReasonId: string | number;
    comment?: string;
  }): Promise<{ data?: PeopleForceApplication }> {
    return this.requestAt(
      this.recruitmentBaseUrl,
      'POST',
      `/recruitment/vacancies/${encodeURIComponent(String(input.vacancyId))}/applications/${encodeURIComponent(String(input.applicationId))}/disqualify`,
      {
        disqualify_reason_id: input.disqualifyReasonId,
        comment: input.comment,
      },
    );
  }

  // === Recruitment (v3) — support / lookups ===

  listDisqualifyReasons(input: { page?: number } = {}): Promise<PeopleForceListResponse<PeopleForceNamed>> {
    return this.requestAt(this.recruitmentBaseUrl, 'GET', '/recruitment/disqualify_reasons', undefined, { page: input.page });
  }

  listRecruitmentSources(input: { page?: number } = {}): Promise<PeopleForceListResponse<PeopleForceNamed>> {
    return this.requestAt(this.recruitmentBaseUrl, 'GET', '/recruitment/sources', undefined, { page: input.page });
  }

  addCandidateNote(input: {
    candidateId: string | number;
    body: string;
  }): Promise<{ data?: PeopleForceCandidateNote }> {
    return this.requestAt(
      this.recruitmentBaseUrl,
      'POST',
      `/recruitment/candidates/${encodeURIComponent(String(input.candidateId))}/notes`,
      { comment: input.body },
    );
  }

  // === Careers API — published job descriptions ===

  getPublishedVacancy(id: string | number): Promise<{ data?: PeopleForceVacancy } | PeopleForceVacancy> {
    return this.requestAt(this.careersBaseUrl, 'GET', `/vacancies/${encodeURIComponent(String(id))}`);
  }

  /**
   * Assemble a candidate dossier for AI assessment: profile + notes +
   * experiences + educations, plus the matching application/stage when a
   * vacancyId is supplied. Best-effort — a failing sub-fetch is recorded in
   * `errors` rather than sinking the whole call, so a partial dossier still
   * reaches the assessor.
   */
  async getCandidateDossier(input: {
    candidateId: string | number;
    vacancyId?: string | number;
  }): Promise<PeopleForceCandidateDossier> {
    const errors: string[] = [];
    const [candidateRes, notesRes, experiencesRes, educationsRes] = await Promise.allSettled([
      this.getCandidate(input.candidateId),
      this.listCandidateNotes(input.candidateId),
      this.listCandidateExperiences(input.candidateId),
      this.listCandidateEducations(input.candidateId),
    ]);

    const candidate =
      candidateRes.status === 'fulfilled' ? candidateRes.value?.data : (errors.push('profile'), undefined);
    const notes = notesRes.status === 'fulfilled' ? notesRes.value?.data ?? [] : (errors.push('notes'), []);
    const experiences =
      experiencesRes.status === 'fulfilled' ? experiencesRes.value?.data ?? [] : (errors.push('experiences'), []);
    const educations =
      educationsRes.status === 'fulfilled' ? educationsRes.value?.data ?? [] : (errors.push('educations'), []);

    let application: PeopleForceApplication | undefined;
    if (input.vacancyId !== undefined) {
      try {
        const apps = await this.listVacancyApplications({ vacancyId: input.vacancyId });
        const wanted = String(input.candidateId);
        application = (apps.data ?? []).find((a) => String(applicationCandidateId(a) ?? '') === wanted);
        if (!application) errors.push('application (no match on vacancy page 1)');
      } catch {
        errors.push('application');
      }
    }

    return { candidate, notes, experiences, educations, application, errors };
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

/**
 * Compose an empty-list message that still surfaces pagination context when
 * present. Useful signal to the LLM that it paged past the last page rather
 * than the workspace actually being empty.
 */
function renderEmptyList(title: string, noun: string, pagination?: PeopleForcePagination): string {
  const pag = renderPaginationLine(pagination);
  if (!pag) return `No ${noun} found.`;
  return [`# ${title}`, '', pag, '', `No ${noun} on this page.`].join('\n');
}

export function formatEmployeeList(
  employees: PeopleForceEmployee[],
  pagination?: PeopleForcePagination,
): string {
  if (employees.length === 0) return renderEmptyList('Employees', 'employees', pagination);
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
  if (departments.length === 0) return renderEmptyList('Departments', 'departments', pagination);
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
  if (requests.length === 0) return renderEmptyList('Leave Requests', 'leave requests', pagination);
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
  const noun = title.toLowerCase();
  if (items.length === 0) return renderEmptyList(title, noun, pagination);
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
    // Don't collapse an omitted balance to 0 — "unknown" and "zero days left"
    // are very different signals for an HR consumer.
    parts.push(`Balance: ${b.balance !== undefined ? `${b.balance}${unit}` : 'unknown'}`);
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
  if (tasks.length === 0) return renderEmptyList('Tasks', 'tasks', pagination);
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
    // Only report yes/no when we actually have a boolean; otherwise say so
    // explicitly rather than false-reporting missing state as "no".
    const completedText = typeof t.completed === 'boolean' ? (t.completed ? 'yes' : 'no') : 'unknown';
    parts.push(`Completed: ${completedText}${t.completed_at ? ` (${t.completed_at})` : ''}`);
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

// ==== Recruitment formatters ====

function stageName(stage: PeopleForceStage | string | undefined | null): string | undefined {
  if (!stage) return undefined;
  if (typeof stage === 'string') return stage;
  return stage.name ?? stage.title ?? stage.label;
}

function formatSkillsInline(skills: PeopleForceCandidate['skills']): string | undefined {
  if (!skills) return undefined;
  if (typeof skills === 'string') return skills || undefined;
  if (Array.isArray(skills)) {
    const names = skills
      .map((s) => (typeof s === 'string' ? s : s?.name))
      .filter((s): s is string => Boolean(s));
    return names.length ? names.join(', ') : undefined;
  }
  return undefined;
}

function datePeriod(startsOn?: string, endsOn?: string): string | undefined {
  if (!startsOn && !endsOn) return undefined;
  return `${startsOn ?? '?'} – ${endsOn ?? 'present'}`;
}

/** Fenced JSON dump — last-resort so an unrecognized record's fields aren't lost. */
function jsonBlock(value: unknown): string[] {
  return ['```json', JSON.stringify(value, null, 2), '```'];
}

export function formatVacancyList(vacancies: PeopleForceVacancy[], pagination?: PeopleForcePagination): string {
  if (vacancies.length === 0) return renderEmptyList('Vacancies', 'vacancies', pagination);
  const parts = ['# Vacancies', ''];
  const pag = renderPaginationLine(pagination);
  if (pag) { parts.push(pag); parts.push(''); }
  vacancies.forEach((v, i) => {
    parts.push(`## ${i + 1}. ${v.title ?? v.name ?? 'Untitled vacancy'}`);
    parts.push(`ID: ${v.id ?? ''}`);
    const status = v.status ?? v.state;
    if (status) parts.push(`Status: ${status}`);
    const dept = refName(v.department);
    if (dept) parts.push(`Department: ${dept}`);
    const loc = refName(v.location);
    if (loc) parts.push(`Location: ${loc}`);
    const applicantCount = v.applications_count ?? v.candidates_count;
    if (typeof applicantCount === 'number') parts.push(`Candidates: ${applicantCount}`);
    parts.push('');
  });
  return parts.join('\n').trimEnd();
}

export function formatVacancy(v: PeopleForceVacancy): string {
  const parts = [`# ${v.title ?? v.name ?? 'Untitled vacancy'}`];
  if (v.id !== undefined) parts.push(`ID: ${v.id}`);
  const status = v.status ?? v.state;
  if (status) parts.push(`Status: ${status}`);
  const dept = refName(v.department);
  if (dept) parts.push(`Department: ${dept}`);
  const division = refName(v.division);
  if (division) parts.push(`Division: ${division}`);
  const loc = refName(v.location);
  if (loc) parts.push(`Location: ${loc}`);
  const stages = v.pipeline?.stages ?? v.stages;
  if (stages && stages.length) {
    const names = stages.map((s) => stageName(s)).filter(Boolean);
    if (names.length) parts.push(`Pipeline stages: ${names.join(' → ')}`);
  }
  const applicantCount = v.applications_count ?? v.candidates_count;
  if (typeof applicantCount === 'number') parts.push(`Candidates: ${applicantCount}`);
  if (v.created_at) parts.push(`Created: ${v.created_at}`);
  const description = v.description_plain ?? v.description;
  if (description) {
    parts.push('');
    parts.push('## Description');
    parts.push(description);
  }
  return parts.join('\n');
}

export function formatPipelineList(pipelines: PeopleForcePipeline[], pagination?: PeopleForcePagination): string {
  if (pipelines.length === 0) return renderEmptyList('Recruitment Pipelines', 'pipelines', pagination);
  const parts = ['# Recruitment Pipelines', ''];
  const pag = renderPaginationLine(pagination);
  if (pag) { parts.push(pag); parts.push(''); }
  pipelines.forEach((p, i) => {
    parts.push(`## ${i + 1}. ${p.name ?? 'Untitled pipeline'}`);
    parts.push(`ID: ${p.id ?? ''}`);
    if (p.stages && p.stages.length) {
      const stageLines = p.stages.map((s) => {
        const n = stageName(s) ?? 'Stage';
        return s.id !== undefined ? `${n} (ID: ${s.id})` : n;
      });
      parts.push(`Stages: ${stageLines.join(' → ')}`);
    }
    parts.push('');
  });
  return parts.join('\n').trimEnd();
}

export function formatCandidateList(candidates: PeopleForceCandidate[], pagination?: PeopleForcePagination): string {
  if (candidates.length === 0) return renderEmptyList('Candidates', 'candidates', pagination);
  const parts = ['# Candidates', ''];
  const pag = renderPaginationLine(pagination);
  if (pag) { parts.push(pag); parts.push(''); }
  candidates.forEach((c, i) => {
    parts.push(`## ${i + 1}. ${fullName(c)}`);
    parts.push(`ID: ${c.id ?? ''}`);
    if (c.email) parts.push(`Email: ${c.email}`);
    const stage = stageName(c.pipeline_stage ?? c.stage);
    if (stage) parts.push(`Stage: ${stage}`);
    const vacancy = refName(c.vacancy);
    if (vacancy) parts.push(`Vacancy: ${vacancy}`);
    parts.push('');
  });
  return parts.join('\n').trimEnd();
}

export function formatCandidate(c: PeopleForceCandidate): string {
  const parts = [`# ${fullName(c)}`];
  if (c.id !== undefined) parts.push(`ID: ${c.id}`);
  if (c.email) parts.push(`Email: ${c.email}`);
  const phone =
    (Array.isArray(c.phone_numbers) && c.phone_numbers.filter(Boolean).join(', ')) || c.phone || c.phone_number;
  if (phone) parts.push(`Phone: ${phone}`);
  const location = refName(c.location);
  if (location) parts.push(`Location: ${location}`);
  const source = refName(c.source);
  if (source) parts.push(`Source: ${source}`);
  const salary = c.desired_salary ?? c.salary_expectation ?? c.expected_salary;
  if (salary !== undefined && salary !== null && salary !== '') {
    parts.push(`Salary expectation: ${salary}${c.currency_code ? ` ${c.currency_code}` : ''}`);
  }
  const stage = stageName(c.pipeline_stage ?? c.stage);
  if (stage) parts.push(`Pipeline stage: ${stage}`);
  const vacancy = refName(c.vacancy);
  if (vacancy) parts.push(`Vacancy: ${vacancy}`);
  const skills = formatSkillsInline(c.skills);
  if (skills) parts.push(`Skills: ${skills}`);
  if (typeof c.disqualified === 'boolean') parts.push(`Disqualified: ${c.disqualified ? 'yes' : 'no'}`);
  if (c.created_at) parts.push(`Created: ${c.created_at}`);
  if (c.updated_at) parts.push(`Updated: ${c.updated_at}`);
  return parts.join('\n');
}

export function formatApplicationList(applications: PeopleForceApplication[], pagination?: PeopleForcePagination): string {
  if (applications.length === 0) return renderEmptyList('Vacancy Applications', 'applications', pagination);
  const parts = ['# Vacancy Applications', ''];
  const pag = renderPaginationLine(pagination);
  if (pag) { parts.push(pag); parts.push(''); }
  applications.forEach((a, i) => {
    const candidate = applicationCandidate(a);
    const name = fullName(candidate);
    parts.push(`## ${i + 1}. ${name}`);
    parts.push(`Application ID: ${a.id ?? ''}`);
    const candidateId = applicationCandidateId(a);
    if (candidateId !== undefined) parts.push(`Candidate ID: ${candidateId}`);
    const stage = stageName(a.pipeline_state ?? a.pipeline_stage ?? a.stage ?? a.applicant_state);
    if (stage) parts.push(`Stage: ${stage}`);
    else if (a.state) parts.push(`State: ${a.state}`);
    // v3 flags disqualification with a timestamp, not a boolean.
    const disqualified =
      typeof a.disqualified === 'boolean' ? a.disqualified : a.disqualified_at ? true : undefined;
    if (disqualified !== undefined) parts.push(`Disqualified: ${disqualified ? 'yes' : 'no'}`);
    const reason = refName(a.disqualify_reason);
    if (reason) parts.push(`Disqualify reason: ${reason}`);
    // If the record didn't yield a candidate name or a stage, the wire shape
    // differs from what we know — dump it verbatim so no field is lost (the
    // PeopleForce v3 application schema is not published).
    if (name === 'Unknown' && candidateId === undefined && !stage) {
      parts.push(...jsonBlock(a));
    }
    parts.push('');
  });
  return parts.join('\n').trimEnd();
}

function noteAuthor(n: PeopleForceCandidateNote): string | undefined {
  if (n.created_by?.full_name) return n.created_by.full_name;
  const a = n.author;
  if (!a) return undefined;
  if (typeof a === 'string') return a || undefined;
  const rec = a as { full_name?: string; name?: string };
  return rec.full_name ?? rec.name ?? undefined;
}

export function formatCandidateNotes(notes: PeopleForceCandidateNote[]): string {
  if (notes.length === 0) return 'No notes recorded for this candidate.';
  const parts = ['# Candidate Notes', ''];
  notes.forEach((n, i) => {
    const author = noteAuthor(n);
    parts.push(`## ${i + 1}. ${author ?? `Note ${i + 1}`}${n.created_at ? ` — ${n.created_at}` : ''}`);
    const text = n.comment ?? n.body ?? n.text ?? n.content;
    if (text) parts.push(text);
    else parts.push(...jsonBlock(n));
    parts.push('');
  });
  return parts.join('\n').trimEnd();
}

export function formatCandidateExperiences(experiences: PeopleForceCandidateExperience[]): string {
  if (experiences.length === 0) return 'No work experience recorded for this candidate.';
  const parts = ['# Candidate Experience', ''];
  experiences.forEach((e, i) => {
    const role = e.position ?? e.title;
    const company = e.company ?? e.company_name;
    const heading = [role, company].filter(Boolean).join(' @ ') || `Experience ${i + 1}`;
    parts.push(`## ${i + 1}. ${heading}`);
    const period = datePeriod(e.starts_on, e.ends_on);
    if (period) parts.push(period);
    if (e.description) parts.push(e.description);
    if (!role && !company && !period && !e.description) parts.push(...jsonBlock(e));
    parts.push('');
  });
  return parts.join('\n').trimEnd();
}

export function formatCandidateEducations(educations: PeopleForceCandidateEducation[]): string {
  if (educations.length === 0) return 'No education recorded for this candidate.';
  const parts = ['# Candidate Education', ''];
  educations.forEach((e, i) => {
    const inst = e.school ?? e.institution;
    // v3: `name` is the degree/qualification, `subject` the field of study.
    const degree = [e.degree ?? e.name, e.field_of_study ?? e.subject].filter(Boolean).join(', ');
    const heading = [degree, inst].filter(Boolean).join(' @ ') || `Education ${i + 1}`;
    parts.push(`## ${i + 1}. ${heading}`);
    // v3 gives from_year/to_year; fall back to full dates when present.
    const period =
      datePeriod(e.starts_on, e.ends_on) ??
      (e.from_year || e.to_year ? `${e.from_year ?? '?'} – ${e.to_year ?? 'present'}` : undefined);
    if (period) parts.push(period);
    if (e.description) parts.push(e.description);
    if (!inst && !degree && !period && !e.description) parts.push(...jsonBlock(e));
    parts.push('');
  });
  return parts.join('\n').trimEnd();
}

export function formatMovementList(movements: PeopleForceMovement[], pagination?: PeopleForcePagination): string {
  if (movements.length === 0) return renderEmptyList('Candidate Movements', 'movements', pagination);
  const parts = ['# Candidate Movements', ''];
  const pag = renderPaginationLine(pagination);
  if (pag) { parts.push(pag); parts.push(''); }
  movements.forEach((m, i) => {
    // v3 gives the destination `stage` plus a `vacancy_application` ref (no
    // candidate name); fall back to the legacy candidate/from→to shape.
    const applicantId = m.vacancy_application?.applicant_id;
    const who = m.candidate ? fullName(m.candidate) : applicantId !== undefined ? `Applicant ${applicantId}` : 'Applicant';
    const to = stageName(m.stage ?? m.to_stage);
    const from = stageName(m.from_stage);
    const transition = from ? `${from} → ${to ?? '?'}` : (to ?? '?');
    parts.push(`## ${i + 1}. ${who}: ${transition}`);
    if (m.id !== undefined) parts.push(`ID: ${m.id}`);
    const vacancyId = m.vacancy_application?.vacancy_id;
    if (vacancyId !== undefined) parts.push(`Vacancy ID: ${vacancyId}`);
    else {
      const vacancy = refName(m.vacancy);
      if (vacancy) parts.push(`Vacancy: ${vacancy}`);
    }
    const applicationId = m.vacancy_application?.id;
    if (applicationId !== undefined) parts.push(`Application ID: ${applicationId}`);
    const movedBy = m.created_by?.full_name ?? m.moved_by?.full_name;
    if (movedBy) parts.push(`Moved by: ${movedBy}`);
    const when = m.entered_at ?? m.created_at;
    if (when) parts.push(`When: ${when}`);
    parts.push('');
  });
  return parts.join('\n').trimEnd();
}

export function formatPublishedVacancy(payload: { data?: PeopleForceVacancy } | PeopleForceVacancy): string {
  const v = (payload && typeof payload === 'object' && 'data' in payload && payload.data
    ? payload.data
    : payload) as PeopleForceVacancy;
  if (!v || typeof v !== 'object' || Object.keys(v).length === 0) return 'No published job description found.';
  const parts = [`# ${v.title ?? v.name ?? 'Job description'}`];
  if (v.id !== undefined) parts.push(`ID: ${v.id}`);
  const loc = refName(v.location);
  if (loc) parts.push(`Location: ${loc}`);
  const dept = refName(v.department);
  if (dept) parts.push(`Department: ${dept}`);
  const description = v.description_plain ?? v.description;
  if (description) {
    parts.push('');
    parts.push('## Description');
    parts.push(description);
  } else {
    parts.push('');
    parts.push(...jsonBlock(v));
  }
  return parts.join('\n');
}

export function formatCandidateDossier(dossier: PeopleForceCandidateDossier): string {
  const parts: string[] = [];
  parts.push(dossier.candidate ? formatCandidate(dossier.candidate) : '# Candidate\n(profile unavailable)');
  if (dossier.application) {
    parts.push('');
    parts.push('## Current Application');
    if (dossier.application.id !== undefined) parts.push(`Application ID: ${dossier.application.id}`);
    const stage = stageName(
      dossier.application.pipeline_stage ?? dossier.application.stage ?? dossier.application.applicant_state,
    );
    if (stage) parts.push(`Stage: ${stage}`);
    if (typeof dossier.application.disqualified === 'boolean') {
      parts.push(`Disqualified: ${dossier.application.disqualified ? 'yes' : 'no'}`);
    }
  }
  parts.push('', '---', formatCandidateNotes(dossier.notes));
  parts.push('', '---', formatCandidateExperiences(dossier.experiences));
  parts.push('', '---', formatCandidateEducations(dossier.educations));
  if (dossier.errors.length) {
    parts.push('', `_Note: could not load ${dossier.errors.join(', ')}._`);
  }
  return parts.join('\n');
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
