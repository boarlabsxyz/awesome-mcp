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

peopleForceServer.addTool({
  name: 'listDepartments',
  annotations: { readOnlyHint: true },
  description: 'Lists all PeopleForce departments, 50 per page (server-fixed). Use `page` to paginate.',
  parameters: z.object({
    page: z.number().int().min(1).optional().default(1).describe('Page number (1-based). 50 departments per page (server-fixed).'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to list departments', session, log, async (client) => {
      log.info(`Listing PeopleForce departments (page=${args.page})`);
      const res = await client.listDepartments({ page: args.page });
      return formatDepartmentList(res.data ?? [], res.metadata?.pagination);
    }),
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
  description: 'Creates a new PeopleForce leave request (time off) for an employee against a specific leave-type ID. Call `listLeaveTypes` first if you need the ID.',
  parameters: z.object({
    employeeId: z.union([z.string(), z.number()]).describe('The employee ID the leave request is for.'),
    leaveTypeId: z.union([z.string(), z.number()]).describe('The leave-type ID (from listLeaveTypes — NOT the name).'),
    startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use ISO date format YYYY-MM-DD.').describe('First day of leave (YYYY-MM-DD).'),
    endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use ISO date format YYYY-MM-DD.').describe('Last day of leave (YYYY-MM-DD).'),
    comment: z.string().optional().describe('Optional comment on the request.'),
  }),
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

peopleForceServer.addTool({
  name: 'listLeaveTypes',
  annotations: { readOnlyHint: true },
  description:
    'Lists PeopleForce leave types (Vacation, Sick, Sabbatical, etc.) with their IDs and time-tracking unit (days/hours). Call this to find the `leaveTypeId` needed for `createLeaveRequest`.',
  parameters: z.object({
    page: z.number().int().min(1).optional().default(1).describe('Page number (1-based). Server-fixed 50 per page.'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to list leave types', session, log, async (client) => {
      log.info(`Listing PeopleForce leave types (page=${args.page})`);
      const res = await client.listLeaveTypes({ page: args.page });
      return formatLeaveTypeList(res.data ?? [], res.metadata?.pagination);
    }),
});

peopleForceServer.addTool({
  name: 'listPositions',
  annotations: { readOnlyHint: true },
  description: 'Lists all PeopleForce job positions with their IDs. Server-fixed 50 per page.',
  parameters: z.object({
    page: z.number().int().min(1).optional().default(1).describe('Page number (1-based).'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to list positions', session, log, async (client) => {
      log.info(`Listing PeopleForce positions (page=${args.page})`);
      const res = await client.listPositions({ page: args.page });
      return formatNamedList('Positions', res.data ?? [], res.metadata?.pagination);
    }),
});

peopleForceServer.addTool({
  name: 'listDivisions',
  annotations: { readOnlyHint: true },
  description: 'Lists PeopleForce divisions (org-chart layer above departments) with their IDs.',
  parameters: z.object({
    page: z.number().int().min(1).optional().default(1).describe('Page number (1-based).'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to list divisions', session, log, async (client) => {
      log.info(`Listing PeopleForce divisions (page=${args.page})`);
      const res = await client.listDivisions({ page: args.page });
      return formatNamedList('Divisions', res.data ?? [], res.metadata?.pagination);
    }),
});

peopleForceServer.addTool({
  name: 'listLocations',
  annotations: { readOnlyHint: true },
  description: 'Lists PeopleForce office/remote locations with country code and time zone. Server-fixed 50 per page.',
  parameters: z.object({
    page: z.number().int().min(1).optional().default(1).describe('Page number (1-based).'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to list locations', session, log, async (client) => {
      log.info(`Listing PeopleForce locations (page=${args.page})`);
      const res = await client.listLocations({ page: args.page });
      return formatLocationList(res.data ?? [], res.metadata?.pagination);
    }),
});

peopleForceServer.addTool({
  name: 'listEmploymentTypes',
  annotations: { readOnlyHint: true },
  description: 'Lists PeopleForce employment types (Employee, Contractor, Intern, etc.) with their IDs.',
  parameters: z.object({}),
  execute: (_args, { log, session }) =>
    withPeopleForceClient('Failed to list employment types', session, log, async (client) => {
      log.info('Listing PeopleForce employment types');
      const res = await client.listEmploymentTypes();
      return formatNamedList('Employment Types', res.data ?? [], res.metadata?.pagination);
    }),
});

peopleForceServer.addTool({
  name: 'listJobLevels',
  annotations: { readOnlyHint: true },
  description: 'Lists PeopleForce job levels (Junior, Mid, Senior, Head of, etc.) with their IDs.',
  parameters: z.object({}),
  execute: (_args, { log, session }) =>
    withPeopleForceClient('Failed to list job levels', session, log, async (client) => {
      log.info('Listing PeopleForce job levels');
      const res = await client.listJobLevels();
      return formatNamedList('Job Levels', res.data ?? [], res.metadata?.pagination);
    }),
});

peopleForceServer.addTool({
  name: 'listSkills',
  annotations: { readOnlyHint: true },
  description: 'Lists the PeopleForce skills catalog (workspace-wide) with IDs. Server-fixed 50 per page.',
  parameters: z.object({
    page: z.number().int().min(1).optional().default(1).describe('Page number (1-based).'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to list skills', session, log, async (client) => {
      log.info(`Listing PeopleForce skills (page=${args.page})`);
      const res = await client.listSkills({ page: args.page });
      return formatNamedList('Skills', res.data ?? [], res.metadata?.pagination);
    }),
});

peopleForceServer.addTool({
  name: 'listCompetencies',
  annotations: { readOnlyHint: true },
  description: 'Lists PeopleForce competencies (behavioral/performance dimensions used in reviews) with their IDs.',
  parameters: z.object({}),
  execute: (_args, { log, session }) =>
    withPeopleForceClient('Failed to list competencies', session, log, async (client) => {
      log.info('Listing PeopleForce competencies');
      const res = await client.listCompetencies();
      return formatNamedList('Competencies', res.data ?? [], res.metadata?.pagination);
    }),
});

peopleForceServer.addTool({
  name: 'listTasks',
  annotations: { readOnlyHint: true },
  description: 'Lists PeopleForce tasks (onboarding, applicant follow-ups, etc.) with assignee, dates, and completion state. Server-fixed 50 per page.',
  parameters: z.object({
    page: z.number().int().min(1).optional().default(1).describe('Page number (1-based).'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to list tasks', session, log, async (client) => {
      log.info(`Listing PeopleForce tasks (page=${args.page})`);
      const res = await client.listTasks({ page: args.page });
      return formatTaskList(res.data ?? [], res.metadata?.pagination);
    }),
});

// === Employee-nested ===

peopleForceServer.addTool({
  name: 'listEmployeeLeaveBalances',
  annotations: { readOnlyHint: true },
  description: 'Lists a specific employee\'s current leave balances per leave type (e.g. "how many vacation days does this person have?").',
  parameters: z.object({
    employeeId: z.union([z.string(), z.number()]).describe('The employee ID.'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to list leave balances', session, log, async (client) => {
      log.info(`Listing PeopleForce leave balances for employee ${args.employeeId}`);
      const res = await client.listEmployeeLeaveBalances(args.employeeId);
      return formatLeaveBalances(res.data ?? []);
    }),
});

peopleForceServer.addTool({
  name: 'listEmployeeSkills',
  annotations: { readOnlyHint: true },
  description: 'Lists the skills recorded on a specific employee\'s profile with proficiency level.',
  parameters: z.object({
    employeeId: z.union([z.string(), z.number()]).describe('The employee ID.'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to list employee skills', session, log, async (client) => {
      log.info(`Listing PeopleForce skills for employee ${args.employeeId}`);
      const res = await client.listEmployeeSkills(args.employeeId);
      return formatEmployeeSkills(res.data ?? []);
    }),
});

peopleForceServer.addTool({
  name: 'listEmployeeDocuments',
  annotations: { readOnlyHint: true },
  description: 'Lists documents attached to a specific employee\'s profile. Payload shape is dumped as JSON since the public API doesn\'t document a fixed schema for this endpoint.',
  parameters: z.object({
    employeeId: z.union([z.string(), z.number()]).describe('The employee ID.'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to list employee documents', session, log, async (client) => {
      log.info(`Listing PeopleForce documents for employee ${args.employeeId}`);
      const res = await client.listEmployeeDocuments(args.employeeId);
      return formatUnknownItemList('Employee Documents', res.data ?? []);
    }),
});

peopleForceServer.addTool({
  name: 'listEmployeeNotes',
  annotations: { readOnlyHint: true },
  description: 'Lists HR notes on a specific employee\'s profile. Payload dumped as JSON (undocumented shape).',
  parameters: z.object({
    employeeId: z.union([z.string(), z.number()]).describe('The employee ID.'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to list employee notes', session, log, async (client) => {
      log.info(`Listing PeopleForce notes for employee ${args.employeeId}`);
      const res = await client.listEmployeeNotes(args.employeeId);
      return formatUnknownItemList('Employee Notes', res.data ?? []);
    }),
});

peopleForceServer.addTool({
  name: 'listEmployeeEmergencyContacts',
  annotations: { readOnlyHint: true },
  description: 'Lists emergency contacts on a specific employee\'s profile. Payload dumped as JSON (undocumented shape).',
  parameters: z.object({
    employeeId: z.union([z.string(), z.number()]).describe('The employee ID.'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to list emergency contacts', session, log, async (client) => {
      log.info(`Listing PeopleForce emergency contacts for employee ${args.employeeId}`);
      const res = await client.listEmployeeEmergencyContacts(args.employeeId);
      return formatUnknownItemList('Emergency Contacts', res.data ?? []);
    }),
});
