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
 */
export function validatePeopleForceToken(input: ValidateInput): Promise<ValidateResult> {
  return validatePasteToken({
    token: input.token,
    baseUrl: input.baseUrl,
    fetchImpl: input.fetchImpl,
    serviceLabel: 'PeopleForce',
    credentialLabel: 'API key',
    rejectedMessage: 'PeopleForce rejected the API key. Check that it is valid and still active.',
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
