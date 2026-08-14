// src/hubspot/server.ts
// HubSpot CRM MCP server. Tools cover contacts, companies, and property
// definitions on the public CRM v3 REST API, plus read tools for the
// engagement/conversation/ticket surface.
//
// Ported from https://github.com/baryhuang/mcp-hubspot@4a8345f2507b4159fc84eb500c74669329076f53
// The reference exposed 16 tools; 15 are implemented here against the HubSpot
// REST API. The 16th (searchData) relied on a local FAISS vector store with no
// equivalent here, so it is intentionally not registered (see below).
//
// Each tool's operation lives in an exported `op*` function (client, args) →
// string; the addTool `execute` is a thin wrapper that resolves the client,
// logs a breadcrumb, and delegates. Keeping the operations pure makes them
// directly unit-testable without going through the MCP transport.

import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';

import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import {
  HubSpotClient,
  COMPANY_SEARCH_PROPERTIES,
  CONTACT_SEARCH_PROPERTIES,
  eqFilterGroup,
  formatCompany,
  formatCompanyActivity,
  formatContact,
  formatObjectList,
  formatProperty,
  formatThreads,
  formatTickets,
  hubspotSenderType,
  missingPropertiesNote,
  recentCompaniesSearch,
  recentContactsSearch,
  textSearch,
  withHubSpotClient,
  type HubSpotMessage,
  type HubSpotObjectType,
  type HubSpotSearchFilter,
  type RenderedThread,
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

// One filter for the CRM search API. Operators mirror HubSpot's search
// operators; `value` is omitted for the existence operators.
const searchFilter = z.object({
  propertyName: z.string().describe('Property to filter on (e.g. domain, email, industry).'),
  operator: z
    .enum(['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN', 'HAS_PROPERTY', 'NOT_HAS_PROPERTY'])
    .optional()
    .default('EQ')
    .describe('Comparison operator (default EQ).'),
  value: z.string().optional().describe('Value to compare against. Omit for HAS_PROPERTY / NOT_HAS_PROPERTY.'),
});

/**
 * Register a CRM search tool. searchCompanies and searchContacts take the same
 * parameters (free-text query and/or ANDed filters, requested properties, limit)
 * and share the "at least one of query/filters" guard that keeps an unbounded
 * match-all off the API — only the object searched and the copy differ.
 */
function addSearchTool(opts: {
  name: string;
  label: 'companies' | 'contacts';
  singular: string;
  /** How the tool description says a record can be looked up, e.g. "name or domain". */
  resolveBy: string;
  /** Example searchable properties named in the `query` parameter description. */
  queryExamples: string;
  /** Default returned properties named in the `properties` parameter description. */
  defaultProperties: string;
}): void {
  hubspotServer.addTool({
    name: opts.name,
    annotations: { readOnlyHint: true },
    description:
      `Search HubSpot ${opts.label} by free-text query and/or property filters. Returns each match's ID, name, and requested properties. ` +
      `Use this to resolve a ${opts.singular} by ${opts.resolveBy}, or any property, to its ID before calling the by-ID ${opts.singular} tools.`,
    parameters: z
      .object({
        query: z.string().optional().describe(`Free-text search across the default searchable properties (e.g. ${opts.queryExamples}).`),
        filters: z.array(searchFilter).optional().describe('Optional property filters, ANDed together.'),
        properties: z.array(z.string()).optional().describe(`Properties to return per match (defaults to ${opts.defaultProperties}).`),
        limit: z.number().int().min(1).max(100).optional().default(10).describe('Maximum matches to return (default 10, max 100).'),
      })
      .refine(a => Boolean(a.query) || (a.filters?.length ?? 0) > 0, {
        message: 'Provide a query and/or at least one filter.',
      }),
    execute: (args, { log, session }) =>
      withHubSpotClient(`Failed to search ${opts.label}`, session, log, (client) => {
        log.info(`${opts.name} query=${args.query ?? ''} filters=${args.filters?.length ?? 0}`);
        return opSearchObjects(client, opts.label, args);
      }),
  });
}

// Cap on how many engagement detail records getCompanyActivity fetches.
const MAX_ACTIVITY_FETCH = 100;

// Ticket properties requested on every search (mirrors the reference client).
const TICKET_PROPERTIES = [
  'subject', 'content', 'hs_pipeline', 'hs_pipeline_stage', 'hs_ticket_status',
  'status', 'hs_ticket_priority', 'createdate', 'closedate', 'hs_lastmodifieddate',
];

/**
 * Fetch a thread's messages and render it for output: keep only real MESSAGE
 * entries (drop system events), classify the sender, and sort oldest-first.
 * Shared by getRecentConversations and getTicketConversationThreads.
 */
async function renderThread(
  fetchMessages: () => Promise<{ results?: HubSpotMessage[] }>,
  thread: { id?: string | number; status?: string },
): Promise<RenderedThread> {
  const page = await fetchMessages().catch(() => ({ results: [] as HubSpotMessage[] }));
  const messages = (page.results ?? [])
    .filter(m => m.type === 'MESSAGE')
    .map(m => ({ created_at: m.createdAt, sender_type: hubspotSenderType(m), text: m.text ?? '' }))
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
  return { id: thread.id, status: thread.status, messages };
}

// ===========================================================================
// Operations — pure (client, args) → string. Exported for direct unit testing.
// Attribution comments reference the ported source handler.
// ===========================================================================

// company_handler.py:105 — dedupe by name, then create.
export async function opCreateCompany(
  client: HubSpotClient,
  args: { name: string; properties?: Record<string, unknown> },
): Promise<string> {
  const search = await client.searchCompanies(eqFilterGroup([{ propertyName: 'name', value: args.name }]));
  if ((search.total ?? 0) > 0) {
    return `Company already exists:\n\n${formatCompany(search.results?.[0])}`;
  }
  // Spread caller properties first so the canonical `name` (the value we just
  // deduped on) always wins over a stray properties.name.
  const created = await client.createCompany({ ...(args.properties ?? {}), name: args.name });
  return `Created company.\n\n${formatCompany(created)}`;
}

// company_handler.py:193
export async function opGetActiveCompanies(client: HubSpotClient, args: { limit: number }): Promise<string> {
  const res = await client.searchCompanies(recentCompaniesSearch(args.limit));
  return formatObjectList(res.results ?? [], 'companies');
}

export type SearchArgs = { query?: string; filters?: HubSpotSearchFilter[]; properties?: string[]; limit: number };

// Companies and contacts search identically — same request body, same output
// shape — so both search ops run through here, differing only in the endpoint
// and the default property set.
async function opSearchObjects(client: HubSpotClient, label: 'companies' | 'contacts', args: SearchArgs): Promise<string> {
  const companies = label === 'companies';
  const properties = args.properties ?? (companies ? COMPANY_SEARCH_PROPERTIES : CONTACT_SEARCH_PROPERTIES);
  const body = textSearch({ query: args.query, filters: args.filters, properties, limit: args.limit });
  const res = companies ? await client.searchCompanies(body) : await client.searchContacts(body);
  return formatObjectList(res.results ?? [], label, properties);
}

// Search companies by free-text query and/or property filters. The primary way
// to resolve a name/domain to a company ID before calling the by-ID tools.
export function opSearchCompanies(client: HubSpotClient, args: SearchArgs): Promise<string> {
  return opSearchObjects(client, 'companies', args);
}

// company_handler.py:219
export async function opGetCompany(client: HubSpotClient, args: { companyId: string; properties?: string[] }): Promise<string> {
  const obj = await client.getCompany(args.companyId, args.properties);
  // Reads are loud: HubSpot silently omits unknown property keys, so flag any
  // the caller asked for but didn't get back.
  return formatCompany(obj) + missingPropertiesNote(args.properties, obj);
}

// company_handler.py:245
export async function opUpdateCompany(
  client: HubSpotClient,
  args: { companyId: string; properties: Record<string, unknown> },
): Promise<string> {
  await client.updateCompany(args.companyId, args.properties);
  // Re-read so the response is the same shape as getCompany — HubSpot's PATCH
  // echo returns only internal/changed fields and omits populated name/domain.
  const fresh = await client.getCompany(args.companyId);
  return `Updated company.\n\n${formatCompany(fresh)}`;
}

// company_handler.py:171 — associations-v4 fan-out + per-id engagement detail.
export async function opGetCompanyActivity(client: HubSpotClient, args: { companyId: string }): Promise<string> {
  const ids = await client.getCompanyEngagementIds(args.companyId);
  const capped = ids.slice(0, MAX_ACTIVITY_FETCH);
  const details = await Promise.all(capped.map(id => client.getEngagementDetail(id).catch(() => null)));
  return formatCompanyActivity(
    details.filter((d): d is NonNullable<typeof d> => d !== null),
    ids.length - capped.length,
  );
}

// contact_handler.py:92 — dedupe by name (+ company), then create.
export async function opCreateContact(
  client: HubSpotClient,
  args: { firstname: string; lastname: string; email?: string; properties?: Record<string, unknown> },
): Promise<string> {
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
  // Spread caller properties first so the canonical firstname/lastname/email
  // (the values we just deduped on) always win over stray property values.
  const properties: Record<string, unknown> = {
    ...(args.properties ?? {}),
    firstname: args.firstname,
    lastname: args.lastname,
    ...(args.email ? { email: args.email } : {}),
  };
  return `Created contact.\n\n${formatContact(await client.createContact(properties))}`;
}

// contact_handler.py:179
export async function opGetActiveContacts(client: HubSpotClient, args: { limit: number }): Promise<string> {
  const res = await client.searchContacts(recentContactsSearch(args.limit));
  return formatObjectList(res.results ?? [], 'contacts');
}

// Search contacts by free-text query and/or property filters. The primary way
// to resolve a name/email to a contact ID before calling the by-ID tools.
export function opSearchContacts(client: HubSpotClient, args: SearchArgs): Promise<string> {
  return opSearchObjects(client, 'contacts', args);
}

// contact_handler.py:205
export async function opGetContact(client: HubSpotClient, args: { contactId: string; properties?: string[] }): Promise<string> {
  const obj = await client.getContact(args.contactId, args.properties);
  return formatContact(obj) + missingPropertiesNote(args.properties, obj);
}

// contact_handler.py:231
export async function opUpdateContact(
  client: HubSpotClient,
  args: { contactId: string; properties: Record<string, unknown> },
): Promise<string> {
  await client.updateContact(args.contactId, args.properties);
  // Re-read for a consistent read shape (see opUpdateCompany).
  const obj = await client.getContact(args.contactId);
  return `Updated contact.\n\n${formatContact(obj)}`;
}

// conversation_handler.py:39 — list threads then fetch each thread's messages.
export async function opGetRecentConversations(
  client: HubSpotClient,
  args: { limit: number; after?: string },
): Promise<string> {
  const page = await client.listConversationThreads({ limit: args.limit, after: args.after });
  const threads = await Promise.all(
    (page.results ?? []).map(t => renderThread(() => client.getThreadMessages(String(t.id)), t)),
  );
  return formatThreads(threads, page.paging?.next?.after);
}

// ticket_handler.py:58 — criteria-based filter groups + retry (in searchTickets).
export async function opGetTickets(
  client: HubSpotClient,
  args: { criteria: 'default' | 'Closed'; limit: number; maxRetries: number; retryDelay: number },
  nowMs: number = Date.now(),
): Promise<string> {
  // HubSpot's search API compares datetime properties (closedate,
  // hs_lastmodifieddate) against epoch MILLISECONDS, not ISO-8601. Passing an
  // ISO string 400s the request — which is why the `default` branch failed
  // while `Closed` (a string stage filter) worked.
  const oneDayAgo = String(nowMs - 24 * 60 * 60 * 1000);
  const filterGroups = args.criteria === 'Closed'
    ? [
        { filters: [{ propertyName: 'hs_pipeline_stage', operator: 'EQ', value: '4' }] },
        { filters: [{ propertyName: 'hs_pipeline_stage', operator: 'EQ', value: 'Closed' }] },
      ]
    : [
        { filters: [{ propertyName: 'closedate', operator: 'GT', value: oneDayAgo }] },
        { filters: [{ propertyName: 'hs_lastmodifieddate', operator: 'GT', value: oneDayAgo }] },
      ];
  const body = {
    filterGroups,
    sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
    limit: args.limit,
    properties: TICKET_PROPERTIES,
  };
  const res = await client.searchTickets(body, { maxRetries: args.maxRetries, retryDelay: args.retryDelay });
  return formatTickets(res.results ?? [], res.total, res.paging?.next?.after);
}

// ticket_handler.py:133 — tickets→conversation associations + per-thread messages.
export async function opGetTicketConversationThreads(client: HubSpotClient, args: { ticketId: string }): Promise<string> {
  const threadIds = await client.getTicketConversationIds(args.ticketId);
  const threads = await Promise.all(threadIds.map(id => renderThread(() => client.getThreadMessages(id), { id })));
  return formatThreads(threads);
}

// property_handler.py:139
export async function opGetProperty(
  client: HubSpotClient,
  args: { objectType: HubSpotObjectType; propertyName: string },
): Promise<string> {
  return formatProperty(await client.getProperty(args.objectType, args.propertyName));
}

// property_handler.py:157
export async function opUpdateProperty(
  client: HubSpotClient,
  args: { objectType: HubSpotObjectType; propertyName: string; options: unknown[]; label?: string; description?: string },
): Promise<string> {
  const body: Record<string, unknown> = { options: args.options };
  if (args.label !== undefined) body.label = args.label;
  if (args.description !== undefined) body.description = args.description;
  const prop = await client.updateProperty(args.objectType, args.propertyName, body);
  return `Updated property.\n\n${formatProperty(prop)}`;
}

// property_handler.py:180
export async function opCreateProperty(
  client: HubSpotClient,
  args: {
    objectType: HubSpotObjectType; name: string; label: string; type: string;
    fieldType: string; groupName: string; options?: unknown[]; description?: string;
  },
): Promise<string> {
  const body: Record<string, unknown> = {
    name: args.name,
    label: args.label,
    type: args.type,
    fieldType: args.fieldType,
    groupName: args.groupName,
  };
  if (args.options !== undefined) body.options = args.options;
  if (args.description !== undefined) body.description = args.description;
  return `Created property.\n\n${formatProperty(await client.createProperty(args.objectType, body))}`;
}

// ===========================================================================
// Tool registration — thin wrappers: resolve client, log breadcrumb, delegate.
// ===========================================================================

// --- Company tools ---

hubspotServer.addTool({
  name: 'createCompany',
  annotations: { readOnlyHint: false },
  description: 'Create a new company in HubSpot (skips creation if a company with the same name already exists).',
  parameters: z.object({
    name: z.string().describe('Company name.'),
    properties: z.record(z.string(), z.any()).optional().describe('Additional company properties (e.g. domain, industry).'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to create company', session, log, (client) => {
      log.info(`createCompany name=${args.name}`);
      return opCreateCompany(client, args);
    }),
});

hubspotServer.addTool({
  name: 'getActiveCompanies',
  annotations: { readOnlyHint: true },
  description: 'Get most recently active companies from HubSpot (sorted by last-modified date).',
  parameters: z.object({
    limit: z.number().int().min(1).optional().default(10).describe('Maximum number of companies to return (default: 10).'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to get active companies', session, log, (client) => {
      log.info(`getActiveCompanies limit=${args.limit}`);
      return opGetActiveCompanies(client, args);
    }),
});

addSearchTool({
  name: 'searchCompanies',
  label: 'companies',
  singular: 'company',
  resolveBy: 'name or domain',
  queryExamples: 'name, domain, phone',
  defaultProperties: 'name, domain, website, phone, industry',
});

hubspotServer.addTool({
  name: 'getCompany',
  annotations: { readOnlyHint: true },
  description: 'Get a specific company by ID from HubSpot.',
  parameters: z.object({
    companyId: z.string().describe('HubSpot company ID.'),
    properties: z.array(z.string()).optional().describe('Optional list of properties to retrieve. If omitted, returns the default set.'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to get company', session, log, (client) => {
      log.info(`getCompany id=${args.companyId}`);
      return opGetCompany(client, args);
    }),
});

hubspotServer.addTool({
  name: 'updateCompany',
  annotations: { readOnlyHint: false },
  description: 'Update an existing company record in HubSpot.',
  parameters: z.object({
    companyId: z.string().describe('HubSpot company ID to update.'),
    properties: z.record(z.string(), z.any())
      .refine(o => Object.keys(o).length > 0, { message: 'Provide at least one property to update.' })
      .describe('Object containing the properties to update (at least one).'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to update company', session, log, (client) => {
      log.info(`updateCompany id=${args.companyId}`);
      return opUpdateCompany(client, args);
    }),
});

hubspotServer.addTool({
  name: 'getCompanyActivity',
  annotations: { readOnlyHint: true },
  description: 'Get activity/engagement history (notes, emails, calls, meetings, tasks) for a specific company.',
  parameters: z.object({
    companyId: z.string().describe('HubSpot company ID.'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to get company activity', session, log, (client) => {
      log.info(`getCompanyActivity id=${args.companyId}`);
      return opGetCompanyActivity(client, args);
    }),
});

// --- Contact tools ---

hubspotServer.addTool({
  name: 'createContact',
  annotations: { readOnlyHint: false },
  description: 'Create a new contact in HubSpot (skips creation if a matching contact already exists).',
  parameters: z.object({
    firstname: z.string().describe("Contact's first name."),
    lastname: z.string().describe("Contact's last name."),
    email: z.string().optional().describe("Contact's email address."),
    properties: z.record(z.string(), z.any()).optional().describe('Additional contact properties (e.g. company, phone).'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to create contact', session, log, (client) => {
      log.info('createContact');
      return opCreateContact(client, args);
    }),
});

hubspotServer.addTool({
  name: 'getActiveContacts',
  annotations: { readOnlyHint: true },
  description: 'Get most recently active contacts from HubSpot (sorted by last-modified date).',
  parameters: z.object({
    limit: z.number().int().min(1).optional().default(10).describe('Maximum number of contacts to return (default: 10).'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to get active contacts', session, log, (client) => {
      log.info(`getActiveContacts limit=${args.limit}`);
      return opGetActiveContacts(client, args);
    }),
});

addSearchTool({
  name: 'searchContacts',
  label: 'contacts',
  singular: 'contact',
  resolveBy: 'name or email',
  queryExamples: 'name, email, phone',
  defaultProperties: 'firstname, lastname, email, company, phone',
});

hubspotServer.addTool({
  name: 'getContact',
  annotations: { readOnlyHint: true },
  description: 'Get a specific contact by ID from HubSpot.',
  parameters: z.object({
    contactId: z.string().describe('HubSpot contact ID.'),
    properties: z.array(z.string()).optional().describe('Optional list of properties to retrieve. If omitted, returns the default set.'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to get contact', session, log, (client) => {
      log.info(`getContact id=${args.contactId}`);
      return opGetContact(client, args);
    }),
});

hubspotServer.addTool({
  name: 'updateContact',
  annotations: { readOnlyHint: false },
  description: 'Update an existing contact record in HubSpot.',
  parameters: z.object({
    contactId: z.string().describe('HubSpot contact ID to update.'),
    properties: z.record(z.string(), z.any())
      .refine(o => Object.keys(o).length > 0, { message: 'Provide at least one property to update.' })
      .describe('Object containing the properties to update (at least one).'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to update contact', session, log, (client) => {
      log.info(`updateContact id=${args.contactId}`);
      return opUpdateContact(client, args);
    }),
});

// --- Conversation tool ---

hubspotServer.addTool({
  name: 'getRecentConversations',
  annotations: { readOnlyHint: true },
  description: 'Get recent conversation threads from HubSpot with their messages.',
  parameters: z.object({
    limit: z.number().int().min(1).optional().default(10).describe('Maximum number of threads to return (default: 10).'),
    after: z.string().optional().describe('Pagination token from a previous call.'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to get recent conversations', session, log, (client) => {
      log.info(`getRecentConversations limit=${args.limit}`);
      return opGetRecentConversations(client, args);
    }),
});

// --- Ticket tools ---

hubspotServer.addTool({
  name: 'getTickets',
  annotations: { readOnlyHint: true },
  description: 'Get tickets from HubSpot based on configurable selection criteria.',
  parameters: z.object({
    criteria: z.enum(['default', 'Closed']).optional().default('default').describe("'default' (closed or last-modified within the last day) or 'Closed' (pipeline stage = Closed)."),
    limit: z.number().int().min(1).optional().default(50).describe('Maximum number of tickets to return (default: 50).'),
    maxRetries: z.number().int().min(0).optional().default(3).describe('Maximum retry attempts on rate limiting / 5xx (default: 3).'),
    retryDelay: z.number().min(0).optional().default(1.0).describe('Initial delay between retries in seconds; doubles each attempt (default: 1.0).'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to get tickets', session, log, (client) => {
      log.info(`getTickets criteria=${args.criteria} limit=${args.limit}`);
      return opGetTickets(client, args);
    }),
});

hubspotServer.addTool({
  name: 'getTicketConversationThreads',
  annotations: { readOnlyHint: true },
  description: 'Get conversation threads (and their messages) associated with a specific ticket.',
  parameters: z.object({
    ticketId: z.string().describe('ID of the ticket to retrieve conversation threads for.'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to get ticket conversation threads', session, log, (client) => {
      log.info(`getTicketConversationThreads ticket=${args.ticketId}`);
      return opGetTicketConversationThreads(client, args);
    }),
});

// The reference exposed a `searchData` tool backed by a local FAISS vector
// store. This codebase has no vector store, so rather than advertise a tool
// that always throws, it is intentionally not registered. See CLAUDE.md.

// --- Property tools ---

hubspotServer.addTool({
  name: 'getProperty',
  annotations: { readOnlyHint: true },
  description: 'Get details of a specific HubSpot property definition.',
  parameters: z.object({
    objectType: objectTypeParam,
    propertyName: z.string().describe('Name of the property.'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to get property', session, log, (client) => {
      log.info(`getProperty ${args.objectType}.${args.propertyName}`);
      return opGetProperty(client, args);
    }),
});

hubspotServer.addTool({
  name: 'updateProperty',
  annotations: { readOnlyHint: false },
  description: 'Update a HubSpot property definition (e.g., add dropdown options).',
  parameters: z.object({
    objectType: objectTypeParam,
    propertyName: z.string().describe('Name of the property.'),
    options: z.array(propertyOption).describe('Array of option objects for dropdown fields.'),
    label: z.string().optional().describe('Optional new display label.'),
    description: z.string().optional().describe('Optional new description.'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to update property', session, log, (client) => {
      log.info(`updateProperty ${args.objectType}.${args.propertyName}`);
      return opUpdateProperty(client, args);
    }),
});

hubspotServer.addTool({
  name: 'createProperty',
  annotations: { readOnlyHint: false },
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
    withHubSpotClient('Failed to create property', session, log, (client) => {
      log.info(`createProperty ${args.objectType}.${args.name}`);
      return opCreateProperty(client, args);
    }),
});
