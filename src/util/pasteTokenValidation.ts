// src/util/pasteTokenValidation.ts
// Shared control flow for validating a pasted provider token (API key / access
// token) by hitting a lightweight authenticated GET endpoint. Each provider
// supplies its own base-URL resolution, validation path, headers, and message
// labels; the timeout / redirect-guard / status-mapping logic lives here once
// so PeopleForce, HubSpot, and future paste-token connectors don't each copy it.

const DEFAULT_TIMEOUT_MS = 10_000;

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

/** Common per-connection knobs a provider's validate input carries. */
export interface ValidateInputBaseUrl {
  /** Optional per-connection base URL override. */
  baseUrl?: string;
  fetchImpl?: FetchImpl;
}

export interface PasteTokenValidationConfig {
  /** The pasted credential. Non-string / blank values are rejected up front. */
  token: unknown;
  /** Optional per-connection base URL override. */
  baseUrl?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  /** Human label for the provider, e.g. "HubSpot". Used in generated messages. */
  serviceLabel: string;
  /** Credential noun, e.g. "API key" or "access token". */
  credentialLabel: string;
  /** Full user-facing message for a 401/403 rejection (provider-specific). */
  rejectedMessage: string;
  /** Resolve the effective base URL (must return it with trailing slashes stripped). */
  resolveBaseUrl: (provided?: string) => string;
  /** Build the GET URL to probe, given the resolved base URL. */
  validationUrl: (baseUrl: string) => string;
  /** Request headers carrying the token. */
  headers: (token: string) => Record<string, string>;
}

const err = (status: number, userMessage: string, logMessage: string): ValidateErr =>
  ({ ok: false, status, userMessage, logMessage });

/** Reject a blank / non-string credential before touching the network. */
function checkTokenPresent(cfg: PasteTokenValidationConfig): ValidateErr | null {
  if (typeof cfg.token === 'string' && cfg.token.trim()) return null;
  return err(
    400,
    `${cfg.serviceLabel} ${cfg.credentialLabel} is required.`,
    `Rejected empty ${cfg.serviceLabel} ${cfg.credentialLabel}`,
  );
}

/** Map a thrown fetch/network failure to a user-facing result. */
function mapNetworkFailure(label: string, baseUrl: string, thrown: any): ValidateErr {
  const message = thrown?.message ?? String(thrown);
  const cause = thrown?.cause?.message ?? '';
  const looksLikeRedirect = /redirect/i.test(message) || /redirect/i.test(cause);
  if (looksLikeRedirect) {
    return err(
      400,
      `${label} URL redirected to another host. Contact your admin.`,
      `${label} validation blocked at redirect: ${message}${cause ? ` (cause: ${cause})` : ''}`,
    );
  }
  return err(502, `Could not reach ${label} at ${baseUrl}.`, `${label} validation fetch failed: ${message}`);
}

/**
 * GET the provider's validation URL with the pasted token; treat 2xx as proof
 * the credential is real. Returns a discriminated result so the caller can map
 * to an HTTP response without a second try/catch. Never throws.
 */
export async function validatePasteToken(cfg: PasteTokenValidationConfig): Promise<ValidateResult> {
  const label = cfg.serviceLabel;

  const missing = checkTokenPresent(cfg);
  if (missing) return missing;

  const fetchImpl = cfg.fetchImpl ?? fetch;
  const baseUrl = cfg.resolveBaseUrl(cfg.baseUrl);
  const token = (cfg.token as string).trim();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const timedOut = (): ValidateErr =>
    err(502, `${label} did not respond in time. Try again.`, `${label} validation timed out: ${baseUrl}`);

  const isAbort = (e: any): boolean => e?.name === 'AbortError';

  try {
    // If a proxy on the base URL 3xx-redirects the request elsewhere, the token
    // must not follow — the target could be a host that shouldn't see it.
    const options: RequestInit = { method: 'GET', headers: cfg.headers(token), signal: controller.signal, redirect: 'error' };

    let response: Response;
    try {
      response = await fetchImpl(cfg.validationUrl(baseUrl), options);
    } catch (thrown: any) {
      return isAbort(thrown) ? timedOut() : mapNetworkFailure(label, baseUrl, thrown);
    }

    if (response.status === 401 || response.status === 403) {
      return err(400, cfg.rejectedMessage, `${label} validation unauthorized: ${response.status}`);
    }

    if (!response.ok) {
      let body = '';
      try {
        body = await response.text();
      } catch (bodyErr: any) {
        if (isAbort(bodyErr)) return timedOut();
      }
      return err(
        502,
        `${label} returned an unexpected response (${response.status}). Try again.`,
        `${label} validation non-2xx: ${response.status} ${body}`,
      );
    }

    return { ok: true, baseUrl };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Compose the instance display name shown on the dashboard for a paste-token
 * connector. Priority: explicit user-provided name > service default.
 */
export function buildSimpleInstanceName(input: {
  serviceName: string;
  providedInstanceName?: string | null;
}): string {
  if (input.providedInstanceName) return input.providedInstanceName;
  return input.serviceName;
}
