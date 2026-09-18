// src/peopleforce-v4/server.ts
// PeopleForce Company API **v4** MCP server (slug: peopleforce-v4).
//
// Separate from the `peopleforce` server on purpose — see apiHelpers.ts for the
// full reasoning. The short version: a v4 service-account key cannot call
// v1–v3 and a Company key cannot call v4, so the two connectors hold different
// credentials; and v4's surface is a *different* set, not a superset. What v4
// does NOT have (all of it still lives on the `peopleforce` connector):
// recruitment, leave requests/balances/types, knowledge base, skills,
// competencies, KPIs and employee custom tables. What it adds, and v3 never
// had: termination dates + reasons, terminated-people and birthday/anniversary
// feeds, salaries, lifecycle records, review cycles/responses, Pulse surveys
// and compliance cases.
//
// Every tool here is subject to the service account's ROLE. Records outside the
// role's population are omitted from a 200 rather than denied, and ungranted
// fields are absent rather than null — the formatters call both out instead of
// rendering a silent gap.

import { FastMCP } from 'fastmcp';
import { z } from 'zod';

import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import { isoDate } from '../util/isoDate.js';
import {
  PeopleForceV4Client,
  V4ListResponse,
  V4Pagination,
  withPeopleForceV4Client,
  formatPersonList,
  formatPerson,
  formatNamedList,
  formatDepartmentList,
  formatLocationList,
  formatSalaryList,
  formatSalary,
  formatLifecycleList,
  formatObjectiveList,
  formatObjective,
  formatReviewCycleList,
  formatReviewResponseList,
  formatSurveyList,
  formatSurveyResponseList,
  formatComplianceCaseList,
  formatComplianceCase,
  formatComplianceDocumentList,
  formatComplianceDocument,
  PERSON_STATUS_VALUES,
  OBJECTIVE_STATUS_VALUES,
  OBJECTIVE_STATE_VALUES,
  OBJECTIVE_TYPE_VALUES,
  REVIEW_CYCLE_TYPE_VALUES,
  LIFECYCLE_SURVEY_STATUS_VALUES,
  ENGAGEMENT_SURVEY_STATUS_VALUES,
  COMPLIANCE_CASE_STATUS_VALUES,
  COMPLIANCE_DOCUMENT_STATUS_VALUES,
} from './apiHelpers.js';

export const peopleForceV4Server = new FastMCP<UserSession>({
  name: 'PeopleForce v4 MCP',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'peopleforce-v4'),
});

// ---------------------------------------------------------------------------
// Shared argument shapes
// ---------------------------------------------------------------------------

/**
 * The three paging knobs every v4 list endpoint accepts. `perPage` is new in
 * v4 (v1–v3 fixed it at 50). PeopleForce enforces no maximum; this caps at 500
 * so a single tool call cannot try to pull a whole tenant into one response.
 */
const pageArgs = {
  page: z.number().int().min(1).optional().describe('Page number, 1-based. Default 1.'),
  perPage: z.number().int().min(1).max(500).optional().describe('Results per page. v4 defaults to 50. Capped at 500 here.'),
  offset: z.number().int().min(0).optional().describe('Skip this many results before the page starts.'),
};

const dateRange = (what: string) =>
  z
    .object({ gte: isoDate.optional(), lte: isoDate.optional() })
    .optional()
    .describe(`Filter by ${what}: { gte, lte } as YYYY-MM-DD. Either bound may be omitted.`);

const idArg = z.union([z.string(), z.number()]);

/** Note appended to every list tool's description — the ceiling is the same for all of them. */
const ROLE_SCOPE_NOTE =
  ' Results are limited to the service account role\'s population: rows it cannot see are omitted from a successful ' +
  'response, so a count is a floor, not a total.';

type PagingArgs = { page?: number; perPage?: number; offset?: number };

/** Register a read-only list tool. `parameters` is merged on top of the paging knobs. */
function addListTool<T, A extends Record<string, unknown>>(config: {
  name: string;
  description: string;
  errorPrefix: string;
  parameters?: z.ZodRawShape;
  fetch: (client: PeopleForceV4Client, args: A & PagingArgs) => Promise<V4ListResponse<T>>;
  format: (rows: T[], pagination?: V4Pagination) => string;
}) {
  peopleForceV4Server.addTool({
    name: config.name,
    annotations: { readOnlyHint: true },
    description: config.description + ROLE_SCOPE_NOTE,
    parameters: z.object({ ...pageArgs, ...(config.parameters ?? {}) }),
    execute: (args: any, { log, session }) =>
      withPeopleForceV4Client(config.errorPrefix, session, log, async (client) => {
        log.info(`${config.name} (page=${args.page ?? 1})`);
        const res = await config.fetch(client, args);
        return config.format(res.data ?? [], res.metadata);
      }),
  });
}

/** Register a read-only get-by-id tool. */
function addGetTool<T>(config: {
  name: string;
  description: string;
  errorPrefix: string;
  idLabel: string;
  fetch: (client: PeopleForceV4Client, id: string | number) => Promise<T>;
  format: (row: T) => string;
}) {
  peopleForceV4Server.addTool({
    name: config.name,
    annotations: { readOnlyHint: true },
    description: config.description,
    parameters: z.object({ id: idArg.describe(config.idLabel) }),
    execute: (args, { log, session }) =>
      withPeopleForceV4Client(config.errorPrefix, session, log, async (client) => {
        log.info(`${config.name} ${args.id}`);
        return config.format(await config.fetch(client, args.id));
      }),
  });
}

/** Register a person-scoped list tool. These endpoints take no paging params. */
function addPersonScopedListTool<T>(config: {
  name: string;
  description: string;
  errorPrefix: string;
  fetch: (client: PeopleForceV4Client, personId: string | number) => Promise<V4ListResponse<T>>;
  format: (rows: T[], pagination?: V4Pagination) => string;
}) {
  peopleForceV4Server.addTool({
    name: config.name,
    annotations: { readOnlyHint: true },
    description: config.description,
    parameters: z.object({ personId: idArg.describe('The person ID (from listPeople).') }),
    execute: (args, { log, session }) =>
      withPeopleForceV4Client(config.errorPrefix, session, log, async (client) => {
        log.info(`${config.name} for person ${args.personId}`);
        const res = await config.fetch(client, args.personId);
        return config.format(res.data ?? [], res.metadata);
      }),
  });
}

/**
 * Register a create tool for a name-only org-structure resource (divisions,
 * job titles, job levels, work types — v4 takes exactly `name` for all four).
 *
 * Create and update are separate helpers, each taking a literal tool name and
 * description, rather than one helper registering the pair: the MCP_TOOLS.md
 * generator is a static scan that reads `name:` / `description:` off the call
 * site, so a helper that minted two names internally would leave both tools
 * undocumented.
 */
function addNamedCreateTool(config: {
  name: string;
  description: string;
  singular: string;
  create: (client: PeopleForceV4Client, body: Record<string, unknown>) => Promise<{ id?: number; name?: string }>;
}) {
  peopleForceV4Server.addTool({
    name: config.name,
    description: config.description,
    parameters: z.object({ name: z.string().min(1).describe(`Name of the new ${config.singular}.`) }),
    execute: (args, { log, session }) =>
      withPeopleForceV4Client(`Error creating ${config.singular}`, session, log, async (client) => {
        log.info(`${config.name} ${args.name}`);
        const row = await config.create(client, { name: args.name });
        return `Created ${config.singular} #${row.id ?? '?'}: ${row.name ?? '(unnamed)'}`;
      }),
  });
}

/** Rename counterpart to {@link addNamedCreateTool}. */
function addNamedUpdateTool(config: {
  name: string;
  description: string;
  singular: string;
  update: (client: PeopleForceV4Client, id: string | number, body: Record<string, unknown>) => Promise<{ id?: number; name?: string }>;
}) {
  peopleForceV4Server.addTool({
    name: config.name,
    description: config.description,
    parameters: z.object({
      id: idArg.describe(`The ${config.singular} ID.`),
      name: z.string().min(1).describe(`New name for the ${config.singular}.`),
    }),
    execute: (args, { log, session }) =>
      withPeopleForceV4Client(`Error updating ${config.singular}`, session, log, async (client) => {
        log.info(`${config.name} ${args.id}`);
        const row = await config.update(client, args.id, { name: args.name });
        return `Updated ${config.singular} #${row.id ?? args.id}: ${row.name ?? '(unnamed)'}`;
      }),
  });
}

// ---------------------------------------------------------------------------
// People — reads
// ---------------------------------------------------------------------------

addListTool({
  name: 'listPeople',
  description:
    'List people in PeopleForce. Unlike the v2/v3 connector — where omitting the status filter silently returned ' +
    'active employees only and no "everyone" value existed — v4 defaults to status=all, so this returns the whole ' +
    'directory (including terminated people) unless you filter. Supports filtering by status, IDs, emails, person ' +
    'numbers, manager, legal entity, hire date and creation date.',
  errorPrefix: 'Error listing people',
  parameters: {
    status: z.enum(PERSON_STATUS_VALUES).optional().describe('Filter by status. Defaults to "all" upstream.'),
    ids: z.array(z.number().int()).optional().describe('Filter to these person IDs.'),
    emails: z.array(z.string()).optional().describe('Filter to these work email addresses.'),
    personNumbers: z.array(z.string()).optional().describe('Filter to these person numbers.'),
    managerId: z.number().int().optional().describe('Only people reporting to this manager ID.'),
    legalEntityId: z.number().int().optional().describe('Only people in this legal entity.'),
    hiredOn: dateRange('hire date'),
    createdAt: dateRange('record creation date'),
  },
  fetch: (client, args: any) => client.listPeople(args),
  format: formatPersonList,
});

peopleForceV4Server.addTool({
  name: 'getPerson',
  annotations: { readOnlyHint: true },
  description:
    'Get one person by ID, including position, department, manager, hire date and (for departed people) termination ' +
    'date, type and reason. Fields the service account\'s role does not grant are absent from v4\'s response rather ' +
    'than empty; this tool lists which ones were withheld so a missing value is never read as "no value".',
  parameters: z.object({
    id: idArg.describe('The person ID (from listPeople).'),
    includeHistoricalValues: z
      .boolean()
      .optional()
      .describe('Include effective_on + historical_values for historical custom fields.'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceV4Client('Error getting person', session, log, async (client) => {
      log.info(`getPerson ${args.id}`);
      return formatPerson(await client.getPerson(args.id, args.includeHistoricalValues));
    }),
});

addListTool({
  name: 'listTerminatedPeople',
  description:
    'List people who have left, with their termination date, type and reason. This is the v4 answer to a question ' +
    'the v2/v3 API could not answer at all: it exposes no termination date anywhere, so "who left and when" (and ' +
    'anything derived from it, such as whether someone left during probation) was not computable there.',
  errorPrefix: 'Error listing terminated people',
  parameters: { terminatedOn: dateRange('termination date') },
  fetch: (client, args: any) => client.listTerminatedPeople(args),
  format: formatPersonList,
});

addListTool({
  name: 'listBirthdays',
  description:
    'List upcoming birthdays. Defaults upstream to today through 30 days out when no date range is given.',
  errorPrefix: 'Error listing birthdays',
  parameters: { date: dateRange('birthday occurrence date') },
  fetch: (client, args: any) => client.listBirthdays(args),
  format: formatPersonList,
});

addListTool({
  name: 'listWorkAnniversaries',
  description:
    'List upcoming work anniversaries. Defaults upstream to today through 30 days out when no date range is given.',
  errorPrefix: 'Error listing work anniversaries',
  parameters: { date: dateRange('anniversary occurrence date') },
  fetch: (client, args: any) => client.listWorkAnniversaries(args),
  format: formatPersonList,
});

addPersonScopedListTool({
  name: 'listPersonAssets',
  description: 'List the company assets assigned to a person (laptops, phones, access cards).',
  errorPrefix: 'Error listing person assets',
  fetch: (client, personId) => client.listPersonAssets(personId),
  format: (rows, pagination) => formatNamedList('assets', rows, pagination),
});

addPersonScopedListTool({
  name: 'listPersonSalaries',
  description:
    'List a person\'s salary history (amount, currency, pay period, effective date). Needs Compensation granted on ' +
    'the service account\'s role — without it the call 403s rather than returning an empty list.',
  errorPrefix: 'Error listing person salaries',
  fetch: (client, personId) => client.listPersonSalaries(personId),
  format: formatSalaryList,
});

peopleForceV4Server.addTool({
  name: 'getPersonSalary',
  annotations: { readOnlyHint: true },
  description: 'Get a single salary record for a person. Needs Compensation granted on the service account\'s role.',
  parameters: z.object({
    personId: idArg.describe('The person ID.'),
    salaryId: idArg.describe('The salary record ID (from listPersonSalaries).'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceV4Client('Error getting salary record', session, log, async (client) => {
      log.info(`getPersonSalary ${args.personId}/${args.salaryId}`);
      return formatSalary(await client.getPersonSalary(args.personId, args.salaryId));
    }),
});

addPersonScopedListTool({
  name: 'listPersonLifecycles',
  description:
    'List a person\'s lifecycle records — hire date, prior experience, last working day, last day in office, and ' +
    'termination type/reason/comment plus rehire eligibility. This is where a departure is dated in detail.',
  errorPrefix: 'Error listing person lifecycle records',
  fetch: (client, personId) => client.listPersonLifecycles(personId),
  format: formatLifecycleList,
});

// ---------------------------------------------------------------------------
// Core (org structure) — reads
// ---------------------------------------------------------------------------

addListTool({
  name: 'listDepartments',
  description: 'List departments, with parent department and manager IDs where set.',
  errorPrefix: 'Error listing departments',
  fetch: (client, args) => client.listDepartments(args),
  format: formatDepartmentList,
});

addGetTool({
  name: 'getDepartment',
  description: 'Get a single department by ID.',
  errorPrefix: 'Error getting department',
  idLabel: 'The department ID.',
  fetch: (client, id) => client.getDepartment(id),
  format: d => formatDepartmentList([d]),
});

addListTool({
  name: 'listDivisions',
  description: 'List divisions.',
  errorPrefix: 'Error listing divisions',
  fetch: (client, args) => client.listDivisions(args),
  format: (rows, pagination) => formatNamedList('divisions', rows, pagination),
});

addGetTool({
  name: 'getDivision',
  description: 'Get a single division by ID.',
  errorPrefix: 'Error getting division',
  idLabel: 'The division ID.',
  fetch: (client, id) => client.getDivision(id),
  format: d => formatNamedList('divisions', [d]),
});

addListTool({
  name: 'listWorkTypes',
  description: 'List work types (v4\'s name for what the v2/v3 connector calls employment types).',
  errorPrefix: 'Error listing work types',
  fetch: (client, args) => client.listWorkTypes(args),
  format: (rows, pagination) => formatNamedList('work types', rows, pagination),
});

addGetTool({
  name: 'getWorkType',
  description: 'Get a single work type by ID.',
  errorPrefix: 'Error getting work type',
  idLabel: 'The work type ID.',
  fetch: (client, id) => client.getWorkType(id),
  format: w => formatNamedList('work types', [w]),
});

addListTool({
  name: 'listJobLevels',
  description: 'List job levels. Note v4 exposes no get-by-id for job levels — list and filter client-side.',
  errorPrefix: 'Error listing job levels',
  fetch: (client, args) => client.listJobLevels(args),
  format: (rows, pagination) => formatNamedList('job levels', rows, pagination),
});

addListTool({
  name: 'listLocations',
  description: 'List locations with country, time zone and address. v4 exposes no get-by-id for locations.',
  errorPrefix: 'Error listing locations',
  fetch: (client, args) => client.listLocations(args),
  format: formatLocationList,
});

addListTool({
  name: 'listJobTitles',
  description:
    'List job titles (v4\'s name for what the v2/v3 connector calls positions). v4 exposes no get-by-id for job titles.',
  errorPrefix: 'Error listing job titles',
  fetch: (client, args) => client.listJobTitles(args),
  format: (rows, pagination) => formatNamedList('job titles', rows, pagination),
});

// ---------------------------------------------------------------------------
// Perform
// ---------------------------------------------------------------------------

addListTool({
  name: 'listObjectives',
  description:
    'List objectives (OKRs) with their key results, progress and owner. v4 adds the server-side filters v3 lacked ' +
    'entirely — status, state, type, owner, department/division/location/team, and start/end date ranges — so ' +
    'period filtering no longer has to happen client-side.',
  errorPrefix: 'Error listing objectives',
  parameters: {
    status: z.enum(OBJECTIVE_STATUS_VALUES).optional().describe('Filter by health status.'),
    states: z.array(z.enum(OBJECTIVE_STATE_VALUES)).optional().describe('Filter by lifecycle state.'),
    objectiveTypes: z.array(z.enum(OBJECTIVE_TYPE_VALUES)).optional().describe('Filter by objective type.'),
    ownerIds: z.array(z.number().int()).optional().describe('Filter by owner (person) IDs.'),
    departmentIds: z.array(z.number().int()).optional().describe('Filter by department IDs.'),
    divisionIds: z.array(z.number().int()).optional().describe('Filter by division IDs.'),
    locationIds: z.array(z.number().int()).optional().describe('Filter by location IDs.'),
    teamIds: z.array(z.number().int()).optional().describe('Filter by team IDs.'),
    startsOn: dateRange('objective start date'),
    endsOn: dateRange('objective end date'),
  },
  fetch: (client, args: any) => client.listObjectives(args),
  format: formatObjectiveList,
});

addGetTool({
  name: 'getObjective',
  description: 'Get a single objective by ID, including every key result with its current and target values.',
  errorPrefix: 'Error getting objective',
  idLabel: 'The objective ID.',
  fetch: (client, id) => client.getObjective(id),
  format: formatObjective,
});

addListTool({
  name: 'listReviewCycles',
  description: 'List performance review cycles with their schedule, deadline and review period.',
  errorPrefix: 'Error listing review cycles',
  parameters: {
    reviewCycleType: z.enum(REVIEW_CYCLE_TYPE_VALUES).optional().describe('Filter by cycle kind.'),
    startsOn: dateRange('cycle start date'),
    endsOn: dateRange('cycle end date'),
  },
  fetch: (client, args: any) => client.listReviewCycles(args),
  format: formatReviewCycleList,
});

addListTool({
  name: 'listReviewResponses',
  description:
    'List individual review responses (one row per participant per review), including the submitted answers. ' +
    'Filter by cycle, review, or reviewee.',
  errorPrefix: 'Error listing review responses',
  parameters: {
    reviewCycleIds: z.array(z.number().int()).optional().describe('Filter by review cycle IDs.'),
    reviewIds: z.array(z.number().int()).optional().describe('Filter by review IDs.'),
    revieweeIds: z.array(z.number().int()).optional().describe('Filter by reviewee (person) IDs.'),
    reviewCycleType: z.enum(REVIEW_CYCLE_TYPE_VALUES).optional().describe('Filter by cycle kind.'),
    createdAt: dateRange('response creation date'),
  },
  fetch: (client, args: any) => client.listReviewResponses(args),
  format: formatReviewResponseList,
});

// ---------------------------------------------------------------------------
// Pulse (surveys)
// ---------------------------------------------------------------------------

addListTool({
  name: 'listLifecycleSurveys',
  description: 'List Pulse lifecycle surveys (onboarding, exit, and other lifecycle-triggered surveys).',
  errorPrefix: 'Error listing lifecycle surveys',
  parameters: { status: z.enum(LIFECYCLE_SURVEY_STATUS_VALUES).optional().describe('Filter by survey status.') },
  fetch: (client, args: any) => client.listLifecycleSurveys(args),
  format: (rows, pagination) => formatSurveyList('lifecycle surveys', rows, pagination),
});

addListTool({
  name: 'listLifecycleSurveyResponses',
  description:
    'List responses to lifecycle surveys. Anonymous surveys return user_id: null by design — the respondent is ' +
    'not identifiable and is reported as anonymous rather than as an unknown employee.',
  errorPrefix: 'Error listing lifecycle survey responses',
  parameters: {
    surveyIds: z.array(z.number().int()).optional().describe('Filter by lifecycle survey IDs.'),
    userIds: z.array(z.number().int()).optional().describe('Filter by employee IDs.'),
    createdAt: dateRange('response creation date'),
  },
  fetch: (client, args: any) => client.listLifecycleSurveyResponses(args),
  format: formatSurveyResponseList,
});

addListTool({
  name: 'listEngagementSurveys',
  description: 'List Pulse engagement surveys with their schedule and status.',
  errorPrefix: 'Error listing engagement surveys',
  parameters: { status: z.enum(ENGAGEMENT_SURVEY_STATUS_VALUES).optional().describe('Filter by survey status.') },
  fetch: (client, args: any) => client.listEngagementSurveys(args),
  format: (rows, pagination) => formatSurveyList('engagement surveys', rows, pagination),
});

addListTool({
  name: 'listEngagementSurveyResponses',
  description:
    'List responses to engagement surveys, with the demographic breakdown fields (department, division, work type, ' +
    'tenure). Anonymous surveys omit position/location/gender and return user_id: null by design.',
  errorPrefix: 'Error listing engagement survey responses',
  parameters: {
    surveyIds: z.array(z.number().int()).optional().describe('Filter by engagement survey IDs.'),
    userIds: z.array(z.number().int()).optional().describe('Filter by employee IDs.'),
    fields: z.array(z.string()).optional().describe('Employee custom-field internal names to include in each row.'),
    createdAt: dateRange('response creation date'),
  },
  fetch: (client, args: any) => client.listEngagementSurveyResponses(args),
  format: formatSurveyResponseList,
});

// ---------------------------------------------------------------------------
// Kadry (compliance cases + documents)
// ---------------------------------------------------------------------------

addListTool({
  name: 'listComplianceCases',
  description:
    'List compliance cases with their attached documents. Use documentPendingUpload to find cases still waiting ' +
    'on a file.',
  errorPrefix: 'Error listing compliance cases',
  parameters: {
    employeeIds: z.array(z.number().int()).optional().describe('Filter by employee IDs.'),
    statuses: z.array(z.enum(COMPLIANCE_CASE_STATUS_VALUES)).optional().describe('Filter by case status.'),
    documentStatuses: z.array(z.enum(COMPLIANCE_DOCUMENT_STATUS_VALUES)).optional().describe('Filter by document status.'),
    documentPendingUpload: z.boolean().optional().describe('Only cases with at least one document pending upload.'),
  },
  fetch: (client, args: any) => client.listComplianceCases(args),
  format: formatComplianceCaseList,
});

addGetTool({
  name: 'getComplianceCase',
  description: 'Get a single compliance case with every attached document.',
  errorPrefix: 'Error getting compliance case',
  idLabel: 'The compliance case ID.',
  fetch: (client, id) => client.getComplianceCase(id),
  format: formatComplianceCase,
});

addListTool({
  name: 'listComplianceCaseDocuments',
  description:
    'List compliance case documents across cases. Download URLs on attachments are short-lived — the expiry is ' +
    'reported next to each one, and a stale URL fails in a way that looks like a missing document.',
  errorPrefix: 'Error listing compliance case documents',
  parameters: {
    employeeIds: z.array(z.number().int()).optional().describe('Filter by employee IDs.'),
    complianceCaseIds: z.array(z.number().int()).optional().describe('Filter by compliance case IDs.'),
    statuses: z.array(z.enum(COMPLIANCE_DOCUMENT_STATUS_VALUES)).optional().describe('Filter by document status.'),
    pendingUpload: z.boolean().optional().describe('Only documents that still need a file uploaded.'),
  },
  fetch: (client, args: any) => client.listComplianceCaseDocuments(args),
  format: formatComplianceDocumentList,
});

addGetTool({
  name: 'getComplianceCaseDocument',
  description: 'Get a single compliance case document, including its short-lived download URL and expiry.',
  errorPrefix: 'Error getting compliance case document',
  idLabel: 'The compliance case document ID.',
  fetch: (client, id) => client.getComplianceCaseDocument(id),
  format: formatComplianceDocument,
});

// ---------------------------------------------------------------------------
// Writes
//
// Additive only: create + update. v4's delete, terminate and activate
// endpoints are deliberately NOT exposed — terminating a person or deleting a
// department is irreversible from here and an MCP tool call has no
// confirmation affordance. They can be added later behind an explicit
// decision; leaving them out costs nothing today.
// ---------------------------------------------------------------------------

/**
 * The person attributes v4 actually accepts on create/update. Notably ABSENT
 * upstream: department, position/job title, job level, location, work type and
 * manager. There is no v4 endpoint that sets them, so this tool cannot place a
 * new hire in the org chart — do that in the PeopleForce UI. Claiming
 * otherwise in a tool description would produce a silent no-op.
 */
const personWritableFields = {
  firstName: z.string().min(1).optional().describe('First name.'),
  lastName: z.string().min(1).optional().describe('Last name.'),
  middleName: z.string().optional().describe('Middle name.'),
  personNumber: z.string().optional().describe('Person number (employee number).'),
  email: z.string().email().optional().describe('Work email address.'),
  personalEmail: z.string().email().optional().describe('Personal email address.'),
  mobileNumber: z.string().optional().describe('Personal mobile number.'),
  workPhoneNumber: z.string().optional().describe('Work phone number.'),
  dateOfBirth: isoDate.optional().describe('Date of birth (YYYY-MM-DD).'),
  hiredOn: isoDate.optional().describe('Hire date (YYYY-MM-DD).'),
  gender: z.string().optional().describe('Gender.'),
};

/** camelCase args → the snake_case body v4 expects. Undefined keys are dropped. */
export function personBody(args: Record<string, unknown>): Record<string, unknown> {
  const map: Record<string, string> = {
    firstName: 'first_name',
    lastName: 'last_name',
    middleName: 'middle_name',
    personNumber: 'person_number',
    email: 'email',
    personalEmail: 'personal_email',
    mobileNumber: 'mobile_number',
    workPhoneNumber: 'work_phone_number',
    dateOfBirth: 'date_of_birth',
    hiredOn: 'hired_on',
    gender: 'gender',
  };
  const body: Record<string, unknown> = {};
  for (const [camel, snake] of Object.entries(map)) {
    if (args[camel] !== undefined) body[snake] = args[camel];
  }
  return body;
}

export const createPersonSchema = z.object({
  ...personWritableFields,
  firstName: z.string().min(1).describe('First name (required).'),
  lastName: z.string().min(1).describe('Last name (required).'),
});

/**
 * Update takes every field as optional, but an all-empty payload is rejected
 * before the API call: PUT with `{}` is a write that reports success while
 * changing nothing, which reads downstream as "the update was applied".
 */
export const updatePersonSchema = z
  .object({ id: idArg.describe('The person ID to update.'), ...personWritableFields })
  .refine(args => Object.keys(personBody(args as Record<string, unknown>)).length > 0, {
    message: 'Provide at least one field to update.',
  });

peopleForceV4Server.addTool({
  name: 'createPerson',
  description:
    'Create a person in PeopleForce. v4 accepts identity and contact details only — department, job title, job ' +
    'level, location, work type and manager CANNOT be set through the API and must be assigned in the PeopleForce ' +
    'UI. Requires Edit permission on the relevant fields via the service account\'s role.',
  parameters: createPersonSchema,
  execute: (args, { log, session }) =>
    withPeopleForceV4Client('Error creating person', session, log, async (client) => {
      log.info(`createPerson ${args.firstName} ${args.lastName}`);
      const person = await client.createPerson(personBody(args as Record<string, unknown>));
      return `Created person #${person.id ?? '?'}.\n\n${formatPerson(person)}`;
    }),
});

peopleForceV4Server.addTool({
  name: 'updatePerson',
  description:
    'Update a person\'s identity or contact details. Only the fields you pass are changed. Department, job title, ' +
    'job level, location, work type and manager are not writable through v4. Requires Edit (not View) on each field ' +
    'via the service account\'s role.',
  parameters: updatePersonSchema,
  execute: (args, { log, session }) =>
    withPeopleForceV4Client('Error updating person', session, log, async (client) => {
      log.info(`updatePerson ${args.id}`);
      const person = await client.updatePerson(args.id, personBody(args as Record<string, unknown>));
      return `Updated person #${person.id ?? args.id}.\n\n${formatPerson(person)}`;
    }),
});

peopleForceV4Server.addTool({
  name: 'createDepartment',
  description:
    'Create a department, optionally nested under a parent and with a manager. Requires the "Manage departments" ' +
    'permission on the service account\'s role (Company tab).',
  parameters: z.object({
    name: z.string().min(1).describe('Department name.'),
    parentId: z.number().int().optional().describe('Parent department ID, for a nested department.'),
    managerId: z.number().int().optional().describe('Manager person ID.'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceV4Client('Error creating department', session, log, async (client) => {
      log.info(`createDepartment ${args.name}`);
      const d = await client.createDepartment({ name: args.name, parent_id: args.parentId, manager_id: args.managerId });
      return `Created department #${d.id ?? '?'}.\n${formatDepartmentList([d])}`;
    }),
});

peopleForceV4Server.addTool({
  name: 'updateDepartment',
  description:
    'Update a department\'s name, parent or manager. v4 requires `name` on this PUT even when only the parent or ' +
    'manager is changing, so pass the current name to keep it. Requires "Manage departments" on the role.',
  parameters: z.object({
    id: idArg.describe('The department ID.'),
    name: z.string().min(1).describe('Department name (required by the API — pass the current name to keep it).'),
    parentId: z.number().int().optional().describe('Parent department ID.'),
    managerId: z.number().int().optional().describe('Manager person ID.'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceV4Client('Error updating department', session, log, async (client) => {
      log.info(`updateDepartment ${args.id}`);
      const d = await client.updateDepartment(args.id, { name: args.name, parent_id: args.parentId, manager_id: args.managerId });
      return `Updated department #${d.id ?? args.id}.\n${formatDepartmentList([d])}`;
    }),
});

peopleForceV4Server.addTool({
  name: 'createLocation',
  description:
    'Create a location. v4 accepts name and time zone only — country code and address are set in the PeopleForce ' +
    'UI. Requires the "Manage locations" permission on the service account\'s role.',
  parameters: z.object({
    name: z.string().min(1).describe('Location name.'),
    timeZone: z.string().optional().describe('IANA time zone, e.g. Europe/Kyiv.'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceV4Client('Error creating location', session, log, async (client) => {
      log.info(`createLocation ${args.name}`);
      const l = await client.createLocation({ name: args.name, time_zone: args.timeZone });
      return `Created location #${l.id ?? '?'}.\n${formatLocationList([l])}`;
    }),
});

peopleForceV4Server.addTool({
  name: 'updateLocation',
  description:
    'Update a location\'s name or time zone. `name` is required by the API even when only the time zone changes. ' +
    'Requires "Manage locations" on the role.',
  parameters: z.object({
    id: idArg.describe('The location ID.'),
    name: z.string().min(1).describe('Location name (required by the API — pass the current name to keep it).'),
    timeZone: z.string().optional().describe('IANA time zone, e.g. Europe/Kyiv.'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceV4Client('Error updating location', session, log, async (client) => {
      log.info(`updateLocation ${args.id}`);
      const l = await client.updateLocation(args.id, { name: args.name, time_zone: args.timeZone });
      return `Updated location #${l.id ?? args.id}.\n${formatLocationList([l])}`;
    }),
});

addNamedCreateTool({
  name: 'createDivision',
  description:
    'Create a division in PeopleForce. Requires the "Manage divisions" permission on the service account\'s role ' +
    '(Roles & permissions → Company tab).',
  singular: 'division',
  create: (client, body) => client.createDivision(body),
});

addNamedUpdateTool({
  name: 'updateDivision',
  description:
    'Rename an existing division. Requires the "Manage divisions" permission on the service account\'s role ' +
    '(Roles & permissions → Company tab).',
  singular: 'division',
  update: (client, id, body) => client.updateDivision(id, body),
});

addNamedCreateTool({
  name: 'createJobTitle',
  description:
    'Create a job title in PeopleForce. Requires the "Manage job titles" permission on the service account\'s role ' +
    '(Roles & permissions → Company tab).',
  singular: 'job title',
  create: (client, body) => client.createJobTitle(body),
});

addNamedUpdateTool({
  name: 'updateJobTitle',
  description:
    'Rename an existing job title. Requires the "Manage job titles" permission on the service account\'s role ' +
    '(Roles & permissions → Company tab).',
  singular: 'job title',
  update: (client, id, body) => client.updateJobTitle(id, body),
});

addNamedCreateTool({
  name: 'createJobLevel',
  description:
    'Create a job level in PeopleForce. Requires the "Manage job levels" permission on the service account\'s role ' +
    '(Roles & permissions → Company tab).',
  singular: 'job level',
  create: (client, body) => client.createJobLevel(body),
});

addNamedUpdateTool({
  name: 'updateJobLevel',
  description:
    'Rename an existing job level. Requires the "Manage job levels" permission on the service account\'s role ' +
    '(Roles & permissions → Company tab).',
  singular: 'job level',
  update: (client, id, body) => client.updateJobLevel(id, body),
});

addNamedCreateTool({
  name: 'createWorkType',
  description:
    'Create a work type in PeopleForce. Requires the "Manage work types" permission on the service account\'s role ' +
    '(Roles & permissions → Company tab).',
  singular: 'work type',
  create: (client, body) => client.createWorkType(body),
});

addNamedUpdateTool({
  name: 'updateWorkType',
  description:
    'Rename an existing work type. Requires the "Manage work types" permission on the service account\'s role ' +
    '(Roles & permissions → Company tab).',
  singular: 'work type',
  update: (client, id, body) => client.updateWorkType(id, body),
});
