// src/pinecone/connectToken.ts
// Validates a pasted Pinecone API key by hitting GET /indexes. The shared
// control flow (timeout, redirect guard, status mapping) lives in
// ../util/pasteTokenValidation.
//
// GET /indexes does double duty: it proves the key AND returns the indexes it
// can see, so the connection can be named after what is actually in the
// project rather than a generic label. There is no cheaper authenticated GET
// on this API.
//
// Note a Pinecone API key is scoped to ONE PROJECT. That is why the probe is
// meaningful even when it returns an empty list — an empty project is a real
// answer, not a failed credential — and it is why mapPineconeError reports a
// 403 as "a different project" rather than as a permissions problem.

import {
  type FetchImpl,
  type ValidateResult,
  buildSimpleInstanceName,
  validatePasteToken,
} from '../util/pasteTokenValidation.js';

import { PINECONE_API_VERSION, PINECONE_CONTROL_BASE_URL } from './apiHelpers.js';

export type { ValidateOk, ValidateErr, ValidateResult, FetchImpl } from '../util/pasteTokenValidation.js';

export interface ValidateInput {
  token: string;
  fetchImpl?: FetchImpl;
}

/** The version header is required on every call, including this probe. */
function pineconeHeaders(token: string): Record<string, string> {
  return {
    'Api-Key': token,
    'X-Pinecone-Api-Version': PINECONE_API_VERSION,
    Accept: 'application/json',
  };
}

/**
 * GET `${baseUrl}/indexes` with the pasted key; treat 2xx as proof it is real.
 *
 * No base-URL parameter and deliberately no `PINECONE_BASE_URL` env override:
 * Pinecone is SaaS with one control-plane host, so a configurable base URL
 * here would only ever be a place to send someone else's credential. (Contrast
 * Outline and Redmine, which are self-hosted and must take the URL per
 * connection.) The per-index data-plane hosts are a different matter — those
 * come from Pinecone's own responses and are validated in apiHelpers.
 */
export function validatePineconeToken(input: ValidateInput): Promise<ValidateResult> {
  return validatePasteToken({
    token: input.token,
    fetchImpl: input.fetchImpl,
    serviceLabel: 'Pinecone',
    credentialLabel: 'API key',
    rejectedMessage:
      'Pinecone rejected the API key. Copy a current key from https://app.pinecone.io/organizations/-/keys — note a key is scoped to one project, so make sure it is the project holding the indexes you want to reach.',
    resolveBaseUrl: () => PINECONE_CONTROL_BASE_URL,
    validationUrl: baseUrl => `${baseUrl}/indexes`,
    headers: pineconeHeaders,
  });
}

/**
 * Read the index list so the connection can be named after its contents.
 *
 * Best-effort and separate from validation: a key that passed the probe is
 * usable, so failing the connect over a name lookup would reject a working
 * credential. Callers fall back to buildPineconeInstanceName's plain label.
 *
 * It carries its OWN timeout. `validatePasteToken` bounds the probe above, but
 * this is a second request on the same connect path — without a deadline here
 * a Pinecone API that stalls AFTER validation succeeded would hang
 * /api/connect-token indefinitely, leaving the user on a spinner for a
 * connection that is already usable. Being best-effort is exactly why a stall
 * has to degrade to `{}` rather than wait.
 */
const INDEX_LOOKUP_TIMEOUT_MS = 10_000;

export async function fetchPineconeIndexSummary(
  token: string,
  fetchImpl: FetchImpl = fetch,
): Promise<{ count?: number; firstName?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INDEX_LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${PINECONE_CONTROL_BASE_URL}/indexes`, {
      headers: pineconeHeaders(token),
      redirect: 'error',
      signal: controller.signal,
    });
    if (!res.ok) return {};
    const body: any = await res.json();
    const indexes = Array.isArray(body?.indexes) ? body.indexes : [];
    const firstName = typeof indexes[0]?.name === 'string' ? indexes[0].name : undefined;
    return { count: indexes.length, firstName };
  } catch {
    // Includes the AbortError from the timeout above.
    return {};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compose the instance display name shown on the dashboard.
 *
 * A Pinecone key names no project of its own — the API has no "whoami" — so
 * the best available label is what the key can see. One index gets named
 * after it; several get a count, which is enough to tell two connections
 * apart on the dashboard. An empty project falls back to the plain label
 * rather than "Pinecone (0 indexes)", which reads like a failure.
 */
export function buildPineconeInstanceName(input: {
  serviceName: string;
  providedInstanceName?: string | null;
  indexCount?: number;
  firstIndexName?: string | null;
}): string {
  const provided = input.providedInstanceName?.trim();
  if (provided) return provided;
  if (input.indexCount === 1 && input.firstIndexName?.trim()) {
    return `Pinecone (${input.firstIndexName.trim()})`;
  }
  if (input.indexCount && input.indexCount > 1) {
    return `Pinecone (${input.indexCount} indexes)`;
  }
  return buildSimpleInstanceName({ serviceName: input.serviceName });
}
