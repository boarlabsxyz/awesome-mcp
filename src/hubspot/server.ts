// src/hubspot/server.ts
// HubSpot CRM MCP server. Tools cover contacts, companies, and property
// definitions on the public CRM v3 REST API, plus stubbed read tools for the
// engagement/conversation/ticket surface.
//
// Ported from https://github.com/baryhuang/mcp-hubspot@4a8345f2507b4159fc84eb500c74669329076f53
// The reference exposed 16 tools. 11 are translated here against the HubSpot
// CRM v3 REST API; 5 (get_company_activity, get_recent_conversations,
// get_tickets, get_ticket_conversation_threads, search_data) are TODO stubs —
// they rely on engagement fan-out, thread caching, retry/backoff, or a local
// FAISS vector store that has no equivalent in this codebase.

import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';

import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import {
  eqFilterGroup,
  formatCompany,
  formatContact,
  formatObjectList,
  formatProperty,
  recentCompaniesSearch,
  recentContactsSearch,
  withHubSpotClient,
} from './apiHelpers.js';

export const hubspotServer = new FastMCP<UserSession>({
  name: 'HubSpot MCP',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'hubspot'),
});

const objectTypeParam = z
  .enum(['companies', 'contacts'])
  .describe('Type of CRM object.');

const propertyOption = z.object({
  label: z.string().describe('Display label for the option.'),
  value: z.string().describe('Internal value for the option.'),
  description: z.string().optional().describe('Optional description for the option.'),
  displayOrder: z.number().int().optional().describe('Optional sort order for the option.'),
});

// ---------------------------------------------------------------------------
// Company tools
// ---------------------------------------------------------------------------

// Adapted from baryhuang/mcp-hubspot@4a8345f handlers/company_handler.py:105
hubspotServer.addTool({
  name: 'createCompany',
  description: 'Create a new company in HubSpot (skips creation if a company with the same name already exists).',
  parameters: z.object({
    name: z.string().describe('Company name.'),
    properties: z.record(z.string(), z.any()).optional().describe('Additional company properties (e.g. domain, industry).'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to create company', session, log, async (client) => {
      log.info(`createCompany name=${args.name}`);
      const search = await client.searchCompanies(eqFilterGroup([{ propertyName: 'name', value: args.name }]));
      if ((search.total ?? 0) > 0) {
        return `Company already exists:\n\n${formatCompany(search.results?.[0])}`;
      }
      const created = await client.createCompany({ name: args.name, ...(args.properties ?? {}) });
      return `Created company.\n\n${formatCompany(created)}`;
    }),
});

// Adapted from baryhuang/mcp-hubspot@4a8345f handlers/company_handler.py:193
hubspotServer.addTool({
  name: 'getActiveCompanies',
  annotations: { readOnlyHint: true },
  description: 'Get most recently active companies from HubSpot (sorted by last-modified date).',
  parameters: z.object({
    limit: z.number().int().min(1).optional().default(10).describe('Maximum number of companies to return (default: 10).'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to get active companies', session, log, async (client) => {
      log.info(`getActiveCompanies limit=${args.limit}`);
      const res = await client.searchCompanies(recentCompaniesSearch(args.limit));
      return formatObjectList(res.results ?? [], 'companies');
    }),
});

// Adapted from baryhuang/mcp-hubspot@4a8345f handlers/company_handler.py:219
hubspotServer.addTool({
  name: 'getCompany',
  annotations: { readOnlyHint: true },
  description: 'Get a specific company by ID from HubSpot.',
  parameters: z.object({
    companyId: z.string().describe('HubSpot company ID.'),
    properties: z.array(z.string()).optional().describe('Optional list of properties to retrieve. If omitted, returns the default set.'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to get company', session, log, async (client) => {
      log.info(`getCompany id=${args.companyId}`);
      const obj = await client.getCompany(args.companyId, args.properties);
      return formatCompany(obj);
    }),
});

// Adapted from baryhuang/mcp-hubspot@4a8345f handlers/company_handler.py:245
hubspotServer.addTool({
  name: 'updateCompany',
  description: 'Update an existing company record in HubSpot.',
  parameters: z.object({
    companyId: z.string().describe('HubSpot company ID to update.'),
    properties: z.record(z.string(), z.any()).describe('Object containing the properties to update.'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to update company', session, log, async (client) => {
      log.info(`updateCompany id=${args.companyId}`);
      const obj = await client.updateCompany(args.companyId, args.properties);
      return `Updated company.\n\n${formatCompany(obj)}`;
    }),
});

// TODO stub — engagement fan-out has no simple REST equivalent here.
// Adapted from baryhuang/mcp-hubspot@4a8345f handlers/company_handler.py:171
hubspotServer.addTool({
  name: 'getCompanyActivity',
  annotations: { readOnlyHint: true },
  description: 'Get activity/engagement history for a specific company.',
  parameters: z.object({
    companyId: z.string().describe('HubSpot company ID.'),
  }),
  // Original source (company_client.get_activity):
  /*
    associated_engagements = self._get_company_engagements(company_id)   # associations v4 get_page → engagements
    engagement_ids = self._extract_engagement_ids(associated_engagements)
    activities = self._get_engagement_details(engagement_ids)            # per-id GET /engagements/v1/engagements/{id}
    converted_activities = convert_datetime_fields(activities)           # + type-specific NOTE/EMAIL/TASK/MEETING/CALL formatting
    return json.dumps(converted_activities)
  */
  execute: async () => {
    throw new UserError(
      'getCompanyActivity is not yet implemented — porting the associations-v4 engagement fan-out + /engagements/v1 detail fetch is pending.',
    );
  },
});

// ---------------------------------------------------------------------------
// Contact tools
// ---------------------------------------------------------------------------

// Adapted from baryhuang/mcp-hubspot@4a8345f handlers/contact_handler.py:92
hubspotServer.addTool({
  name: 'createContact',
  description: 'Create a new contact in HubSpot (skips creation if a matching contact already exists).',
  parameters: z.object({
    firstname: z.string().describe("Contact's first name."),
    lastname: z.string().describe("Contact's last name."),
    email: z.string().optional().describe("Contact's email address."),
    properties: z.record(z.string(), z.any()).optional().describe('Additional contact properties (e.g. company, phone).'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to create contact', session, log, async (client) => {
      log.info(`createContact ${args.firstname} ${args.lastname}`);
      const filters = [
        { propertyName: 'firstname', value: args.firstname },
        { propertyName: 'lastname', value: args.lastname },
      ];
      const company = (args.properties ?? {})['company'];
      if (typeof company === 'string' && company) {
        filters.push({ propertyName: 'company', value: company });
      }
      const search = await client.searchContacts(eqFilterGroup(filters));
      if ((search.total ?? 0) > 0) {
        return `Contact already exists:\n\n${formatContact(search.results?.[0])}`;
      }
      const properties: Record<string, unknown> = {
        firstname: args.firstname,
        lastname: args.lastname,
        ...(args.email ? { email: args.email } : {}),
        ...(args.properties ?? {}),
      };
      const created = await client.createContact(properties);
      return `Created contact.\n\n${formatContact(created)}`;
    }),
});

// Adapted from baryhuang/mcp-hubspot@4a8345f handlers/contact_handler.py:179
hubspotServer.addTool({
  name: 'getActiveContacts',
  annotations: { readOnlyHint: true },
  description: 'Get most recently active contacts from HubSpot (sorted by last-modified date).',
  parameters: z.object({
    limit: z.number().int().min(1).optional().default(10).describe('Maximum number of contacts to return (default: 10).'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to get active contacts', session, log, async (client) => {
      log.info(`getActiveContacts limit=${args.limit}`);
      const res = await client.searchContacts(recentContactsSearch(args.limit));
      return formatObjectList(res.results ?? [], 'contacts');
    }),
});

// Adapted from baryhuang/mcp-hubspot@4a8345f handlers/contact_handler.py:205
hubspotServer.addTool({
  name: 'getContact',
  annotations: { readOnlyHint: true },
  description: 'Get a specific contact by ID from HubSpot.',
  parameters: z.object({
    contactId: z.string().describe('HubSpot contact ID.'),
    properties: z.array(z.string()).optional().describe('Optional list of properties to retrieve. If omitted, returns the default set.'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to get contact', session, log, async (client) => {
      log.info(`getContact id=${args.contactId}`);
      const obj = await client.getContact(args.contactId, args.properties);
      return formatContact(obj);
    }),
});

// Adapted from baryhuang/mcp-hubspot@4a8345f handlers/contact_handler.py:231
hubspotServer.addTool({
  name: 'updateContact',
  description: 'Update an existing contact record in HubSpot.',
  parameters: z.object({
    contactId: z.string().describe('HubSpot contact ID to update.'),
    properties: z.record(z.string(), z.any()).describe('Object containing the properties to update.'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to update contact', session, log, async (client) => {
      log.info(`updateContact id=${args.contactId}`);
      const obj = await client.updateContact(args.contactId, args.properties);
      return `Updated contact.\n\n${formatContact(obj)}`;
    }),
});

// ---------------------------------------------------------------------------
// Conversation tools (stub)
// ---------------------------------------------------------------------------

// TODO stub — thread caching + message truncation has no equivalent here.
// Adapted from baryhuang/mcp-hubspot@4a8345f handlers/conversation_handler.py:39
hubspotServer.addTool({
  name: 'getRecentConversations',
  annotations: { readOnlyHint: true },
  description: 'Get recent conversation threads from HubSpot with their messages.',
  parameters: z.object({
    limit: z.number().int().min(1).optional().default(10).describe('Maximum number of threads to return (default: 10).'),
    after: z.string().optional().describe('Pagination token.'),
    refreshCache: z.boolean().optional().default(false).describe('Whether to refresh the threads cache (default: false).'),
  }),
  // Original source (conversation_handler.get_recent_conversations):
  /*
    results = self.hubspot.get_recent_threads(limit, after, refresh_cache)   # conversations API + ThreadStorage cache
    self._store_conversations_in_faiss(results, limit, after)                # per-thread FAISS indexing
    truncated_results = self._truncate_conversation_messages(results)        # cap message text/rich_text at 200 chars
    return self.create_text_response(truncated_results)
  */
  execute: async () => {
    throw new UserError(
      'getRecentConversations is not yet implemented — porting the conversations threads API + thread cache is pending.',
    );
  },
});

// ---------------------------------------------------------------------------
// Ticket tools (stubs)
// ---------------------------------------------------------------------------

// TODO stub — retry/backoff + criteria selection not yet ported.
// Adapted from baryhuang/mcp-hubspot@4a8345f handlers/ticket_handler.py:58
hubspotServer.addTool({
  name: 'getTickets',
  annotations: { readOnlyHint: true },
  description: 'Get tickets from HubSpot based on configurable selection criteria.',
  parameters: z.object({
    criteria: z.enum(['default', 'Closed']).optional().default('default').describe("'default' (recently closed/modified) or 'Closed' (status = Closed)."),
    limit: z.number().int().min(1).optional().default(50).describe('Maximum number of tickets to return (default: 50).'),
    maxRetries: z.number().int().min(0).optional().default(3).describe('Maximum retry attempts for rate limiting (default: 3).'),
    retryDelay: z.number().optional().default(1.0).describe('Initial delay between retries in seconds (default: 1.0).'),
  }),
  // Original source (ticket_handler.get_tickets → ticket_client.get_tickets):
  /*
    results = self.hubspot.get_tickets(criteria, limit, max_retries, retry_delay)  # search API w/ criteria + exponential backoff on 429
    self._store_tickets_in_faiss(results, criteria, limit)
    return self.create_text_response(results)
  */
  execute: async () => {
    throw new UserError(
      'getTickets is not yet implemented — porting the ticket search criteria + retry/backoff logic is pending.',
    );
  },
});

// TODO stub — ticket→conversation thread association fan-out not yet ported.
// Adapted from baryhuang/mcp-hubspot@4a8345f handlers/ticket_handler.py:133
hubspotServer.addTool({
  name: 'getTicketConversationThreads',
  annotations: { readOnlyHint: true },
  description: 'Get conversation threads associated with a specific ticket.',
  parameters: z.object({
    ticketId: z.string().describe('ID of the ticket to retrieve conversation threads for.'),
  }),
  // Original source (ticket_handler.get_ticket_conversation_threads):
  /*
    results = self.hubspot.get_ticket_conversation_threads(ticket_id)   # associations → threads → messages aggregation
    self._store_ticket_threads_in_faiss(results, ticket_id)
    return self.create_text_response(results)
  */
  execute: async () => {
    throw new UserError(
      'getTicketConversationThreads is not yet implemented — porting the ticket→thread association aggregation is pending.',
    );
  },
});

// ---------------------------------------------------------------------------
// Search tool (stub — depends on FAISS vector store)
// ---------------------------------------------------------------------------

// TODO stub — the reference searches a local FAISS index of previously-fetched
// data; this codebase has no vector store, so there is nothing to search.
// Adapted from baryhuang/mcp-hubspot@4a8345f handlers/search_handler.py:46
hubspotServer.addTool({
  name: 'searchData',
  annotations: { readOnlyHint: true },
  description: 'Semantic search across previously-retrieved HubSpot data (requires a vector store).',
  parameters: z.object({
    query: z.string().describe('Text query to search for.'),
    limit: z.number().int().min(1).optional().default(10).describe('Maximum number of results to return (default: 10).'),
  }),
  // Original source (search_handler.search_data):
  /*
    results, _ = search_in_faiss(faiss_manager=self.faiss_manager, query=query,
                                 model=self.embedding_model, limit=limit)
    return self.create_text_response(results)
  */
  execute: async () => {
    throw new UserError(
      'searchData is not yet implemented — the reference depends on a local FAISS vector store that this codebase does not have.',
    );
  },
});

// ---------------------------------------------------------------------------
// Property tools
// ---------------------------------------------------------------------------

// Adapted from baryhuang/mcp-hubspot@4a8345f handlers/property_handler.py:139
hubspotServer.addTool({
  name: 'getProperty',
  annotations: { readOnlyHint: true },
  description: 'Get details of a specific HubSpot property definition.',
  parameters: z.object({
    objectType: objectTypeParam,
    propertyName: z.string().describe('Name of the property.'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to get property', session, log, async (client) => {
      log.info(`getProperty ${args.objectType}.${args.propertyName}`);
      const prop = await client.getProperty(args.objectType, args.propertyName);
      return formatProperty(prop);
    }),
});

// Adapted from baryhuang/mcp-hubspot@4a8345f handlers/property_handler.py:157
hubspotServer.addTool({
  name: 'updateProperty',
  description: 'Update a HubSpot property definition (e.g., add dropdown options).',
  parameters: z.object({
    objectType: objectTypeParam,
    propertyName: z.string().describe('Name of the property.'),
    options: z.array(propertyOption).describe('Array of option objects for dropdown fields.'),
    label: z.string().optional().describe('Optional new display label.'),
    description: z.string().optional().describe('Optional new description.'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to update property', session, log, async (client) => {
      log.info(`updateProperty ${args.objectType}.${args.propertyName}`);
      const body: Record<string, unknown> = { options: args.options };
      if (args.label !== undefined) body.label = args.label;
      if (args.description !== undefined) body.description = args.description;
      const prop = await client.updateProperty(args.objectType, args.propertyName, body);
      return `Updated property.\n\n${formatProperty(prop)}`;
    }),
});

// Adapted from baryhuang/mcp-hubspot@4a8345f handlers/property_handler.py:180
hubspotServer.addTool({
  name: 'createProperty',
  description: 'Create a new custom property in HubSpot.',
  parameters: z.object({
    objectType: objectTypeParam,
    name: z.string().describe('Internal name of the property.'),
    label: z.string().describe('Display label for the property.'),
    type: z.string().describe('Data type (string, number, date, enumeration, etc.).'),
    fieldType: z.string().describe('Field type (text, textarea, select, number, date, etc.).'),
    groupName: z.string().describe('Property group name.'),
    options: z.array(propertyOption).optional().describe('Array of option objects for dropdown fields.'),
    description: z.string().optional().describe('Property description.'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to create property', session, log, async (client) => {
      log.info(`createProperty ${args.objectType}.${args.name}`);
      const body: Record<string, unknown> = {
        name: args.name,
        label: args.label,
        type: args.type,
        fieldType: args.fieldType,
        groupName: args.groupName,
      };
      if (args.options !== undefined) body.options = args.options;
      if (args.description !== undefined) body.description = args.description;
      const prop = await client.createProperty(args.objectType, body);
      return `Created property.\n\n${formatProperty(prop)}`;
    }),
});
