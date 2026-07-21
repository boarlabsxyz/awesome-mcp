// src/outline/oauthCallback.ts
// Extracted from the /connect/outline/callback handler in webServer.ts so the
// OAuth exchange + auth.info fetch + instance-name logic can be unit-tested
// independently of Express.

const TOKEN_EXCHANGE_TIMEOUT_MS = 15_000;
const USERINFO_TIMEOUT_MS = 10_000;

export type FetchImpl = typeof fetch;

export type ExchangeOk = {
  ok: true;
  accessToken: string;
  /** Refresh token for the authorization_code grant; null if Outline omitted it. */
  refreshToken: string | null;
  /** Access-token lifetime in seconds; null if Outline omitted it. */
  expiresIn: number | null;
  email: string | null;
  teamName: string | null;
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
  baseUrl: string;
  fetchImpl?: FetchImpl;
}

/**
 * Perform the OAuth 2.0 authorization_code exchange with Outline, then fetch
 * the user's email + team name from /api/auth.info.
 *
 * Never throws: returns a discriminated result so the caller can map to an
 * HTTP response without a second try/catch.
 */
export async function exchangeOutlineOauthCode(input: ExchangeInput): Promise<ExchangeResult> {
  const fetchImpl = input.fetchImpl ?? fetch;

  const tokenResult = await postTokenExchange(input, fetchImpl);
  if (!tokenResult.ok) return tokenResult;

  const { email, teamName } = await fetchOutlineUserInfo(input.baseUrl, tokenResult.accessToken, fetchImpl);
  return {
    ok: true,
    accessToken: tokenResult.accessToken,
    refreshToken: tokenResult.refreshToken,
    expiresIn: tokenResult.expiresIn,
    email,
    teamName,
  };
}

async function postTokenExchange(
  input: ExchangeInput,
  fetchImpl: FetchImpl,
): Promise<{ ok: true; accessToken: string; refreshToken: string | null; expiresIn: number | null } | ExchangeErr> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKEN_EXCHANGE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(input.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        client_id: input.clientId,
        client_secret: input.clientSecret,
        redirect_uri: input.redirectUri,
      }).toString(),
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timeout);
    if (err?.name === 'AbortError') {
      return {
        ok: false,
        status: 502,
        userMessage: 'Outline token exchange timed out. Please try again.',
        logMessage: `Outline token exchange timed out: POST ${input.tokenUrl}`,
      };
    }
    return {
      ok: false,
      status: 502,
      userMessage: `Outline token exchange failed: ${err?.message ?? 'unknown error'} Please try again.`,
      logMessage: `Outline token exchange fetch failed: ${err?.message ?? err}`,
    };
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return {
      ok: false,
      status: 500,
      userMessage: 'Outline token exchange failed. Please try again.',
      logMessage: `Outline token exchange failed: ${response.status} ${body}`,
    };
  }

  const parsed = await response.json().catch(() => null) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  } | null;
  if (!parsed?.access_token) {
    return {
      ok: false,
      status: 500,
      userMessage: 'Outline returned no access token. Please try again.',
      logMessage: `Outline token response missing access_token: ${JSON.stringify(parsed)}`,
    };
  }
  return {
    ok: true,
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? null,
    expiresIn: typeof parsed.expires_in === 'number' ? parsed.expires_in : null,
  };
}

// ==== Refresh-token grant (used at tool-call time when the access token nears expiry) ====

export interface RefreshInput {
  /** Outline token endpoint, e.g. https://wiki.example.com/oauth/token */
  tokenUrl: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: FetchImpl;
}

export type RefreshResult =
  | { ok: true; accessToken: string; refreshToken: string | null; expiresIn: number | null }
  | { ok: false; status: number; logMessage: string };

/**
 * Exchange an Outline refresh token for a fresh access token via the
 * `refresh_token` grant (client_secret_post). Outline ROTATES the refresh
 * token on every use, so callers must persist the returned `refreshToken`.
 *
 * Never throws: returns a discriminated result so the caller can decide
 * whether to fall back to the (soon-to-be-rejected) existing access token.
 */
export async function refreshOutlineToken(input: RefreshInput): Promise<RefreshResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKEN_EXCHANGE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(input.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: input.refreshToken,
        client_id: input.clientId,
        client_secret: input.clientSecret,
      }).toString(),
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timeout);
    const timedOut = err?.name === 'AbortError';
    return {
      ok: false,
      status: 502,
      logMessage: timedOut
        ? `Outline token refresh timed out: POST ${input.tokenUrl}`
        : `Outline token refresh fetch failed: ${err?.message ?? err}`,
    };
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return { ok: false, status: response.status, logMessage: `Outline token refresh failed: ${response.status} ${body}` };
  }

  const parsed = await response.json().catch(() => null) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  } | null;
  if (!parsed?.access_token) {
    return { ok: false, status: 500, logMessage: `Outline refresh response missing access_token: ${JSON.stringify(parsed)}` };
  }
  return {
    ok: true,
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? null,
    expiresIn: typeof parsed.expires_in === 'number' ? parsed.expires_in : null,
  };
}

/**
 * Best-effort fetch of /api/auth.info to learn the user's email and team name.
 * Returns nulls (not an error) on any failure — the connection still succeeds
 * because the access token is what matters; email/team are only used for
 * naming the instance.
 */
export async function fetchOutlineUserInfo(
  baseUrl: string,
  accessToken: string,
  fetchImpl: FetchImpl = fetch,
): Promise<{ email: string | null; teamName: string | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), USERINFO_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${baseUrl}/api/auth.info`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return { email: null, teamName: null };
    const data = await response.json().catch(() => null) as {
      data?: { user?: { email?: string }; team?: { name?: string } };
    } | null;
    return {
      email: data?.data?.user?.email ?? null,
      teamName: data?.data?.team?.name ?? null,
    };
  } catch {
    return { email: null, teamName: null };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Compose the instance display name shown on the dashboard. Priority:
 *   1. Explicit `providedInstanceName` from the dashboard form (highest)
 *   2. `<Service Name> (<Team>)` — preferred when team is known
 *   3. `<Service Name> (<Email>)` — fallback when only email is known
 *   4. `<Service Name>` — last-resort
 */
export function buildOutlineInstanceName(input: {
  serviceName: string;
  providedInstanceName?: string | null;
  teamName?: string | null;
  email?: string | null;
}): string {
  if (input.providedInstanceName) return input.providedInstanceName;
  if (input.teamName) return `${input.serviceName} (${input.teamName})`;
  if (input.email) return `${input.serviceName} (${input.email})`;
  return input.serviceName;
}
