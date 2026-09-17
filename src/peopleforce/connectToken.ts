// src/peopleforce/connectToken.ts
// Validates a pasted PeopleForce personal API key by hitting a lightweight
// endpoint (GET /employees?per_page=1). The shared control flow (timeout,
// redirect guard, status mapping) lives in ../util/pasteTokenValidation.

import {
  validatePasteToken,
  buildSimpleInstanceName,
  type ValidateInputBaseUrl,
  type ValidateResult,
} from '../util/pasteTokenValidation.js';

export type { ValidateOk, ValidateErr, ValidateResult, FetchImpl } from '../util/pasteTokenValidation.js';

const DEFAULT_BASE_URL = 'https://app.peopleforce.io/api/public/v2';

export interface ValidateInput extends ValidateInputBaseUrl {
  token: string;
}

/**
 * GET `${baseUrl}/employees?per_page=1` with the pasted token; treat 2xx as
 * proof the key is real. PeopleForce accepts either `X-API-KEY` or a bearer
 * token, so we send both.
 *
 * Key TYPE matters as much as validity here. PeopleForce ships three kinds of
 * key and they do not overlap: a **Company** key works on v1–v3, a **Service
 * account** key (Settings → API keys, new with the v4 beta) works on
 * `/api/v4/*` and *only* there, and a Career key reaches published vacancies
 * only. Since every tool in this repo speaks v2/v3, a pasted service-account
 * key 401s on this probe exactly like a revoked one — which is why the
 * rejection message names the key type instead of only telling the user to
 * check that the key is active. See the PeopleForce v4 auth docs: "a service
 * account API key only works against v4 - you can't use it to access v3, v2 or
 * v1 APIs."
 */
export function validatePeopleForceToken(input: ValidateInput): Promise<ValidateResult> {
  return validatePasteToken({
    token: input.token,
    baseUrl: input.baseUrl,
    fetchImpl: input.fetchImpl,
    serviceLabel: 'PeopleForce',
    credentialLabel: 'API key',
    rejectedMessage:
      'PeopleForce rejected the API key. This connector uses the PeopleForce v2/v3 public API, which accepts a Company API key only — a Service account key works against API v4 alone and is rejected here no matter how it is scoped. In PeopleForce go to Settings → API keys and generate a key of type Company, or check that the existing key is still active.',
    resolveBaseUrl: provided => (provided?.trim() || process.env.PEOPLEFORCE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    validationUrl: baseUrl => `${baseUrl}/employees?per_page=1`,
    headers: token => ({ 'X-API-KEY': token, Authorization: `Bearer ${token}`, Accept: 'application/json' }),
  });
}

/**
 * Compose the instance display name shown on the dashboard. PeopleForce
 * doesn't expose a reliable `/me` endpoint, so we fall back to the service
 * name (or a user-provided one).
 */
export function buildPeopleForceInstanceName(input: {
  serviceName: string;
  providedInstanceName?: string | null;
}): string {
  return buildSimpleInstanceName(input);
}
