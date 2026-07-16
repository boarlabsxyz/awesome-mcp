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
  formatLeaveRequestList,
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
  description: 'Creates a new PeopleForce leave request (time off) for an employee against a specific leave-type ID.',
  parameters: z.object({
    employeeId: z.union([z.string(), z.number()]).describe('The employee ID the leave request is for.'),
    leaveTypeId: z.union([z.string(), z.number()]).describe('The leave-type ID (from PeopleForce settings — NOT the name).'),
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
