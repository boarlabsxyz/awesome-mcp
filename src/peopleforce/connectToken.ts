// src/peopleforce/connectToken.ts
// Validates a pasted PeopleForce personal API key by hitting a lightweight
// endpoint (GET /employees?per_page=1). Kept out of webServer.ts so the
// validation + error mapping can be unit-tested in isolation.

const VALIDATE_TIMEOUT_MS = 10_000;

export type FetchImpl = typeof fetch;

export type ValidateOk = {
  ok: true;
  /** Base URL with any trailing slashes stripped. Safe to use as `${baseUrl}${path}`. */
  baseUrl: string;
};

export type ValidateErr = {
  ok: false;
  status: number;
  userMessage: string;
  logMessage: string;
};

export type ValidateResult = ValidateOk | ValidateErr;

export interface ValidateInput {
  token: string;
  /**
   * Optional per-connection base URL. Falls back to PEOPLEFORCE_BASE_URL or the
   * public default. Unlike Outline, PeopleForce is not self-hosted per tenant,
   * so most callers pass nothing.
   */
  baseUrl?: string;
  fetchImpl?: FetchImpl;
}

const DEFAULT_BASE_URL = 'https://app.peopleforce.io/api/public/v2';

function resolveBaseUrl(input?: string): string {
  const raw = input?.trim() || process.env.PEOPLEFORCE_BASE_URL || DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, '');
}

/**
 * GET `${baseUrl}/employees?per_page=1` with the pasted token; treat 200 as
 * proof the key is real. Uses a discriminated result so the caller can map
 * to an HTTP response without a second try/catch.
 */
export async function validatePeopleForceToken(input: ValidateInput): Promise<ValidateResult> {
  if (typeof input.token !== 'string' || !input.token.trim()) {
    return {
      ok: false,
      status: 400,
      userMessage: 'PeopleForce API key is required.',
      logMessage: 'Rejected empty PeopleForce API key',
    };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = resolveBaseUrl(input.baseUrl);
  const token = input.token.trim();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
  const timedOut = (): ValidateErr => ({
    ok: false,
    status: 502,
    userMessage: 'PeopleForce did not respond in time. Try again.',
    logMessage: `PeopleForce validation timed out: ${baseUrl}`,
  });

  try {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/employees?per_page=1`, {
        method: 'GET',
        headers: {
          'X-API-KEY': token,
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
        // If a proxy on the base URL 3xx-redirects the request elsewhere, the
        // token should not follow — the redirect target could be a different
        // host that has no business seeing the key.
        redirect: 'error',
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') return timedOut();
      const message = err?.message ?? String(err);
      const cause = err?.cause?.message ?? '';
      if (/redirect/i.test(message) || /redirect/i.test(cause)) {
        return {
          ok: false,
          status: 400,
          userMessage: 'PeopleForce URL redirected to another host. Contact your admin.',
          logMessage: `PeopleForce validation blocked at redirect: ${message}${cause ? ` (cause: ${cause})` : ''}`,
        };
      }
      return {
        ok: false,
        status: 502,
        userMessage: `Could not reach PeopleForce at ${baseUrl}.`,
        logMessage: `PeopleForce validation fetch failed: ${message}`,
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: 400,
        userMessage: 'PeopleForce rejected the API key. Check that it is valid and still active.',
        logMessage: `PeopleForce validation unauthorized: ${response.status}`,
      };
    }

    if (!response.ok) {
      let body = '';
      try {
        body = await response.text();
      } catch (bodyErr: any) {
        if (bodyErr?.name === 'AbortError') return timedOut();
      }
      return {
        ok: false,
        status: 502,
        userMessage: `PeopleForce returned an unexpected response (${response.status}). Try again.`,
        logMessage: `PeopleForce validation non-2xx: ${response.status} ${body}`,
      };
    }

    return { ok: true, baseUrl };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Compose the instance display name shown on the dashboard. PeopleForce
 * doesn't expose a `/me` endpoint we can rely on, so we fall back to the
 * service name (or a user-provided one) rather than pulling metadata from
 * the upstream API. Priority: explicit name > service default.
 */
export function buildPeopleForceInstanceName(input: {
  serviceName: string;
  providedInstanceName?: string | null;
}): string {
  if (input.providedInstanceName) return input.providedInstanceName;
  return input.serviceName;
}
