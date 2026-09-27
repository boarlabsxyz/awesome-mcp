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
import { registerMintRestBearerForCurl } from '../sharedTools/mintRestBearerForCurl.js';
import { registerListRestEndpoints } from '../sharedTools/listRestEndpoints.js';
import {
  HubSpotClient,
  COMPANY_SEARCH_PROPERTIES,
  CONTACT_SEARCH_PROPERTIES,
  DEAL_SEARCH_PROPERTIES,
  eqFilterGroup,
  formatCompany,
  formatCompanyActivity,
  formatContact,
  formatDeal,
  formatEngagement,
  formatObjectList,
  formatPipelines,
  formatProperty,
  formatThreads,
  formatTickets,
  hubspotSenderType,
  missingPropertiesNote,
  recentCompaniesSearch,
  recentContactsSearch,
  recentDealsSearch,
  textSearch,
  withHubSpotClient,
  type HubSpotEngagementDetail,
  type HubSpotEngagementType,
  type HubSpotObject,
  type HubSpotMessage,
  type HubSpotObjectType,
  type HubSpotSearchFilter,
  type HubSpotSearchResponse,
  type RenderedThread,
} from './apiHelpers.js';

export const hubspotServer = new FastMCP<UserSession>({
  name: 'HubSpot MCP',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'hubspot'),
});

// REST data-plane companions. Registered because src/restCatalog.ts marks the
// /api/v1/hubspot endpoints live: without mintRestBearerForCurl the only
// credential for them is the PERMANENT dashboard API key, and without
// listRestEndpoints a client cannot discover them in-session.
registerMintRestBearerForCurl(hubspotServer);
registerListRestEndpoints(hubspotServer);

const objectTypeParam = z
  .enum(['companies', 'contacts', 'deals'])
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
  label: 'companies' | 'contacts' | 'deals';
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
        properties: z
          .array(z.string())
          .optional()
          .describe(
            `Properties to return per match (defaults to ${opts.defaultProperties}). Every requested property is rendered — unset ones as "(empty)" — and any HubSpot does not return is listed in a note.`,
          ),
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

/**
 * Register a "most recently active <object>" tool. companies, contacts, and
 * deals all take a single `limit`, sort by last-modified date server-side, and
 * differ only in the op they call and a clause of copy.
 */
function addRecentListTool(opts: {
  name: string;
  label: 'companies' | 'contacts' | 'deals';
  /** Extra clause appended to the description, e.g. ", including amount and stage". */
  extra?: string;
  op: (client: HubSpotClient, args: { limit: number }) => Promise<string>;
}): void {
  hubspotServer.addTool({
    name: opts.name,
    annotations: { readOnlyHint: true },
    description: `Get most recently active ${opts.label} from HubSpot (sorted by last-modified date)${opts.extra ?? ''}.`,
    parameters: z.object({
      limit: z.number().int().min(1).optional().default(10).describe(`Maximum number of ${opts.label} to return (default: 10).`),
    }),
    execute: (args, { log, session }) =>
      withHubSpotClient(`Failed to get active ${opts.label}`, session, log, (client) => {
        log.info(`${opts.name} limit=${args.limit}`);
        return opts.op(client, args);
      }),
  });
}

// Fields shared by every engagement-write tool: an optional timestamp (defaults
// to now) and an optional record to attach the activity to (both-or-neither).
const engagementAssociationShape = {
  hs_timestamp: z
    .union([z.string(), z.number()])
    .optional()
    .describe('Activity time as ISO-8601 or epoch milliseconds. Defaults to now.'),
  associateToObjectType: objectTypeParam
    .optional()
    .describe('Record type to attach this activity to (companies, contacts, or deals), so it shows on that timeline.'),
  associateToObjectId: z.string().optional().describe('ID of the record to attach this activity to.'),
};
const TARGET_MSG = 'Provide both associateToObjectType and associateToObjectId, or neither.';
const bothOrNeitherTarget = (a: { associateToObjectType?: string; associateToObjectId?: string }) =>
  Boolean(a.associateToObjectType) === Boolean(a.associateToObjectId);

// ---------------------------------------------------------------------------
// Parameter schemas for the write tools that have a live POST /api/v1/hubspot/*
// sibling. Named and exported rather than inlined in addTool so the REST route
// validates req.body with EXACTLY what the MCP tool validates — hand-rolling
// `if (!field)` checks in webServer.ts is the drift this prevents. The reads
// keep their schemas inline: a GET route validates query params, not a body.
// ---------------------------------------------------------------------------

export const createCompanySchema = z.object({
  name: z.string().describe('Company name.'),
  properties: z.record(z.string(), z.any()).optional().describe('Additional company properties (e.g. domain, industry).'),
});

export const createContactSchema = z.object({
  firstname: z.string().describe("Contact's first name."),
  lastname: z.string().describe("Contact's last name."),
  email: z.string().optional().describe("Contact's email address."),
  properties: z.record(z.string(), z.any()).optional().describe('Additional contact properties (e.g. company, phone).'),
});

export const createDealSchema = z.object({
  dealname: z.string().describe('Deal name.'),
  properties: z.record(z.string(), z.any()).optional().describe('Additional deal properties (e.g. amount, dealstage, pipeline, closedate).'),
});

export const createNoteSchema = z
  .object({
    body: z.string().describe('Note text (hs_note_body).'),
    ...engagementAssociationShape,
  })
  .refine(bothOrNeitherTarget, { message: TARGET_MSG });

export const logCallSchema = z
  .object({
    title: z.string().optional().describe('Call title (hs_call_title).'),
    body: z.string().optional().describe('Call notes/summary (hs_call_body).'),
    durationMs: z.number().int().optional().describe('Call duration in milliseconds (hs_call_duration).'),
    direction: z.enum(['INBOUND', 'OUTBOUND']).optional().describe('Call direction (hs_call_direction).'),
    ...engagementAssociationShape,
  })
  .refine(bothOrNeitherTarget, { message: TARGET_MSG });

export const logMeetingSchema = z
  .object({
    title: z.string().optional().describe('Meeting title (hs_meeting_title).'),
    body: z.string().optional().describe('Meeting notes/agenda (hs_meeting_body).'),
    startTime: z.union([z.string(), z.number()]).optional().describe('Meeting start (ISO-8601 or epoch ms; hs_meeting_start_time).'),
    endTime: z.union([z.string(), z.number()]).optional().describe('Meeting end (ISO-8601 or epoch ms; hs_meeting_end_time).'),
    ...engagementAssociationShape,
  })
  .refine(bothOrNeitherTarget, { message: TARGET_MSG });

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
export async function renderThread(
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

/**
 * Create a company unless one of that name already exists.
 *
 * company_handler.py:105 — dedupe by name, then create. `created` is the
 * load-bearing half of the return: this call is a NO-OP when a match exists,
 * and a caller (REST especially, where it decides 201 vs 200) has no other way
 * to tell a write from a match.
 */
export async function performCreateCompany(
  client: HubSpotClient,
  args: { name: string; properties?: Record<string, unknown> },
): Promise<{ created: boolean; company: HubSpotObject | undefined }> {
  const search = await client.searchCompanies(eqFilterGroup([{ propertyName: 'name', value: args.name }]));
  if ((search.total ?? 0) > 0) {
    return { created: false, company: search.results?.[0] };
  }
  // Spread caller properties first so the canonical `name` (the value we just
  // deduped on) always wins over a stray properties.name.
  return { created: true, company: await client.createCompany({ ...(args.properties ?? {}), name: args.name }) };
}

/** Body of the `createCompany` tool: the dedupe-or-create above, rendered. */
export async function opCreateCompany(
  client: HubSpotClient,
  args: { name: string; properties?: Record<string, unknown> },
): Promise<string> {
  const { created, company } = await performCreateCompany(client, args);
  return `${created ? 'Created company.' : 'Company already exists:'}\n\n${formatCompany(company)}`;
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
async function opSearchObjects(
  client: HubSpotClient,
  label: 'companies' | 'contacts' | 'deals',
  args: SearchArgs,
): Promise<string> {
  const defaults = {
    companies: COMPANY_SEARCH_PROPERTIES,
    contacts: CONTACT_SEARCH_PROPERTIES,
    deals: DEAL_SEARCH_PROPERTIES,
  }[label];
  const properties = args.properties ?? defaults;
  const body = textSearch({ query: args.query, filters: args.filters, properties, limit: args.limit });
  const search = {
    companies: () => client.searchCompanies(body),
    contacts: () => client.searchContacts(body),
    deals: () => client.searchDeals(body),
  }[label];
  const res = await search();
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

/**
 * Engagements associated with a company, resolved to detail records.
 *
 * company_handler.py:171 — associations-v4 fan-out, then one detail read per id.
 * `omitted` is returned rather than dropped: the fan-out is capped, so a caller
 * that only saw the details would read a truncated activity list as the whole
 * timeline. Both the MCP formatter and the REST route report it.
 */
export async function fetchCompanyActivity(
  client: HubSpotClient,
  companyId: string,
): Promise<{ details: HubSpotEngagementDetail[]; omitted: number }> {
  const ids = await client.getCompanyEngagementIds(companyId);
  const capped = ids.slice(0, MAX_ACTIVITY_FETCH);
  const details = await Promise.all(capped.map(id => client.getEngagementDetail(id).catch(() => null)));
  return {
    details: details.filter((d): d is NonNullable<typeof d> => d !== null),
    omitted: ids.length - capped.length,
  };
}

/** Body of the `getCompanyActivity` tool: the fetch above, rendered. */
export async function opGetCompanyActivity(client: HubSpotClient, args: { companyId: string }): Promise<string> {
  const { details, omitted } = await fetchCompanyActivity(client, args.companyId);
  return formatCompanyActivity(details, omitted);
}

/**
 * Create a contact unless a matching one already exists.
 *
 * contact_handler.py:92 — dedupe on first and last name, plus company when one
 * is given. Returns `created` for the same reason performCreateCompany does.
 */
export async function performCreateContact(
  client: HubSpotClient,
  args: { firstname: string; lastname: string; email?: string; properties?: Record<string, unknown> },
): Promise<{ created: boolean; contact: HubSpotObject | undefined }> {
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
    return { created: false, contact: search.results?.[0] };
  }
  // Spread caller properties first so the canonical firstname/lastname/email
  // (the values we just deduped on) always win over stray property values.
  const properties: Record<string, unknown> = {
    ...(args.properties ?? {}),
    firstname: args.firstname,
    lastname: args.lastname,
    ...(args.email ? { email: args.email } : {}),
  };
  return { created: true, contact: await client.createContact(properties) };
}

/** Body of the `createContact` tool: the dedupe-or-create above, rendered. */
export async function opCreateContact(
  client: HubSpotClient,
  args: { firstname: string; lastname: string; email?: string; properties?: Record<string, unknown> },
): Promise<string> {
  const { created, contact } = await performCreateContact(client, args);
  return `${created ? 'Created contact.' : 'Contact already exists:'}\n\n${formatContact(contact)}`;
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

// --- Deal ops ---

export async function opGetActiveDeals(client: HubSpotClient, args: { limit: number }): Promise<string> {
  const res = await client.searchDeals(recentDealsSearch(args.limit));
  // Surface amount / dealstage / closedate so pipeline questions are answerable from the list.
  return formatObjectList(res.results ?? [], 'deals', DEAL_SEARCH_PROPERTIES);
}

// Search deals by free-text query and/or property filters — the by-name route
// to a deal ID, mirroring opSearchCompanies/opSearchContacts.
export function opSearchDeals(client: HubSpotClient, args: SearchArgs): Promise<string> {
  return opSearchObjects(client, 'deals', args);
}

/**
 * Deals associated with a company, resolved to full records.
 *
 * Two phases on purpose: associations v4 returns IDs only — and pages them, so
 * the ID scan is itself a loop — while the batch read is what turns those IDs
 * into amounts/stages/close dates. Every cap is reported rather than applied
 * silently: a truncated list that says "Found 10 deals" would read as the
 * company's complete pipeline.
 */
/**
 * Deals associated with a company, resolved to full records.
 *
 * Two phases on purpose: associations v4 returns IDs only — and pages them, so
 * the ID scan is itself a loop — while the batch read turns those IDs into
 * amounts, stages and close dates. Every cap is reported rather than applied
 * silently, which is what the four counters in the return are for.
 */
export async function fetchCompanyDeals(
  client: HubSpotClient,
  args: { companyId: string; limit: number; properties?: string[] },
): Promise<{
  deals: HubSpotObject[];
  properties: string[];
  /** IDs the association scan found, before `limit` was applied. */
  associatedCount: number;
  /** IDs this call asked HubSpot to read — `min(associatedCount, limit)`. */
  requestedCount: number;
  /** The association scan hit its page bound, so associatedCount is a floor. */
  truncated: boolean;
}> {
  const { ids, truncated } = await client.getCompanyDealIds(args.companyId);
  const properties = args.properties ?? DEAL_SEARCH_PROPERTIES;
  if (ids.length === 0) return { deals: [], properties, associatedCount: 0, requestedCount: 0, truncated };
  const requested = ids.slice(0, args.limit);
  return {
    deals: await client.readDealsByIds(requested, properties),
    properties,
    associatedCount: ids.length,
    requestedCount: requested.length,
    truncated,
  };
}

export type CompanyDealsResult = Awaited<ReturnType<typeof fetchCompanyDeals>>;

/**
 * Render a company's deals, including the two truncation facts.
 *
 * Split from the fetch so the REST sibling can serve the same numbers as JSON
 * without a second round-trip, and so the "N+" rule lives in one place: a
 * truncated association scan makes the total a FLOOR, and a total rendered as
 * an exact count would read as the company's whole pipeline.
 */
export function renderCompanyDeals(result: CompanyDealsResult): string {
  const { deals, properties, associatedCount, requestedCount, truncated } = result;
  if (associatedCount === 0) return 'No deals are associated with this company.';
  const total = truncated ? `${associatedCount}+` : `${associatedCount}`;
  const note = truncated || associatedCount > requestedCount
    ? `\n\nShowing ${requestedCount} of ${total} associated deals — raise \`limit\` to see the rest.`
    : '';
  return formatObjectList(deals, 'deals', properties) + note;
}

/** Body of the `getCompanyDeals` tool: the fetch above, rendered. */
export async function opGetCompanyDeals(
  client: HubSpotClient,
  args: { companyId: string; limit: number; properties?: string[] },
): Promise<string> {
  return renderCompanyDeals(await fetchCompanyDeals(client, args));
}

export async function opGetDeal(client: HubSpotClient, args: { dealId: string; properties?: string[] }): Promise<string> {
  const obj = await client.getDeal(args.dealId, args.properties);
  return formatDeal(obj) + missingPropertiesNote(args.properties, obj);
}

// Deals aren't uniquely named, so — unlike companies/contacts — there's no
// dedupe-before-create step; every call creates a new deal.
export async function opCreateDeal(
  client: HubSpotClient,
  args: { dealname: string; properties?: Record<string, unknown> },
): Promise<string> {
  // Spread caller properties first so the canonical dealname always wins.
  const created = await client.createDeal({ ...(args.properties ?? {}), dealname: args.dealname });
  return `Created deal.\n\n${formatDeal(created)}`;
}

export async function opUpdateDeal(
  client: HubSpotClient,
  args: { dealId: string; properties: Record<string, unknown> },
): Promise<string> {
  await client.updateDeal(args.dealId, args.properties);
  // Re-read for a consistent read shape (see opUpdateCompany).
  const fresh = await client.getDeal(args.dealId);
  return `Updated deal.\n\n${formatDeal(fresh)}`;
}

// Resolve stage IDs to human-readable names: one GET returns every pipeline
// with its ordered stages, covering both "list pipelines" and "list stages".
export async function opListPipelines(client: HubSpotClient, _args: Record<string, never>): Promise<string> {
  const page = await client.listDealPipelines();
  return formatPipelines(page.results ?? []);
}

// --- Engagement (activity) write ops ---

type EngagementArgs = {
  hs_timestamp?: string | number;
  associateToObjectType?: HubSpotObjectType;
  associateToObjectId?: string;
};

/**
 * Create an engagement, then (if a target is given) attach it via a default
 * v4 association so it lands on that record's timeline. hs_timestamp defaults
 * to now — omitting it is the most common HubSpot engagement-create failure.
 * Reports honestly: success only claims a timeline attachment once the
 * association call returns 2xx; otherwise it flags the note as orphaned.
 */
/**
 * The outcome of the optional timeline attachment.
 *
 * Reported as data rather than only folded into a message, because the REST
 * sibling has to answer the same question in JSON: `attempted` without
 * `attached` is an ORPHANED engagement — it exists but appears on no record's
 * timeline — and a response omitting that would read as a plain success.
 */
export type EngagementAssociation =
  | { attempted: false }
  | { attempted: true; attached: true; objectType: string; objectId: string }
  | { attempted: true; attached: false; objectType: string; objectId: string; error: string };

/**
 * Create an engagement, then (if a target was given) attach it to that record.
 *
 * Two calls, because HubSpot has no create-and-associate endpoint: the
 * engagement is created standalone and a v4 DEFAULT association attaches it,
 * which avoids the direction-sensitive association-type-ID table. hs_timestamp
 * defaults to now — omitting it is the most common documented create failure.
 * The association outcome comes back as data rather than folded into a message
 * so the REST sibling can answer the same question in JSON.
 */
export async function performCreateEngagement(
  client: HubSpotClient,
  engagementType: HubSpotEngagementType,
  label: string,
  properties: Record<string, unknown>,
  args: EngagementArgs,
  nowMs: number = Date.now(),
): Promise<{ engagement: HubSpotObject; association: EngagementAssociation }> {
  const created = await client.createEngagement(engagementType, {
    ...properties,
    hs_timestamp: args.hs_timestamp ?? nowMs,
  });
  if (!args.associateToObjectType || !args.associateToObjectId) {
    return { engagement: created, association: { attempted: false } };
  }
  const objectType = args.associateToObjectType;
  const objectId = args.associateToObjectId;
  if (!created.id) {
    return {
      engagement: created,
      association: {
        attempted: true,
        attached: false,
        objectType,
        objectId,
        error: 'HubSpot returned no ID for the created engagement, so it could not be attached.',
      },
    };
  }
  try {
    await client.associateDefault(engagementType, created.id, objectType, objectId);
    return { engagement: created, association: { attempted: true, attached: true, objectType, objectId } };
  } catch (err: any) {
    return {
      engagement: created,
      association: { attempted: true, attached: false, objectType, objectId, error: String(err?.message ?? err) },
    };
  }
}

async function opCreateEngagement(
  client: HubSpotClient,
  engagementType: HubSpotEngagementType,
  label: string,
  properties: Record<string, unknown>,
  args: EngagementArgs,
  nowMs: number = Date.now(),
): Promise<string> {
  const { engagement, association } = await performCreateEngagement(client, engagementType, label, properties, args, nowMs);
  let note = '';
  if (association.attempted) {
    const { objectType, objectId } = association;
    if (association.attached) {
      note = `\n\nAttached to ${objectType} ${objectId} (visible on its timeline).`;
    } else if (!engagement.id) {
      note = `\n\n⚠ ${label} created but no ID was returned, so it could not be attached to ${objectType} ${objectId}.`;
    } else {
      note = `\n\n⚠ ${label} created (id ${engagement.id}) but attaching it to ${objectType} ${objectId} failed: ${association.error}. It will not appear on that record's timeline until associated.`;
    }
  }
  return `Created ${label}.\n\n${formatEngagement(engagement, label)}${note}`;
}

export async function opCreateNote(
  client: HubSpotClient,
  args: EngagementArgs & { body: string },
  nowMs: number = Date.now(),
): Promise<string> {
  return opCreateEngagement(client, 'notes', 'note', { hs_note_body: args.body }, args, nowMs);
}

export async function opCreateTask(
  client: HubSpotClient,
  args: EngagementArgs & { subject?: string; body?: string; status?: string; priority?: string },
  nowMs: number = Date.now(),
): Promise<string> {
  const props: Record<string, unknown> = {};
  if (args.subject !== undefined) props.hs_task_subject = args.subject;
  if (args.body !== undefined) props.hs_task_body = args.body;
  if (args.status !== undefined) props.hs_task_status = args.status;
  if (args.priority !== undefined) props.hs_task_priority = args.priority;
  return opCreateEngagement(client, 'tasks', 'task', props, args, nowMs);
}

export async function opLogCall(
  client: HubSpotClient,
  args: EngagementArgs & { title?: string; body?: string; durationMs?: number; direction?: string },
  nowMs: number = Date.now(),
): Promise<string> {
  const props: Record<string, unknown> = {};
  if (args.title !== undefined) props.hs_call_title = args.title;
  if (args.body !== undefined) props.hs_call_body = args.body;
  if (args.durationMs !== undefined) props.hs_call_duration = args.durationMs;
  if (args.direction !== undefined) props.hs_call_direction = args.direction;
  return opCreateEngagement(client, 'calls', 'call', props, args, nowMs);
}

export async function opLogMeeting(
  client: HubSpotClient,
  args: EngagementArgs & { title?: string; body?: string; startTime?: string | number; endTime?: string | number },
  nowMs: number = Date.now(),
): Promise<string> {
  const props: Record<string, unknown> = {};
  if (args.title !== undefined) props.hs_meeting_title = args.title;
  if (args.body !== undefined) props.hs_meeting_body = args.body;
  if (args.startTime !== undefined) props.hs_meeting_start_time = args.startTime;
  if (args.endTime !== undefined) props.hs_meeting_end_time = args.endTime;
  return opCreateEngagement(client, 'meetings', 'meeting', props, args, nowMs);
}

/**
 * Delete an engagement. The counterpart to the four create tools: without it,
 * anything written while testing the timeline-association behaviour has to be
 * cleaned up by hand in the HubSpot UI.
 */
export async function opDeleteEngagement(
  client: HubSpotClient,
  args: { engagementType: HubSpotEngagementType; engagementId: string },
): Promise<string> {
  await client.deleteEngagement(args.engagementType, args.engagementId);
  // Every engagement type is the plural of its label ('notes' -> 'note').
  const label = args.engagementType.slice(0, -1);
  return `Deleted ${label} ${args.engagementId}. It no longer appears on any record's timeline (recoverable from HubSpot's recycling bin).`;
}

/**
 * Recent conversation threads, each with its messages.
 *
 * conversation_handler.py:39 — list threads, then fetch each thread's messages.
 * That is one upstream call per thread on top of the list, so `limit` is the
 * cost knob on both surfaces.
 */
export async function fetchRecentConversations(
  client: HubSpotClient,
  args: { limit: number; after?: string },
): Promise<{ threads: RenderedThread[]; nextAfter?: string }> {
  const page = await client.listConversationThreads({ limit: args.limit, after: args.after });
  const threads = await Promise.all(
    (page.results ?? []).map(t => renderThread(() => client.getThreadMessages(String(t.id)), t)),
  );
  return { threads, nextAfter: page.paging?.next?.after };
}

/** Body of the `getRecentConversations` tool: the fetch above, rendered. */
export async function opGetRecentConversations(
  client: HubSpotClient,
  args: { limit: number; after?: string },
): Promise<string> {
  const { threads, nextAfter } = await fetchRecentConversations(client, args);
  return formatThreads(threads, nextAfter);
}

// ticket_handler.py:58 — criteria-based filter groups + retry (in searchTickets).
/**
 * Search tickets by criteria, with backoff on 429 and 5xx.
 *
 * ticket_handler.py:58. The date filters go out as epoch MILLISECONDS, not
 * ISO-8601: HubSpot's search API 400s on an ISO datetime, which is why the
 * `default` branch used to fail while `Closed` (a string stage filter) worked.
 */
export async function fetchTickets(
  client: HubSpotClient,
  args: { criteria: 'default' | 'Closed'; limit: number; maxRetries: number; retryDelay: number },
  nowMs: number = Date.now(),
): Promise<HubSpotSearchResponse> {
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
  return client.searchTickets(body, { maxRetries: args.maxRetries, retryDelay: args.retryDelay });
}

/** Body of the `getTickets` tool: the search above, rendered. */
export async function opGetTickets(
  client: HubSpotClient,
  args: { criteria: 'default' | 'Closed'; limit: number; maxRetries: number; retryDelay: number },
  nowMs: number = Date.now(),
): Promise<string> {
  const res = await fetchTickets(client, args, nowMs);
  return formatTickets(res.results ?? [], res.total, res.paging?.next?.after);
}

/**
 * Conversation threads associated with a ticket, each with its messages.
 *
 * ticket_handler.py:133 — the tickets-to-conversation association read, then one
 * message read per thread.
 */
export async function fetchTicketConversationThreads(
  client: HubSpotClient,
  ticketId: string,
): Promise<{ threads: RenderedThread[] }> {
  const threadIds = await client.getTicketConversationIds(ticketId);
  return { threads: await Promise.all(threadIds.map(id => renderThread(() => client.getThreadMessages(id), { id }))) };
}

/** Body of the `getTicketConversationThreads` tool: the fetch above, rendered. */
export async function opGetTicketConversationThreads(client: HubSpotClient, args: { ticketId: string }): Promise<string> {
  const { threads } = await fetchTicketConversationThreads(client, args.ticketId);
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
  parameters: createCompanySchema,
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to create company', session, log, (client) => {
      log.info(`createCompany name=${args.name}`);
      return opCreateCompany(client, args);
    }),
});

addRecentListTool({ name: 'getActiveCompanies', label: 'companies', op: opGetActiveCompanies });

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
  parameters: createContactSchema,
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to create contact', session, log, (client) => {
      log.info('createContact');
      return opCreateContact(client, args);
    }),
});

addRecentListTool({ name: 'getActiveContacts', label: 'contacts', op: opGetActiveContacts });

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

// --- Deal tools ---

addRecentListTool({
  name: 'getActiveDeals',
  label: 'deals',
  extra: ', including amount, stage, pipeline, and close date',
  op: opGetActiveDeals,
});

addSearchTool({
  name: 'searchDeals',
  label: 'deals',
  singular: 'deal',
  resolveBy: 'name',
  queryExamples: 'dealname',
  defaultProperties: 'dealname, amount, dealstage, pipeline, closedate',
});

hubspotServer.addTool({
  name: 'getCompanyDeals',
  annotations: { readOnlyHint: true },
  description:
    "List the deals associated with a company, with amount, stage, pipeline, and close date. " +
    'Use this to go from a company ID to its deal IDs — getDeal needs an ID no other tool returns.',
  parameters: z.object({
    companyId: z.string().describe('HubSpot company ID (resolve a name with searchCompanies).'),
    properties: z
      .array(z.string())
      .optional()
      .describe('Deal properties to return (defaults to dealname, amount, dealstage, pipeline, closedate).'),
    limit: z.number().int().min(1).max(100).optional().default(25)
      .describe('Maximum deals to return (default 25, max 100). The total found is always reported.'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to get company deals', session, log, (client) => {
      log.info(`getCompanyDeals companyId=${args.companyId}`);
      return opGetCompanyDeals(client, args);
    }),
});

hubspotServer.addTool({
  name: 'getDeal',
  annotations: { readOnlyHint: true },
  description: 'Get a specific deal by ID from HubSpot.',
  parameters: z.object({
    dealId: z.string().describe('HubSpot deal ID.'),
    properties: z.array(z.string()).optional().describe('Optional list of properties to retrieve. If omitted, returns the default set.'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to get deal', session, log, (client) => {
      log.info(`getDeal id=${args.dealId}`);
      return opGetDeal(client, args);
    }),
});

hubspotServer.addTool({
  name: 'createDeal',
  annotations: { readOnlyHint: false },
  description: 'Create a new deal in HubSpot. Set dealstage/pipeline via properties (use listPipelines to resolve stage IDs).',
  parameters: createDealSchema,
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to create deal', session, log, (client) => {
      log.info(`createDeal name=${args.dealname}`);
      return opCreateDeal(client, args);
    }),
});

hubspotServer.addTool({
  name: 'updateDeal',
  annotations: { readOnlyHint: false },
  description: 'Update an existing deal record in HubSpot (e.g. move stage, change amount).',
  parameters: z.object({
    dealId: z.string().describe('HubSpot deal ID to update.'),
    properties: z.record(z.string(), z.any())
      .refine(o => Object.keys(o).length > 0, { message: 'Provide at least one property to update.' })
      .describe('Object containing the properties to update (at least one).'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to update deal', session, log, (client) => {
      log.info(`updateDeal id=${args.dealId}`);
      return opUpdateDeal(client, args);
    }),
});

hubspotServer.addTool({
  name: 'listPipelines',
  annotations: { readOnlyHint: true },
  description: 'List HubSpot deal pipelines and their stages (with stage IDs), so deal stage IDs can be resolved to human-readable names.',
  parameters: z.object({}),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to list pipelines', session, log, (client) => {
      log.info('listPipelines');
      return opListPipelines(client, args);
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

// --- Engagement (activity) write tools ---
// Create notes/tasks/calls/meetings and optionally attach them to a record's
// timeline. HubSpot covers all four under the contacts read/write scopes the
// catalog already requests — see the scope note in mcpCatalogStore.ts.

hubspotServer.addTool({
  name: 'createNote',
  annotations: { readOnlyHint: false },
  description: 'Create a note and optionally attach it to a company, contact, or deal so it appears on that record\'s timeline.',
  parameters: createNoteSchema,
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to create note', session, log, (client) => {
      log.info(`createNote associate=${args.associateToObjectType ?? 'none'}`);
      return opCreateNote(client, args);
    }),
});

hubspotServer.addTool({
  name: 'createTask',
  annotations: { readOnlyHint: false },
  description: 'Create a task and optionally attach it to a company, contact, or deal.',
  parameters: z
    .object({
      subject: z.string().optional().describe('Task title (hs_task_subject).'),
      body: z.string().optional().describe('Task notes/body (hs_task_body).'),
      status: z.string().optional().describe('Task status, e.g. NOT_STARTED, IN_PROGRESS, WAITING, COMPLETED, DEFERRED (hs_task_status).'),
      priority: z.string().optional().describe('Task priority, e.g. LOW, MEDIUM, HIGH (hs_task_priority).'),
      ...engagementAssociationShape,
    })
    .refine(bothOrNeitherTarget, { message: TARGET_MSG }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to create task', session, log, (client) => {
      log.info(`createTask associate=${args.associateToObjectType ?? 'none'}`);
      return opCreateTask(client, args);
    }),
});

hubspotServer.addTool({
  name: 'logCall',
  annotations: { readOnlyHint: false },
  description: 'Log a call activity and optionally attach it to a company, contact, or deal.',
  parameters: logCallSchema,
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to log call', session, log, (client) => {
      log.info(`logCall associate=${args.associateToObjectType ?? 'none'}`);
      return opLogCall(client, args);
    }),
});

hubspotServer.addTool({
  name: 'logMeeting',
  annotations: { readOnlyHint: false },
  description: 'Log a meeting activity and optionally attach it to a company, contact, or deal.',
  parameters: logMeetingSchema,
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to log meeting', session, log, (client) => {
      log.info(`logMeeting associate=${args.associateToObjectType ?? 'none'}`);
      return opLogMeeting(client, args);
    }),
});

hubspotServer.addTool({
  name: 'deleteEngagement',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description:
    'Delete a note, task, call, or meeting by ID — the cleanup counterpart to createNote/createTask/logCall/logMeeting.',
  parameters: z.object({
    engagementType: z
      .enum(['notes', 'tasks', 'calls', 'meetings'])
      .describe('Type of engagement to delete (plural, matching the tool that created it).'),
    engagementId: z.string().describe('HubSpot ID of the engagement (returned when it was created).'),
  }),
  execute: (args, { log, session }) =>
    withHubSpotClient('Failed to delete engagement', session, log, (client) => {
      log.info(`deleteEngagement type=${args.engagementType} id=${args.engagementId}`);
      return opDeleteEngagement(client, args);
    }),
});
