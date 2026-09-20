// src/outline/connectToken.ts
// Validates a pasted Outline base URL + personal API key by calling
// POST <baseUrl>/api/auth.info. Extracted from webServer.ts so the
// validation + error-mapping logic can be unit-tested independently.

import { checkBaseUrl as checkBaseUrlFor } from '../util/baseUrlGuard.js';

const VALIDATE_TIMEOUT_MS = 10_000;

// The SSRF range table and URL shape checks are shared with the other
// self-hosted connector (Redmine) — see src/util/baseUrlGuard.ts. Re-exported
// here so existing importers (and the unit tests that enumerate every blocked
// range) keep working against this module.
export { isPrivateHost } from '../util/baseUrlGuard.js';

export type FetchImpl = typeof fetch;

export type ValidateOk = {
  ok: true;
  /** Base URL with any trailing slashes stripped. Safe to use as `${baseUrl}${path}`. */
  baseUrl: string;
  email: string | null;
  teamName: string | null;
};

export type ValidateErr = {
  ok: false;
  status: number;
  userMessage: string;
  logMessage: string;
};

export type ValidateResult = ValidateOk | ValidateErr;

export interface ValidateInput {
  baseUrl: string;
  token: string;
  fetchImpl?: FetchImpl;
}

/**
 * Reject a pasted Outline base URL that is empty, schemeless, whitespace-laden,
 * or points at a private host. Thin wrapper over the shared guard that pins the
 * "Outline" label — callers surface the returned string verbatim.
 * Returns `null` if the URL is acceptable; otherwise the user-facing reason.
 */
export function checkBaseUrl(raw: string): string | null {
  return checkBaseUrlFor(raw, 'Outline');
}

/**
 * POST <baseUrl>/api/auth.info with the pasted token; treat 200 as proof the
 * token is real. Uses a discriminated result so the caller can map to an HTTP
 * response without a second try/catch.
 */
export async function validateOutlineToken(input: ValidateInput): Promise<ValidateResult> {
  const badUrl = checkBaseUrl(input.baseUrl);
  if (badUrl) {
    return { ok: false, status: 400, userMessage: badUrl, logMessage: `Rejected Outline base URL: ${badUrl}` };
  }
  if (typeof input.token !== 'string' || !input.token.trim()) {
    return { ok: false, status: 400, userMessage: 'Outline API key is required.', logMessage: 'Rejected empty Outline API key' };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
  const token = input.token.trim();

  // Single AbortController + timeout guards the entire round trip: the fetch
  // headers, response.text(), and response.json(). A Slowloris-style slow body
  // would otherwise hang the connect flow forever.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
  const timedOut = (): ValidateErr => ({
    ok: false,
    status: 502,
    userMessage: 'Outline did not respond in time. Check the URL and try again.',
    logMessage: `Outline auth.info timed out: ${baseUrl}`,
  });

  try {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/api/auth.info`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
        // SSRF hardening: refuse to follow redirects. checkBaseUrl only
        // verifies the URL the user pasted — the target server could still
        // 302 the request to a private host (metadata endpoint, RFC1918
        // subnet, etc.), leaking the API key. redirect:'error' makes fetch
        // throw on any 3xx, matching the intent that the token only reach
        // the URL the user typed.
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
          userMessage: 'Outline URL redirected to another host. Paste the final URL directly.',
          logMessage: `Outline auth.info blocked at redirect: ${message}${cause ? ` (cause: ${cause})` : ''}`,
        };
      }
      return {
        ok: false,
        status: 502,
        userMessage: `Could not reach Outline at ${baseUrl}. Check the URL.`,
        logMessage: `Outline auth.info fetch failed: ${message}`,
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: 400,
        userMessage: 'Outline rejected the API key. Check that it is valid and still active.',
        logMessage: `Outline auth.info unauthorized: ${response.status}`,
      };
    }

    if (!response.ok) {
      let body = '';
      try {
        body = await response.text();
      } catch (bodyErr: any) {
        if (bodyErr?.name === 'AbortError') return timedOut();
        // Non-abort body-read failure: log without the body, keep going.
      }
      return {
        ok: false,
        status: 502,
        userMessage: `Outline returned an unexpected response (${response.status}). Try again.`,
        logMessage: `Outline auth.info non-2xx: ${response.status} ${body}`,
      };
    }

    type AuthInfoBody = { data?: { user?: { email?: string }; team?: { name?: string } } };
    let data: AuthInfoBody | null = null;
    try {
      data = await response.json() as AuthInfoBody;
    } catch (bodyErr: any) {
      if (bodyErr?.name === 'AbortError') return timedOut();
      // Non-abort JSON parse failure: treat as an OK-but-no-metadata response.
    }

    return {
      ok: true,
      baseUrl,
      email: data?.data?.user?.email ?? null,
      teamName: data?.data?.team?.name ?? null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Compose the instance display name shown on the dashboard. Priority:
 *   1. Explicit `providedInstanceName` from the paste form (highest)
 *   2. `<Service Name> (<Team>)` — preferred when the team is known
 *   3. `<Service Name> (<Email>)` — fallback when only email is known
 *   4. `<Service Name>` — last-resort
 *
 * Duplicates the shape used by the OAuth path in src/outline/oauthCallback.ts
 * on purpose — the two auth flows should produce identical connection names
 * for the same team, so a user connecting via API key and later via OAuth
 * still triggers the duplicate-connection guard.
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
