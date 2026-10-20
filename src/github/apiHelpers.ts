// src/github/apiHelpers.ts
// GitHubClient (a thin REST client over jsonApiRequest), the session → client
// helper, call-time OAuth refresh, and the error mapping every tool shares.
//
// The error mapping is most of the value here. GitHub reuses a handful of
// statuses for causes that need opposite fixes, and the only thing that tells
// them apart is usually a response HEADER, not the body:
//
//   403 — rate limit used up        (x-ratelimit-remaining: 0)    → wait
//   403 — secondary/abuse limit     (retry-after)                 → slow down
//   403 — SAML SSO not authorized   (x-github-sso)                → authorize the token for the org
//   403 — fine-grained token lacks a permission (x-accepted-github-permissions) → edit the token
//   403/404 — OAuth scope missing   (x-accepted-oauth-scopes vs x-oauth-scopes) → reconnect
//   404 — does not exist OR you cannot see it (GitHub never says which)
//
// Reporting all of these as "Permission denied" — which is what the reference
// implementation did with every 403 — sends the user to fix the wrong thing.

import { UserError } from 'fastmcp';

import type { UserSession } from '../userSession.js';
import { jsonApiRequestWithMeta, RedirectRefusedError } from '../util/jsonApiRequest.js';
import {
  assertOwnerAllowed,
  loadGitHubOwnerPolicy,
  ownerAllowed,
  ownerFromPath,
  searchItemOwner,
  type OwnerPolicy,
} from './accessRules.js';
import { GITHUB_API_BASE_URL, githubHeaders } from './constants.js';
import { GITHUB_TOKEN_URL, refreshGitHubToken } from './oauthCallback.js';
import { oauthAppApprovalUrl } from './ownerDiscovery.js';

export { GITHUB_API_BASE_URL } from './constants.js';

const REQUEST_TIMEOUT_MS = 30_000;

/** GitHub caps every `per_page` at 100. */
export const GITHUB_MAX_PER_PAGE = 100;

export type GitHubToolLog = {
  info: (msg: string) => void;
  error: (msg: string) => void;
};

export type QueryValue = string | number | boolean | null | undefined;

/** Where a paginated list sits, read from GitHub's `Link` header. */
export interface PageInfo {
  /** Page number to ask for next, or null when this is the last page. */
  next: number | null;
  /** Number of the last page, when GitHub reports one (it does not for every endpoint). */
  last: number | null;
}

export interface GitHubResponse<T> {
  data: T;
  status: number;
  page: PageInfo;
  headers: Headers;
  /** Search results this connector's access rules removed from `data.items`. */
  hiddenByAccessRules?: number;
}

/**
 * Parse `Link: <https://api.github.com/...&page=3>; rel="next", <...>; rel="last"`.
 *
 * Read rather than inferred from "the page came back full": a full page is
 * exactly as long when it is the last one, so guessing either invents a next
 * page that is empty or hides one that is not.
 */
export function parseLinkHeader(header: string | null | undefined): PageInfo {
  const info: PageInfo = { next: null, last: null };
  if (!header) return info;
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part);
    if (!match) continue;
    let page: number;
    try {
      page = Number(new URL(match[1]).searchParams.get('page'));
    } catch {
      continue;
    }
    if (!Number.isInteger(page) || page < 1) continue;
    const rels = match[2].split(/\s+/);
    if (rels.includes('next')) info.next = page;
    if (rels.includes('last')) info.last = page;
  }
  // GitHub can send a `next` past its own `last` (seen live on /commits when
  // the results exactly fill the page: next=2, last=1, and page 2 is empty).
  // `last` is the bound, so a `next` beyond it is not a next page.
  if (info.next !== null && info.last !== null && info.next > info.last) info.next = null;
  return info;
}

function buildQuery(query?: Record<string, QueryValue>): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** One path segment — an owner, a repo, a branch component. */
export const seg = (value: string): string => encodeURIComponent(value);

/** `/repos/{owner}/{repo}` with both parts encoded. */
export function repoPath(owner: string, repo: string): string {
  return `/repos/${seg(owner)}/${seg(repo)}`;
}

/**
 * A slash-separated path (a file path, or a branch like `feature/x`) with each
 * segment encoded but the slashes kept. Encoding the whole string would turn
 * `/` into `%2F`, which GitHub does not resolve as a directory separator.
 */
export function slashPath(value: string): string {
  return value.split('/').filter(Boolean).map(seg).join('/');
}

export interface GitHubClientOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /**
   * Asked once per client when GitHub rejects the token (401): resolves to a
   * different token to re-send THAT request with, or null to let the 401
   * stand. The retry lives here, at the request boundary, and not around a
   * whole tool callback: a 401 means GitHub ran that one request and nothing
   * else, but the requests before it in the same op DID run, so replaying the
   * callback would file a second issue or push a second commit.
   */
  onUnauthorized?: () => Promise<string | null>;
  /**
   * This connection's owner allowlist (see ./accessRules); null or absent is
   * unrestricted. Enforced HERE, at the one place every request passes, so the
   * MCP tools, the REST routes and any op added later are all covered without
   * each remembering to check.
   */
  allowedOwners?: OwnerPolicy;
}

/** The search endpoints whose results belong to a repository, and so to an owner. */
const OWNED_SEARCH = /^\/search\/(?:repositories|code|issues)$/;

export class GitHubClient {
  private token: string;
  /** Shared by concurrent 401s, so the store is read at most once per client. */
  private reload: Promise<string | null> | null = null;

  constructor(token: string, private readonly opts: GitHubClientOptions = {}) {
    this.token = token;
  }

  get baseUrl(): string {
    return this.opts.baseUrl ?? GITHUB_API_BASE_URL;
  }

  /** This connection's owner allowlist, or null when unrestricted. */
  get allowedOwners(): OwnerPolicy {
    return this.opts.allowedOwners ?? null;
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    options: { query?: Record<string, QueryValue>; body?: unknown; accept?: string } = {},
  ): Promise<GitHubResponse<T>> {
    this.enforceAccessRules(method, path, options.body);
    const sent = this.token;
    let res: GitHubResponse<T>;
    try {
      res = await this.send<T>(sent, method, path, options);
    } catch (error: any) {
      if (error?.status !== 401 || !this.opts.onUnauthorized) throw error;
      this.reload ??= this.opts.onUnauthorized();
      const fresh = await this.reload;
      if (!fresh || fresh === sent) throw error;
      this.token = fresh;
      res = await this.send<T>(fresh, method, path, options);
    }
    return this.filterSearchResults(path, res);
  }

  /** Refuse, before anything is sent, a request into an owner the rules exclude. */
  private enforceAccessRules(method: string, path: string, body: unknown): void {
    const policy = this.opts.allowedOwners;
    if (!policy) return;
    const owner = ownerFromPath(path);
    if (owner) assertOwnerAllowed(owner, policy);
    // A fork's destination is in the BODY: forking an allowed repository into
    // an excluded organization would write there.
    const organization = (body as { organization?: unknown } | undefined)?.organization;
    if (method === 'POST' && path.endsWith('/forks') && typeof organization === 'string' && organization) {
      assertOwnerAllowed(organization, policy);
    }
  }

  /**
   * Drop search hits from excluded owners. Search spans everything the token
   * can see, and GitHub's query language has no "not these orgs" — so results
   * are filtered after the fact and the count is reported, because a silent
   * drop reads as "GitHub found nothing" (the Slack search lesson). An item
   * whose owner cannot be determined is dropped too: unknown is not allowed.
   */
  private filterSearchResults<T>(path: string, res: GitHubResponse<T>): GitHubResponse<T> {
    const policy = this.opts.allowedOwners;
    const items = (res.data as { items?: unknown[] } | null)?.items;
    if (!policy || !OWNED_SEARCH.test(path) || !Array.isArray(items)) return res;
    const kept = items.filter(item => ownerAllowed(searchItemOwner(item), policy));
    return {
      ...res,
      data: { ...(res.data as object), items: kept } as T,
      hiddenByAccessRules: items.length - kept.length,
    };
  }

  private async send<T>(
    token: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    options: { query?: Record<string, QueryValue>; body?: unknown; accept?: string },
  ): Promise<GitHubResponse<T>> {
    const res = await jsonApiRequestWithMeta<T>({
      url: `${this.baseUrl}${path}${buildQuery(options.query)}`,
      method,
      headers: githubHeaders(token, options.accept),
      body: options.body,
      timeoutMs: REQUEST_TIMEOUT_MS,
      serviceLabel: 'GitHub API',
      target: `${method} ${path}`,
      // GitHub answers a request for a RENAMED or TRANSFERRED repository with a
      // 301 to /repositories/<id>/..., same origin. Following it on reads is
      // what keeps an old owner/name working; jsonApiRequest refuses it for
      // writes (a replayed POST could duplicate), and mapGitHubError explains.
      // NOT followed under access rules: /repositories/<id> names no owner, so
      // a repository transferred OUT of an allowed organization would be read
      // through its old name. The refusal tells the caller to use the new one,
      // which is then checked like any other.
      followSameOriginRedirects: this.opts.allowedOwners ? 0 : 3,
      secrets: [token],
      fetchImpl: this.opts.fetchImpl,
    });
    return {
      data: res.data as T,
      status: res.status,
      page: parseLinkHeader(res.headers.get('link')),
      headers: res.headers,
    };
  }

  async get<T>(path: string, query?: Record<string, QueryValue>, accept?: string): Promise<GitHubResponse<T>> {
    return this.request<T>('GET', path, { query, accept });
  }

  async post<T>(path: string, body?: unknown): Promise<GitHubResponse<T>> {
    return this.request<T>('POST', path, { body });
  }

  async put<T>(path: string, body?: unknown): Promise<GitHubResponse<T>> {
    return this.request<T>('PUT', path, { body });
  }

  async patch<T>(path: string, body?: unknown): Promise<GitHubResponse<T>> {
    return this.request<T>('PATCH', path, { body });
  }
}

const SILENT_LOG: GitHubToolLog = { info: () => {}, error: () => {} };

export function getGitHubClient(
  session?: UserSession,
  log: GitHubToolLog = SILENT_LOG,
  allowedOwners: OwnerPolicy = null,
): GitHubClient {
  if (!session?.githubAccessToken) {
    throw new UserError('GitHub not connected. Visit the dashboard to connect your GitHub account.');
  }
  return new GitHubClient(session.githubAccessToken, {
    onUnauthorized: async () => (await reloadStoredGitHubToken(session, log)) ? session.githubAccessToken ?? null : null,
    allowedOwners,
  });
}

/**
 * The client every caller should use: this connection's access rules, read
 * fresh, applied. The rules are loaded after the connection check so a
 * missing connection still reads "GitHub not connected".
 */
export async function getRuledGitHubClient(session: UserSession | undefined, log: GitHubToolLog = SILENT_LOG): Promise<GitHubClient> {
  if (!session?.githubAccessToken) return getGitHubClient(session, log); // throws "not connected"
  return getGitHubClient(session, log, await loadGitHubOwnerPolicy(session));
}


// ---- Error mapping ----

/** What a failing call was about, so a 404 can name it instead of "resource". */
export interface GitHubErrorContext {
  /** e.g. `repository octocat/hello-world` or `pull request #12 in octocat/hello-world`. */
  resource?: string;
  /** True for a call that may have changed state, which changes what a 5xx means. */
  write?: boolean;
}

interface GitHubErrorBody {
  message?: string;
  errors?: Array<{ message?: string; resource?: string; field?: string; code?: string } | string>;
  documentation_url?: string;
}

/** How many of GitHub's validation errors a 422 message renders. */
const VALIDATION_ERRORS_SHOWN = 10;

function errorBody(error: any): GitHubErrorBody | null {
  const raw = error?.body;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as GitHubErrorBody : null;
  } catch {
    return null;
  }
}

function errorHeader(error: any, name: string): string | null {
  try {
    return error?.headers?.get?.(name) ?? null;
  } catch {
    return null;
  }
}

function scopeList(raw: string | null): string[] | null {
  if (raw === null) return null;
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Scopes that imply others, per GitHub's scope documentation. Without this a
 * token holding `repo` would be told it lacks `public_repo`, which it does not.
 */
const IMPLIED_SCOPES: Record<string, string[]> = {
  repo: ['public_repo', 'repo:status', 'repo_deployment', 'repo:invite', 'security_events'],
  'admin:org': ['write:org', 'read:org'],
  'write:org': ['read:org'],
  user: ['read:user', 'user:email', 'user:follow'],
};

function effectiveScopes(granted: string[]): Set<string> {
  const all = new Set(granted);
  for (const scope of granted) {
    for (const implied of IMPLIED_SCOPES[scope] ?? []) all.add(implied);
  }
  return all;
}

/**
 * When the response says which OAuth scopes the call accepts AND which the
 * token holds, and they do not overlap, name both. This is the same
 * needed-and-granted contract the HubSpot and Slack connectors follow: the
 * granted half is what tells "the reconnect never happened" from "it did and
 * still did not grant it". Fine-grained tokens and GitHub App tokens carry no
 * `x-oauth-scopes` header at all, so this returns null for them rather than
 * claiming they hold no scopes.
 */
function missingScopeNote(error: any): string | null {
  const accepted = scopeList(errorHeader(error, 'x-accepted-oauth-scopes'));
  const granted = scopeList(errorHeader(error, 'x-oauth-scopes'));
  if (!accepted?.length || granted === null) return null;
  const held = effectiveScopes(granted);
  if (accepted.some(scope => held.has(scope))) return null;
  return `This call needs one of the OAuth scopes [${accepted.join(', ')}], and the connected credential holds [${granted.join(', ') || 'none'}]. Reconnect GitHub from the dashboard; for a pasted classic token, add the scope at github.com/settings/tokens.`;
}

function rateLimitMessage(error: any, message: string): string | null {
  const status = error?.status;
  if (status !== 403 && status !== 429) return null;
  const remaining = errorHeader(error, 'x-ratelimit-remaining');
  const retryAfter = errorHeader(error, 'retry-after');
  if (remaining === '0') {
    const reset = Number(errorHeader(error, 'x-ratelimit-reset'));
    const resource = errorHeader(error, 'x-ratelimit-resource') ?? 'core';
    const limit = errorHeader(error, 'x-ratelimit-limit');
    const when = Number.isFinite(reset) && reset > 0
      ? ` It resets at ${new Date(reset * 1000).toISOString()} (in about ${Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60_000))} min).`
      : '';
    const search = resource.includes('search') ? ' Search has its own, much smaller budget (30 requests/min, 10 for code search).' : '';
    return `GitHub's "${resource}" rate limit${limit ? ` of ${limit}` : ''} is used up, so nothing was done.${when}${search}`;
  }
  if (retryAfter || /secondary rate limit|abuse/i.test(message)) {
    return `GitHub's secondary rate limit was triggered — too many requests, or too many writes, in a short window — so nothing was done. Wait ${retryAfter ? `${retryAfter} s` : 'a minute'} before retrying, and avoid issuing writes in parallel.`;
  }
  return null;
}

function forbiddenMessage(error: any, message: string): string {
  const sso = errorHeader(error, 'x-github-sso');
  if (sso && /required/i.test(sso)) {
    const url = /url=(\S+)/.exec(sso)?.[1];
    return `The organization that owns this enforces SAML single sign-on, and this credential has not been authorized for it.${url ? ` Authorize it at ${url} and retry.` : ' Authorize the token for the organization (github.com/settings/tokens → Configure SSO) and retry.'}`;
  }
  const permissions = errorHeader(error, 'x-accepted-github-permissions');
  if (permissions || /resource not accessible by/i.test(message)) {
    return `The credential is a fine-grained token or GitHub App token that lacks the repository permission this call needs${permissions ? ` (${permissions})` : ''}. Grant it in the token's or app's settings, and check the repository is among the ones it was given access to. GitHub said: ${message}`;
  }
  if (/workflow/i.test(message)) {
    return `${message} — this connector deliberately does not request the \`workflow\` scope, so files under .github/workflows/ cannot be written through it; edit them on GitHub directly.`;
  }
  if (/OAuth App access restrictions/i.test(message)) {
    // The organization has not approved this app. No setting on our side —
    // access rules, scopes, a reconnect — changes that; only an owner can.
    const org = /the [`'"]?([^`'"\s]+)[`'"]? organization/i.exec(message)?.[1];
    const approval = oauthAppApprovalUrl();
    return `${org ? `The ${org} organization` : 'This organization'} restricts OAuth Apps and has not approved this one, so GitHub hides its resources from this connection. `
      + `${approval ? `Request approval (an owner can grant it directly) at ${approval}` : 'An organization owner must approve the app'}; until then nothing in this connector's settings can reach it.`;
  }
  const scopes = missingScopeNote(error);
  if (scopes) return scopes;
  return `GitHub refused this (403): ${message || 'no reason given'}. The connected account may lack write access to the repository, or an organization policy may block it.`;
}

function validationMessage(body: GitHubErrorBody | null, message: string): string {
  const errors = (body?.errors ?? []).map(e => {
    if (typeof e === 'string') return e;
    return e.message || [e.resource, e.field].filter(Boolean).join('.') + (e.code ? ` ${e.code}` : '');
  }).filter(Boolean);
  if (!errors.length) return `GitHub rejected the values (422): ${message || 'validation failed'}`;
  const shown = errors.slice(0, VALIDATION_ERRORS_SHOWN);
  const rest = errors.length - shown.length;
  return `GitHub rejected the values (422): ${message ? `${message} — ` : ''}${shown.join('; ')}${rest > 0 ? ` (and ${rest} more)` : ''}`;
}

/**
 * Turn a thrown request error into the sentence the model should see. Exported
 * so the REST plane can word the same failure the same way.
 */
export function describeGitHubError(error: any, ctx: GitHubErrorContext = {}): string {
  if (error instanceof RedirectRefusedError) {
    const r = error.redirect;
    if (r.sameOrigin && r.path?.startsWith('/repositories/')) {
      return 'GitHub reports that this repository was renamed or transferred, and a write is not replayed to its new location. Find its current owner/name (searchRepositories) and retry with that.';
    }
    return error.message;
  }

  const status: number | undefined = typeof error?.status === 'number' ? error.status : undefined;
  if (status === undefined) {
    return `could not reach GitHub — ${error?.message ?? String(error)}`;
  }

  const body = errorBody(error);
  const message = body?.message ?? '';

  const limited = rateLimitMessage(error, message);
  if (limited) return limited;

  switch (status) {
    case 401:
      return 'GitHub rejected the stored credential (401): it was revoked, expired, or the app\'s access was removed. Reconnect GitHub from the dashboard.';
    case 403:
      return forbiddenMessage(error, message);
    case 404: {
      const what = ctx.resource ?? 'resource';
      const scopes = missingScopeNote(error);
      return `${what} was not found. GitHub answers 404 — not 403 — when a private resource exists but the credential cannot see it, so either it does not exist, a name is misspelled, or the connected account has no access to it (an organization can also block this app until an owner approves it under Settings → Third-party access).${scopes ? ` ${scopes}` : ''}`;
    }
    case 409:
      if (/repository is empty/i.test(message)) {
        return 'the repository has no commits yet, so there is no branch to build on. Create the first file with createOrUpdateFile, which can commit to an empty repository.';
      }
      return `GitHub reported a conflict (409): ${message || 'the resource changed underneath this call'}.`;
    case 422:
      return validationMessage(body, message);
    default:
      if (status >= 500) {
        return `GitHub returned ${status}, an error on GitHub's side.${ctx.write ? ' A write that fails this way may or may not have been applied — check before retrying.' : ' Retry shortly.'}`;
      }
      return `GitHub returned ${status}: ${message || error?.message || 'no details'}`;
  }
}

/**
 * The HTTP status the REST plane answers a failed GitHub call with, and the
 * sentence to put in `{ error }`.
 *
 * Not sendUpstreamError, for three reasons. It maps every 403 to "Permission
 * denied", which is wrong for a rate limit — that is 429 here, with
 * Retry-After, so a pipeline can back off instead of giving up. GitHub's 401
 * means the STORED credential is dead, so it is answered 502: echoing 401 on
 * this plane tells the caller their REST bearer is bad and sends them to
 * re-mint one (the Redmine lesson). And an op that already turned GitHub's
 * answer into a sentence raises a UserError that may carry the status it
 * stands for (a missing branch is 404, a lost push race is 409); one with no
 * status is a request the op refused before calling GitHub, which is a 400.
 */
export function githubRestError(error: any): { status: number; message: string; retryAfter?: string } {
  const status: number | undefined = typeof error?.status === 'number' ? error.status : undefined;
  // instanceof, not `name === 'UserError'`: FastMCP names an error after its
  // class, so a subclass (GitHubAccessDenied) would otherwise be re-described
  // as GitHub's own 403 and lose the message that names the access rule.
  if (error instanceof UserError || error?.name === 'UserError') {
    return { status: status ?? 400, message: error.message };
  }
  const message = describeGitHubError(error);
  if (status === undefined) return { status: 502, message };
  const remaining = errorHeader(error, 'x-ratelimit-remaining');
  const retryAfter = errorHeader(error, 'retry-after') ?? undefined;
  if ((status === 403 || status === 429) && (remaining === '0' || retryAfter)) {
    const reset = Number(errorHeader(error, 'x-ratelimit-reset'));
    const wait = retryAfter
      ?? (Number.isFinite(reset) && reset > 0 ? String(Math.max(1, Math.ceil(reset - Date.now() / 1000))) : undefined);
    return { status: 429, message, retryAfter: wait };
  }
  if (status === 401 || status >= 500) return { status: 502, message };
  return { status, message };
}

/** Throw the described error as a UserError, logging only what is unexpected. */
export function mapGitHubError(prefix: string, error: any, log: GitHubToolLog, ctx: GitHubErrorContext = {}): never {
  if (error instanceof UserError) throw error;
  const status = typeof error?.status === 'number' ? error.status : undefined;
  if (status === undefined || status >= 500) {
    log.error(`${prefix}: ${error?.message ?? error}`);
  }
  throw new UserError(`${prefix}: ${describeGitHubError(error, ctx)}`);
}

// ---- OAuth token refresh (only ever runs for GitHub App user tokens) ----

/** GitHub App user tokens live 8h; refresh comfortably before the edge. */
const REFRESH_SKEW_MS = 5 * 60_000;

const inflightById = new Map<string, Promise<void>>();
const inflightBySession = new WeakMap<UserSession, Promise<void>>();

/**
 * Refresh the access token when it is at or near expiry.
 *
 * A no-op for OAuth App tokens and pasted tokens, which carry no expiry. For a
 * GitHub App token it is single-flight per connection, because GitHub ROTATES
 * the refresh token: two concurrent calls each spending the same one would
 * leave the connection holding a dead token, discovered on the call after
 * next.
 */
export async function maybeRefreshGitHubToken(session: UserSession | undefined, log: GitHubToolLog): Promise<void> {
  if (!session) return;
  const { githubTokenExpiry: expiry, githubRefreshToken, githubOauthClientId, githubOauthClientSecret } = session;
  if (!expiry || !githubRefreshToken || !githubOauthClientId || !githubOauthClientSecret) return;
  if (Date.now() < expiry - REFRESH_SKEW_MS) return;

  const id = session.githubInstanceId;
  const pending = id ? inflightById.get(id) : inflightBySession.get(session);
  if (pending) {
    await pending;
    return;
  }
  const run = performGitHubRefresh(session, log).finally(() => {
    if (id) inflightById.delete(id);
    else inflightBySession.delete(session);
  });
  if (id) inflightById.set(id, run);
  else inflightBySession.set(session, run);
  await run;
}

/**
 * Best-effort: never throws, so every single-flight waiter resolves. A failed
 * refresh falls through to the existing token, whose 401 then tells the user
 * to reconnect — which, once the 6-month refresh token itself has lapsed, is
 * the only fix there is.
 */
async function performGitHubRefresh(session: UserSession, log: GitHubToolLog): Promise<void> {
  const refreshToken = session.githubRefreshToken;
  const clientId = session.githubOauthClientId;
  const clientSecret = session.githubOauthClientSecret;
  if (!refreshToken || !clientId || !clientSecret) return;

  const result = await refreshGitHubToken({ tokenUrl: GITHUB_TOKEN_URL, refreshToken, clientId, clientSecret });
  if (!result.ok) {
    log.error(`GitHub token refresh failed (${result.status}); using existing token. ${result.logMessage}`);
    return;
  }

  const newRefresh = result.refreshToken ?? refreshToken;
  const newExpiry = result.expiresIn ? Date.now() + result.expiresIn * 1000 : undefined;
  session.githubAccessToken = result.accessToken;
  session.githubRefreshToken = newRefresh;
  session.githubTokenExpiry = newExpiry;

  const instanceId = session.githubInstanceId;
  if (!instanceId) return;
  try {
    const { getMcpConnectionByInstanceId, updateMcpInstanceProviderTokens } = await import('../mcpConnectionStore.js');
    // The store REPLACES provider_tokens, so the stored record is read and
    // only the token fields are swapped. Writing just the three token fields
    // would drop accessRules on every refresh — every 8 hours, silently
    // widening a restricted connector back to every organization.
    const stored = (await getMcpConnectionByInstanceId(instanceId))?.providerTokens as Record<string, unknown> | undefined;
    await updateMcpInstanceProviderTokens(instanceId, {
      ...stored,
      access_token: result.accessToken,
      refresh_token: newRefresh,
      expiry_date: newExpiry,
    } as any);
  } catch (err: any) {
    log.error(`Failed to persist refreshed GitHub tokens for ${instanceId}: ${err?.message ?? err}`);
  }
}

/**
 * The standard tool wrapper: refresh, build the client, run, map errors.
 * `getGitHubClient` runs before the callback so "not connected" is surfaced
 * verbatim rather than re-wrapped.
 */
export async function withGitHubClient<T>(
  prefix: string,
  session: UserSession | undefined,
  log: GitHubToolLog,
  fn: (client: GitHubClient) => Promise<T>,
  ctx: GitHubErrorContext = {},
): Promise<T> {
  await maybeRefreshGitHubToken(session, log);
  const client = await getRuledGitHubClient(session, log);
  try {
    return await fn(client);
  } catch (error: any) {
    mapGitHubError(prefix, error, log, ctx);
  }
}

/**
 * Pick up a credential stored after this session was built. FastMCP's stateful
 * httpStream transport authenticates once per MCP session and keeps that
 * UserSession for its lifetime, so a Reconnect from the dashboard — another
 * process — writes a new token that a session already open would never read:
 * it would go on sending the revoked one and telling the user to reconnect,
 * which they just did. Re-reading on every call would cost a store round-trip
 * per tool call; on a 401 it costs one, and only when something is wrong.
 * Wired into GitHubClient as `onUnauthorized` by getGitHubClient.
 *
 * Returns true only when the stored token differs from the one that failed, so
 * a genuinely dead credential is not retried. Never throws: a failed lookup
 * leaves the original 401 to be reported.
 */
export async function reloadStoredGitHubToken(session: UserSession | undefined, log: GitHubToolLog): Promise<boolean> {
  const instanceId = session?.githubInstanceId;
  if (!session || !instanceId) return false;
  try {
    const { getMcpConnectionByInstanceId } = await import('../mcpConnectionStore.js');
    const stored = (await getMcpConnectionByInstanceId(instanceId))?.providerTokens as
      { access_token?: string; refresh_token?: string; expiry_date?: number } | undefined;
    if (!stored?.access_token || stored.access_token === session.githubAccessToken) return false;
    session.githubAccessToken = stored.access_token;
    session.githubRefreshToken = stored.refresh_token || undefined;
    session.githubTokenExpiry = stored.expiry_date || undefined;
    log.info(`GitHub token for ${instanceId} was replaced in storage; retrying with it.`);
    return true;
  } catch (err: any) {
    log.error(`Could not reload the stored GitHub token for ${instanceId}: ${err?.message ?? err}`);
    return false;
  }
}
