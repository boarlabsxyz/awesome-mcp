// src/website/connectionHealth.ts
//
// Answers one question the stored record cannot: does this connection's
// credential still work?
//
// The dashboard used to decide whether to offer Reconnect from token fields
// alone, and that is not decidable. computeTokenStatus() reports isExpired
// false whenever a refresh_token exists — correct, because a refresh token
// normally self-heals an expired access token — but a refresh token that the
// provider has REVOKED sits in the record looking identical to a healthy one
// and fails only at call time. That is how a dead Gmail connection came to
// render with no badge and no button. Widening the button to "always visible"
// fixed the dead end but destroyed the signal: every healthy row grew a
// permanent amber warning, and it stayed there after a successful reconnect.
//
// So the button is gated on an actual probe instead. Each provider already has
// a cheap authenticated call used at connect time; this reuses those.
//
// The distinction that makes it usable: NEEDS_REAUTH only for a definitive
// rejection of the credential (401/403, invalid_grant, Slack's invalid_auth).
// A timeout, DNS failure or provider 500 returns `unknown`, never a reconnect
// prompt — otherwise one flaky minute upstream would light up every row in the
// dashboard and train the user to ignore the button entirely.

import { OAuth2Client } from 'google-auth-library';
import type { McpConnection } from '../mcpConnectionStore.js';
import { validateOutlineToken } from '../outline/connectToken.js';
import { validatePeopleForceToken } from '../peopleforce/connectToken.js';
import { validateHubSpotToken } from '../hubspot/connectToken.js';

/**
 * `healthy`  — credential works.
 * `reauth`   — provider definitively rejected it; show Reconnect.
 * `unknown`  — could not tell (network, timeout, upstream 5xx, missing config).
 *              Deliberately NOT a reconnect prompt.
 */
export type ConnectionHealthState = 'healthy' | 'reauth' | 'unknown';

export interface ConnectionHealth {
  state: ConnectionHealthState;
  /** Short, user-facing when state is 'reauth'; diagnostic otherwise. */
  reason?: string;
}

const PROBE_TIMEOUT_MS = 8_000;

/** Injected so tests never touch the network. */
export interface HealthDeps {
  fetchImpl?: typeof fetch;
  /** Overridable for the Google probe, which needs an OAuth client rather than a bare fetch. */
  probeGoogle?: (refreshToken: string, clientId: string, clientSecret: string) => Promise<ConnectionHealth>;
}

/**
 * Is this error object the provider saying "this credential is no good",
 * as opposed to "I could not answer right now"?
 *
 * Google reports a revoked or expired grant as invalid_grant; that is the
 * whole reason this module exists, so it is matched explicitly rather than
 * inferred from a status code.
 */
function classifyGoogleError(err: any): ConnectionHealth {
  const body = err?.response?.data;
  const code = String(body?.error || '');
  const message = String(err?.message || '');
  if (code === 'invalid_grant' || message.includes('invalid_grant')) {
    return { state: 'reauth', reason: 'Google reports the authorization was revoked or expired (invalid_grant).' };
  }
  if (code === 'invalid_client' || message.includes('invalid_client')) {
    // A misconfigured OAuth app, not a user problem — reconnecting cannot fix it.
    return { state: 'unknown', reason: 'OAuth client rejected (invalid_client) — check the deployment credentials.' };
  }
  const status = err?.response?.status;
  if (status === 400 || status === 401) {
    return { state: 'reauth', reason: `Google rejected the stored refresh token (HTTP ${status}).` };
  }
  return { state: 'unknown', reason: message || 'Google token refresh failed for an unknown reason.' };
}

async function defaultProbeGoogle(
  refreshToken: string, clientId: string, clientSecret: string,
): Promise<ConnectionHealth> {
  const client = new OAuth2Client(clientId, clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  try {
    // Forces a refresh round-trip, which is exactly where a revoked grant
    // surfaces. Nothing is persisted: this is a probe, and the real session
    // path does its own refresh-and-store.
    const { token } = await client.getAccessToken();
    return token
      ? { state: 'healthy' }
      : { state: 'unknown', reason: 'Google returned no access token.' };
  } catch (err: any) {
    return classifyGoogleError(err);
  }
}

/** Map a shared ValidateResult onto health, keeping 5xx/timeouts out of 'reauth'. */
function fromValidateResult(result: { ok: boolean; status?: number; userMessage?: string }): ConnectionHealth {
  if (result.ok) return { state: 'healthy' };
  const status = result.status ?? 0;
  if (status === 401 || status === 403) {
    return { state: 'reauth', reason: result.userMessage || 'The stored credential was rejected.' };
  }
  // 400 from these validators means a malformed credential, which a reconnect
  // does fix; 5xx/0 means the provider could not answer and must not prompt.
  if (status === 400) {
    return { state: 'reauth', reason: result.userMessage || 'The stored credential is not valid.' };
  }
  return { state: 'unknown', reason: result.userMessage || `Provider unreachable (status ${status}).` };
}

/** Slack (bot and user) and ClickUp both answer a single authenticated GET/POST. */
async function probeBearerEndpoint(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
  opts: { method?: string; slackStyle?: boolean } = {},
): Promise<ConnectionHealth> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: opts.method || 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { state: 'reauth', reason: `Provider rejected the stored token (HTTP ${res.status}).` };
    }
    if (!res.ok) {
      return { state: 'unknown', reason: `Provider returned HTTP ${res.status}.` };
    }
    if (opts.slackStyle) {
      // Slack answers 200 with ok:false for auth problems, so the status code
      // alone would call a revoked token healthy.
      const data = await res.json() as { ok?: boolean; error?: string };
      if (data?.ok) return { state: 'healthy' };
      const error = String(data?.error || 'unknown');
      const fatal = ['invalid_auth', 'token_revoked', 'token_expired', 'account_inactive', 'not_authed'];
      return fatal.includes(error)
        ? { state: 'reauth', reason: `Slack reports the token is no longer usable (${error}).` }
        : { state: 'unknown', reason: `Slack returned ${error}.` };
    }
    return { state: 'healthy' };
  } catch (err: any) {
    // Abort, DNS, TLS — we genuinely do not know.
    return { state: 'unknown', reason: err?.name === 'AbortError' ? 'Probe timed out.' : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe one connection. Never throws: an unusable answer is 'unknown', which
 * the dashboard renders as no button rather than as a false alarm.
 */
export async function checkConnectionHealth(
  connection: McpConnection,
  credentials: { clientId?: string | null; clientSecret?: string | null },
  deps: HealthDeps = {},
): Promise<ConnectionHealth> {
  const fetchImpl = deps.fetchImpl || fetch;
  const provider = connection.provider || 'google';
  const providerTokens = (connection.providerTokens || {}) as Record<string, any>;
  const accessToken = providerTokens.access_token;

  try {
    switch (provider) {
      case 'google': {
        const refreshToken = connection.googleTokens?.refresh_token;
        if (!refreshToken) {
          // Nothing to refresh with — the existing token-status path already
          // treats this as needing attention, and it is definitive.
          return { state: 'reauth', reason: 'No refresh token stored; the connection cannot renew itself.' };
        }
        if (!credentials.clientId || !credentials.clientSecret) {
          return { state: 'unknown', reason: 'No OAuth client configured for this MCP on this deployment.' };
        }
        const probe = deps.probeGoogle || defaultProbeGoogle;
        return await probe(refreshToken, credentials.clientId, credentials.clientSecret);
      }

      case 'slack':
      case 'slack-bot': {
        if (!accessToken) return { state: 'reauth', reason: 'No Slack token stored.' };
        return await probeBearerEndpoint('https://slack.com/api/auth.test', accessToken, fetchImpl, {
          method: 'POST', slackStyle: true,
        });
      }

      case 'clickup': {
        if (!accessToken) return { state: 'reauth', reason: 'No ClickUp token stored.' };
        return await probeBearerEndpoint('https://api.clickup.com/api/v2/user', accessToken, fetchImpl);
      }

      case 'outline': {
        if (!accessToken) return { state: 'reauth', reason: 'No Outline token stored.' };
        return fromValidateResult(await validateOutlineToken({
          baseUrl: providerTokens.baseUrl || process.env.OUTLINE_BASE_URL || '',
          token: accessToken,
          fetchImpl,
        } as any));
      }

      case 'peopleforce': {
        if (!accessToken) return { state: 'reauth', reason: 'No PeopleForce API key stored.' };
        return fromValidateResult(await validatePeopleForceToken({
          token: accessToken, baseUrl: providerTokens.baseUrl, fetchImpl,
        } as any));
      }

      case 'hubspot': {
        if (!accessToken) return { state: 'reauth', reason: 'No HubSpot token stored.' };
        return fromValidateResult(await validateHubSpotToken({
          token: accessToken, baseUrl: providerTokens.baseUrl, fetchImpl,
        } as any));
      }

      default:
        return { state: 'unknown', reason: `No health probe implemented for provider "${provider}".` };
    }
  } catch (err: any) {
    // A probe throwing is our problem, not evidence about the credential.
    return { state: 'unknown', reason: String(err?.message || err) };
  }
}
