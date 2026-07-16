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
