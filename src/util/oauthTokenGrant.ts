// src/util/oauthTokenGrant.ts
// Shared POST to an OAuth 2.0 token endpoint (authorization_code and
// refresh_token grants alike). Every provider's exchange differs only in the
// endpoint URL, the form params, and the label used in messages — the timeout,
// network-error mapping, non-2xx handling and "response carried no
// access_token" check are identical, so they live here once.
//
// Kept deliberately provider-agnostic: no provider name, no default token URL.

const DEFAULT_TIMEOUT_MS = 15_000;

export type FetchImpl = typeof fetch;

export type TokenGrantOk = {
  ok: true;
  accessToken: string;
  /** Present only when the provider returned one; callers keep their existing token otherwise. */
  refreshToken: string | null;
  /** Access-token lifetime in seconds, or null when the provider omitted it. */
  expiresIn: number | null;
};

export type TokenGrantErr = {
  ok: false;
  status: number;
  userMessage: string;
  logMessage: string;
};

export type TokenGrantResult = TokenGrantOk | TokenGrantErr;

export interface TokenGrantInput {
  tokenUrl: string;
  /** Form-encoded body params (grant_type, code/refresh_token, client_id, …). */
  params: Record<string, string>;
  /** Human label used in both messages, e.g. "Redmine token exchange". */
  label: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

/** POST the token endpoint under a timeout; the caller maps thrown errors. */
function fetchTokenGrant(input: TokenGrantInput, fetchImpl: FetchImpl): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return fetchImpl(input.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(input.params).toString(),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));
}

/** Map a thrown fetch failure (timeout / network) to a discriminated error. */
function grantNetworkError(err: any, label: string, tokenUrl: string): TokenGrantErr {
  const timedOut = err?.name === 'AbortError';
  return {
    ok: false,
    status: 502,
    userMessage: `${label} ${timedOut ? 'timed out' : 'failed'}. Please try again.`,
    logMessage: timedOut ? `${label} timed out: POST ${tokenUrl}` : `${label} fetch failed: ${err?.message ?? err}`,
  };
}

/** Turn a token-endpoint Response into a normalized token result. */
async function readGrantResponse(response: Response, label: string): Promise<TokenGrantResult> {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return {
      ok: false,
      status: response.status,
      userMessage: `${label} failed. Please try again.`,
      logMessage: `${label} failed: ${response.status} ${body}`,
    };
  }
  const parsed = (await response.json().catch(() => null)) as
    { access_token?: string; refresh_token?: string; expires_in?: number } | null;
  if (!parsed?.access_token) {
    return {
      ok: false,
      status: 500,
      userMessage: `${label} returned no access token. Please try again.`,
      logMessage: `${label} response missing access_token: ${JSON.stringify(parsed)}`,
    };
  }
  return {
    ok: true,
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? null,
    expiresIn: typeof parsed.expires_in === 'number' ? parsed.expires_in : null,
  };
}

/**
 * Run one OAuth 2.0 token grant. Never throws — returns a discriminated result
 * so the caller can map straight to an HTTP response or a log line.
 */
export async function postTokenGrant(input: TokenGrantInput): Promise<TokenGrantResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchTokenGrant(input, fetchImpl);
  } catch (err: any) {
    return grantNetworkError(err, input.label, input.tokenUrl);
  }
  return readGrantResponse(response, input.label);
}
