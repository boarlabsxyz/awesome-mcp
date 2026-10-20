// src/github/revoke.ts
// Forget a GitHub connection on GitHub's side when it is deleted or
// reconnected, so the next "Connect with GitHub" shows the full consent screen
// again — including the organization panel — instead of GitHub silently
// re-approving the app it already remembers.
//
// Two GitHub calls, and the difference between them is the whole design:
//   - DELETE /applications/{client_id}/grant revokes the AUTHORIZATION. It is
//     the only way to get the consent screen back, and it deletes EVERY token
//     the GitHub account holds for this app.
//   - DELETE /applications/{client_id}/token revokes ONE token; the
//     authorization stays, so GitHub keeps skipping the consent screen.
// Several connectors per GitHub account is a supported setup (one per
// workspace, each with its own access rules), so revoking the grant when the
// account backs another connector would silently kill that one too. In that
// case only this connector's token is revoked, and the caller says so.
//
// Only OAuth tokens can be revoked this way: `gho_` (OAuth App) and `ghu_`
// (GitHub App user token). A pasted personal access token (`ghp_`,
// `github_pat_`) was not issued to this app, so there is nothing of ours to
// revoke — the user deletes it on GitHub.

import { GITHUB_API_BASE_URL, githubHeaders } from './constants.js';
import { fetchGitHubUser, type FetchImpl } from './connectToken.js';

const REVOKE_TIMEOUT_MS = 10_000;

/**
 * `grant` — authorization revoked; the next connect shows the consent screen.
 * `token` — only this token revoked, because the account backs another connector.
 * `not-oauth` — a pasted token; nothing of this app's to revoke.
 * `no-app` — no OAuth client configured on this deployment.
 * `failed` — GitHub did not confirm; the connector is still removed/replaced.
 */
export type RevokeOutcome = 'grant' | 'token' | 'not-oauth' | 'no-app' | 'failed';

export interface RevokeResult {
  outcome: RevokeOutcome;
  /** One sentence for the person who pressed the button. */
  message: string;
}

interface ConnectionLike {
  instanceId: string;
  provider?: string;
  providerTokens?: unknown;
}

const isOAuthToken = (token: unknown): token is string => typeof token === 'string' && /^gh[ou]_/.test(token);
const tokenOf = (c: ConnectionLike): unknown => (c.providerTokens as { access_token?: unknown } | undefined)?.access_token;

/**
 * True when another connector's token belongs to the same GitHub account as
 * `token`. An account that cannot be identified counts as the same: revoking
 * the grant on a guess would break a connector, while revoking only the token
 * merely leaves the consent screen skipped.
 */
async function accountBacksAnotherConnector(token: string, others: string[], fetchImpl: FetchImpl): Promise<boolean> {
  if (!others.length) return false;
  const { login } = await fetchGitHubUser(token, fetchImpl);
  if (!login) return true;
  for (const other of others) {
    const { login: otherLogin } = await fetchGitHubUser(other, fetchImpl);
    if (!otherLogin || otherLogin.toLowerCase() === login.toLowerCase()) return true;
  }
  return false;
}

export async function revokeGitHubConnection(
  connection: ConnectionLike,
  /** The same user's other connections; GitHub ones are checked for a shared account. */
  userConnections: ConnectionLike[],
  opts: { clientId?: string; clientSecret?: string; fetchImpl?: FetchImpl } = {},
): Promise<RevokeResult> {
  const clientId = opts.clientId ?? process.env.GITHUB_CLIENT_ID;
  const clientSecret = opts.clientSecret ?? process.env.GITHUB_CLIENT_SECRET;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = tokenOf(connection);

  if (!isOAuthToken(token)) {
    return {
      outcome: 'not-oauth',
      message: 'This connector used a pasted token, which this app cannot revoke. Delete it on GitHub (Settings → Developer settings → Personal access tokens) if it is no longer needed.',
    };
  }
  if (!clientId || !clientSecret) {
    return { outcome: 'no-app', message: 'No GitHub OAuth app is configured here, so the authorization was not revoked on GitHub.' };
  }

  const others = userConnections
    .filter(c => c.instanceId !== connection.instanceId && c.provider === 'github')
    .map(tokenOf)
    .filter(isOAuthToken);
  const shared = await accountBacksAnotherConnector(token, others, fetchImpl);
  const mode = shared ? 'token' : 'grant';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REVOKE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${GITHUB_API_BASE_URL}/applications/${encodeURIComponent(clientId)}/${mode}`, {
      method: 'DELETE',
      headers: {
        ...githubHeaders(''),
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ access_token: token }),
      signal: controller.signal,
      redirect: 'error',
    });
    // 404: the token is already gone (revoked on GitHub, or expired) — the
    // outcome the caller wanted.
    if (res.status !== 204 && res.status !== 404) {
      return { outcome: 'failed', message: `GitHub did not confirm the revocation (${res.status}). Revoke the app at github.com/settings/applications to see the consent screen again.` };
    }
  } catch (err: any) {
    return { outcome: 'failed', message: `Could not reach GitHub to revoke the authorization (${err?.message ?? err}). Revoke the app at github.com/settings/applications to see the consent screen again.` };
  } finally {
    clearTimeout(timer);
  }

  return mode === 'grant'
    ? { outcome: 'grant', message: 'The GitHub authorization was revoked; the next connect asks GitHub for consent again, including organization access.' }
    : { outcome: 'token', message: 'Only this connector\'s token was revoked: another connector uses the same GitHub account, and revoking the authorization would have disconnected it too. GitHub will therefore skip the consent screen on the next connect.' };
}
