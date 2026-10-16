// src/github/connectToken.ts
// Validates a pasted GitHub personal access token (classic or fine-grained)
// by hitting GET https://api.github.com/user, which every token type can read
// with no scope or permission at all. The shared control flow (timeout,
// redirect guard, status mapping) lives in ../util/pasteTokenValidation.

import {
  validatePasteToken,
  buildSimpleInstanceName,
  type FetchImpl,
  type ValidateResult,
} from '../util/pasteTokenValidation.js';
import { GITHUB_API_BASE_URL, githubHeaders } from './constants.js';

export type { ValidateOk, ValidateErr, ValidateResult, FetchImpl } from '../util/pasteTokenValidation.js';

const USER_LOOKUP_TIMEOUT_MS = 10_000;

export interface ValidateInput {
  token: string;
  fetchImpl?: FetchImpl;
}

/**
 * Probe the token. Only proves the token is a live GitHub credential — NOT
 * that it can reach any particular repository: a fine-grained token scoped to
 * zero repositories passes this and then 404s on every repo call. That case is
 * diagnosed at call time by mapGitHubError, which is the only place the
 * repository is known.
 *
 * 401 and 403 are worded separately because they mean different things here:
 * 401 is a dead token, while a 403 on `/user` is almost always a rate limit or
 * an organization policy, and telling someone to regenerate a working token is
 * the failure this avoids.
 */
export function validateGitHubToken(input: ValidateInput): Promise<ValidateResult> {
  return validatePasteToken({
    token: input.token,
    fetchImpl: input.fetchImpl,
    serviceLabel: 'GitHub',
    credentialLabel: 'personal access token',
    rejectedMessage: status => status === 401
      ? 'GitHub rejected the token (401): it is invalid, expired or revoked. Create a new one at github.com/settings/tokens and paste it here.'
      : 'GitHub refused the token (403). On this endpoint that is usually a rate limit or an organization policy restricting personal access tokens, not a bad token — wait a minute and retry, or ask an organization owner whether personal access tokens are allowed.',
    resolveBaseUrl: () => GITHUB_API_BASE_URL,
    validationUrl: baseUrl => `${baseUrl}/user`,
    headers: token => githubHeaders(token),
  });
}

/**
 * Best-effort lookup of the account a token belongs to, for naming the
 * connection. Returns nulls on any failure rather than an error — by the time
 * this runs the credential has already been accepted.
 */
export async function fetchGitHubUser(
  token: string,
  fetchImpl: FetchImpl = fetch,
): Promise<{ login: string | null; email: string | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), USER_LOOKUP_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${GITHUB_API_BASE_URL}/user`, {
      method: 'GET',
      headers: githubHeaders(token),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) return { login: null, email: null };
    const data = await response.json().catch(() => null) as { login?: unknown; email?: unknown } | null;
    return {
      login: typeof data?.login === 'string' ? data.login : null,
      email: typeof data?.email === 'string' && data.email ? data.email : null,
    };
  } catch {
    return { login: null, email: null };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Compose the instance display name. Priority: explicit user-provided name >
 * `<Service> (<login>)` > service name. The login matters more than for most
 * connectors because a person commonly holds several GitHub accounts (work and
 * personal), and two rows both named "GitHub" cannot be told apart.
 */
export function buildGitHubInstanceName(input: {
  serviceName: string;
  providedInstanceName?: string | null;
  login?: string | null;
}): string {
  if (input.providedInstanceName) return input.providedInstanceName;
  // The catalog row is "GitHub MCP Server" while every other row is "<X> MCP",
  // and callers derive serviceName by stripping " MCP" — which here leaves
  // "GitHub Server". Normalised once, here, rather than at each call site.
  const serviceName = input.serviceName.replace(/\s+MCP(\s+Server)?$/i, '').replace(/\s+Server$/i, '').trim() || 'GitHub';
  if (input.login) return `${serviceName} (${input.login})`;
  return buildSimpleInstanceName({ serviceName });
}
