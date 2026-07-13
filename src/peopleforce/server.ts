// src/peopleforce/server.ts
// PeopleForce HRIS MCP server. Tools cover the core employee/department/absence
// surface of the public REST API (https://apidoc.peopleforce.io/).

import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';

import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import {
  formatAbsenceList,
  formatDepartmentList,
  formatEmployee,
  formatEmployeeList,
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

// === Absences ===

peopleForceServer.addTool({
  name: 'listAbsences',
  annotations: { readOnlyHint: true },
  description: 'Lists PeopleForce absences (time off, sick leave, etc.). Supports employee, status, and date-range filters.',
  parameters: z.object({
    page: z.number().int().min(1).optional().default(1).describe('Page number (1-based).'),
    perPage: z.number().int().min(1).max(100).optional().default(25).describe('Results per page (max 100).'),
    employeeId: z.union([z.string(), z.number()]).optional().describe('Restrict to a single employee ID.'),
    status: z.string().optional().describe('Filter by status (e.g. "approved", "pending").'),
    startFrom: z.string().optional().describe('Include absences starting on/after this ISO date (YYYY-MM-DD).'),
    startTo: z.string().optional().describe('Include absences starting on/before this ISO date (YYYY-MM-DD).'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to list absences', session, log, async (client) => {
      log.info(`Listing PeopleForce absences (page=${args.page})`);
      const res = await client.listAbsences({
        page: args.page,
        per_page: args.perPage,
        employeeId: args.employeeId,
        status: args.status,
        startFrom: args.startFrom,
        startTo: args.startTo,
      });
      return formatAbsenceList(res.data ?? [], res.meta);
    }),
});

peopleForceServer.addTool({
  name: 'createAbsence',
  description: 'Creates a new PeopleForce absence (time-off request) for an employee against a specific policy.',
  parameters: z.object({
    employeeId: z.union([z.string(), z.number()]).describe('The employee ID the absence is for.'),
    policyId: z.union([z.string(), z.number()]).describe('The absence policy ID (from PeopleForce settings).'),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use ISO date format YYYY-MM-DD.').describe('Absence start date (YYYY-MM-DD).'),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use ISO date format YYYY-MM-DD.').describe('Absence end date (YYYY-MM-DD).'),
    reason: z.string().optional().describe('Optional reason/comment.'),
  }),
  execute: (args, { log, session }) =>
    withPeopleForceClient('Failed to create absence', session, log, async (client) => {
      log.info(`Creating PeopleForce absence for employee ${args.employeeId}`);
      const res = await client.createAbsence({
        employeeId: args.employeeId,
        policyId: args.policyId,
        startDate: args.startDate,
        endDate: args.endDate,
        reason: args.reason,
      });
      if (!res?.data) throw new UserError('Failed to create absence.');
      return `Absence created successfully (ID: ${res.data.id ?? 'unknown'})`;
    }),
});
