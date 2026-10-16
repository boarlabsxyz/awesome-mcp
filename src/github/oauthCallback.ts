// src/github/oauthCallback.ts
// GitHub OAuth 2.0 authorization_code exchange + refresh grant, extracted from
// the /connect/github/callback handler so the token logic can be unit-tested
// independently of Express. Same split as src/hubspot/oauthCallback.ts.
//
// GitHub specifics worth knowing before touching this:
//
//   - One token endpoint for both app kinds: POST
//     https://github.com/login/oauth/access_token, form-encoded. It answers
//     form-encoded text unless asked for JSON, which postTokenGrant does
//     (Accept: application/json).
//   - It answers a FAILED exchange with **200** and `{"error": "..."}` rather
//     than a 4xx (bad_verification_code, redirect_uri_mismatch,
//     incorrect_client_credentials). postTokenGrant reads that as "no
//     access_token" and keeps the body in logMessage, which is where the real
//     reason is.
//   - An **OAuth App** token never expires and comes with no refresh token, so
//     the refresh path below never runs for one. A **GitHub App** with
//     user-token expiration enabled returns `expires_in` (8h) and a refresh
//     token (6 months) that ROTATES on every use — the old one stops working —
//     so whatever comes back must be persisted, exactly as for Redmine.
//     Supporting both is free: the session carries whatever the token response
//     carried, and maybeRefreshGitHubToken is a no-op without an expiry.

import { postTokenGrant, type TokenGrantOk } from '../util/oauthTokenGrant.js';
import { fetchGitHubUser } from './connectToken.js';

export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

const TOKEN_EXCHANGE_TIMEOUT_MS = 15_000;

/**
 * OAuth App scopes this connector asks for.
 *
 * `repo` is the only scope GitHub offers that reaches PRIVATE repositories,
 * issues and pull requests, and it is coarse: it grants read/write to every
 * repository the user can write to. GitHub has no read-only private-repo scope
 * for OAuth Apps — a GitHub App (configured with per-permission access) is the
 * finer-grained alternative, and the same connect flow serves it, since GitHub
 * ignores `scope` for GitHub Apps.
 *
 * `workflow` is deliberately ABSENT: without it GitHub refuses any write under
 * `.github/workflows/`, and with it a prompt-injected model could rewrite CI to
 * exfiltrate repository secrets. A push touching a workflow file therefore
 * fails with GitHub's own "without `workflow` scope" message, which
 * mapGitHubError explains.
 *
 * Nothing else is requested because nothing else is used: no tool reads org
 * membership or teams (`read:org`), and `GET /user` — the only account read,
 * for naming the connection — needs no scope at all.
 *
 * Note GitHub tokens are frozen at the scopes they were minted with, so adding
 * a scope here only reaches existing connections after they reconnect.
 */
export const GITHUB_OAUTH_SCOPES = ['repo'];

export type FetchImpl = typeof fetch;

export type ExchangeOk = {
  ok: true;
  accessToken: string;
  /** Present only for GitHub Apps with expiring user tokens. */
  refreshToken: string | null;
  /** Access-token lifetime in seconds; null for non-expiring OAuth App tokens. */
  expiresIn: number | null;
  /** The authorizing account's login (for naming); null on lookup failure. */
  login: string | null;
  /** The account's public email (for naming); null when private or on failure. */
  email: string | null;
};

export type ExchangeErr = {
  ok: false;
  status: number;
  userMessage: string;
  logMessage: string;
};

export type ExchangeResult = ExchangeOk | ExchangeErr;

export interface ExchangeInput {
  tokenUrl: string;
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: FetchImpl;
}

/**
 * Exchange the authorization code, then look up the account the token belongs
 * to so the instance can be named after it. The lookup is best-effort: the
 * token is what matters, and failing a connect over a display name would reject
 * a credential that works. Never throws.
 */
export async function exchangeGitHubOauthCode(input: ExchangeInput): Promise<ExchangeResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const result = await postTokenGrant({
    tokenUrl: input.tokenUrl,
    params: {
      grant_type: 'authorization_code',
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
    },
    label: 'GitHub token exchange',
    fetchImpl,
    timeoutMs: TOKEN_EXCHANGE_TIMEOUT_MS,
  });
  if (!result.ok) return result;

  const user = await fetchGitHubUser(result.accessToken, fetchImpl);
  return {
    ok: true,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresIn: result.expiresIn,
    login: user.login,
    email: user.email,
  };
}

export type RefreshResult = TokenGrantOk | { ok: false; status: number; logMessage: string };

/**
 * Refresh grant — only ever reached for GitHub App user tokens, since an OAuth
 * App token carries no expiry. GitHub ROTATES the refresh token here, so the
 * caller must persist `refreshToken` whenever it is present. Never throws.
 */
export async function refreshGitHubToken(input: {
  tokenUrl: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: FetchImpl;
}): Promise<RefreshResult> {
  const result = await postTokenGrant({
    tokenUrl: input.tokenUrl,
    params: {
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    },
    label: 'GitHub token refresh',
    fetchImpl: input.fetchImpl,
    timeoutMs: TOKEN_EXCHANGE_TIMEOUT_MS,
  });
  if (!result.ok) return { ok: false, status: result.status, logMessage: result.logMessage };
  return result;
}
