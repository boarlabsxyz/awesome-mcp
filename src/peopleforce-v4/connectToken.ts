// src/peopleforce-v4/connectToken.ts
// Validates a pasted PeopleForce **service account** API key against API v4.
// Shared control flow (timeout, redirect guard, status mapping) lives in
// ../util/pasteTokenValidation.

import {
  validatePasteToken,
  buildSimpleInstanceName,
  type ValidateInputBaseUrl,
  type ValidateResult,
} from '../util/pasteTokenValidation.js';

import { insecureBaseUrlReason } from './apiHelpers.js';

export type { ValidateOk, ValidateErr, ValidateResult, FetchImpl } from '../util/pasteTokenValidation.js';

const DEFAULT_BASE_URL = 'https://app.peopleforce.io/api/v4';

export interface ValidateInput extends ValidateInputBaseUrl {
  token: string;
}

/** Per-connection override > env > public default, trailing slashes stripped. */
function resolveBaseUrl(provided?: string): string {
  return (provided?.trim() || process.env.PEOPLEFORCE_V4_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/**
 * GET `${baseUrl}/people?per_page=1` with the pasted key; 2xx proves it is a
 * live service-account key.
 *
 * Two details are deliberate. The probe path is `/people`, because v4
 * renamed the resource — `/api/v4/employees` is a 404 (verified live
 * 2026-09-17), and a 404 would be reported as an unexpected upstream response
 * rather than a bad key. And only `X-API-KEY` is sent: v1–v3 also accepted a
 * bearer, v4 documents one header.
 *
 * The rejection message names the key type because the mirror-image mistake —
 * pasting a **Company** key here — 401s exactly like a revoked one, and that
 * key is perfectly valid on the other PeopleForce connector.
 */
export function validatePeopleForceV4Token(input: ValidateInput): Promise<ValidateResult> {
  // Scheme is checked HERE rather than inside `resolveBaseUrl`, which
  // validatePasteToken calls outside its try block: throwing from there would
  // break that function's "never throws" contract and 500 the connect route.
  // Refusing before the request also means the key is never put on the wire.
  const baseUrl = resolveBaseUrl(input.baseUrl);
  const insecure = insecureBaseUrlReason(baseUrl);
  if (insecure) {
    return Promise.resolve({
      ok: false,
      status: 400,
      userMessage: `PeopleForce v4 base URL rejected: ${insecure}`,
      logMessage: `PeopleForce v4 validation refused a non-HTTPS base URL: ${baseUrl}`,
    });
  }

  return validatePasteToken({
    token: input.token,
    baseUrl: input.baseUrl,
    fetchImpl: input.fetchImpl,
    serviceLabel: 'PeopleForce v4',
    credentialLabel: 'service account API key',
    rejectedMessage:
      'PeopleForce rejected the key. This connector uses API v4, which accepts a Service account key only — a ' +
      'Company or Career API key is rejected here (use the PeopleForce connector for those). In PeopleForce go to ' +
      'Settings → API keys → Generate API key and choose the Service account type, then check the key is still ' +
      'enabled and was copied in full.',
    resolveBaseUrl,
    validationUrl: baseUrl => `${baseUrl}/people?per_page=1`,
    headers: token => ({ 'X-API-KEY': token, Accept: 'application/json' }),
  });
}

/**
 * Dashboard display name. v4 exposes no `/me` for a service account (the key
 * is not a person), so there is nothing upstream to name the instance after.
 */
export function buildPeopleForceV4InstanceName(input: {
  serviceName: string;
  providedInstanceName?: string | null;
}): string {
  return buildSimpleInstanceName(input);
}
