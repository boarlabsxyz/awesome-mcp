// src/hubspot/apiHelpers.ts
// Bearer-token HTTP client for the HubSpot CRM v3 REST API.
// Docs: https://developers.hubspot.com/docs/api/crm/understanding-the-crm
//
// Ported from https://github.com/baryhuang/mcp-hubspot@4a8345f2507b4159fc84eb500c74669329076f53
// The reference implementation used the official `hubspot` Python SDK
// (self.client.crm.companies.basic_api...); here we talk to the same public
// endpoints directly over fetch. Auth is a HubSpot private-app access token
// (bearer). Only the simple CRUD/search/property surface is translated;
// engagement fan-out (activity), conversation caching, ticket retry/backoff,
// and the FAISS semantic search are left as TODO stubs in server.ts.

import { UserError } from 'fastmcp';
import { UserSession } from '../userSession.js';
import { refreshHubSpotToken, HUBSPOT_TOKEN_URL } from './oauthCallback.js';

const DEFAULT_BASE_URL = process.env.HUBSPOT_BASE_URL || 'https://api.hubapi.com';

const REQUEST_TIMEOUT_MS = 30_000;

/** A CRM object as returned by the v3 basic/search APIs. */
export type HubSpotObject = {
  id?: string;
  properties?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
};

export type HubSpotSearchResponse = {
  total?: number;
  results?: HubSpotObject[];
  paging?: { next?: { after?: string } };
};

/** A HubSpot property definition (from /crm/v3/properties/{objectType}/...). */
export type HubSpotProperty = {
  name?: string;
  label?: string;
  type?: string;
  fieldType?: string;
  groupName?: string;
  description?: string;
  options?: Array<{ label?: string; value?: string; description?: string; displayOrder?: number }>;
};

/** Object types the property + search tools operate on. */
export type HubSpotObjectType = 'companies' | 'contacts';

/** A dropdown option, as accepted by the property create/update tools. */
export type HubSpotPropertyOption = {
  label: string;
  value: string;
  description?: string;
  displayOrder?: number;
};

/** A page of associations-v4 results (`toObjectId` is the associated record). */
export type HubSpotAssociationPage = {
  results?: Array<{ toObjectId?: string | number; id?: string | number }>;
};

/** Legacy `/engagements/v1` detail shape. */
export type HubSpotEngagementDetail = {
  engagement?: { id?: string | number; type?: string; timestamp?: number | string };
  metadata?: Record<string, any>;
};

/** A conversation message (`/conversations/v3`). */
export type HubSpotMessage = {
  id?: string;
  type?: string;
  text?: string;
  createdAt?: string;
  direction?: string;
  senders?: Array<{ actorId?: string; senderField?: string }>;
};

export type HubSpotMessagePage = { results?: HubSpotMessage[] };

/** A conversation thread (`/conversations/v3`). */
export type HubSpotThread = {
  id?: string | number;
  status?: string;
  createdAt?: string;
};

export type HubSpotThreadPage = {
  results?: HubSpotThread[];
  paging?: { next?: { after?: string } };
};

/** A thread rendered for output: header fields plus normalized messages. */
export type RenderedThread = {
  id?: string | number;
  status?: string;
  messages: Array<{ created_at?: string; sender_type?: string; text?: string }>;
};

export class HubSpotClient {
  /** Base URL of the HubSpot API this client talks to (no trailing slash). */
  public readonly baseUrl: string;

  constructor(private token: string, baseUrl?: string) {
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new Error(`HubSpot API ${method} ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err: any = new Error(`HubSpot API ${method} ${path} failed: ${res.status} ${text}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }
    if (res.status === 204) return undefined as unknown as T;
    if (res.headers.get('content-type')?.includes('application/json')) {
      return (await res.json()) as T;
    }
    return undefined as unknown as T;
  }

  // === Companies ===

  searchCompanies(body: unknown): Promise<HubSpotSearchResponse> {
    return this.request('POST', '/crm/v3/objects/companies/search', body);
  }

  createCompany(properties: Record<string, unknown>): Promise<HubSpotObject> {
    return this.request('POST', '/crm/v3/objects/companies', { properties });
  }

  getCompany(companyId: string, properties?: string[]): Promise<HubSpotObject> {
    const qs = properties?.length ? `&properties=${properties.map(encodeURIComponent).join(',')}` : '';
    return this.request('GET', `/crm/v3/objects/companies/${encodeURIComponent(companyId)}?archived=false${qs}`);
  }

  updateCompany(companyId: string, properties: Record<string, unknown>): Promise<HubSpotObject> {
    return this.request('PATCH', `/crm/v3/objects/companies/${encodeURIComponent(companyId)}`, { properties });
  }

  // === Contacts ===

  searchContacts(body: unknown): Promise<HubSpotSearchResponse> {
    return this.request('POST', '/crm/v3/objects/contacts/search', body);
  }

  createContact(properties: Record<string, unknown>): Promise<HubSpotObject> {
    return this.request('POST', '/crm/v3/objects/contacts', { properties });
  }

  getContact(contactId: string, properties?: string[]): Promise<HubSpotObject> {
    const qs = properties?.length ? `&properties=${properties.map(encodeURIComponent).join(',')}` : '';
    return this.request('GET', `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}?archived=false${qs}`);
  }

  updateContact(contactId: string, properties: Record<string, unknown>): Promise<HubSpotObject> {
    return this.request('PATCH', `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`, { properties });
  }

  // === Properties ===

  getProperty(objectType: HubSpotObjectType, propertyName: string): Promise<HubSpotProperty> {
    return this.request('GET', `/crm/v3/properties/${objectType}/${encodeURIComponent(propertyName)}`);
  }

  updateProperty(
    objectType: HubSpotObjectType,
    propertyName: string,
    body: Record<string, unknown>,
  ): Promise<HubSpotProperty> {
    return this.request('PATCH', `/crm/v3/properties/${objectType}/${encodeURIComponent(propertyName)}`, body);
  }

  createProperty(objectType: HubSpotObjectType, body: Record<string, unknown>): Promise<HubSpotProperty> {
    return this.request('POST', `/crm/v3/properties/${objectType}`, body);
  }

  // === Company activity (engagements) ===

  /** IDs of engagements associated with a company (associations v4). */
  async getCompanyEngagementIds(companyId: string): Promise<string[]> {
    const res = await this.request<HubSpotAssociationPage>(
      'GET',
      `/crm/v4/objects/companies/${encodeURIComponent(companyId)}/associations/engagements?limit=500`,
    );
    return (res.results ?? [])
      .map(r => String(r.toObjectId ?? r.id ?? ''))
      .filter(Boolean);
  }

  /** Legacy engagement detail: `{ engagement, metadata, associations }`. */
  getEngagementDetail(engagementId: string): Promise<HubSpotEngagementDetail> {
    return this.request('GET', `/engagements/v1/engagements/${encodeURIComponent(engagementId)}`);
  }

  // === Tickets ===

  /**
   * Ticket search with exponential backoff on 429 / 5xx (mirrors the
   * reference client's retry loop). `retryDelay` is in seconds; the nth retry
   * waits `retryDelay * 2^(n-1)` seconds.
   */
  async searchTickets(
    body: unknown,
    opts: { maxRetries: number; retryDelay: number },
  ): Promise<HubSpotSearchResponse> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.request<HubSpotSearchResponse>('POST', '/crm/v3/objects/tickets/search', body);
      } catch (err: any) {
        const status = err?.status;
        const retryable = status === 429 || (typeof status === 'number' && status >= 500 && status < 600);
        if (!retryable || attempt >= opts.maxRetries) throw err;
        attempt += 1;
        const sleepMs = opts.retryDelay * 1000 * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, sleepMs));
      }
    }
  }

  /** IDs of conversation threads associated with a ticket (associations v4). */
  async getTicketConversationIds(ticketId: string): Promise<string[]> {
    const res = await this.request<HubSpotAssociationPage>(
      'GET',
      `/crm/v4/objects/tickets/${encodeURIComponent(ticketId)}/associations/conversation`,
    );
    return (res.results ?? [])
      .map(r => String(r.toObjectId ?? r.id ?? ''))
      .filter(Boolean);
  }

  // === Conversations ===

  /** A page of conversation threads, newest first. */
  listConversationThreads(input: { limit: number; after?: string }): Promise<HubSpotThreadPage> {
    const qs = new URLSearchParams({ limit: String(input.limit), sort: '-id' });
    if (input.after) qs.set('after', input.after);
    return this.request('GET', `/conversations/v3/conversations/threads?${qs.toString()}`);
  }

  /** All messages on a conversation thread. */
  getThreadMessages(threadId: string): Promise<HubSpotMessagePage> {
    return this.request('GET', `/conversations/v3/conversations/threads/${encodeURIComponent(threadId)}/messages`);
  }
}

// ==== Search-request builders (ported from the reference clients) ====

/** Default company properties returned by the list/search company tools. */
export const COMPANY_SEARCH_PROPERTIES = ['name', 'domain', 'website', 'phone', 'industry', 'hs_lastmodifieddate'];
/** Default contact properties returned by the list/search contact tools. */
export const CONTACT_SEARCH_PROPERTIES = ['firstname', 'lastname', 'email', 'company', 'phone', 'lastmodifieddate'];

// Adapted from baryhuang/mcp-hubspot@4a8345f clients/company_client.py:105
export function recentCompaniesSearch(limit: number): Record<string, unknown> {
  return {
    sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
    limit,
    properties: COMPANY_SEARCH_PROPERTIES,
  };
}

// Contacts sort on lastmodifieddate; mirror the company shape with contact props.
export function recentContactsSearch(limit: number): Record<string, unknown> {
  return {
    sorts: [{ propertyName: 'lastmodifieddate', direction: 'DESCENDING' }],
    limit,
    properties: CONTACT_SEARCH_PROPERTIES,
  };
}

/** An `EQ` filter group for the search API. */
export function eqFilterGroup(filters: Array<{ propertyName: string; value: string }>): Record<string, unknown> {
  return { filterGroups: [{ filters: filters.map(f => ({ ...f, operator: 'EQ' })) }] };
}

/** A single filter for the CRM search API. `value` is omitted for existence operators. */
export type HubSpotSearchFilter = { propertyName: string; operator: string; value?: string };

/**
 * Build a CRM search request from a free-text query and/or explicit filters.
 * `query` maps to HubSpot's top-level free-text `query` (which searches the
 * object's default searchable properties); `filters` become a single AND
 * filterGroup. At least one of the two should be present — the tool layer
 * enforces that so the API isn't hit with an unbounded match-all.
 */
export function textSearch(input: {
  query?: string;
  filters?: HubSpotSearchFilter[];
  properties: string[];
  limit: number;
}): Record<string, unknown> {
  const body: Record<string, unknown> = { limit: input.limit, properties: input.properties };
  if (input.query) body.query = input.query;
  if (input.filters?.length) body.filterGroups = [{ filters: input.filters }];
  return body;
}

// ==== Formatting helpers ====

function fmtObject(obj: HubSpotObject | undefined, label: string): string {
  if (!obj) return `No ${label} data returned.`;
  const lines = [`${label}:`, `  ID: ${obj.id ?? ''}`];
  for (const [k, v] of Object.entries(obj.properties ?? {})) {
    if (v === null || v === undefined || v === '') continue;
    lines.push(`  ${k}: ${String(v)}`);
  }
  if (obj.updatedAt) lines.push(`  Updated: ${obj.updatedAt}`);
  return lines.join('\n');
}

export function formatCompany(obj: HubSpotObject | undefined): string {
  return fmtObject(obj, 'Company');
}

export function formatContact(obj: HubSpotObject | undefined): string {
  return fmtObject(obj, 'Contact');
}

export function formatObjectList(results: HubSpotObject[], label: string, requestedProps?: string[]): string {
  if (results.length === 0) return `No ${label} found.`;
  const parts = [`Found ${results.length} ${label}:`, ''];
  // Requested keys HubSpot never returned on any record — reported once at the
  // end so "unknown property" stays distinguishable from "unset on this record".
  const neverReturned = new Set(requestedProps ?? []);
  results.forEach((obj, i) => {
    const props = obj.properties ?? {};
    const name =
      (props.name as string) ||
      [props.firstname, props.lastname].filter(Boolean).join(' ') ||
      (props.email as string) ||
      '(unnamed)';
    parts.push(`${i + 1}. ${name}`);
    parts.push(`   ID: ${obj.id ?? ''}`);
    // When the caller requested specific properties (search tools), render every
    // one of them — including the empty ones, explicitly marked. Silently
    // dropping empties makes "no value on this record" look identical to "this
    // tool doesn't return that property".
    for (const key of requestedProps ?? []) {
      if (!(key in props)) continue;
      neverReturned.delete(key);
      const v = props[key];
      const empty = v === null || v === undefined || v === '';
      parts.push(`   ${key}: ${empty ? '(empty)' : String(v)}`);
    }
    if (obj.updatedAt) parts.push(`   Updated: ${obj.updatedAt}`);
    parts.push('');
  });
  const out = parts.join('\n').trimEnd();
  if (neverReturned.size === 0) return out;
  return `${out}\n\n⚠ Requested properties not returned by HubSpot (unknown or unavailable): ${[...neverReturned].join(', ')}`;
}

export function formatProperty(prop: HubSpotProperty | undefined): string {
  if (!prop) return 'No property data returned.';
  const lines = [
    `Property: ${prop.label ?? prop.name ?? ''}`,
    `  Name: ${prop.name ?? ''}`,
    `  Type: ${prop.type ?? ''}`,
    `  Field type: ${prop.fieldType ?? ''}`,
    `  Group: ${prop.groupName ?? ''}`,
  ];
  if (prop.description) lines.push(`  Description: ${prop.description}`);
  if (prop.options?.length) {
    lines.push(`  Options (${prop.options.length}):`);
    for (const o of prop.options) lines.push(`    - ${o.label ?? ''} = ${o.value ?? ''}`);
  }
  return lines.join('\n');
}

/** Cap free-text fields so a tool response can't balloon past a few lines. */
const TEXT_CAP = 200;
function cap(v: unknown): string {
  const s = typeof v === 'string' ? v : '';
  return s.length > TEXT_CAP ? `${s.slice(0, TEXT_CAP)}…` : s;
}

/**
 * Classify a conversation message's sender as AGENT / CUSTOMER / UNKNOWN.
 * Ported from ticket_client._determine_sender_type: HubSpot agents send with
 * `senderField === 'FROM'` and an actorId prefixed by an agent/team namespace.
 */
export function hubspotSenderType(msg: HubSpotMessage): string {
  const senders = msg?.senders;
  if (Array.isArray(senders) && senders.length > 0) {
    const s = senders[0];
    const actorId = typeof s?.actorId === 'string' ? s.actorId : '';
    if (s?.senderField === 'FROM' && (actorId.startsWith('0-1') || actorId.startsWith('0-2'))) {
      return 'AGENT';
    }
    return 'CUSTOMER';
  }
  return 'UNKNOWN';
}

/** Render one engagement's content by type (ported from company_client). */
function engagementContent(type: string, metadata: Record<string, any>): string {
  switch (type) {
    case 'NOTE':
      return cap(metadata?.body);
    case 'EMAIL': {
      const subject = metadata?.subject ? `Subject: ${metadata.subject}; ` : '';
      const from = metadata?.from?.email || metadata?.from?.raw || '';
      const fromStr = from ? `From: ${from}; ` : '';
      return `${subject}${fromStr}${cap(metadata?.text || metadata?.html)}`.trim();
    }
    case 'TASK':
      return `${metadata?.subject ?? ''} ${cap(metadata?.body)} ${metadata?.status ? `[${metadata.status}]` : ''}`.trim();
    case 'MEETING':
      return `${metadata?.title ?? ''} ${cap(metadata?.body)}`.trim();
    case 'CALL':
      return `${cap(metadata?.body)} ${metadata?.status ? `[${metadata.status}]` : ''}`.trim();
    default:
      return '';
  }
}

/**
 * Render a HubSpot timestamp as ISO-8601 for output consistency. The
 * /engagements/v1 API returns epoch milliseconds (number or numeric string);
 * every other tool emits ISO, so normalize here. Non-timestamp values pass
 * through unchanged.
 */
export function epochToIso(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  const ms = typeof v === 'number' ? v : /^\d+$/.test(String(v)) ? Number(v) : NaN;
  if (!Number.isFinite(ms)) return String(v);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

/**
 * When a read requested specific property keys, flag any that HubSpot didn't
 * return — it silently drops unknown keys, so this makes reads "loud" instead
 * of quietly returning a partial record. Returns '' when nothing is missing.
 */
export function missingPropertiesNote(requested: string[] | undefined, obj: HubSpotObject | undefined): string {
  if (!requested?.length) return '';
  const props = obj?.properties ?? {};
  const missing = requested.filter(p => !(p in props));
  if (missing.length === 0) return '';
  return `\n\n⚠ Requested properties not returned (unknown or unavailable on this record): ${missing.join(', ')}`;
}

export function formatCompanyActivity(details: HubSpotEngagementDetail[], omitted = 0): string {
  if (details.length === 0) return 'No activity found for this company.';
  const parts = [`Found ${details.length} activit${details.length === 1 ? 'y' : 'ies'}:`, ''];
  details.forEach((d, i) => {
    const e = d?.engagement ?? {};
    const type = e?.type ?? 'UNKNOWN';
    parts.push(`${i + 1}. ${type} (id ${e?.id ?? ''})`);
    if (e?.timestamp) parts.push(`   When: ${epochToIso(e.timestamp)}`);
    const content = engagementContent(type, d?.metadata ?? {});
    if (content) parts.push(`   ${content}`);
    parts.push('');
  });
  if (omitted > 0) parts.push(`(+${omitted} more activities not shown)`);
  return parts.join('\n').trimEnd();
}

export function formatThreads(threads: RenderedThread[], nextAfter?: string): string {
  if (threads.length === 0) return 'No conversation threads found.';
  const parts = [`Found ${threads.length} conversation thread${threads.length === 1 ? '' : 's'}:`, ''];
  threads.forEach((t, i) => {
    const status = t.status ? ` [${t.status}]` : '';
    parts.push(`${i + 1}. Thread ${t.id ?? ''}${status}`);
    parts.push(`   ${t.messages.length} message${t.messages.length === 1 ? '' : 's'}`);
    for (const m of t.messages) {
      const who = m.sender_type && m.sender_type !== 'UNKNOWN' ? `${m.sender_type}: ` : '';
      parts.push(`   - ${who}${cap(m.text)}`);
    }
    parts.push('');
  });
  if (nextAfter) parts.push(`More available. Pass after="${nextAfter}" to page.`);
  return parts.join('\n').trimEnd();
}

export function formatTickets(tickets: HubSpotObject[], total?: number, nextAfter?: string): string {
  if (tickets.length === 0) return 'No tickets found.';
  const header = total ? `Found ${tickets.length} of ${total} tickets:` : `Found ${tickets.length} tickets:`;
  const parts = [header, ''];
  tickets.forEach((t, i) => {
    const p = (t.properties ?? {}) as Record<string, any>;
    parts.push(`${i + 1}. ${p.subject ?? '(no subject)'}`);
    parts.push(`   ID: ${t.id ?? ''}`);
    if (p.hs_ticket_priority) parts.push(`   Priority: ${p.hs_ticket_priority}`);
    if (p.hs_pipeline_stage) parts.push(`   Stage: ${p.hs_pipeline_stage}`);
    if (p.createdate) parts.push(`   Created: ${p.createdate}`);
    if (p.closedate) parts.push(`   Closed: ${p.closedate}`);
    parts.push('');
  });
  if (nextAfter) parts.push(`More available (pagination token: ${nextAfter}).`);
  return parts.join('\n').trimEnd();
}

// ==== Session + error helpers used by every HubSpot tool executor ====

export type HubSpotToolLog = {
  info: (msg: string) => void;
  error: (msg: string) => void;
};

/** Extract the HubSpotClient from a session, or throw a not-connected UserError. */
export function getHubSpotClient(session?: UserSession): HubSpotClient {
  if (!session?.hubspotAccessToken) {
    throw new UserError('HubSpot not connected. Visit the dashboard to connect your HubSpot account.');
  }
  return new HubSpotClient(session.hubspotAccessToken, session.hubspotBaseUrl);
}

/** Translate an API/network error into a `UserError` with the given prefix. */
export function mapHubSpotError(prefix: string, error: any, log: HubSpotToolLog): never {
  log.error(`${prefix}: ${error?.message ?? error}`);
  if (error?.status === 401 || error?.status === 403) {
    throw new UserError(`${prefix}: not authorized. Check that your HubSpot token has the required scopes.`);
  }
  if (error?.status === 404) {
    throw new UserError(`${prefix}: not found.`);
  }
  throw new UserError(`${prefix}: ${error?.message ?? 'Unknown error'}`);
}

/** Refresh proactively this many ms before the access token's stated expiry. */
const HUBSPOT_REFRESH_SKEW_MS = 60_000;

// Single-flight guard: collapse concurrent refreshes for the same connection so
// only one refresh grant is in flight at a time. Keyed by hubspotInstanceId when
// present; the WeakMap covers the (rare) session without a stable instance id.
const inflightHubSpotRefreshById = new Map<string, Promise<void>>();
const inflightHubSpotRefreshBySession = new WeakMap<UserSession, Promise<void>>();

/**
 * If this is an OAuth HubSpot session whose access token is at/near expiry,
 * exchange the refresh token for a fresh access token, mutate the (cached,
 * by-reference) session in place, and persist the new tokens. Concurrent calls
 * for the same connection share a single in-flight refresh.
 *
 * Best-effort and never throws: on any failure the existing access token is
 * left in place so the tool call still proceeds (and surfaces a normal 401 via
 * mapHubSpotError if the token really is dead). No-ops for paste-token sessions
 * (no refresh_token / expiry / client creds) — so the paste-token flow is
 * completely unaffected.
 */
export async function maybeRefreshHubSpotToken(
  session: UserSession | undefined,
  log: HubSpotToolLog,
): Promise<void> {
  if (!session) return;
  const expiry = session.hubspotTokenExpiry;
  // Only OAuth connections carry all of these; anything else skips refresh.
  if (!expiry || !session.hubspotRefreshToken || !session.hubspotOauthClientId || !session.hubspotOauthClientSecret) {
    return;
  }
  if (Date.now() < expiry - HUBSPOT_REFRESH_SKEW_MS) return;

  const instanceId = session.hubspotInstanceId;
  const existing = instanceId
    ? inflightHubSpotRefreshById.get(instanceId)
    : inflightHubSpotRefreshBySession.get(session);
  if (existing) {
    await existing;
    return;
  }

  const refresh = performHubSpotRefresh(session, log).finally(() => {
    if (instanceId) inflightHubSpotRefreshById.delete(instanceId);
    else inflightHubSpotRefreshBySession.delete(session);
  });
  if (instanceId) inflightHubSpotRefreshById.set(instanceId, refresh);
  else inflightHubSpotRefreshBySession.set(session, refresh);
  await refresh;
}

/**
 * Perform the refresh_token exchange, update the session tokens in place, and
 * persist them. Never throws (best-effort) so single-flight awaiters always
 * resolve cleanly. HubSpot does not rotate refresh tokens, so we keep the
 * existing one when the response omits a new one.
 */
async function performHubSpotRefresh(session: UserSession, log: HubSpotToolLog): Promise<void> {
  const refreshToken = session.hubspotRefreshToken;
  const clientId = session.hubspotOauthClientId;
  const clientSecret = session.hubspotOauthClientSecret;
  if (!refreshToken || !clientId || !clientSecret) return;

  const result = await refreshHubSpotToken({ tokenUrl: HUBSPOT_TOKEN_URL, refreshToken, clientId, clientSecret });
  if (!result.ok) {
    log.error(`HubSpot token refresh failed (${result.status}); using existing token. ${result.logMessage}`);
    return;
  }

  const newRefresh = result.refreshToken ?? refreshToken;
  const newExpiry = result.expiresIn ? Date.now() + result.expiresIn * 1000 : undefined;
  session.hubspotAccessToken = result.accessToken;
  session.hubspotRefreshToken = newRefresh;
  session.hubspotTokenExpiry = newExpiry;

  const instanceId = session.hubspotInstanceId;
  if (instanceId) {
    try {
      const { updateMcpInstanceProviderTokens } = await import('../mcpConnectionStore.js');
      await updateMcpInstanceProviderTokens(instanceId, {
        access_token: result.accessToken,
        refresh_token: newRefresh,
        expiry_date: newExpiry,
        baseUrl: session.hubspotBaseUrl,
      });
    } catch (err: any) {
      log.error(`Failed to persist refreshed HubSpot tokens for ${instanceId}: ${err?.message ?? err}`);
    }
  }
}

/**
 * Wrap a tool body with the standard client-fetch + error-mapping pattern.
 * A proactive OAuth-token refresh runs first (no-op for paste-token sessions);
 * `getHubSpotClient` then runs BEFORE the callback so a missing token is
 * surfaced verbatim (no double-wrapping via mapHubSpotError).
 */
export async function withHubSpotClient<T>(
  prefix: string,
  session: UserSession | undefined,
  log: HubSpotToolLog,
  fn: (client: HubSpotClient) => Promise<T>,
): Promise<T> {
  await maybeRefreshHubSpotToken(session, log);
  const client = getHubSpotClient(session);
  try {
    return await fn(client);
  } catch (error: any) {
    mapHubSpotError(prefix, error, log);
  }
}
