// src/redmine/connectToken.ts
// Validates a pasted Redmine base URL + personal API key by hitting
// GET <baseUrl>/users/current.json. The shared control flow (timeout, redirect
// guard, status mapping) lives in ../util/pasteTokenValidation; the SSRF range
// table lives in ../util/baseUrlGuard.

import { checkBaseUrl } from '../util/baseUrlGuard.js';
import { stripTrailingSlashes } from '../util/url.js';
import {
  validatePasteToken,
  type ValidateInputBaseUrl,
  type ValidateResult,
} from '../util/pasteTokenValidation.js';

export type { ValidateOk, ValidateErr, ValidateResult, FetchImpl } from '../util/pasteTokenValidation.js';

export interface ValidateInput extends ValidateInputBaseUrl {
  token: string;
  /**
   * Which credential this is. The connect form only ever produces `apiKey`,
   * but the dashboard health probe re-validates STORED credentials, and an
   * OAuth access token sent as `X-Redmine-API-Key` is rejected — which would
   * report a perfectly healthy OAuth connection as a bad key.
   */
  authMode?: 'apiKey' | 'oauth';
}

/**
 * Why a rejection is reported by status rather than with one message.
 *
 * Redmine answers a request it will not authenticate in two different ways,
 * and they mean opposite things for the user:
 *
 *   403 → the REST API is switched off entirely (Administration → Settings →
 *         API → "Enable REST API"). The key is irrelevant; an admin has to act.
 *   401 → the credential itself was rejected.
 *
 * Redmine only started distinguishing these in 4.1.0 (defect #30086) — before
 * that a disabled REST API also answered 401, byte-identical to a bad key.
 * So the 401 text names BOTH causes rather than sending someone off to
 * regenerate a key that was never the problem.
 */
function rejectedMessage(status: number): string {
  if (status === 403) {
    return (
      "Redmine refused the request because its REST API is disabled. " +
      "An administrator must enable it: Administration → Settings → API → tick 'Enable REST API'. " +
      'The API key is not the problem here.'
    );
  }
  return (
    'Redmine rejected the API key. Copy it from your Redmine profile at /my/account (right-hand ' +
    '"API access key" panel) and check the account is still active. Note: on Redmine older than 4.1 ' +
    'this same response also means the REST API is disabled server-wide (Administration → Settings → API).'
  );
}

/**
 * GET `${baseUrl}/users/current.json` with the pasted key; treat 2xx as proof
 * the credential is real and the REST API is reachable.
 *
 * Unlike PeopleForce/HubSpot, the base URL is REQUIRED and is checked before
 * the network: Redmine is always self-hosted, so there is no default host to
 * fall back to, and the URL the user typed is attacker-controllable input that
 * this server is about to send a credential to.
 */
export function validateRedmineToken(input: ValidateInput): Promise<ValidateResult> {
  const badUrl = checkBaseUrl(input.baseUrl ?? '', 'Redmine');
  if (badUrl) {
    return Promise.resolve({
      ok: false,
      status: 400,
      userMessage: badUrl,
      logMessage: `Rejected Redmine base URL: ${badUrl}`,
    });
  }
  const baseUrl = stripTrailingSlashes((input.baseUrl as string).trim());

  return validatePasteToken({
    token: input.token,
    baseUrl,
    fetchImpl: input.fetchImpl,
    serviceLabel: 'Redmine',
    credentialLabel: 'API key',
    rejectedMessage,
    resolveBaseUrl: () => baseUrl,
    validationUrl: base => `${base}/users/current.json`,
    headers: token => ({
      ...(input.authMode === 'oauth'
        ? { Authorization: `Bearer ${token}` }
        : { 'X-Redmine-API-Key': token }),
      Accept: 'application/json',
    }),
  });
}

/**
 * Compose the instance display name shown on the dashboard. The host is what
 * distinguishes two Redmine connections, so it wins over any user identity —
 * see buildRedmineInstanceName in ./oauthCallback.ts, which both auth paths
 * share so the same instance gets the same name either way.
 */
export { buildRedmineInstanceName } from './oauthCallback.js';
