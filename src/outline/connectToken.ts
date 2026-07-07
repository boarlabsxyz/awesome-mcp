// src/outline/connectToken.ts
// Validates a pasted Outline base URL + personal API key by calling
// POST <baseUrl>/api/auth.info. Extracted from webServer.ts so the
// validation + error-mapping logic can be unit-tested independently.

const VALIDATE_TIMEOUT_MS = 10_000;

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
 * Reject inputs that are clearly wrong before hitting the network:
 *  - non-string / empty
 *  - missing scheme (http/https)
 *  - contains whitespace
 * Returns `null` if the URL is acceptable; otherwise the user-facing reason.
 */
function checkBaseUrl(raw: string): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return 'Outline URL is required.';
  const trimmed = raw.trim();
  if (/\s/.test(trimmed)) return 'Outline URL must not contain whitespace.';
  if (!/^https?:\/\//i.test(trimmed)) return 'Outline URL must start with http:// or https://.';
  try {
    void new URL(trimmed);
  } catch {
    return 'Outline URL is not a valid URL.';
  }
  return null;
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/api/auth.info`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timeout);
    if (err?.name === 'AbortError') {
      return {
        ok: false,
        status: 502,
        userMessage: 'Outline did not respond in time. Check the URL and try again.',
        logMessage: `Outline auth.info timed out: ${baseUrl}`,
      };
    }
    return {
      ok: false,
      status: 502,
      userMessage: `Could not reach Outline at ${baseUrl}. Check the URL.`,
      logMessage: `Outline auth.info fetch failed: ${err?.message ?? err}`,
    };
  } finally {
    clearTimeout(timeout);
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
    const body = await response.text().catch(() => '');
    return {
      ok: false,
      status: 502,
      userMessage: `Outline returned an unexpected response (${response.status}). Try again.`,
      logMessage: `Outline auth.info non-2xx: ${response.status} ${body}`,
    };
  }

  const data = await response.json().catch(() => null) as {
    data?: { user?: { email?: string }; team?: { name?: string } };
  } | null;

  return {
    ok: true,
    baseUrl,
    email: data?.data?.user?.email ?? null,
    teamName: data?.data?.team?.name ?? null,
  };
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
