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
}

// ==== Search-request builders (ported from the reference clients) ====

// Adapted from baryhuang/mcp-hubspot@4a8345f clients/company_client.py:105
export function recentCompaniesSearch(limit: number): Record<string, unknown> {
  return {
    sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
    limit,
    properties: ['name', 'domain', 'website', 'phone', 'industry', 'hs_lastmodifieddate'],
  };
}

// Contacts sort on lastmodifieddate; mirror the company shape with contact props.
export function recentContactsSearch(limit: number): Record<string, unknown> {
  return {
    sorts: [{ propertyName: 'lastmodifieddate', direction: 'DESCENDING' }],
    limit,
    properties: ['firstname', 'lastname', 'email', 'company', 'phone', 'lastmodifieddate'],
  };
}

/** An `EQ` filter group for the search API. */
export function eqFilterGroup(filters: Array<{ propertyName: string; value: string }>): Record<string, unknown> {
  return { filterGroups: [{ filters: filters.map(f => ({ ...f, operator: 'EQ' })) }] };
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

export function formatObjectList(results: HubSpotObject[], label: string): string {
  if (results.length === 0) return `No ${label} found.`;
  const parts = [`Found ${results.length} ${label}:`, ''];
  results.forEach((obj, i) => {
    const props = obj.properties ?? {};
    const name =
      (props.name as string) ||
      [props.firstname, props.lastname].filter(Boolean).join(' ') ||
      (props.email as string) ||
      '(unnamed)';
    parts.push(`${i + 1}. ${name}`);
    parts.push(`   ID: ${obj.id ?? ''}`);
    if (obj.updatedAt) parts.push(`   Updated: ${obj.updatedAt}`);
    parts.push('');
  });
  return parts.join('\n').trimEnd();
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

/**
 * Wrap a tool body with the standard client-fetch + error-mapping pattern.
 * `getHubSpotClient` runs BEFORE the callback so a missing token is surfaced
 * verbatim (no double-wrapping via mapHubSpotError).
 */
export async function withHubSpotClient<T>(
  prefix: string,
  session: UserSession | undefined,
  log: HubSpotToolLog,
  fn: (client: HubSpotClient) => Promise<T>,
): Promise<T> {
  const client = getHubSpotClient(session);
  try {
    return await fn(client);
  } catch (error: any) {
    mapHubSpotError(prefix, error, log);
  }
}
