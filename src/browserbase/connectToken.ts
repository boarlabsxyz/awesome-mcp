// src/browserbase/connectToken.ts
// Validates a pasted Browserbase API key by hitting GET /v1/projects. The
// shared control flow (timeout, redirect guard, status mapping) lives in
// ../util/pasteTokenValidation.
//
// /v1/projects does double duty: it proves the key AND returns the projects it
// can see, so the instance gets named after the real project instead of a
// generic label, and the project id can be stored for the usage read. There is
// no cheaper authenticated GET on this API.

import {
  validatePasteToken,
  buildSimpleInstanceName,
  type FetchImpl,
  type ValidateResult,
} from '../util/pasteTokenValidation.js';

export type { ValidateOk, ValidateErr, ValidateResult, FetchImpl } from '../util/pasteTokenValidation.js';

const DEFAULT_BASE_URL = 'https://api.browserbase.com/v1';

export interface ValidateInput {
  token: string;
  fetchImpl?: FetchImpl;
}

/**
 * GET `${baseUrl}/projects` with the pasted key; treat 2xx as proof it is real.
 *
 * Note there is no base-URL parameter and deliberately no
 * `BROWSERBASE_BASE_URL` env override: Browserbase is SaaS with one API host,
 * so a configurable base URL here would only ever be a place to send someone
 * else's credential. (Contrast Outline and Redmine, which are self-hosted and
 * must take the URL per connection.)
 */
export function validateBrowserbaseToken(input: ValidateInput): Promise<ValidateResult> {
  return validatePasteToken({
    token: input.token,
    fetchImpl: input.fetchImpl,
    serviceLabel: 'Browserbase',
    credentialLabel: 'API key',
    rejectedMessage:
      'Browserbase rejected the API key. Copy a current key from the Browserbase dashboard at https://www.browserbase.com/settings — note this must be the API key, not a session or context id.',
    resolveBaseUrl: () => DEFAULT_BASE_URL,
    validationUrl: baseUrl => `${baseUrl}/projects`,
    headers: token => ({ 'x-bb-api-key': token, Accept: 'application/json' }),
  });
}

/**
 * Fetch the project list so the connection can be named and its project id
 * stored.
 *
 * Best-effort and separate from validation: a key that passed the probe is
 * usable, so failing the connect over a name lookup would reject a working
 * credential. Callers fall back to buildBrowserbaseInstanceName's plain label.
 *
 * It carries its OWN timeout, which is not belt-and-braces. `validatePasteToken`
 * bounds the probe above, but this is a second request on the same connect
 * path — so without a deadline here a Browserbase API that stalls *after*
 * validation succeeded would hang `/api/connect-token` indefinitely, and the
 * user would sit on a spinner for a connection that is already usable. Being
 * best-effort is exactly why a stall has to degrade to `{}` rather than wait.
 */
const PROJECT_LOOKUP_TIMEOUT_MS = 10_000;

export async function fetchBrowserbaseProject(
  token: string,
  fetchImpl: FetchImpl = fetch,
): Promise<{ id?: string; name?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROJECT_LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${DEFAULT_BASE_URL}/projects`, {
      headers: { 'x-bb-api-key': token, Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!res.ok) return {};
    const body = await res.json();
    const first = Array.isArray(body) ? body[0] : undefined;
    if (!first) return {};
    return { id: typeof first.id === 'string' ? first.id : undefined, name: typeof first.name === 'string' ? first.name : undefined };
  } catch {
    // Includes the AbortError from the timeout above.
    return {};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compose the instance display name shown on the dashboard. Prefers the
 * Browserbase project name, which is what the user sees in their own
 * dashboard, so the two line up.
 */
export function buildBrowserbaseInstanceName(input: {
  serviceName: string;
  providedInstanceName?: string | null;
  projectName?: string | null;
}): string {
  const provided = input.providedInstanceName?.trim();
  if (provided) return provided;
  const project = input.projectName?.trim();
  if (project) return `Browserbase (${project})`;
  return buildSimpleInstanceName({ serviceName: input.serviceName });
}
