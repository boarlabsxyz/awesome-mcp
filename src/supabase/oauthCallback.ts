// src/supabase/oauthCallback.ts
// Supabase OAuth 2.0 authorization_code exchange + refresh grant, extracted
// from the /connect/supabase/callback handler so the token logic can be unit
// tested without Express. Same split as src/github/oauthCallback.ts.
//
// Supabase specifics, read from its authorization-server metadata
// (https://api.supabase.com/.well-known/oauth-authorization-server) and its
// integration guide:
//
//   - The OAuth app is registered by an organization owner in the Supabase
//     dashboard (Organization settings → OAuth Apps). Its SCOPES are chosen
//     there, not in the authorize request — which is why the catalog seeds no
//     `oauthScopes` and the generic /connect redirect then sends no `scope`.
//   - At consent the user picks ONE organization, and the token reaches that
//     organization only. A second organization is a second connection.
//   - The token endpoint accepts client credentials in the body
//     (`client_secret_post` is in token_endpoint_auth_methods_supported), so
//     the shared postTokenGrant works unchanged. The guide's examples use HTTP
//     Basic; both are advertised.
//   - Access tokens expire. Whether the refresh token ROTATES is not
//     documented, so the refresh path persists whatever comes back and keeps
//     the old one only when none is returned — correct either way.

import { postTokenGrant, type TokenGrantOk } from '../util/oauthTokenGrant.js';
import { fetchSupabaseOrganizationSummary, SUPABASE_API_BASE_URL } from './connectToken.js';

export const SUPABASE_AUTHORIZE_URL = `${SUPABASE_API_BASE_URL}/v1/oauth/authorize`;
export const SUPABASE_TOKEN_URL = `${SUPABASE_API_BASE_URL}/v1/oauth/token`;

const TOKEN_EXCHANGE_TIMEOUT_MS = 15_000;

export type FetchImpl = typeof fetch;

export type ExchangeOk = {
  ok: true;
  accessToken: string;
  refreshToken: string | null;
  /** Access-token lifetime in seconds, or null when Supabase omitted it. */
  expiresIn: number | null;
  /** How many organizations the grant reaches (for naming); undefined on lookup failure. */
  organizationCount?: number;
  /** The first organization's name (for naming); undefined on lookup failure. */
  organizationName?: string;
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
 * Exchange the authorization code, then look up the organization the grant
 * reaches so the instance can be named after it. The lookup is best-effort:
 * failing a connect over a display name would reject a credential that works.
 * Never throws.
 */
export async function exchangeSupabaseOauthCode(input: ExchangeInput): Promise<ExchangeResult> {
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
    label: 'Supabase token exchange',
    fetchImpl,
    timeoutMs: TOKEN_EXCHANGE_TIMEOUT_MS,
  });
  if (!result.ok) return result;

  const summary = await fetchSupabaseOrganizationSummary(result.accessToken, fetchImpl);
  return {
    ok: true,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresIn: result.expiresIn,
    organizationCount: summary.count,
    organizationName: summary.firstName,
  };
}

export type RefreshResult = TokenGrantOk | { ok: false; status: number; logMessage: string };

/** Refresh grant. The caller persists `refreshToken` whenever it is present. Never throws. */
export async function refreshSupabaseToken(input: {
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
    label: 'Supabase token refresh',
    fetchImpl: input.fetchImpl,
    timeoutMs: TOKEN_EXCHANGE_TIMEOUT_MS,
  });
  if (!result.ok) return { ok: false, status: result.status, logMessage: result.logMessage };
  return result;
}
