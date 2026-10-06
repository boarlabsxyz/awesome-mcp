// src/browserbase/apiHelpers.ts
// Client for the Browserbase REST API (https://api.browserbase.com/v1).
//
// This is the SECOND of two upstreams this connector talks to, and the split is
// worth understanding before changing anything here:
//
//   - The six browser-driving tools (start/end/navigate/act/observe/extract)
//     proxy to Browserbase's HOSTED MCP server. That lives in mcpProxyClient.ts.
//     Stagehand and its model run there, which is why this connector needs no
//     model key of its own.
//   - Everything about a session's *existence* — is it running, what is it
//     costing, make it stop — is REST, and lives here. Without it a leaked
//     session would be completely invisible through this server while still
//     billing, which is the risk the ticket called out.
//
// The hosted MCP endpoint does not need a project ID and this one treats it as
// optional (Browserbase infers the project from the key), so the project id is
// carried in providerTokens purely so the usage read has something to name.

import { UserError } from 'fastmcp';

import { UserSession } from '../userSession.js';
import { jsonApiRequest } from '../util/jsonApiRequest.js';

const DEFAULT_BASE_URL = 'https://api.browserbase.com/v1';
const REQUEST_TIMEOUT_MS = 30_000;

/** Browser sessions a user can see in the Browserbase dashboard. */
export interface BrowserbaseSession {
  id: string;
  status?: string;
  projectId?: string;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  endedAt?: string;
  expiresAt?: string;
  region?: string;
  keepAlive?: boolean;
  contextId?: string;
  proxyBytes?: number;
  avgCpuUsage?: number;
  memoryUsage?: number;
}

export interface BrowserbaseProject {
  id: string;
  name?: string;
  ownerId?: string;
  region?: string;
  createdAt?: string;
  updatedAt?: string;
  defaultTimeout?: number;
  concurrency?: number;
}

export interface BrowserbaseProjectUsage {
  browserMinutes?: number;
  proxyBytes?: number;
}

/** The slice of FastMCP's log the ops use. Matches RedmineToolLog's shape. */
export type BrowserbaseToolLog = {
  info: (msg: string) => void;
  error: (msg: string) => void;
};

/** The dashboard page for a session — the only place a replay can be watched. */
export function sessionDashboardUrl(sessionId: string): string {
  return `https://www.browserbase.com/sessions/${encodeURIComponent(sessionId)}`;
}

/**
 * Thin client over the Browserbase REST API. One instance per tool call — it
 * holds only a key and a base URL, so construction is free.
 */
export class BrowserbaseClient {
  constructor(
    private readonly apiKey: string,
    public readonly baseUrl: string = DEFAULT_BASE_URL,
    /** Injected in tests. */
    private readonly fetchImpl?: typeof fetch,
  ) {}

  /**
   * One REST call.
   *
   * The redirect guard, the deadline, the `.status` tagging and the
   * empty-body handling all live in jsonApiRequest — see its header for why
   * each matters. The upstream status landing on `.status` is the detail worth
   * knowing here: it is what lets the REST handlers answer a real 404 with no
   * translation step, unlike ClickUp's symbol-tagged status.
   */
  request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return jsonApiRequest<T>({
      url: `${this.baseUrl}${path}`,
      method,
      headers: { 'x-bb-api-key': this.apiKey },
      body,
      timeoutMs: REQUEST_TIMEOUT_MS,
      serviceLabel: 'Browserbase API',
      target: `${method} ${path}`,
      fetchImpl: this.fetchImpl,
    }) as Promise<T>;
  }

  /**
   * GET /v1/sessions. `status` narrows to one lifecycle state; omitting it
   * returns every session the key can see, which is what makes a leaked one
   * findable.
   */
  async listSessions(status?: string): Promise<BrowserbaseSession[]> {
    const query = status ? `?status=${encodeURIComponent(status)}` : '';
    const res = await this.request<BrowserbaseSession[]>('GET', `/sessions${query}`);
    return Array.isArray(res) ? res : [];
  }

  getSession(sessionId: string): Promise<BrowserbaseSession> {
    return this.request<BrowserbaseSession>('GET', `/sessions/${encodeURIComponent(sessionId)}`);
  }

  /**
   * Close a session before its timeout. Browserbase models this as an update
   * to REQUEST_RELEASE rather than a DELETE, and its own docs frame it as the
   * way to "avoid unnecessary usage charges" — so this is the cost lever, not
   * a tidiness one.
   */
  releaseSession(sessionId: string): Promise<BrowserbaseSession> {
    return this.request<BrowserbaseSession>('POST', `/sessions/${encodeURIComponent(sessionId)}`, {
      status: 'REQUEST_RELEASE',
    });
  }

  async listProjects(): Promise<BrowserbaseProject[]> {
    const res = await this.request<BrowserbaseProject[]>('GET', '/projects');
    return Array.isArray(res) ? res : [];
  }

  getProjectUsage(projectId: string): Promise<BrowserbaseProjectUsage> {
    return this.request<BrowserbaseProjectUsage>('GET', `/projects/${encodeURIComponent(projectId)}/usage`);
  }
}

/** Build a REST client from the session. */
export function getBrowserbaseClient(session?: UserSession): BrowserbaseClient {
  if (!session?.browserbaseAccessToken) {
    throw new UserError(
      'Browserbase not connected. Visit the dashboard to connect your Browserbase account with an API key.',
    );
  }
  return new BrowserbaseClient(session.browserbaseAccessToken);
}

/**
 * Map a REST failure to a message that says what to do. Browserbase's statuses
 * are unambiguous — unlike Redmine's 403, which means "an admin switched the
 * REST API off" as often as "missing permission" — so this stays short.
 */
export function mapBrowserbaseError(prefix: string, error: any, log?: BrowserbaseToolLog): never {
  const status: number | undefined = error?.status;
  log?.error(`${prefix}: ${error?.message ?? error} (status ${status ?? 'none'})`);

  if (status === 401 || status === 403) {
    throw new UserError(
      `${prefix}: Browserbase rejected the API key. Reconnect from the dashboard with a current key from https://www.browserbase.com/settings.`,
    );
  }
  if (status === 404) {
    throw new UserError(
      `${prefix}: Browserbase has no record of that id. A session that has already ended is reaped, so an id from an earlier conversation may simply be gone — run listBrowserSessions to see what still exists.`,
    );
  }
  if (status === 429) {
    throw new UserError(`${prefix}: Browserbase rate-limited the request. Retry in a few seconds.`);
  }
  if (status === undefined) {
    // undici reports every transport failure as the string "fetch failed" with
    // no status, so saying "Browserbase returned an error" here would be a
    // guess about something that may never have reached Browserbase at all.
    throw new UserError(
      `${prefix}: could not reach the Browserbase API (${error?.message ?? 'network error'}). The request may or may not have been received.`,
    );
  }
  throw new UserError(`${prefix}: Browserbase API error (${status}). ${error?.message ?? ''}`.trim());
}

/** Wrap a REST tool body with the standard client-fetch + error-mapping pattern. */
export async function withBrowserbaseClient<T>(
  prefix: string,
  session: UserSession | undefined,
  log: BrowserbaseToolLog,
  fn: (client: BrowserbaseClient) => Promise<T>,
): Promise<T> {
  // getBrowserbaseClient runs BEFORE the callback so a missing token surfaces
  // verbatim rather than being re-wrapped as an upstream failure.
  const client = getBrowserbaseClient(session);
  try {
    return await fn(client);
  } catch (error: any) {
    if (error instanceof UserError) throw error;
    mapBrowserbaseError(prefix, error, log);
  }
}
