// src/redmine/oauthCallback.ts
// Redmine OAuth 2.0 authorization_code exchange + refresh grant, extracted from
// the /connect/redmine/callback handler so the token logic can be unit-tested
// independently of Express. The grant POST itself lives in
// src/util/oauthTokenGrant.ts, shared with HubSpot.
//
// Redmine specifics:
//   - OAuth2 provider (Doorkeeper) exists only in Redmine 6.1.0+ (feature
//     #24808). Older instances have no /oauth/* routes at all and must use the
//     paste-token path instead.
//   - Endpoints are RELATIVE TO THE INSTANCE: <base>/oauth/authorize and
//     <base>/oauth/token. There is no central Redmine host, which is why the
//     catalog's OAuth URLs are derived from REDMINE_BASE_URL rather than being
//     constants like HubSpot's.
//   - The OAuth *application* is registered per instance at
//     <base>/oauth/applications by an ADMINISTRATOR. One client_id therefore
//     only ever serves one Redmine.
//   - Access tokens expire (Doorkeeper default 7200s, `expires_in`), and
//     Redmine ships with refresh-token rotation, so the refresh response
//     normally carries a NEW refresh_token that must be persisted. Treating it
//     as non-rotating (HubSpot's assumption) logs the user out on the call
//     after next.
//   - Scopes are Redmine PERMISSION names (view_issues, add_issues, …) plus
//     `admin`, not OAuth-style strings.

import { postTokenGrant, type FetchImpl } from '../util/oauthTokenGrant.js';

const TOKEN_EXCHANGE_TIMEOUT_MS = 15_000;
const USERINFO_TIMEOUT_MS = 10_000;

export type { FetchImpl };

/** Build the Doorkeeper endpoint URLs for a given Redmine base URL. */
export function redmineOauthUrls(baseUrl: string): { authorizeUrl: string; tokenUrl: string } {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return { authorizeUrl: `${base}/oauth/authorize`, tokenUrl: `${base}/oauth/token` };
}

export type ExchangeOk = {
  ok: true;
  accessToken: string;
  /** Refresh token for the authorization_code grant; null if Redmine omitted it. */
  refreshToken: string | null;
  /** Access-token lifetime in seconds; null if Redmine omitted it. */
  expiresIn: number | null;
  /** The authorizing user's login (for naming); null on lookup failure. */
  login: string | null;
  /** The authorizing user's email (for naming); null on lookup failure. */
  email: string | null;
};

export type ExchangeErr = {
  ok: false;
  status: number;
  userMessage: string;
  logMessage: string;
};

export type ExchangeResult = ExchangeOk | ExchangeErr;

export interface ExchangeInput {
  tokenUrl: string;
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Instance base URL, used for the best-effort /users/current.json lookup. */
  baseUrl?: string;
  fetchImpl?: FetchImpl;
}

/**
 * Perform the OAuth 2.0 authorization_code exchange with Redmine, then look up
 * the authorizing user so the connection can be named.
 *
 * Never throws: returns a discriminated result so the caller can map to an HTTP
 * response without a second try/catch.
 */
export async function exchangeRedmineOauthCode(input: ExchangeInput): Promise<ExchangeResult> {
  const fetchImpl = input.fetchImpl ?? fetch;

  const tokenResult = await postTokenGrant({
    tokenUrl: input.tokenUrl,
    params: {
      grant_type: 'authorization_code',
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
    },
    fetchImpl,
    label: 'Redmine token exchange',
    timeoutMs: TOKEN_EXCHANGE_TIMEOUT_MS,
  });
  if (!tokenResult.ok) return tokenResult;

  const { login, email } = input.baseUrl
    ? await fetchRedmineCurrentUser(input.baseUrl, tokenResult.accessToken, fetchImpl)
    : { login: null, email: null };

  return {
    ok: true,
    accessToken: tokenResult.accessToken,
    refreshToken: tokenResult.refreshToken,
    expiresIn: tokenResult.expiresIn,
    login,
    email,
  };
}

// ==== Refresh-token grant (run at tool-call time when the access token nears expiry) ====

export type RefreshResult =
  | { ok: true; accessToken: string; refreshToken: string | null; expiresIn: number | null }
  | { ok: false; status: number; logMessage: string };

/**
 * Refresh grant. Redmine/Doorkeeper rotates refresh tokens, so the caller MUST
 * persist `refreshToken` when it comes back non-null — reusing the old one
 * after a rotation fails, and the user silently loses the connection. Never
 * throws.
 */
export async function refreshRedmineToken(input: {
  tokenUrl: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: FetchImpl;
}): Promise<RefreshResult> {
  const result = await postTokenGrant({
    tokenUrl: input.tokenUrl,
    params: {
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    },
    fetchImpl: input.fetchImpl,
    label: 'Redmine token refresh',
    timeoutMs: TOKEN_EXCHANGE_TIMEOUT_MS,
  });
  if (!result.ok) {
    return { ok: false, status: result.status, logMessage: result.logMessage };
  }
  return { ok: true, accessToken: result.accessToken, refreshToken: result.refreshToken, expiresIn: result.expiresIn };
}

/**
 * Best-effort lookup of the authorizing user's login + email from
 * GET <base>/users/current.json. Returns nulls (not an error) on any failure —
 * the connection still succeeds because the token is what matters; these are
 * only used to name the instance.
 */
export async function fetchRedmineCurrentUser(
  baseUrl: string,
  accessToken: string,
  fetchImpl: FetchImpl = fetch,
): Promise<{ login: string | null; email: string | null }> {
  const base = baseUrl.trim().replace(/\/+$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), USERINFO_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${base}/users/current.json`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return { login: null, email: null };
    const data = await response.json().catch(() => null) as { user?: { login?: string; mail?: string } } | null;
    return { login: data?.user?.login ?? null, email: data?.user?.mail ?? null };
  } catch {
    return { login: null, email: null };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Compose the instance display name. Priority:
 *   1. Explicit `providedInstanceName` (dashboard form)
 *   2. `<Service Name> (<host>)` — the host is what distinguishes two Redmines
 *   3. `<Service Name> (<login or email>)`
 *   4. `<Service Name>`
 *
 * Host beats user here (unlike HubSpot, where the portal is the account): a
 * user connecting two Redmine instances needs to tell them apart, and they are
 * very likely the same person on both.
 */
export function buildRedmineInstanceName(input: {
  serviceName: string;
  providedInstanceName?: string | null;
  baseUrl?: string | null;
  login?: string | null;
  email?: string | null;
}): string {
  if (input.providedInstanceName) return input.providedInstanceName;
  const host = hostOf(input.baseUrl);
  if (host) return `${input.serviceName} (${host})`;
  if (input.login) return `${input.serviceName} (${input.login})`;
  if (input.email) return `${input.serviceName} (${input.email})`;
  return input.serviceName;
}

/** Hostname of a base URL, or null when it is absent/unparseable. */
function hostOf(baseUrl?: string | null): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).host || null;
  } catch {
    return null;
  }
}
