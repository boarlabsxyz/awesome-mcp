// src/peopleforce/server.ts
// PeopleForce HRIS MCP server. Tools cover the core employee/department/
// leave-request surface of the public REST API
// (https://apidoc.peopleforce.io/).
//
// Only the filter/pagination knobs the API actually honors are exposed.
// Notably: no perPage (server fixes it at 50/100), no department/employee/
// date-range filters (not supported by the public v2 API).

import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';

import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import {
  PeopleForceClient,
  PeopleForceListResponse,
  PeopleForcePagination,
  formatDepartmentList,
  formatEmployee,
  formatEmployeeList,
  formatEmployeeSkills,
  formatLeaveBalances,
  formatLeaveRequestList,
  formatLeaveTypeList,
  formatLocationList,
  formatNamedList,
  formatTaskList,
  formatUnknownItemList,
  withPeopleForceClient,
  // Recruitment (v3)
  formatVacancyList,
  formatVacancy,
  formatPipelineList,
  formatCandidateList,
  formatCandidate,
  formatApplicationList,
  formatCandidateNotes,
  formatCandidateExperiences,
  formatCandidateEducations,
  formatMovementList,
  formatPublishedVacancy,
  formatCandidateDossier,
} from './apiHelpers.js';

export const peopleForceServer = new FastMCP<UserSession>({
  name: 'PeopleForce MCP',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'peopleforce'),
});

// ---------------------------------------------------------------------------
// Shared building blocks — every list tool has essentially the same body:
// `withPeopleForceClient` wrapper, a `log.info` breadcrumb, one client call,
// and a formatter over `{data, metadata.pagination}`. The two helpers below
// collapse ~250 lines of near-identical addTool blocks into ~60 while keeping
// per-tool descriptions, error prefixes, and formatters inline at the call
// site (so grep-for-tool-name still works).
// ---------------------------------------------------------------------------

/**
 * Register a read-only list tool that takes a single `page` argument.
 * Covers every /-level PeopleForce resource we expose (employees excepted —
 * it also takes `status`, so its Zod schema is bespoke).
 */
function addPaginatedListTool<T>(config: {
  name: string;
  description: string;
  errorPrefix: string;
  fetch: (client: PeopleForceClient, page: number) => Promise<PeopleForceListResponse<T>>;
  format: (data: T[], pagination?: PeopleForcePagination) => string;
}) {
  peopleForceServer.addTool({
    name: config.name,
    annotations: { readOnlyHint: true },
    description: config.description,
    parameters: z.object({
      page: z.number().int().min(1).optional().default(1).describe('Page number (1-based). Server-fixed page size.'),
    }),
    execute: (args, { log, session }) =>
      withPeopleForceClient(config.errorPrefix, session, log, async (client) => {
        log.info(`${config.name} (page=${args.page})`);
        const res = await config.fetch(client, args.page);
        return config.format(res.data ?? [], res.metadata?.pagination);
      }),
  });
}

/**
 * Register a read-only tool nested under an employee (leave balances, skills,
 * documents, notes, emergency contacts). Employee-nested endpoints on the
 * public API don't paginate — always return the full list.
 */
function addEmployeeScopedListTool<T>(config: {
  name: string;
  description: string;
  errorPrefix: string;
  fetch: (client: PeopleForceClient, employeeId: string | number) => Promise<PeopleForceListResponse<T>>;
  format: (data: T[]) => string;
}) {
  peopleForceServer.addTool({
    name: config.name,
    annotations: { readOnlyHint: true },
    description: config.description,
    parameters: z.object({
      employeeId: z.union([z.string(), z.number()]).describe('The employee ID.'),
    }),
    execute: (args, { log, session }) =>
      withPeopleForceClient(config.errorPrefix, session, log, async (client) => {
        log.info(`${config.name} for employee ${args.employeeId}`);
        const res = await config.fetch(client, args.employeeId);
        return config.format(res.data ?? []);
      }),
  });
}

/**
 * Like {@link addEmployeeScopedListTool} but scoped to a recruitment candidate
 * (notes, experiences, educations). Same "employee-nested endpoints don't
 * paginate" assumption applies to these candidate-nested v3 endpoints.
 */
function addCandidateScopedListTool<T>(config: {
  name: string;
  description: string;
  errorPrefix: string;
  fetch: (client: PeopleForceClient, candidateId: string | number) => Promise<PeopleForceListResponse<T>>;
  format: (data: T[]) => string;
}) {
  peopleForceServer.addTool({
    name: config.name,
    annotations: { readOnlyHint: true },
    description: config.description,
    parameters: z.object({
      candidateId: z.union([z.string(), z.number()]).describe('The recruitment candidate ID.'),
    }),
    execute: (args, { log, session }) =>
      withPeopleForceClient(config.errorPrefix, session, log, async (client) => {
        log.info(`${config.name} for candidate ${args.candidateId}`);
        const res = await config.fetch(client, args.candidateId);
        return config.format(res.data ?? []);
      }),
  });
}

/**
 * ISO-date string (YYYY-MM-DD) whose value is also a real calendar date.
 * Rejects 2026-02-31, 2026-13-01, etc. The regex-only check the tools used
 * to have accepted those and only failed downstream on the PeopleForce API.
 * Exported for unit tests.
 */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use ISO date format YYYY-MM-DD.')
  .refine((s) => {
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }, 'Not a valid calendar date.');

/**
 * Full Zod schema for `createLeaveRequest`. Exported so the calendar-validity
 * + cross-field ordering guards can be tested without reaching into FastMCP
 * internals.
 */
export const createLeaveRequestSchema = z
  .object({
    employeeId: z.union([z.string(), z.number()]).describe('The employee ID the leave request is for.'),
    leaveTypeId: z.union([z.string(), z.number()]).describe('The leave-type ID (from listLeaveTypes — NOT the name).'),
    startsOn: isoDate.describe('First day of leave (YYYY-MM-DD).'),
    endsOn: isoDate.describe('Last day of leave (YYYY-MM-DD).'),
    comment: z.string().optional().describe('Optional comment on the request.'),
  })
  // Compare as ISO strings — YYYY-MM-DD sorts lexicographically the same as chronologically.
  .refine((v) => v.startsOn <= v.endsOn, {
    message: 'endsOn must be on or after startsOn.',
    path: ['endsOn'],
  });

// === Employees ===

peopleForceServer.addTool({
  name: 'listEmployees',
  annotations: { readOnlyHint: true },
  description:
    'Lists PeopleForce employees, 50 per page (server-fixed). Use `page` to paginate; `status` narrows the cohort (e.g. "active", "terminated").',
  parameters: z.object({
    page: z.number().int().min(1).optional().default(1).describe('Page number (1-based). 50 employees per page (server-fixed).'),
    status: z.string().optional().describe('Filter by employee status (e.g. "active", "terminated").'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to list employees', session, log, async (client) => {
      log.info(`Listing PeopleForce employees (page=${args.page}${args.status ? `, status=${args.status}` : ''})`);
      const res = await client.listEmployees({
        page: args.page,
        status: args.status,
      });
      return formatEmployeeList(res.data ?? [], res.metadata?.pagination);
    }),
});

peopleForceServer.addTool({
  name: 'getEmployee',
  annotations: { readOnlyHint: true },
  description:
    'Retrieves a single PeopleForce employee by ID. Returns full profile: contact, position, department, division, employment type, location, reporting line, and hiring dates.',
  parameters: z.object({
    employeeId: z.union([z.string(), z.number()]).describe('The PeopleForce employee ID.'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to fetch employee', session, log, async (client) => {
      log.info(`Fetching PeopleForce employee ${args.employeeId}`);
      const res = await client.getEmployee(args.employeeId);
      if (!res?.data) throw new UserError('Employee not found.');
      return formatEmployee(res.data);
    }),
});

// === Departments ===

addPaginatedListTool({
  name: 'listDepartments',
  description: 'Lists all PeopleForce departments, 50 per page (server-fixed). Use `page` to paginate.',
  errorPrefix: 'Failed to list departments',
  fetch: (client, page) => client.listDepartments({ page }),
  format: formatDepartmentList,
});

// === Leave requests ===

peopleForceServer.addTool({
  name: 'listLeaveRequests',
  annotations: { readOnlyHint: true },
  description:
    'Lists PeopleForce leave requests, 100 per page (server-fixed). Use `page` to paginate; `state` filters by lifecycle state (e.g. "pending", "approved", "declined"). PeopleForce\'s public API does NOT support server-side filtering by employee or date range — fetch pages and filter client-side if needed.',
  parameters: z.object({
    page: z.number().int().min(1).optional().default(1).describe('Page number (1-based). 100 leave requests per page (server-fixed).'),
    state: z.string().optional().describe('Filter by leave-request state (e.g. "pending", "approved", "declined").'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to list leave requests', session, log, async (client) => {
      log.info(`Listing PeopleForce leave requests (page=${args.page}${args.state ? `, state=${args.state}` : ''})`);
      const res = await client.listLeaveRequests({
        page: args.page,
        state: args.state,
      });
      return formatLeaveRequestList(res.data ?? [], res.metadata?.pagination);
    }),
});

peopleForceServer.addTool({
  name: 'createLeaveRequest',
  annotations: { readOnlyHint: false },
  description: 'Creates a new PeopleForce leave request (time off) for an employee against a specific leave-type ID. Call `listLeaveTypes` first if you need the ID.',
  parameters: createLeaveRequestSchema,
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to create leave request', session, log, async (client) => {
      log.info(`Creating PeopleForce leave request for employee ${args.employeeId} (leave_type_id=${args.leaveTypeId})`);
      const res = await client.createLeaveRequest({
        employeeId: args.employeeId,
        leaveTypeId: args.leaveTypeId,
        startsOn: args.startsOn,
        endsOn: args.endsOn,
        comment: args.comment,
      });
      if (!res?.data) throw new UserError('Failed to create leave request.');
      return `Leave request created successfully (ID: ${res.data.id ?? 'unknown'})`;
    }),
});

peopleForceServer.addTool({
  name: 'getLeaveRequest',
  annotations: { readOnlyHint: true },
  description: 'Retrieves a single PeopleForce leave request by ID (state, dates, amount, employee, comment).',
  parameters: z.object({
    leaveRequestId: z.union([z.string(), z.number()]).describe('The leave-request ID.'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to fetch leave request', session, log, async (client) => {
      log.info(`Fetching PeopleForce leave request ${args.leaveRequestId}`);
      const res = await client.getLeaveRequest(args.leaveRequestId);
      if (!res?.data) throw new UserError('Leave request not found.');
      return formatLeaveRequestList([res.data]);
    }),
});

// === Reference / lookup data ===

addPaginatedListTool({
  name: 'listLeaveTypes',
  description:
    'Lists PeopleForce leave types (Vacation, Sick, Sabbatical, etc.) with their IDs and time-tracking unit (days/hours). Call this to find the `leaveTypeId` needed for `createLeaveRequest`.',
  errorPrefix: 'Failed to list leave types',
  fetch: (client, page) => client.listLeaveTypes({ page }),
  format: formatLeaveTypeList,
});

addPaginatedListTool({
  name: 'listPositions',
  description: 'Lists all PeopleForce job positions with their IDs. Server-fixed 50 per page.',
  errorPrefix: 'Failed to list positions',
  fetch: (client, page) => client.listPositions({ page }),
  format: (data, p) => formatNamedList('Positions', data, p),
});

addPaginatedListTool({
  name: 'listDivisions',
  description: 'Lists PeopleForce divisions (org-chart layer above departments) with their IDs.',
  errorPrefix: 'Failed to list divisions',
  fetch: (client, page) => client.listDivisions({ page }),
  format: (data, p) => formatNamedList('Divisions', data, p),
});

addPaginatedListTool({
  name: 'listLocations',
  description: 'Lists PeopleForce office/remote locations with country code and time zone. Server-fixed 50 per page.',
  errorPrefix: 'Failed to list locations',
  fetch: (client, page) => client.listLocations({ page }),
  format: formatLocationList,
});

addPaginatedListTool({
  name: 'listEmploymentTypes',
  description: 'Lists PeopleForce employment types (Employee, Contractor, Intern, etc.) with their IDs.',
  errorPrefix: 'Failed to list employment types',
  fetch: (client, page) => client.listEmploymentTypes({ page }),
  format: (data, p) => formatNamedList('Employment Types', data, p),
});

addPaginatedListTool({
  name: 'listJobLevels',
  description: 'Lists PeopleForce job levels (Junior, Mid, Senior, Head of, etc.) with their IDs.',
  errorPrefix: 'Failed to list job levels',
  fetch: (client, page) => client.listJobLevels({ page }),
  format: (data, p) => formatNamedList('Job Levels', data, p),
});

addPaginatedListTool({
  name: 'listSkills',
  description: 'Lists the PeopleForce skills catalog (workspace-wide) with IDs. Server-fixed 50 per page.',
  errorPrefix: 'Failed to list skills',
  fetch: (client, page) => client.listSkills({ page }),
  format: (data, p) => formatNamedList('Skills', data, p),
});

addPaginatedListTool({
  name: 'listCompetencies',
  description: 'Lists PeopleForce competencies (behavioral/performance dimensions used in reviews) with their IDs.',
  errorPrefix: 'Failed to list competencies',
  fetch: (client, page) => client.listCompetencies({ page }),
  format: (data, p) => formatNamedList('Competencies', data, p),
});

addPaginatedListTool({
  name: 'listTasks',
  description: 'Lists PeopleForce tasks (onboarding, applicant follow-ups, etc.) with assignee, dates, and completion state. Server-fixed 50 per page.',
  errorPrefix: 'Failed to list tasks',
  fetch: (client, page) => client.listTasks({ page }),
  format: formatTaskList,
});

// === Employee-nested ===

addEmployeeScopedListTool({
  name: 'listEmployeeLeaveBalances',
  description: 'Lists a specific employee\'s current leave balances per leave type (e.g. "how many vacation days does this person have?").',
  errorPrefix: 'Failed to list leave balances',
  fetch: (client, id) => client.listEmployeeLeaveBalances(id),
  format: formatLeaveBalances,
});

addEmployeeScopedListTool({
  name: 'listEmployeeSkills',
  description: 'Lists the skills recorded on a specific employee\'s profile with proficiency level.',
  errorPrefix: 'Failed to list employee skills',
  fetch: (client, id) => client.listEmployeeSkills(id),
  format: formatEmployeeSkills,
});

addEmployeeScopedListTool({
  name: 'listEmployeeDocuments',
  description: 'Lists documents attached to a specific employee\'s profile. Payload shape is dumped as JSON since the public API doesn\'t document a fixed schema for this endpoint.',
  errorPrefix: 'Failed to list employee documents',
  fetch: (client, id) => client.listEmployeeDocuments(id),
  format: (data) => formatUnknownItemList('Employee Documents', data),
});

addEmployeeScopedListTool({
  name: 'listEmployeeNotes',
  description: 'Lists HR notes on a specific employee\'s profile. Payload dumped as JSON (undocumented shape).',
  errorPrefix: 'Failed to list employee notes',
  fetch: (client, id) => client.listEmployeeNotes(id),
  format: (data) => formatUnknownItemList('Employee Notes', data),
});

addEmployeeScopedListTool({
  name: 'listEmployeeEmergencyContacts',
  description: 'Lists emergency contacts on a specific employee\'s profile. Payload dumped as JSON (undocumented shape).',
  errorPrefix: 'Failed to list emergency contacts',
  fetch: (client, id) => client.listEmployeeEmergencyContacts(id),
  format: (data) => formatUnknownItemList('Emergency Contacts', data),
});

// ===========================================================================
// Recruitment (v3 API)
// ---------------------------------------------------------------------------
// These endpoints live on the v3 base (…/api/public/v3/recruitment), derived
// from the v2 base by PeopleForceClient. PeopleForce does not publish response
// schemas, so formatters render known fields and fall back to a JSON dump;
// field-name drift is corrected on first live use.
//
// Feedback note: the public API exposes candidate NOTES but NO scorecard /
// test-result / interview endpoint — technical-assessment feedback surfaces
// through notes (and whatever is inlined on candidate/application payloads).
// ===========================================================================

// === Vacancies ===

peopleForceServer.addTool({
  name: 'listVacancies',
  annotations: { readOnlyHint: true },
  description:
    'Lists recruitment vacancies (job openings). Filter by `status` (drafting, opened, closed, held, cancelled, archived) and/or `tagIds`. Paginated (server-fixed page size). Use this to find the vacancy a candidate pipeline belongs to.',
  parameters: z.object({
    page: z.number().int().min(1).optional().default(1).describe('Page number (1-based).'),
    status: z.array(z.string()).optional().describe('Filter by one or more statuses: drafting, opened, closed, held, cancelled, archived.'),
    tagIds: z.array(z.union([z.string(), z.number()])).optional().describe('Filter by one or more vacancy tag IDs.'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to list vacancies', session, log, async (client) => {
      log.info(`Listing PeopleForce vacancies (page=${args.page})`);
      const res = await client.listVacancies({ page: args.page, status: args.status, tagIds: args.tagIds });
      return formatVacancyList(res.data ?? [], res.metadata?.pagination);
    }),
});

peopleForceServer.addTool({
  name: 'getVacancy',
  annotations: { readOnlyHint: true },
  description:
    'Retrieves a single recruitment vacancy by ID, including its internal job description and pipeline stages. Use the description to match a candidate against the role.',
  parameters: z.object({
    vacancyId: z.union([z.string(), z.number()]).describe('The vacancy ID (from listVacancies).'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to fetch vacancy', session, log, async (client) => {
      log.info(`Fetching PeopleForce vacancy ${args.vacancyId}`);
      const res = await client.getVacancy(args.vacancyId);
      if (!res?.data) throw new UserError('Vacancy not found.');
      return formatVacancy(res.data);
    }),
});

addPaginatedListTool({
  name: 'listRecruitmentPipelines',
  description:
    'Lists recruitment pipelines and their stage definitions (with stage IDs). Call this to find the `pipelineStageId` needed for listCandidates or moveVacancyApplication.',
  errorPrefix: 'Failed to list recruitment pipelines',
  fetch: (client, page) => client.listRecruitmentPipelines({ page }),
  format: formatPipelineList,
});

// === Candidates ===

peopleForceServer.addTool({
  name: 'listCandidates',
  annotations: { readOnlyHint: true },
  description:
    'Lists recruitment candidates. Filter by `vacancyIds` (candidates applied to those vacancies), `pipelineStageId` (candidates at a stage), `skills` (stack), `email`, and created/updated date ranges (YYYY-MM-DD or ISO). This is the entry point for pulling a role\'s pipeline excerpt.',
  parameters: z.object({
    page: z.number().int().min(1).optional().default(1).describe('Page number (1-based).'),
    vacancyIds: z.array(z.union([z.string(), z.number()])).optional().describe('Filter to candidates on these vacancy IDs.'),
    pipelineStageId: z.union([z.string(), z.number()]).optional().describe('Filter to candidates at this pipeline stage ID (from listRecruitmentPipelines).'),
    skills: z.array(z.string()).optional().describe('Filter by skill names (stack), e.g. ["React","Node.js"].'),
    email: z.string().optional().describe('Match a candidate by email address.'),
    createdAtGte: z.string().optional().describe('Only candidates created on/after this date (YYYY-MM-DD or ISO).'),
    createdAtLte: z.string().optional().describe('Only candidates created on/before this date.'),
    updatedAtGte: z.string().optional().describe('Only candidates updated on/after this date.'),
    updatedAtLte: z.string().optional().describe('Only candidates updated on/before this date.'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to list candidates', session, log, async (client) => {
      log.info(`Listing PeopleForce candidates (page=${args.page})`);
      const res = await client.listCandidates({
        page: args.page,
        vacancyIds: args.vacancyIds,
        pipelineStageId: args.pipelineStageId,
        skills: args.skills,
        email: args.email,
        createdAtGte: args.createdAtGte,
        createdAtLte: args.createdAtLte,
        updatedAtGte: args.updatedAtGte,
        updatedAtLte: args.updatedAtLte,
      });
      return formatCandidateList(res.data ?? [], res.metadata?.pagination);
    }),
});

peopleForceServer.addTool({
  name: 'getCandidate',
  annotations: { readOnlyHint: true },
  description:
    'Retrieves a single recruitment candidate by ID: full profile (contact, location, source, skills, salary expectation, current stage/vacancy).',
  parameters: z.object({
    candidateId: z.union([z.string(), z.number()]).describe('The candidate ID.'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to fetch candidate', session, log, async (client) => {
      log.info(`Fetching PeopleForce candidate ${args.candidateId}`);
      const res = await client.getCandidate(args.candidateId);
      if (!res?.data) throw new UserError('Candidate not found.');
      return formatCandidate(res.data);
    }),
});

addCandidateScopedListTool({
  name: 'listCandidateNotes',
  description:
    'Lists recruiter notes on a candidate — the main place free-text feedback (including technical-assessment comments) is recorded. The public API has no separate scorecard/test-result endpoint.',
  errorPrefix: 'Failed to list candidate notes',
  fetch: (client, id) => client.listCandidateNotes(id),
  format: formatCandidateNotes,
});

addCandidateScopedListTool({
  name: 'listCandidateExperiences',
  description: 'Lists a candidate\'s work experience entries (company, role, dates) — used to assess years/stack.',
  errorPrefix: 'Failed to list candidate experiences',
  fetch: (client, id) => client.listCandidateExperiences(id),
  format: formatCandidateExperiences,
});

addCandidateScopedListTool({
  name: 'listCandidateEducations',
  description: 'Lists a candidate\'s education entries (institution, degree, field, dates).',
  errorPrefix: 'Failed to list candidate educations',
  fetch: (client, id) => client.listCandidateEducations(id),
  format: formatCandidateEducations,
});

peopleForceServer.addTool({
  name: 'listCandidateMovements',
  annotations: { readOnlyHint: true },
  description:
    'Lists candidate pipeline movements (stage transitions) across recruitment — the history of who moved where and when. Paginated.',
  parameters: z.object({
    page: z.number().int().min(1).optional().default(1).describe('Page number (1-based).'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to list candidate movements', session, log, async (client) => {
      log.info(`Listing PeopleForce candidate movements (page=${args.page})`);
      const res = await client.listCandidateMovements({ page: args.page });
      return formatMovementList(res.data ?? [], res.metadata?.pagination);
    }),
});

// === Applications ===

peopleForceServer.addTool({
  name: 'listVacancyApplications',
  annotations: { readOnlyHint: true },
  description:
    'Lists the applications (candidates) on a specific vacancy with their current pipeline stage — i.e. the vacancy\'s pipeline excerpt. Paginated.',
  parameters: z.object({
    vacancyId: z.union([z.string(), z.number()]).describe('The vacancy ID (from listVacancies).'),
    page: z.number().int().min(1).optional().default(1).describe('Page number (1-based).'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to list vacancy applications', session, log, async (client) => {
      log.info(`Listing applications for vacancy ${args.vacancyId} (page=${args.page})`);
      const res = await client.listVacancyApplications({ vacancyId: args.vacancyId, page: args.page });
      return formatApplicationList(res.data ?? [], res.metadata?.pagination);
    }),
});

peopleForceServer.addTool({
  name: 'getVacancyApplication',
  annotations: { readOnlyHint: true },
  description: 'Retrieves a single vacancy application by vacancy ID + application ID (candidate, current stage, disqualification).',
  parameters: z.object({
    vacancyId: z.union([z.string(), z.number()]).describe('The vacancy ID.'),
    applicationId: z.union([z.string(), z.number()]).describe('The application ID (from listVacancyApplications).'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to fetch vacancy application', session, log, async (client) => {
      log.info(`Fetching application ${args.applicationId} on vacancy ${args.vacancyId}`);
      const res = await client.getVacancyApplication({ vacancyId: args.vacancyId, applicationId: args.applicationId });
      if (!res?.data) throw new UserError('Vacancy application not found.');
      return formatApplicationList([res.data]);
    }),
});

// === Support / lookups ===

addPaginatedListTool({
  name: 'listDisqualifyReasons',
  description:
    'Lists recruitment disqualify reasons with their IDs. Call this to find the `disqualifyReasonId` needed for disqualifyVacancyApplication.',
  errorPrefix: 'Failed to list disqualify reasons',
  fetch: (client, page) => client.listDisqualifyReasons({ page }),
  format: (data, p) => formatNamedList('Disqualify Reasons', data, p),
});

addPaginatedListTool({
  name: 'listRecruitmentSources',
  description: 'Lists recruitment sources (where candidates came from) with their IDs.',
  errorPrefix: 'Failed to list recruitment sources',
  fetch: (client, page) => client.listRecruitmentSources({ page }),
  format: (data, p) => formatNamedList('Recruitment Sources', data, p),
});

// === Dossier (bundled read for AI assessment) ===

peopleForceServer.addTool({
  name: 'getCandidateDossier',
  annotations: { readOnlyHint: true },
  description:
    'Assembles a single candidate dossier for assessment: profile + recruiter notes + work experience + education, plus the current application/stage when `vacancyId` is given. One call to gather everything the AI needs to evaluate a candidate against a role. Best-effort: parts that fail to load are noted, not fatal.',
  parameters: z.object({
    candidateId: z.union([z.string(), z.number()]).describe('The candidate ID.'),
    vacancyId: z.union([z.string(), z.number()]).optional().describe('Optional vacancy ID to also resolve the candidate\'s application + current stage on that vacancy.'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to build candidate dossier', session, log, async (client) => {
      log.info(`Building dossier for candidate ${args.candidateId}${args.vacancyId ? ` on vacancy ${args.vacancyId}` : ''}`);
      const dossier = await client.getCandidateDossier({ candidateId: args.candidateId, vacancyId: args.vacancyId });
      return formatCandidateDossier(dossier);
    }),
});

// === Careers API (published job descriptions) ===

peopleForceServer.addTool({
  name: 'getPublishedJobDescription',
  annotations: { readOnlyHint: true },
  description:
    'Fetches the canonical public job description for a vacancy from the PeopleForce Careers API. Use this to get the exact JD text posted on your careers site for matching. Note: some tenants gate the Careers API behind a separate career-site token — if this returns not-authorized, use getVacancy\'s description instead.',
  parameters: z.object({
    vacancyId: z.union([z.string(), z.number()]).describe('The public careers vacancy ID.'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to fetch published job description', session, log, async (client) => {
      log.info(`Fetching published JD for vacancy ${args.vacancyId}`);
      const res = await client.getPublishedVacancy(args.vacancyId);
      return formatPublishedVacancy(res);
    }),
});

// === Write actions ===

peopleForceServer.addTool({
  name: 'moveVacancyApplication',
  annotations: { readOnlyHint: false },
  description:
    'Moves a candidate\'s vacancy application to a different pipeline stage. Needs the vacancy ID, application ID, and target `pipelineStageId` (from listRecruitmentPipelines or getVacancy).',
  parameters: z.object({
    vacancyId: z.union([z.string(), z.number()]).describe('The vacancy ID.'),
    applicationId: z.union([z.string(), z.number()]).describe('The application ID (from listVacancyApplications).'),
    pipelineStageId: z.union([z.string(), z.number()]).describe('The target pipeline stage ID.'),
    performAutomations: z.boolean().optional().describe('Whether to run the stage\'s automations (PeopleForce defaults to true).'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to move vacancy application', session, log, async (client) => {
      log.info(`Moving application ${args.applicationId} on vacancy ${args.vacancyId} to stage ${args.pipelineStageId}`);
      await client.moveVacancyApplication({
        vacancyId: args.vacancyId,
        applicationId: args.applicationId,
        pipelineStageId: args.pipelineStageId,
        performAutomations: args.performAutomations,
      });
      return `Moved application ${args.applicationId} to pipeline stage ${args.pipelineStageId}.`;
    }),
});

peopleForceServer.addTool({
  name: 'disqualifyVacancyApplication',
  annotations: { readOnlyHint: false },
  description:
    'Disqualifies a vacancy application with a reason. Needs the vacancy ID, application ID (from listVacancyApplications), and a `disqualifyReasonId` (from listDisqualifyReasons); an optional comment is recorded.',
  parameters: z.object({
    vacancyId: z.union([z.string(), z.number()]).describe('The vacancy ID.'),
    applicationId: z.union([z.string(), z.number()]).describe('The application ID (from listVacancyApplications).'),
    disqualifyReasonId: z.union([z.string(), z.number()]).describe('The disqualify reason ID (from listDisqualifyReasons).'),
    comment: z.string().optional().describe('Optional comment explaining the disqualification.'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to disqualify vacancy application', session, log, async (client) => {
      log.info(`Disqualifying application ${args.applicationId} on vacancy ${args.vacancyId} (reason ${args.disqualifyReasonId})`);
      await client.disqualifyVacancyApplication({
        vacancyId: args.vacancyId,
        applicationId: args.applicationId,
        disqualifyReasonId: args.disqualifyReasonId,
        comment: args.comment,
      });
      return `Disqualified application ${args.applicationId}.`;
    }),
});

peopleForceServer.addTool({
  name: 'addCandidateNote',
  annotations: { readOnlyHint: false },
  description:
    'Adds a note to a candidate — e.g. to record the AI\'s assessment or interview feedback back into PeopleForce. The note appears on the candidate card.',
  parameters: z.object({
    candidateId: z.union([z.string(), z.number()]).describe('The candidate ID.'),
    body: z.string().min(1).describe('The note text.'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to add candidate note', session, log, async (client) => {
      log.info(`Adding note to candidate ${args.candidateId}`);
      await client.addCandidateNote({ candidateId: args.candidateId, body: args.body });
      return `Note added to candidate ${args.candidateId}.`;
    }),
});
