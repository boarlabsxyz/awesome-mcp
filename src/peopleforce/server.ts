// src/peopleforce/server.ts
// PeopleForce HRIS MCP server. Tools cover the core employee/department/absence
// surface of the public REST API (https://apidoc.peopleforce.io/).

import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';

import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import {
  formatDepartmentList,
  formatEmployee,
  formatEmployeeList,
  formatLeaveRequestList,
  withPeopleForceClient,
} from './apiHelpers.js';

export const peopleForceServer = new FastMCP<UserSession>({
  name: 'PeopleForce MCP Server',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'peopleforce'),
});

// === Employees ===

peopleForceServer.addTool({
  name: 'listEmployees',
  annotations: { readOnlyHint: true },
  description: 'Lists PeopleForce employees. Paginated; supports optional status and department filters.',
  parameters: z.object({
    page: z.number().int().min(1).optional().default(1).describe('Page number (1-based).'),
    perPage: z.number().int().min(1).max(100).optional().default(25).describe('Results per page (max 100).'),
    status: z.string().optional().describe('Filter by status (e.g. "active", "terminated").'),
    departmentId: z.union([z.string(), z.number()]).optional().describe('Restrict to a single department ID.'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to list employees', session, log, async (client) => {
      log.info(`Listing PeopleForce employees (page=${args.page}, perPage=${args.perPage})`);
      const res = await client.listEmployees({
        page: args.page,
        per_page: args.perPage,
        status: args.status,
        departmentId: args.departmentId,
      });
      return formatEmployeeList(res.data ?? [], res.meta);
    }),
});

peopleForceServer.addTool({
  name: 'getEmployee',
  annotations: { readOnlyHint: true },
  description: 'Retrieves a single PeopleForce employee by ID.',
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
  description: 'Lists all PeopleForce departments in the workspace (paginated).',
  parameters: z.object({
    page: z.number().int().min(1).optional().default(1).describe('Page number (1-based).'),
    perPage: z.number().int().min(1).max(100).optional().default(100).describe('Results per page (max 100).'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to list departments', session, log, async (client) => {
      log.info(`Listing PeopleForce departments (page=${args.page})`);
      const res = await client.listDepartments({ page: args.page, per_page: args.perPage });
      return formatDepartmentList(res.data ?? []);
    }),
});

// === Leave requests ===

peopleForceServer.addTool({
  name: 'listLeaveRequests',
  annotations: { readOnlyHint: true },
  description: 'Lists PeopleForce leave requests (time off, sick leave, etc.). Supports employee, state, and date-range filters.',
  parameters: z.object({
    page: z.number().int().min(1).optional().default(1).describe('Page number (1-based).'),
    perPage: z.number().int().min(1).max(100).optional().default(25).describe('Results per page (max 100).'),
    employeeId: z.union([z.string(), z.number()]).optional().describe('Restrict to a single employee ID.'),
    state: z.string().optional().describe('Filter by leave-request state (e.g. "approved", "pending", "declined").'),
    startsFrom: z.string().optional().describe('Include leave requests starting on/after this ISO date (YYYY-MM-DD).'),
    startsTo: z.string().optional().describe('Include leave requests starting on/before this ISO date (YYYY-MM-DD).'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to list leave requests', session, log, async (client) => {
      log.info(`Listing PeopleForce leave requests (page=${args.page})`);
      const res = await client.listLeaveRequests({
        page: args.page,
        per_page: args.perPage,
        employeeId: args.employeeId,
        state: args.state,
        startsFrom: args.startsFrom,
        startsTo: args.startsTo,
      });
      return formatLeaveRequestList(res.data ?? [], res.meta);
    }),
});

peopleForceServer.addTool({
  name: 'createLeaveRequest',
  description: 'Creates a new PeopleForce leave request (time off) for an employee against a specific leave type.',
  parameters: z.object({
    employeeId: z.union([z.string(), z.number()]).describe('The employee ID the leave request is for.'),
    leaveType: z.union([z.string(), z.number()]).describe('The leave-type ID (from PeopleForce settings).'),
    startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use ISO date format YYYY-MM-DD.').describe('First day of leave (YYYY-MM-DD).'),
    endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use ISO date format YYYY-MM-DD.').describe('Last day of leave (YYYY-MM-DD).'),
    description: z.string().optional().describe('Optional description/comment.'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to create leave request', session, log, async (client) => {
      log.info(`Creating PeopleForce leave request for employee ${args.employeeId}`);
      const res = await client.createLeaveRequest({
        employeeId: args.employeeId,
        leaveType: args.leaveType,
        startsOn: args.startsOn,
        endsOn: args.endsOn,
        description: args.description,
      });
      if (!res?.data) throw new UserError('Failed to create leave request.');
      return `Leave request created successfully (ID: ${res.data.id ?? 'unknown'})`;
    }),
});
