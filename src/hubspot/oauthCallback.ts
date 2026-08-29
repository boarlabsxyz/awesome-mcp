// src/hubspot/oauthCallback.ts
// HubSpot OAuth 2.0 authorization_code exchange + refresh grant, extracted from
// the /connect/hubspot/callback handler so the token logic can be unit-tested
// independently of Express. Mirrors src/outline/oauthCallback.ts.
//
// HubSpot specifics:
//   - Token endpoint: POST https://api.hubapi.com/oauth/v1/token (form-encoded).
//   - Access tokens expire (~30 min, `expires_in` in the response).
//   - Refresh tokens are long-lived and do NOT rotate — the same refresh_token
//     keeps working, and the refresh response may omit it (keep the old one).
//   - Token metadata: GET /oauth/v1/access-tokens/{token} → { hub_domain, user, ... }
//     used only to name the connection.

const TOKEN_EXCHANGE_TIMEOUT_MS = 15_000;
const TOKENINFO_TIMEOUT_MS = 10_000;

export const HUBSPOT_TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';
const TOKENINFO_URL = 'https://api.hubapi.com/oauth/v1/access-tokens';

export type FetchImpl = typeof fetch;

export type ExchangeOk = {
  ok: true;
  accessToken: string;
  /** Refresh token for the authorization_code grant; null if HubSpot omitted it. */
  refreshToken: string | null;
  /** Access-token lifetime in seconds; null if HubSpot omitted it. */
  expiresIn: number | null;
  /** The connected portal's domain (for naming); null on lookup failure. */
  hubDomain: string | null;
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
  fetchImpl?: FetchImpl;
}

/**
 * Perform the OAuth 2.0 authorization_code exchange with HubSpot, then fetch
 * the portal domain + user email from the access-token metadata endpoint.
 *
 * Never throws: returns a discriminated result so the caller can map to an HTTP
 * response without a second try/catch.
 */
export async function exchangeHubSpotOauthCode(input: ExchangeInput): Promise<ExchangeResult> {
  const fetchImpl = input.fetchImpl ?? fetch;

  const tokenResult = await postTokenGrant(
    input.tokenUrl,
    {
      grant_type: 'authorization_code',
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
    },
    fetchImpl,
    'exchange',
  );
  if (!tokenResult.ok) return tokenResult;

  const { hubDomain, email } = await fetchHubSpotTokenInfo(tokenResult.accessToken, fetchImpl);
  return {
    ok: true,
    accessToken: tokenResult.accessToken,
    refreshToken: tokenResult.refreshToken,
    expiresIn: tokenResult.expiresIn,
    hubDomain,
    email,
  };
}

// ==== Refresh-token grant (run at tool-call time when the access token nears expiry) ====

export type RefreshResult = TokenOk | { ok: false; status: number; logMessage: string };

/**
 * Refresh grant. HubSpot does not rotate the refresh token, so keep the one you
 * already have when the response omits `refresh_token`. Never throws.
 */
export async function refreshHubSpotToken(input: {
  tokenUrl: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: FetchImpl;
}): Promise<RefreshResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const result = await postTokenGrant(
    input.tokenUrl,
    {
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    },
    fetchImpl,
    'refresh',
  );
  if (!result.ok) {
    return { ok: false, status: result.status, logMessage: result.logMessage };
  }
  return { ok: true, accessToken: result.accessToken, refreshToken: result.refreshToken, expiresIn: result.expiresIn };
}

type TokenOk = { ok: true; accessToken: string; refreshToken: string | null; expiresIn: number | null };

/** POST the token endpoint under a timeout; the caller maps thrown errors. */
function fetchTokenGrant(tokenUrl: string, params: Record<string, string>, fetchImpl: FetchImpl): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKEN_EXCHANGE_TIMEOUT_MS);
  return fetchImpl(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));
}

/** Map a thrown fetch failure (timeout / network) to a discriminated error. */
function grantNetworkError(err: any, label: string, tokenUrl: string): ExchangeErr {
  const timedOut = err?.name === 'AbortError';
  return {
    ok: false,
    status: 502,
    userMessage: `${label} ${timedOut ? 'timed out' : 'failed'}. Please try again.`,
    logMessage: timedOut ? `${label} timed out: POST ${tokenUrl}` : `${label} fetch failed: ${err?.message ?? err}`,
  };
}

/** Turn a token-endpoint Response into a normalized token result. */
async function readGrantResponse(response: Response, label: string): Promise<TokenOk | ExchangeErr> {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return { ok: false, status: response.status, userMessage: `${label} failed. Please try again.`, logMessage: `${label} failed: ${response.status} ${body}` };
  }
  const parsed = (await response.json().catch(() => null)) as { access_token?: string; refresh_token?: string; expires_in?: number } | null;
  if (!parsed?.access_token) {
    return { ok: false, status: 500, userMessage: `${label} returned no access token. Please try again.`, logMessage: `${label} response missing access_token: ${JSON.stringify(parsed)}` };
  }
  return { ok: true, accessToken: parsed.access_token, refreshToken: parsed.refresh_token ?? null, expiresIn: typeof parsed.expires_in === 'number' ? parsed.expires_in : null };
}

/** Shared POST for both grant types. `phase` only shapes the log/user messages. */
async function postTokenGrant(
  tokenUrl: string,
  params: Record<string, string>,
  fetchImpl: FetchImpl,
  phase: 'exchange' | 'refresh',
): Promise<TokenOk | ExchangeErr> {
  const label = phase === 'exchange' ? 'HubSpot token exchange' : 'HubSpot token refresh';
  let response: Response;
  try {
    response = await fetchTokenGrant(tokenUrl, params, fetchImpl);
  } catch (err: any) {
    return grantNetworkError(err, label, tokenUrl);
  }
  return readGrantResponse(response, label);
}

/**
 * Best-effort lookup of the portal domain + authorizing user's email from the
 * access-token metadata endpoint. Returns nulls (not an error) on any failure —
 * the connection still succeeds because the token is what matters; these are
 * only used to name the instance.
 */
export async function fetchHubSpotTokenInfo(
  accessToken: string,
  fetchImpl: FetchImpl = fetch,
): Promise<{ hubDomain: string | null; email: string | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKENINFO_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${TOKENINFO_URL}/${encodeURIComponent(accessToken)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return { hubDomain: null, email: null };
    const data = await response.json().catch(() => null) as { hub_domain?: string; user?: string } | null;
    return { hubDomain: data?.hub_domain ?? null, email: data?.user ?? null };
  } catch {
    return { hubDomain: null, email: null };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The scopes HubSpot says this access token actually holds.
 *
 * This is the authoritative answer to "did the user re-consent yet?" — the
 * catalog's `oauthScopes` only says what we *ask* for, and a token minted
 * before a scope was added keeps working for everything else, so a 403 alone
 * cannot distinguish "reconnect never happened" from "reconnect happened and
 * still did not grant it". Best-effort: returns null on any failure so an
 * error message degrades to "we could not read the granted scopes" rather
 * than turning a diagnostic into a second failure.
 */
export async function fetchHubSpotGrantedScopes(
  accessToken: string,
  fetchImpl: FetchImpl = fetch,
): Promise<string[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKENINFO_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${TOKENINFO_URL}/${encodeURIComponent(accessToken)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null) as { scopes?: unknown } | null;
    if (!Array.isArray(data?.scopes)) return null;
    return data.scopes.filter((s): s is string => typeof s === 'string');
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Compose the instance display name. Priority:
 *   1. Explicit `providedInstanceName` (dashboard form)
 *   2. `<Service Name> (<portal domain>)`
 *   3. `<Service Name> (<email>)`
 *   4. `<Service Name>`
 */
export function buildHubSpotOauthInstanceName(input: {
  serviceName: string;
  providedInstanceName?: string | null;
  hubDomain?: string | null;
  email?: string | null;
}): string {
  if (input.providedInstanceName) return input.providedInstanceName;
  if (input.hubDomain) return `${input.serviceName} (${input.hubDomain})`;
  if (input.email) return `${input.serviceName} (${input.email})`;
  return input.serviceName;
}
