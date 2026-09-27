// Client resolution and error mapping for the third-party REST data planes
// (HubSpot, Redmine).
//
// Split out of webServer.ts for the same reason restUpstreamError.ts and
// restContent.ts are: these are the parts of a route that are NOT about routing,
// they are reused by ~45 handlers, and inside registerRestApiRoutes they were
// closures no test could reach.
//
// Two things every handler here gets right by construction, because getting
// either wrong is a silent failure rather than a loud one:
//
//   1. The client is resolved through a refresh. HubSpot OAuth access tokens
//      expire in ~30 minutes and Redmine's Doorkeeper tokens in ~2 hours, so a
//      connection the dashboard reports as perfectly healthy 401s on every call
//      unless maybeRefreshXToken has run first.
//   2. A missing connection answers 403 here rather than reaching the provider.
//      createServiceAuth falls back to a plain Google session when the account
//      has no connection for the service, so auth passes and the bearer would
//      otherwise go out undefined — surfacing as a confusing upstream 401.

import type { Request, Response } from 'express';

import type { UserSession } from '../userSession.js';
import type { HubSpotClient } from '../hubspot/apiHelpers.js';
import type { RedmineClient } from '../redmine/apiHelpers.js';
import { fetchHubSpotGrantedScopes } from '../hubspot/oauthCallback.js';
import { sendUpstreamError } from './restUpstreamError.js';

/** The only part of the authenticated REST request these helpers need. */
type ProviderRequest = Request & { userSession?: UserSession };

/**
 * Log sink for the provider helpers this module reuses from the MCP servers
 * (token refresh, error mapping). They expect a FastMCP-shaped `{info, error}`;
 * a REST handler has no per-call log channel, so both ends go to stderr beside
 * the console.error the routes already use for failures.
 *
 * Deliberately not console.log: under MCP_MODE=mcp this module shares a process
 * with MCP servers, and a stray line on stdout is not worth risking for a
 * breadcrumb.
 */
export const REST_PROVIDER_LOG = {
  info: (msg: string) => console.error(msg),
  error: (msg: string) => console.error(msg),
};

/**
 * Resolve a refreshed HubSpot client, or answer 403 and return null.
 *
 * The refresh helper mutates the session in place, which is why
 * getHubSpotClient is called after it rather than before.
 */
export async function hubspotRestClient(
  req: ProviderRequest,
  res: Response,
): Promise<HubSpotClient | null> {
  if (!req.userSession?.hubspotAccessToken) {
    res.status(403).json({ error: 'HubSpot connection required for REST. Connect via the dashboard.' });
    return null;
  }
  const { maybeRefreshHubSpotToken, getHubSpotClient } = await import('../hubspot/apiHelpers.js');
  await maybeRefreshHubSpotToken(req.userSession, REST_PROVIDER_LOG);
  return getHubSpotClient(req.userSession);
}

/**
 * Error mapper for the HubSpot routes.
 *
 * Defers to sendUpstreamError for everything except the missing-scope 403,
 * which is the one failure where the token itself holds the answer the user
 * needs: every deal endpoint 403s on a connection the dashboard reports as
 * perfectly healthy until the user reconnects and re-consents, and a bare
 * "Permission denied" sends them to inspect HubSpot user permissions instead.
 *
 * Mirrors withHubSpotClient's branch, including the best-effort granted-scope
 * lookup — `granted` is the only thing that separates "the reconnect never
 * happened" from "it happened and still did not grant the scope", and in the
 * latter case the message stops telling them to reconnect.
 */
export async function sendHubSpotError(
  req: ProviderRequest,
  res: Response,
  err: unknown,
  opts: { notFound: string; fallback: string },
): Promise<void> {
  const { parseHubSpotMissingScopes, formatHubSpotScopeError } = await import('../hubspot/apiHelpers.js');
  const required = parseHubSpotMissingScopes(err);
  const token = req.userSession?.hubspotAccessToken;
  if (required && token) {
    // Never throws — returns null when the token lookup fails, which degrades
    // to the needed-only message rather than to a second error.
    const granted = await fetchHubSpotGrantedScopes(token);
    res.status(403).json({
      error: formatHubSpotScopeError(opts.fallback, required, granted),
      requiredScopes: required,
      ...(granted ? { grantedScopes: granted } : {}),
    });
    return;
  }
  sendUpstreamError(res, err, opts);
}

/**
 * Resolve a refreshed Redmine client, or answer 403 and return null.
 *
 * Redmine is self-hosted, so a connection carries three things a Google session
 * has no slot for — the instance URL, the credential, and which of the two auth
 * headers it goes in — and all three are settled before a client is built. The
 * base-URL check has no fallback on purpose: there is no api.redmine.com, so
 * guessing a host would send the credential somewhere the user never named.
 */
export async function redmineRestClient(
  req: ProviderRequest,
  res: Response,
): Promise<RedmineClient | null> {
  const session = req.userSession;
  if (!session?.redmineAccessToken) {
    res.status(403).json({ error: 'Redmine connection required for REST. Connect via the dashboard.' });
    return null;
  }
  if (!session.redmineBaseUrl) {
    res.status(403).json({ error: 'Redmine connection is missing its instance URL. Reconnect from the dashboard and enter your Redmine URL.' });
    return null;
  }
  const { maybeRefreshRedmineToken, getRedmineClient } = await import('../redmine/apiHelpers.js');
  // Doorkeeper expires access tokens in ~2h AND rotates the refresh token on
  // use. The helper is single-flight per connection precisely so two concurrent
  // REST calls cannot race to spend the same rotating refresh token, which would
  // kill the connection on the call after next.
  await maybeRefreshRedmineToken(session, REST_PROVIDER_LOG);
  return getRedmineClient(session);
}

/**
 * Error mapper for the Redmine routes.
 *
 * Not sendUpstreamError, because for Redmine the bare status is misleading in
 * three ways the MCP surface already handles and a curl caller needs just as
 * much: 403 means an administrator switched the REST API off about as often as
 * it means a missing permission, 422 carries Redmine's own `{"errors":[...]}`
 * validation list that a generic 500 would bury, and an unreachable self-hosted
 * instance throws with no status at all — undici reports every one of those as
 * the bare string "fetch failed".
 *
 * The message text comes from mapRedmineError so the two surfaces cannot word
 * the same failure differently; it signals by throwing a UserError rather than
 * returning, which is what the try/catch here is reading.
 */
export async function sendRedmineError(
  res: Response,
  err: unknown,
  opts: { fallback: string; adminOnly?: boolean; permission?: string; baseUrl?: string },
): Promise<void> {
  const { mapRedmineError } = await import('../redmine/apiHelpers.js');
  let message = opts.fallback;
  try {
    mapRedmineError(
      opts.fallback,
      err,
      REST_PROVIDER_LOG,
      { adminOnly: opts.adminOnly, permission: opts.permission },
      opts.baseUrl || 'the Redmine instance',
    );
  } catch (error: any) {
    if (typeof error?.message === 'string' && error.message) message = error.message;
  }
  const upstream = typeof (err as any)?.status === 'number' ? (err as any).status : undefined;
  // An upstream 401 is deliberately NOT echoed as a 401. On this plane a 401
  // means "your REST bearer is bad", so a client that saw one would go re-mint a
  // bearer when the real problem is the stored Redmine credential. 502 plus the
  // mapped message ("Redmine rejected the credential. Reconnect from the
  // dashboard.") says what actually happened. A missing status is the same class
  // of thing — the instance was never reached.
  res.status(upstream && upstream !== 401 ? upstream : 502).json({ error: message });
}

/** 400 for a query string the tool's own schema rejects. */
export function sendInvalidQuery(res: Response, issues: unknown): void {
  res.status(400).json({ error: 'Invalid query parameters', issues });
}
