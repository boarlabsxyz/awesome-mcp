// src/hubspot/connectToken.ts
// Validates a pasted HubSpot private-app access token by hitting a lightweight
// endpoint (GET /crm/v3/objects/companies?limit=1). Kept out of webServer.ts so
// the validation + error mapping can be unit-tested in isolation. Mirrors the
// PeopleForce paste-token flow.

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
   * Optional base URL override. Falls back to HUBSPOT_BASE_URL or the public
   * default. HubSpot is not self-hosted per tenant, so most callers pass nothing.
   */
  baseUrl?: string;
  fetchImpl?: FetchImpl;
}

const DEFAULT_BASE_URL = 'https://api.hubapi.com';

function resolveBaseUrl(input?: string): string {
  const raw = input?.trim() || process.env.HUBSPOT_BASE_URL || DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, '');
}

/**
 * GET `${baseUrl}/crm/v3/objects/companies?limit=1` with the pasted token;
 * treat 2xx as proof the token is real. Uses a discriminated result so the
 * caller can map to an HTTP response without a second try/catch.
 */
export async function validateHubSpotToken(input: ValidateInput): Promise<ValidateResult> {
  if (typeof input.token !== 'string' || !input.token.trim()) {
    return {
      ok: false,
      status: 400,
      userMessage: 'HubSpot access token is required.',
      logMessage: 'Rejected empty HubSpot access token',
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
    userMessage: 'HubSpot did not respond in time. Try again.',
    logMessage: `HubSpot validation timed out: ${baseUrl}`,
  });

  try {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/crm/v3/objects/companies?limit=1`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
        // If a proxy on the base URL 3xx-redirects the request elsewhere, the
        // token should not follow — the redirect target could be a different
        // host that has no business seeing the token.
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
          userMessage: 'HubSpot URL redirected to another host. Contact your admin.',
          logMessage: `HubSpot validation blocked at redirect: ${message}${cause ? ` (cause: ${cause})` : ''}`,
        };
      }
      return {
        ok: false,
        status: 502,
        userMessage: `Could not reach HubSpot at ${baseUrl}.`,
        logMessage: `HubSpot validation fetch failed: ${message}`,
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: 400,
        userMessage: 'HubSpot rejected the token. Check that it is valid and has CRM read scopes.',
        logMessage: `HubSpot validation unauthorized: ${response.status}`,
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
        userMessage: `HubSpot returned an unexpected response (${response.status}). Try again.`,
        logMessage: `HubSpot validation non-2xx: ${response.status} ${body}`,
      };
    }

    return { ok: true, baseUrl };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Compose the instance display name shown on the dashboard. HubSpot's token
 * introspection endpoint isn't reliably reachable with a private-app token, so
 * we fall back to the service name (or a user-provided one). Priority:
 * explicit name > service default.
 */
export function buildHubSpotInstanceName(input: {
  serviceName: string;
  providedInstanceName?: string | null;
}): string {
  if (input.providedInstanceName) return input.providedInstanceName;
  return input.serviceName;
}
