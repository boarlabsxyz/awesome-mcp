// src/hubspot/connectToken.ts
// Validates a pasted HubSpot private-app access token by hitting a lightweight
// endpoint (GET /crm/v3/objects/companies?limit=1). The shared control flow
// (timeout, redirect guard, status mapping) lives in ../util/pasteTokenValidation.

import {
  validatePasteToken,
  buildSimpleInstanceName,
  type ValidateInputBaseUrl,
  type ValidateResult,
} from '../util/pasteTokenValidation.js';

export type { ValidateOk, ValidateErr, ValidateResult, FetchImpl } from '../util/pasteTokenValidation.js';

const DEFAULT_BASE_URL = 'https://api.hubapi.com';

export interface ValidateInput extends ValidateInputBaseUrl {
  token: string;
}

/**
 * GET `${baseUrl}/crm/v3/objects/companies?limit=1` with the pasted token;
 * treat 2xx as proof the token is real.
 */
export function validateHubSpotToken(input: ValidateInput): Promise<ValidateResult> {
  return validatePasteToken({
    token: input.token,
    baseUrl: input.baseUrl,
    fetchImpl: input.fetchImpl,
    serviceLabel: 'HubSpot',
    credentialLabel: 'access token',
    rejectedMessage: 'HubSpot rejected the token. Check that it is valid and has CRM read scopes.',
    resolveBaseUrl: provided => (provided?.trim() || process.env.HUBSPOT_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    validationUrl: baseUrl => `${baseUrl}/crm/v3/objects/companies?limit=1`,
    headers: token => ({ Authorization: `Bearer ${token}`, Accept: 'application/json' }),
  });
}

/** Compose the instance display name shown on the dashboard. */
export function buildHubSpotInstanceName(input: {
  serviceName: string;
  providedInstanceName?: string | null;
}): string {
  return buildSimpleInstanceName(input);
}
