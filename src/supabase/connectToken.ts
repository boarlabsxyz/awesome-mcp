// src/supabase/connectToken.ts
// Validates a pasted Supabase personal access token by hitting
// GET https://api.supabase.com/v1/organizations. The shared control flow
// (timeout, redirect guard, status mapping) lives in ../util/pasteTokenValidation.
//
// /v1/organizations does double duty: it proves the token AND returns the
// organizations it reaches, so the connection can be named after them. That
// matters because people commonly hold tokens for more than one organization
// (personal and work), and "Supabase" twice on the dashboard tells them apart
// by nothing.
//
// The same probe validates an OAuth access token in the health check: both are
// Bearer tokens against the same Management API.

import {
  type FetchImpl,
  type ValidateResult,
  buildSimpleInstanceName,
  validatePasteToken,
} from '../util/pasteTokenValidation.js';

export type { ValidateOk, ValidateErr, ValidateResult, FetchImpl } from '../util/pasteTokenValidation.js';

/**
 * Supabase's Management API. A constant with no env override: Supabase's
 * platform is SaaS with one API host, so a configurable base URL would only
 * ever be a place to send someone else's token. (Self-hosted Supabase has no
 * Management API at all, and its MCP server serves a different tool subset.)
 */
export const SUPABASE_API_BASE_URL = 'https://api.supabase.com';

export interface ValidateInput {
  token: string;
  fetchImpl?: FetchImpl;
}

function supabaseHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
}

export function validateSupabaseToken(input: ValidateInput): Promise<ValidateResult> {
  return validatePasteToken({
    token: input.token,
    fetchImpl: input.fetchImpl,
    serviceLabel: 'Supabase',
    credentialLabel: 'access token',
    rejectedMessage:
      'Supabase rejected the access token. Create a personal access token at https://supabase.com/dashboard/account/tokens (it starts with sbp_) — note this is the ACCOUNT token, not a project API key such as the anon, publishable or service_role key.',
    resolveBaseUrl: () => SUPABASE_API_BASE_URL,
    validationUrl: baseUrl => `${baseUrl}/v1/organizations`,
    headers: supabaseHeaders,
  });
}

/**
 * Read the organization list so the connection can be named after it.
 *
 * Best-effort and separate from validation: a token that passed the probe is
 * usable, so failing the connect over a display name would reject a working
 * credential. It carries its OWN timeout for the reason fetchPineconeIndexSummary
 * does — it is a second request on the connect path, and a stall after a
 * successful validation must not leave the user on a spinner.
 */
const ORG_LOOKUP_TIMEOUT_MS = 10_000;

export async function fetchSupabaseOrganizationSummary(
  token: string,
  fetchImpl: FetchImpl = fetch,
): Promise<{ count?: number; firstName?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ORG_LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${SUPABASE_API_BASE_URL}/v1/organizations`, {
      headers: supabaseHeaders(token),
      redirect: 'error',
      signal: controller.signal,
    });
    if (!res.ok) return {};
    const body: any = await res.json();
    const orgs = Array.isArray(body) ? body : [];
    const firstName = typeof orgs[0]?.name === 'string' ? orgs[0].name : undefined;
    return { count: orgs.length, firstName };
  } catch {
    // Includes the AbortError from the timeout above.
    return {};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compose the instance display name shown on the dashboard. One organization
 * gets named after it; several get a count. Zero falls back to the plain label
 * rather than "Supabase (0 organizations)", which reads like a failure.
 */
export function buildSupabaseInstanceName(input: {
  serviceName: string;
  providedInstanceName?: string | null;
  organizationCount?: number;
  firstOrganizationName?: string | null;
}): string {
  const provided = input.providedInstanceName?.trim();
  if (provided) return provided;
  if (input.organizationCount === 1 && input.firstOrganizationName?.trim()) {
    return `Supabase (${input.firstOrganizationName.trim()})`;
  }
  if (input.organizationCount && input.organizationCount > 1) {
    return `Supabase (${input.organizationCount} organizations)`;
  }
  return buildSimpleInstanceName({ serviceName: input.serviceName });
}
