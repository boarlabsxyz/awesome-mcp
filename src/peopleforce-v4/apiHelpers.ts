// src/peopleforce-v4/apiHelpers.ts
// HTTP client + formatters for the PeopleForce Company API **v4**
// (https://developer.peopleforce.io/company/v4).
//
// This is a sibling of src/peopleforce/apiHelpers.ts, not a replacement, and
// the split is forced by PeopleForce rather than chosen:
//
//   - v4 authenticates with a **service account** API key and nothing else.
//     "a service account API key only works against v4 - you can't use it to
//     access v3, v2 or v1 APIs", and v4 in turn rejects Company and Career
//     keys. One connection cannot serve both surfaces, so the two connectors
//     hold different credentials and never share a session field.
//   - The resources are renamed: people, not employees (`/api/v4/employees` is
//     a 404, verified live 2026-09-17).
//   - The pagination envelope changed shape (see {@link V4Pagination}).
//   - v4 covers a *subset* of v3 — no recruitment, leave, knowledge base,
//     skills, KPIs or employee custom tables — while adding termination data,
//     surveys, review cycles and compliance cases that v3 never exposed.
//
// Everything a caller can get wrong here comes from one property of v4: the
// service account's ROLE, not the key, decides what exists. A record outside
// the role's population is omitted from a 200 (not denied), and a field the
// role does not grant is absent from the JSON (not null). Both failure modes
// read as "the data isn't there", which is why the formatters below go out of
// their way to say "we were not shown this" instead of rendering a silent gap.

import { UserError } from 'fastmcp';
import { UserSession } from '../userSession.js';
import { appendQueryParams, type PeopleForceQueryParams } from '../peopleforce/apiHelpers.js';

/** v4 lives on its own version segment — NOT under /api/public/ like v1–v3. */
const DEFAULT_BASE_URL = 'https://app.peopleforce.io/api/v4';

/** Resolve the effective v4 base URL for a connection. Exported for tests. */
export function resolveV4BaseUrl(baseUrl?: string): string {
  return (baseUrl?.trim() || process.env.PEOPLEFORCE_V4_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/**
 * v4's pagination envelope. The field names all changed from v1–v3:
 * `pages` → `total_pages`, `count` → `total_count`, `items` → `per_page`
 * (and `items` counted the CURRENT page while `per_page` is the requested
 * page size). Reading a v3 name off a v4 payload yields `undefined`, which
 * renders as a missing total rather than an error — hence the explicit type.
 */
export type V4Pagination = {
  page?: number;
  per_page?: number;
  total_pages?: number;
  total_count?: number;
};

export type V4ListResponse<T> = {
  data?: T[];
  metadata?: V4Pagination;
};

/** v4's "Association model" — every embedded reference is `{id, name}`. */
export type V4Ref = { id?: number; name?: string } | null;

export type V4Person = {
  id?: number;
  status?: string;
  access?: string;
  employee_number?: string;
  full_name?: string;
  first_name?: string;
  middle_name?: string;
  last_name?: string;
  avatar_url?: string;
  email?: string;
  personal_email?: string;
  work_phone_number?: string;
  mobile_number?: string;
  date_of_birth?: string;
  probation_ends_on?: string;
  hired_on?: string;
  gender?: V4Ref;
  position?: V4Ref;
  job_level?: V4Ref;
  location?: V4Ref;
  employment_type?: V4Ref;
  division?: V4Ref;
  department?: V4Ref;
  reporting_to?: { id?: number; first_name?: string; last_name?: string; email?: string; type?: string } | null;
  job_profile?: V4Ref;
  legal_entity?: V4Ref;
  created_at?: string;
  updated_at?: string;
  /** Present only on terminated people (and only if the role grants Job data). */
  termination_effective_on?: string;
  termination_comment?: string;
  termination_eligible_for_rehire?: string;
  termination_type?: V4Ref;
  termination_reason?: V4Ref;
  fields?: unknown;
};

export type V4Named = { id?: number; name?: string };

export type V4Department = V4Named & {
  parent_id?: number | null;
  manager_id?: number | null;
  created_at?: string;
  updated_at?: string;
  fields?: unknown;
};

export type V4Location = V4Named & {
  country_code?: string;
  address?: string;
  time_zone?: string;
  holiday_policy_id?: number | null;
  created_at?: string;
  updated_at?: string;
};

export type V4Salary = {
  id?: number;
  effective_on?: string;
  amount?: number;
  currency_code?: string;
  per?: string;
  comment?: string;
  created_at?: string;
  updated_at?: string;
  custom_fields?: Record<string, unknown>;
};

export type V4Lifecycle = {
  id?: number;
  start_date?: string;
  experience_before_hire?: number;
  last_working_day?: string;
  last_day_in_office?: string;
  termination_type?: V4Ref;
  termination_reason?: V4Ref;
  termination_comment?: string;
  eligible_for_rehire?: boolean;
  created_at?: string;
  updated_at?: string;
};

export type V4KeyResult = {
  id?: number;
  name?: string;
  progress_percentage?: number;
  value?: number;
  start?: number;
  target?: number;
  metric?: string;
  weight?: number;
  status?: string;
  currency_code?: string;
  owner?: V4Ref;
  starts_on?: string;
  ends_on?: string;
};

export type V4Objective = {
  id?: number;
  title?: string;
  type?: string;
  state?: string;
  progress_percentage?: number;
  status?: string;
  starts_on?: string;
  ends_on?: string;
  parent_id?: number | null;
  key_results?: V4KeyResult[];
  owner?: V4Ref;
  team?: V4Ref;
  department?: V4Ref;
  division?: V4Ref;
  location?: V4Ref;
  tags?: unknown[];
  created_at?: string;
  updated_at?: string;
};

export type V4ReviewCycle = {
  id?: number;
  name?: string;
  review_cycle_type?: string;
  description?: string;
  status?: string;
  starts_on?: string;
  ends_on?: string;
  deadline_on?: string;
  review_period_starts_on?: string;
  review_period_ends_on?: string;
};

export type V4ReviewResponse = {
  id?: number;
  review_id?: number;
  reviewee_id?: number;
  reviewer_id?: number;
  review_cycle_type?: string;
  review_cycle?: string;
  type?: string;
  status?: string;
  submitted_at?: string;
  answers?: Array<{ question?: string; value?: string; comment?: string }>;
};

export type V4Survey = {
  id?: number;
  name?: string;
  status?: string;
  anonymous?: boolean;
  starts_at?: string;
  ends_at?: string;
  created_at?: string;
  updated_at?: string;
};

export type V4SurveyResponse = {
  id?: number;
  survey_id?: number;
  /** Null when the survey is anonymous. */
  user_id?: number | null;
  anonymous?: boolean;
  status?: string;
  finished_at?: string;
  position?: V4Ref;
  location?: V4Ref;
  division?: V4Ref;
  department?: V4Ref;
  work_type?: V4Ref;
  gender?: V4Ref;
  age?: string | null;
  tenure?: string | null;
  answers?: Array<{ question?: unknown; value?: string; comment?: string }>;
};

export type V4ComplianceDocument = {
  id?: number;
  compliance_case_id?: number;
  employee_id?: number;
  compliance_process_document_id?: number;
  status?: string;
  verified_at?: string | null;
  attachment?: { url?: string; expires_at?: string } | null;
  pending_upload?: boolean;
  created_at?: string;
  updated_at?: string;
};

export type V4ComplianceCase = {
  id?: number;
  employee_id?: number;
  compliance_process_id?: number;
  status?: string;
  resource_type?: string | null;
  resource_id?: number | null;
  compliance_case_documents?: V4ComplianceDocument[];
  created_at?: string;
  updated_at?: string;
};

/**
 * `status` values the /people filter accepts. Unlike v2 — where omitting the
 * filter silently returned ACTIVE ONLY and no "everyone" value existed — v4
 * documents `all` AND defaults to it. Full headcount is one call here.
 */
export const PERSON_STATUS_VALUES = ['active', 'employed', 'terminated', 'hired', 'probation', 'all'] as const;
export type PersonStatus = (typeof PERSON_STATUS_VALUES)[number];

export const OBJECTIVE_STATUS_VALUES = ['none', 'on_track', 'behind', 'at_risk'] as const;
export const OBJECTIVE_STATE_VALUES = ['opened', 'upcoming', 'overdue', 'closed', 'archived'] as const;
export const OBJECTIVE_TYPE_VALUES = ['individual', 'department', 'location', 'division', 'team', 'company'] as const;
export const REVIEW_CYCLE_TYPE_VALUES = ['manual', 'lifecycle'] as const;
export const LIFECYCLE_SURVEY_STATUS_VALUES = ['draft', 'active', 'inactive'] as const;
export const ENGAGEMENT_SURVEY_STATUS_VALUES = ['draft', 'scheduled', 'running', 'archived', 'closed'] as const;
export const COMPLIANCE_CASE_STATUS_VALUES = ['verification', 'pending', 'cancelled', 'completed'] as const;
export const COMPLIANCE_DOCUMENT_STATUS_VALUES = ['unverified', 'verified', 'signed'] as const;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Shared paging knobs — every v4 list endpoint accepts exactly these three. */
export type V4PageInput = { page?: number; perPage?: number; offset?: number };

function pageParams(input: V4PageInput = {}): PeopleForceQueryParams {
  return { page: input.page, per_page: input.perPage, offset: input.offset };
}

/**
 * Expand `{gte, lte}` into the literal bracket keys v4 filters use
 * (`hired_on[gte]=2026-01-01`). `appendQueryParams` passes bracket keys
 * through untouched, so they must be built here rather than nested.
 */
export function rangeParams(field: string, range?: { gte?: string; lte?: string }): PeopleForceQueryParams {
  if (!range) return {};
  const out: PeopleForceQueryParams = {};
  if (range.gte) out[`${field}[gte]`] = range.gte;
  if (range.lte) out[`${field}[lte]`] = range.lte;
  return out;
}

export class PeopleForceV4Client {
  public readonly baseUrl: string;

  constructor(private token: string, baseUrl?: string) {
    this.baseUrl = resolveV4BaseUrl(baseUrl);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: PeopleForceQueryParams,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    appendQueryParams(url, query);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method,
        headers: {
          // v4 takes the service-account key in X-API-KEY only. v1–v3 also
          // accepted `Authorization: Bearer`; sending it here would just be
          // noise on a surface that documents one header.
          'X-API-KEY': this.token,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new Error(`PeopleForce v4 API ${method} ${path} timed out after 30000ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err: any = new Error(`PeopleForce v4 API ${method} ${path} failed: ${res.status} ${text}`);
      err.status = res.status;
      err.body = text;
      // 429 carries Retry-After in SECONDS (v4 documents 300 req/min per key).
      // Surfacing it lets the tool tell the caller how long to wait instead of
      // "retry later", which invites an immediate retry into the same wall.
      const retryAfter = res.headers.get('retry-after');
      if (retryAfter) err.retryAfter = retryAfter;
      throw err;
    }
    if (res.status === 204) return undefined as unknown as T;
    if (res.headers.get('content-type')?.includes('application/json')) {
      return (await res.json()) as T;
    }
    return undefined as unknown as T;
  }

  // === People ===

  listPeople(input: V4PageInput & {
    status?: PersonStatus;
    ids?: number[];
    emails?: string[];
    personNumbers?: string[];
    managerId?: number;
    legalEntityId?: number;
    hiredOn?: { gte?: string; lte?: string };
    createdAt?: { gte?: string; lte?: string };
  } = {}): Promise<V4ListResponse<V4Person>> {
    return this.request('GET', '/people', undefined, {
      ...pageParams(input),
      status: input.status,
      ids: input.ids,
      emails: input.emails,
      person_numbers: input.personNumbers,
      manager_id: input.managerId,
      legal_entity_id: input.legalEntityId,
      ...rangeParams('hired_on', input.hiredOn),
      ...rangeParams('created_at', input.createdAt),
    });
  }

  getPerson(id: number | string, includeHistoricalValues?: boolean): Promise<V4Person> {
    return this.request('GET', `/people/${id}`, undefined, {
      include_historical_values: includeHistoricalValues ? 'true' : undefined,
    });
  }

  listTerminatedPeople(input: V4PageInput & { terminatedOn?: { gte?: string; lte?: string } } = {}): Promise<V4ListResponse<V4Person>> {
    return this.request('GET', '/people/terminated', undefined, {
      ...pageParams(input),
      ...rangeParams('terminated_on', input.terminatedOn),
    });
  }

  listBirthdays(input: V4PageInput & { date?: { gte?: string; lte?: string } } = {}): Promise<V4ListResponse<V4Person>> {
    return this.request('GET', '/people/birthdays', undefined, {
      ...pageParams(input),
      ...rangeParams('date', input.date),
    });
  }

  listWorkAnniversaries(input: V4PageInput & { date?: { gte?: string; lte?: string } } = {}): Promise<V4ListResponse<V4Person>> {
    return this.request('GET', '/people/anniversaries', undefined, {
      ...pageParams(input),
      ...rangeParams('date', input.date),
    });
  }

  listPersonAssets(personId: number | string): Promise<V4ListResponse<V4Named>> {
    return this.request('GET', `/people/${personId}/assets`);
  }

  listPersonSalaries(personId: number | string): Promise<V4ListResponse<V4Salary>> {
    return this.request('GET', `/people/${personId}/compensation/salaries`);
  }

  getPersonSalary(personId: number | string, id: number | string): Promise<V4Salary> {
    return this.request('GET', `/people/${personId}/compensation/salaries/${id}`);
  }

  listPersonLifecycles(personId: number | string): Promise<V4ListResponse<V4Lifecycle>> {
    return this.request('GET', `/people/${personId}/lifecycles`);
  }

  createPerson(body: Record<string, unknown>): Promise<V4Person> {
    return this.request('POST', '/people', body);
  }

  updatePerson(id: number | string, body: Record<string, unknown>): Promise<V4Person> {
    return this.request('PUT', `/people/${id}`, body);
  }

  // === Core (org structure) ===

  listDepartments(input: V4PageInput = {}): Promise<V4ListResponse<V4Department>> {
    return this.request('GET', '/departments', undefined, pageParams(input));
  }

  getDepartment(id: number | string): Promise<V4Department> {
    return this.request('GET', `/departments/${id}`);
  }

  createDepartment(body: Record<string, unknown>): Promise<V4Department> {
    return this.request('POST', '/departments', body);
  }

  updateDepartment(id: number | string, body: Record<string, unknown>): Promise<V4Department> {
    return this.request('PUT', `/departments/${id}`, body);
  }

  listDivisions(input: V4PageInput = {}): Promise<V4ListResponse<V4Named>> {
    return this.request('GET', '/divisions', undefined, pageParams(input));
  }

  getDivision(id: number | string): Promise<V4Named> {
    return this.request('GET', `/divisions/${id}`);
  }

  createDivision(body: Record<string, unknown>): Promise<V4Named> {
    return this.request('POST', '/divisions', body);
  }

  updateDivision(id: number | string, body: Record<string, unknown>): Promise<V4Named> {
    return this.request('PUT', `/divisions/${id}`, body);
  }

  listWorkTypes(input: V4PageInput = {}): Promise<V4ListResponse<V4Named>> {
    return this.request('GET', '/work_types', undefined, pageParams(input));
  }

  getWorkType(id: number | string): Promise<V4Named> {
    return this.request('GET', `/work_types/${id}`);
  }

  createWorkType(body: Record<string, unknown>): Promise<V4Named> {
    return this.request('POST', '/work_types', body);
  }

  updateWorkType(id: number | string, body: Record<string, unknown>): Promise<V4Named> {
    return this.request('PUT', `/work_types/${id}`, body);
  }

  listJobLevels(input: V4PageInput = {}): Promise<V4ListResponse<V4Named>> {
    return this.request('GET', '/job_levels', undefined, pageParams(input));
  }

  createJobLevel(body: Record<string, unknown>): Promise<V4Named> {
    return this.request('POST', '/job_levels', body);
  }

  updateJobLevel(id: number | string, body: Record<string, unknown>): Promise<V4Named> {
    return this.request('PUT', `/job_levels/${id}`, body);
  }

  listLocations(input: V4PageInput = {}): Promise<V4ListResponse<V4Location>> {
    return this.request('GET', '/locations', undefined, pageParams(input));
  }

  createLocation(body: Record<string, unknown>): Promise<V4Location> {
    return this.request('POST', '/locations', body);
  }

  updateLocation(id: number | string, body: Record<string, unknown>): Promise<V4Location> {
    return this.request('PUT', `/locations/${id}`, body);
  }

  listJobTitles(input: V4PageInput = {}): Promise<V4ListResponse<V4Named>> {
    return this.request('GET', '/job_titles', undefined, pageParams(input));
  }

  createJobTitle(body: Record<string, unknown>): Promise<V4Named> {
    return this.request('POST', '/job_titles', body);
  }

  updateJobTitle(id: number | string, body: Record<string, unknown>): Promise<V4Named> {
    return this.request('PUT', `/job_titles/${id}`, body);
  }

  // === Perform ===

  listObjectives(input: V4PageInput & {
    status?: string;
    states?: string[];
    objectiveTypes?: string[];
    ownerIds?: number[];
    departmentIds?: number[];
    divisionIds?: number[];
    locationIds?: number[];
    teamIds?: number[];
    startsOn?: { gte?: string; lte?: string };
    endsOn?: { gte?: string; lte?: string };
  } = {}): Promise<V4ListResponse<V4Objective>> {
    return this.request('GET', '/perform/objectives', undefined, {
      ...pageParams(input),
      status: input.status,
      states: input.states,
      objective_types: input.objectiveTypes,
      owner_ids: input.ownerIds,
      department_ids: input.departmentIds,
      division_ids: input.divisionIds,
      location_ids: input.locationIds,
      team_ids: input.teamIds,
      ...rangeParams('starts_on', input.startsOn),
      ...rangeParams('ends_on', input.endsOn),
    });
  }

  getObjective(id: number | string): Promise<V4Objective> {
    return this.request('GET', `/perform/objectives/${id}`);
  }

  listReviewCycles(input: V4PageInput & {
    reviewCycleType?: string;
    startsOn?: { gte?: string; lte?: string };
    endsOn?: { gte?: string; lte?: string };
  } = {}): Promise<V4ListResponse<V4ReviewCycle>> {
    return this.request('GET', '/perform/review_cycles', undefined, {
      ...pageParams(input),
      review_cycle_type: input.reviewCycleType,
      ...rangeParams('starts_on', input.startsOn),
      ...rangeParams('ends_on', input.endsOn),
    });
  }

  listReviewResponses(input: V4PageInput & {
    reviewCycleIds?: number[];
    reviewIds?: number[];
    revieweeIds?: number[];
    reviewCycleType?: string;
    createdAt?: { gte?: string; lte?: string };
  } = {}): Promise<V4ListResponse<V4ReviewResponse>> {
    return this.request('GET', '/perform/review_responses', undefined, {
      ...pageParams(input),
      review_cycle_ids: input.reviewCycleIds,
      review_ids: input.reviewIds,
      reviewee_ids: input.revieweeIds,
      review_cycle_type: input.reviewCycleType,
      ...rangeParams('created_at', input.createdAt),
    });
  }

  // === Pulse ===

  listLifecycleSurveys(input: V4PageInput & { status?: string } = {}): Promise<V4ListResponse<V4Survey>> {
    return this.request('GET', '/pulse/lifecycle_surveys', undefined, { ...pageParams(input), status: input.status });
  }

  listLifecycleSurveyResponses(input: V4PageInput & {
    surveyIds?: number[];
    userIds?: number[];
    createdAt?: { gte?: string; lte?: string };
  } = {}): Promise<V4ListResponse<V4SurveyResponse>> {
    return this.request('GET', '/pulse/lifecycle_survey_responses', undefined, {
      ...pageParams(input),
      survey_ids: input.surveyIds,
      user_ids: input.userIds,
      ...rangeParams('created_at', input.createdAt),
    });
  }

  listEngagementSurveys(input: V4PageInput & { status?: string } = {}): Promise<V4ListResponse<V4Survey>> {
    return this.request('GET', '/pulse/engagement_surveys', undefined, { ...pageParams(input), status: input.status });
  }

  listEngagementSurveyResponses(input: V4PageInput & {
    surveyIds?: number[];
    userIds?: number[];
    fields?: string[];
    createdAt?: { gte?: string; lte?: string };
  } = {}): Promise<V4ListResponse<V4SurveyResponse>> {
    return this.request('GET', '/pulse/engagement_survey_responses', undefined, {
      ...pageParams(input),
      survey_ids: input.surveyIds,
      user_ids: input.userIds,
      fields: input.fields,
      ...rangeParams('created_at', input.createdAt),
    });
  }

  // === Kadry (compliance) ===

  listComplianceCases(input: V4PageInput & {
    employeeIds?: number[];
    statuses?: string[];
    documentStatuses?: string[];
    documentPendingUpload?: boolean;
  } = {}): Promise<V4ListResponse<V4ComplianceCase>> {
    return this.request('GET', '/compliance/compliance_cases', undefined, {
      ...pageParams(input),
      employee_ids: input.employeeIds,
      statuses: input.statuses,
      document_statuses: input.documentStatuses,
      document_pending_upload: input.documentPendingUpload === undefined ? undefined : String(input.documentPendingUpload),
    });
  }

  getComplianceCase(id: number | string): Promise<V4ComplianceCase> {
    return this.request('GET', `/compliance/compliance_cases/${id}`);
  }

  listComplianceCaseDocuments(input: V4PageInput & {
    employeeIds?: number[];
    complianceCaseIds?: number[];
    statuses?: string[];
    pendingUpload?: boolean;
  } = {}): Promise<V4ListResponse<V4ComplianceDocument>> {
    return this.request('GET', '/compliance/compliance_case_documents', undefined, {
      ...pageParams(input),
      employee_ids: input.employeeIds,
      compliance_case_ids: input.complianceCaseIds,
      statuses: input.statuses,
      pending_upload: input.pendingUpload === undefined ? undefined : String(input.pendingUpload),
    });
  }

  getComplianceCaseDocument(id: number | string): Promise<V4ComplianceDocument> {
    return this.request('GET', `/compliance/compliance_case_documents/${id}`);
  }
}

// ---------------------------------------------------------------------------
// Formatters
//
// Two v4-specific hazards drive every choice below, both documented by
// PeopleForce under "What to expect in a response":
//
//   1. A record outside the role's population is OMITTED from a 200 with a
//      shorter list — not denied. So an empty list never means "no such data"
//      on its own, and a count is only ever a floor.
//   2. A field the role does not grant is ABSENT from the JSON, not null. So
//      rendering a blank would assert "this person has no manager" when the
//      truth is "this key was not shown the manager".
//
// Both are silent by construction. The formatters make them loud.
// ---------------------------------------------------------------------------

const ref = (r: V4Ref | undefined): string | undefined => (r && r.name ? r.name : undefined);

/** `Page 2 of 7 — 340 total (50 per page).` Omits parts the payload didn't carry. */
export function formatPaginationFooter(p?: V4Pagination): string {
  if (!p) return '';
  const bits: string[] = [];
  if (p.page !== undefined) bits.push(p.total_pages !== undefined ? `Page ${p.page} of ${p.total_pages}` : `Page ${p.page}`);
  if (p.total_count !== undefined) bits.push(`${p.total_count} total`);
  if (p.per_page !== undefined) bits.push(`${p.per_page} per page`);
  return bits.length ? `\n\n${bits.join(' — ')}.` : '';
}

/**
 * What an empty v4 list actually means. Reported instead of a bare "none
 * found" because the most common cause is a role that grants nothing — the
 * API's own troubleshooting entry is titled "Authentication works, but every
 * list is empty" — and "no results" would read as a fact about the company.
 */
export function emptyListNote(resource: string): string {
  return (
    `No ${resource} returned.\n\n` +
    `On API v4 this is ambiguous: records outside the service account role's population are omitted from a ` +
    `200 response rather than denied, so this means either there are none, or this key's role cannot see them. ` +
    `Check Settings → Roles & permissions → the role attached to this key: "Who is assigned this role?" and ` +
    `"Whose data can members access?".`
  );
}

function renderList<T>(resource: string, rows: T[], pagination: V4Pagination | undefined, render: (row: T) => string): string {
  if (!rows.length) return emptyListNote(resource);
  return rows.map(render).join('\n') + formatPaginationFooter(pagination);
}

/**
 * Person fields v4 documents but drops entirely when the role does not grant
 * them. Listed so {@link formatPerson} can say which ones were withheld —
 * `in` is the only way to tell "not granted" from "granted and empty", and
 * the difference decides whether the answer is "he has no manager" or "ask
 * your admin".
 */
const PERSON_GRANTABLE_FIELDS = [
  'email', 'personal_email', 'work_phone_number', 'mobile_number', 'date_of_birth',
  'hired_on', 'probation_ends_on', 'position', 'job_level', 'location', 'employment_type',
  'division', 'department', 'reporting_to', 'legal_entity', 'gender',
] as const;

function withheldFields(person: V4Person): string[] {
  return PERSON_GRANTABLE_FIELDS.filter(f => !(f in person));
}

const personLabel = (p: V4Person): string =>
  p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || `Person ${p.id ?? '?'}`;

export function formatPersonList(rows: V4Person[], pagination?: V4Pagination): string {
  return renderList('people', rows, pagination, p => {
    const parts = [`#${p.id ?? '?'} ${personLabel(p)}`];
    const position = ref(p.position);
    const department = ref(p.department);
    if (position) parts.push(position);
    if (department) parts.push(department);
    if (p.email) parts.push(p.email);
    if (p.status) parts.push(`status: ${p.status}`);
    if (p.hired_on) parts.push(`hired ${p.hired_on}`);
    if (p.termination_effective_on) {
      const reason = ref(p.termination_reason);
      parts.push(`terminated ${p.termination_effective_on}${reason ? ` (${reason})` : ''}`);
    }
    return `- ${parts.join(' | ')}`;
  });
}

export function formatPerson(p: V4Person): string {
  const lines: string[] = [`${personLabel(p)} (ID: ${p.id ?? '?'})`];
  const put = (label: string, value: string | number | undefined | null) => {
    if (value !== undefined && value !== null && value !== '') lines.push(`${label}: ${value}`);
  };
  put('Status', p.status);
  put('Access', p.access);
  put('Person number', p.employee_number);
  put('Work email', p.email);
  put('Personal email', p.personal_email);
  put('Work phone', p.work_phone_number);
  put('Mobile', p.mobile_number);
  put('Date of birth', p.date_of_birth);
  put('Position', ref(p.position));
  put('Job level', ref(p.job_level));
  put('Department', ref(p.department));
  put('Division', ref(p.division));
  put('Location', ref(p.location));
  put('Employment type', ref(p.employment_type));
  put('Legal entity', ref(p.legal_entity));
  put('Gender', ref(p.gender));
  if (p.reporting_to) {
    const name = [p.reporting_to.first_name, p.reporting_to.last_name].filter(Boolean).join(' ');
    put('Reports to', `${name || `#${p.reporting_to.id}`}${p.reporting_to.email ? ` <${p.reporting_to.email}>` : ''}`);
  }
  put('Hired on', p.hired_on);
  put('Probation ends on', p.probation_ends_on);
  put('Terminated on', p.termination_effective_on);
  put('Termination type', ref(p.termination_type));
  put('Termination reason', ref(p.termination_reason));
  put('Termination comment', p.termination_comment);
  put('Eligible for rehire', p.termination_eligible_for_rehire);
  put('Created', p.created_at);
  put('Updated', p.updated_at);

  const withheld = withheldFields(p);
  if (withheld.length) {
    lines.push(
      '',
      `⚠ Not returned by v4 for this person: ${withheld.join(', ')}. ` +
        `v4 omits fields the service account's role does not grant rather than returning them empty, so this is ` +
        `"not granted to this key", NOT "this person has no value". Grant them on the role's People → ` +
        `"What can this role see?" tab (Personal for profile fields, Job for hire/termination dates, Compensation for pay).`,
    );
  }
  return lines.join('\n');
}

export function formatNamedList(resource: string, rows: V4Named[], pagination?: V4Pagination): string {
  return renderList(resource, rows, pagination, r => `- #${r.id ?? '?'} ${r.name ?? '(unnamed)'}`);
}

export function formatDepartmentList(rows: V4Department[], pagination?: V4Pagination): string {
  return renderList('departments', rows, pagination, d => {
    const extra: string[] = [];
    if (d.parent_id) extra.push(`parent: #${d.parent_id}`);
    if (d.manager_id) extra.push(`manager: #${d.manager_id}`);
    return `- #${d.id ?? '?'} ${d.name ?? '(unnamed)'}${extra.length ? ` (${extra.join(', ')})` : ''}`;
  });
}

export function formatLocationList(rows: V4Location[], pagination?: V4Pagination): string {
  return renderList('locations', rows, pagination, l => {
    const extra = [l.country_code, l.time_zone, l.address].filter(Boolean).join(', ');
    return `- #${l.id ?? '?'} ${l.name ?? '(unnamed)'}${extra ? ` — ${extra}` : ''}`;
  });
}

export function formatSalary(s: V4Salary): string {
  const amount = s.amount !== undefined ? `${s.amount}${s.currency_code ? ` ${s.currency_code}` : ''}${s.per ? ` per ${s.per}` : ''}` : '(amount not granted)';
  const bits = [`#${s.id ?? '?'}`, amount];
  if (s.effective_on) bits.push(`effective ${s.effective_on}`);
  if (s.comment) bits.push(s.comment);
  return bits.join(' | ');
}

export function formatSalaryList(rows: V4Salary[], pagination?: V4Pagination): string {
  return renderList('salary records', rows, pagination, s => `- ${formatSalary(s)}`);
}

export function formatLifecycleList(rows: V4Lifecycle[], pagination?: V4Pagination): string {
  return renderList('lifecycle records', rows, pagination, l => {
    const bits = [`#${l.id ?? '?'}`];
    if (l.start_date) bits.push(`start ${l.start_date}`);
    if (l.last_working_day) bits.push(`last working day ${l.last_working_day}`);
    if (l.last_day_in_office) bits.push(`last day in office ${l.last_day_in_office}`);
    const type = ref(l.termination_type);
    const reason = ref(l.termination_reason);
    if (type) bits.push(`type: ${type}`);
    if (reason) bits.push(`reason: ${reason}`);
    if (l.eligible_for_rehire !== undefined) bits.push(`rehire: ${l.eligible_for_rehire ? 'yes' : 'no'}`);
    if (l.termination_comment) bits.push(l.termination_comment);
    return `- ${bits.join(' | ')}`;
  });
}

function formatKeyResult(kr: V4KeyResult): string {
  const bits = [`  • ${kr.name ?? '(untitled)'}`];
  if (kr.progress_percentage !== undefined) bits.push(`${kr.progress_percentage}%`);
  if (kr.value !== undefined && kr.target !== undefined) bits.push(`${kr.value}/${kr.target}${kr.metric ? ` ${kr.metric}` : ''}`);
  if (kr.status) bits.push(kr.status);
  const owner = ref(kr.owner);
  if (owner) bits.push(`owner: ${owner}`);
  return bits.join(' | ');
}

export function formatObjective(o: V4Objective): string {
  const lines = [`${o.title ?? '(untitled)'} (ID: ${o.id ?? '?'})`];
  const head: string[] = [];
  if (o.type) head.push(`type: ${o.type}`);
  if (o.state) head.push(`state: ${o.state}`);
  if (o.status) head.push(`status: ${o.status}`);
  if (o.progress_percentage !== undefined) head.push(`progress: ${o.progress_percentage}%`);
  if (head.length) lines.push(head.join(' | '));
  const owner = ref(o.owner);
  if (owner) lines.push(`Owner: ${owner}`);
  for (const [label, value] of [['Team', ref(o.team)], ['Department', ref(o.department)], ['Division', ref(o.division)], ['Location', ref(o.location)]] as const) {
    if (value) lines.push(`${label}: ${value}`);
  }
  if (o.starts_on || o.ends_on) lines.push(`Period: ${o.starts_on ?? '?'} → ${o.ends_on ?? '?'}`);
  if (o.key_results?.length) {
    lines.push(`Key results (${o.key_results.length}):`);
    lines.push(...o.key_results.map(formatKeyResult));
  }
  return lines.join('\n');
}

export function formatObjectiveList(rows: V4Objective[], pagination?: V4Pagination): string {
  return renderList('objectives', rows, pagination, o => {
    const bits = [`#${o.id ?? '?'} ${o.title ?? '(untitled)'}`];
    if (o.type) bits.push(o.type);
    if (o.state) bits.push(o.state);
    if (o.status) bits.push(o.status);
    if (o.progress_percentage !== undefined) bits.push(`${o.progress_percentage}%`);
    const owner = ref(o.owner);
    if (owner) bits.push(`owner: ${owner}`);
    if (o.ends_on) bits.push(`ends ${o.ends_on}`);
    if (o.key_results?.length) bits.push(`${o.key_results.length} KR`);
    return `- ${bits.join(' | ')}`;
  });
}

export function formatReviewCycleList(rows: V4ReviewCycle[], pagination?: V4Pagination): string {
  return renderList('review cycles', rows, pagination, c => {
    const bits = [`#${c.id ?? '?'} ${c.name ?? '(unnamed)'}`];
    if (c.review_cycle_type) bits.push(c.review_cycle_type);
    if (c.status) bits.push(c.status);
    if (c.starts_on || c.ends_on) bits.push(`${c.starts_on ?? '?'} → ${c.ends_on ?? '?'}`);
    if (c.deadline_on) bits.push(`deadline ${c.deadline_on}`);
    return `- ${bits.join(' | ')}`;
  });
}

export function formatReviewResponseList(rows: V4ReviewResponse[], pagination?: V4Pagination): string {
  return renderList('review responses', rows, pagination, r => {
    const bits = [`#${r.id ?? '?'}`];
    if (r.review_cycle) bits.push(r.review_cycle);
    if (r.type) bits.push(`as ${r.type}`);
    if (r.reviewee_id !== undefined) bits.push(`reviewee #${r.reviewee_id}`);
    if (r.reviewer_id !== undefined) bits.push(`reviewer #${r.reviewer_id}`);
    if (r.status) bits.push(r.status);
    if (r.submitted_at) bits.push(`submitted ${r.submitted_at}`);
    if (r.answers?.length) bits.push(`${r.answers.length} answers`);
    return `- ${bits.join(' | ')}`;
  });
}

export function formatSurveyList(resource: string, rows: V4Survey[], pagination?: V4Pagination): string {
  return renderList(resource, rows, pagination, s => {
    const bits = [`#${s.id ?? '?'} ${s.name ?? '(unnamed)'}`];
    if (s.status) bits.push(s.status);
    if (s.anonymous !== undefined) bits.push(s.anonymous ? 'anonymous' : 'attributed');
    if (s.starts_at || s.ends_at) bits.push(`${s.starts_at ?? '?'} → ${s.ends_at ?? '?'}`);
    return `- ${bits.join(' | ')}`;
  });
}

export function formatSurveyResponseList(rows: V4SurveyResponse[], pagination?: V4Pagination): string {
  return renderList('survey responses', rows, pagination, r => {
    const bits = [`#${r.id ?? '?'}`];
    if (r.survey_id !== undefined) bits.push(`survey #${r.survey_id}`);
    // An anonymous response carries user_id: null BY DESIGN — rendering it as
    // "unknown employee" would invite a caller to go looking for the person.
    bits.push(r.anonymous ? 'anonymous' : r.user_id != null ? `employee #${r.user_id}` : 'employee not disclosed');
    if (r.status) bits.push(r.status);
    if (r.finished_at) bits.push(`finished ${r.finished_at}`);
    if (r.answers?.length) bits.push(`${r.answers.length} answers`);
    return `- ${bits.join(' | ')}`;
  });
}

/**
 * Attachment URLs are short-lived and v4 says so in the payload
 * (`expires_at`). The expiry is rendered next to the link because a stale
 * copied URL 404s later in a way that looks like a missing document.
 */
function formatAttachment(doc: V4ComplianceDocument): string | undefined {
  if (!doc.attachment?.url) return undefined;
  return `${doc.attachment.url}${doc.attachment.expires_at ? ` (expires ${doc.attachment.expires_at})` : ''}`;
}

export function formatComplianceDocument(d: V4ComplianceDocument): string {
  const bits = [`#${d.id ?? '?'}`];
  if (d.compliance_case_id !== undefined) bits.push(`case #${d.compliance_case_id}`);
  if (d.employee_id !== undefined) bits.push(`employee #${d.employee_id}`);
  if (d.status) bits.push(d.status);
  if (d.pending_upload) bits.push('pending upload');
  if (d.verified_at) bits.push(`verified ${d.verified_at}`);
  const attachment = formatAttachment(d);
  if (attachment) bits.push(attachment);
  return bits.join(' | ');
}

export function formatComplianceDocumentList(rows: V4ComplianceDocument[], pagination?: V4Pagination): string {
  return renderList('compliance case documents', rows, pagination, d => `- ${formatComplianceDocument(d)}`);
}

export function formatComplianceCase(c: V4ComplianceCase): string {
  const lines = [`Compliance case #${c.id ?? '?'}`];
  if (c.employee_id !== undefined) lines.push(`Employee: #${c.employee_id}`);
  if (c.status) lines.push(`Status: ${c.status}`);
  if (c.compliance_process_id !== undefined) lines.push(`Process: #${c.compliance_process_id}`);
  if (c.resource_type) lines.push(`Triggered by: ${c.resource_type}${c.resource_id ? ` #${c.resource_id}` : ''}`);
  if (c.created_at) lines.push(`Created: ${c.created_at}`);
  const docs = c.compliance_case_documents ?? [];
  if (docs.length) {
    lines.push(`Documents (${docs.length}):`);
    lines.push(...docs.map(d => `- ${formatComplianceDocument(d)}`));
  }
  return lines.join('\n');
}

export function formatComplianceCaseList(rows: V4ComplianceCase[], pagination?: V4Pagination): string {
  return renderList('compliance cases', rows, pagination, c => {
    const bits = [`#${c.id ?? '?'}`];
    if (c.employee_id !== undefined) bits.push(`employee #${c.employee_id}`);
    if (c.status) bits.push(c.status);
    const docs = c.compliance_case_documents ?? [];
    if (docs.length) {
      const pending = docs.filter(d => d.pending_upload).length;
      bits.push(`${docs.length} documents${pending ? ` (${pending} pending upload)` : ''}`);
    }
    return `- ${bits.join(' | ')}`;
  });
}

// ---------------------------------------------------------------------------
// Session + error mapping
// ---------------------------------------------------------------------------

export type PeopleForceV4ToolLog = { info: (m: string) => void; error: (m: string) => void };

export function getPeopleForceV4Client(session?: UserSession): PeopleForceV4Client {
  if (!session?.peopleForceV4AccessToken) {
    throw new UserError(
      'PeopleForce v4 not connected. Visit the dashboard and connect with a PeopleForce **Service account** API key ' +
        '(Settings → API keys → Generate API key → Service account).',
    );
  }
  return new PeopleForceV4Client(session.peopleForceV4AccessToken, session.peopleForceV4BaseUrl);
}

/**
 * Map a v4 HTTP failure onto the cause the caller can actually act on.
 *
 * v4's status table is narrower than it looks, and two entries are routinely
 * misread:
 *
 *   401 — the key is wrong, disabled, or NOT A SERVICE ACCOUNT KEY. A Company
 *         key pasted here authenticates nowhere on /api/v4, so this is the
 *         single most likely first-run failure and the message says so.
 *   404 — "The record doesn't exist — OR is outside the role's population."
 *         Reporting a bare "not found" would send someone hunting for a
 *         deleted record when the row is simply invisible to this key.
 */
export function mapPeopleForceV4Error(prefix: string, error: any, log: PeopleForceV4ToolLog): never {
  log.error(`${prefix}: ${error?.message ?? error}`);
  const status = error?.status;
  if (status === 401) {
    throw new UserError(
      `${prefix}: PeopleForce rejected the API key (401). Check that it is a **Service account** key (a Company or ` +
        `Career key cannot call API v4 at all), that it was copied in full, and that it is still enabled in ` +
        `Settings → API keys.`,
    );
  }
  if (status === 403) {
    throw new UserError(
      `${prefix}: the service account's role does not grant this action (403). Org-structure writes need the matching ` +
        `"Manage …" permission on the role's Company tab; writes to a person's data need Edit rather than View on ` +
        `that field.`,
    );
  }
  if (status === 404) {
    throw new UserError(
      `${prefix}: not found (404). On v4 this means the record does not exist OR it falls outside the population ` +
        `the service account's role can access — the two are indistinguishable from the response.`,
    );
  }
  if (status === 422) {
    throw new UserError(`${prefix}: PeopleForce rejected the payload (422 validation error). ${error?.body ?? ''}`.trim());
  }
  if (status === 429) {
    const retry = error?.retryAfter ? ` Retry after ${error.retryAfter}s.` : '';
    throw new UserError(`${prefix}: rate limited by PeopleForce (300 requests/minute per API key).${retry}`);
  }
  throw new UserError(`${prefix}: ${error?.message ?? 'Unknown error'}`);
}

export async function withPeopleForceV4Client<T>(
  prefix: string,
  session: UserSession | undefined,
  log: PeopleForceV4ToolLog,
  fn: (client: PeopleForceV4Client) => Promise<T>,
): Promise<T> {
  const client = getPeopleForceV4Client(session);
  try {
    return await fn(client);
  } catch (error: any) {
    mapPeopleForceV4Error(prefix, error, log);
  }
}
