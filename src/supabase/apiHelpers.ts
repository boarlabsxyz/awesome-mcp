// src/supabase/apiHelpers.ts
// Session plumbing for the Supabase connector: resolve the credential, refresh
// an expiring OAuth token at call time, and run one proxied tool.
//
// There is no SupabaseClient here on purpose. Every tool is a proxy to
// Supabase's hosted MCP server (see hostedProxy.ts), so the only thing this
// module owns is getting a valid Bearer token to it.

import { UserError } from 'fastmcp';

import type { UserSession } from '../userSession.js';

import { proxySupabaseTool } from './hostedProxy.js';
import { refreshSupabaseToken, SUPABASE_TOKEN_URL } from './oauthCallback.js';

export type SupabaseToolLog = {
  info: (msg: string) => void;
  error: (msg: string) => void;
};

/** The stored credential, or the dashboard instruction when there is none. */
export function getSupabaseAccessToken(session?: UserSession): string {
  const token = session?.supabaseAccessToken;
  if (!token) {
    throw new UserError(
      'Supabase not connected. Visit the dashboard to connect your Supabase account (Connect with Supabase, or paste a personal access token).',
    );
  }
  return token;
}

// ---- OAuth token refresh (no-op for a pasted personal access token) ----

/** Refresh comfortably before the edge, so a slow call cannot outlive its token. */
const REFRESH_SKEW_MS = 5 * 60_000;

/** Keyed by instance id where there is one, by session object otherwise. */
const refreshesInFlight = new Map<string, Promise<void>>();
const refreshesInFlightBySession = new WeakMap<UserSession, Promise<void>>();

function needsRefresh(session: UserSession): boolean {
  const expiry = session.supabaseTokenExpiry;
  return !!expiry
    && !!session.supabaseRefreshToken
    && !!session.supabaseOauthClientId
    && !!session.supabaseOauthClientSecret
    && Date.now() >= expiry - REFRESH_SKEW_MS;
}

/**
 * Refresh the access token when it is at or near expiry.
 *
 * A no-op for a personal access token, which carries no expiry and no refresh
 * token. Single-flight per connection: if Supabase rotates refresh tokens (it
 * does not document either way), two concurrent calls each spending the same
 * one would leave the connection holding a dead token, discovered on the call
 * after next.
 */
export async function maybeRefreshSupabaseToken(session: UserSession | undefined, log: SupabaseToolLog): Promise<void> {
  if (!session || !needsRefresh(session)) return;

  const id = session.supabaseInstanceId;
  const pending = id ? refreshesInFlight.get(id) : refreshesInFlightBySession.get(session);
  if (pending) return pending;

  const run = refreshAndPersist(session, log).finally(() => {
    if (id) refreshesInFlight.delete(id);
    else refreshesInFlightBySession.delete(session);
  });
  if (id) refreshesInFlight.set(id, run);
  else refreshesInFlightBySession.set(session, run);
  return run;
}

/**
 * Best-effort: never throws, so every single-flight waiter resolves. A failed
 * refresh falls through to the existing token, whose 401 then tells the user
 * to reconnect — the only fix once the grant itself has lapsed.
 */
async function refreshAndPersist(session: UserSession, log: SupabaseToolLog): Promise<void> {
  const result = await refreshSupabaseToken({
    tokenUrl: SUPABASE_TOKEN_URL,
    refreshToken: session.supabaseRefreshToken!,
    clientId: session.supabaseOauthClientId!,
    clientSecret: session.supabaseOauthClientSecret!,
  });
  if (!result.ok) {
    log.error(`Supabase token refresh failed (${result.status}); using the existing token. ${result.logMessage}`);
    return;
  }

  // Keep the old refresh token only when Supabase sent none back.
  const refreshToken = result.refreshToken ?? session.supabaseRefreshToken;
  const expiry = result.expiresIn ? Date.now() + result.expiresIn * 1000 : undefined;
  session.supabaseAccessToken = result.accessToken;
  session.supabaseRefreshToken = refreshToken;
  session.supabaseTokenExpiry = expiry;

  const instanceId = session.supabaseInstanceId;
  if (!instanceId) return;
  try {
    const { getMcpConnectionByInstanceId, updateMcpInstanceProviderTokens } = await import('../mcpConnectionStore.js');
    // The store REPLACES provider_tokens, so read the record and swap only the
    // token fields — anything stored beside them must survive a refresh.
    const stored = (await getMcpConnectionByInstanceId(instanceId))?.providerTokens as Record<string, unknown> | undefined;
    await updateMcpInstanceProviderTokens(instanceId, {
      ...stored,
      access_token: result.accessToken,
      refresh_token: refreshToken,
      expiry_date: expiry,
    } as any);
  } catch (err: any) {
    log.error(`Failed to persist refreshed Supabase tokens for ${instanceId}: ${err?.message ?? err}`);
  }
}

/**
 * The standard tool body: refresh if needed, then forward the call.
 *
 * The token is read AFTER the refresh, since the refresh replaces it on the
 * session in place.
 */
export async function runSupabaseTool(
  name: string,
  args: Record<string, unknown>,
  session: UserSession | undefined,
  log: SupabaseToolLog,
): Promise<string> {
  await maybeRefreshSupabaseToken(session, log);
  const token = getSupabaseAccessToken(session);
  return proxySupabaseTool(token, name, args);
}
