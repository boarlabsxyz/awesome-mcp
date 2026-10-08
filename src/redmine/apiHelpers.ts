// src/redmine/apiHelpers.ts
// HTTP client + response formatters for the Redmine REST API.
// Docs: https://www.redmine.org/projects/redmine/wiki/Rest_api
//
// Three things about Redmine shape this file:
//
//  1. It is ALWAYS self-hosted. There is no default host, so `baseUrl` is
//     required per connection rather than falling back to an env var.
//  2. There are two credentials. A personal API key goes in `X-Redmine-API-Key`
//     and works on every Redmine version; an OAuth 2.0 access token goes in
//     `Authorization: Bearer` and exists only on Redmine 6.1+. `authMode` picks
//     the header; nothing above this layer cares which was used.
//  3. Collections are paginated with `offset`/`limit` (limit caps at 100) and
//     answer with `total_count`. Every list formatter prints the window it
//     actually returned — a truncated list that doesn't say so reads as "that
//     is everything", which is the failure mode worth spending a line on.

import { UserError } from 'fastmcp';
import { UserSession } from '../userSession.js';
import { stripTrailingSlashes } from '../util/url.js';
import { jsonApiRequest, RedirectRefusedError, type RedirectRefusal } from '../util/jsonApiRequest.js';
import { resolveRedmineAuthMode, type RedmineAuthMode } from './authMode.js';
import { redmineOauthUrls, refreshRedmineToken } from './oauthCallback.js';

export { resolveRedmineAuthMode };
export type { RedmineAuthMode };

const REQUEST_TIMEOUT_MS = 30_000;

/** Redmine caps `limit` at 100 server-side; asking for more silently returns 100. */
export const REDMINE_MAX_LIMIT = 100;
/** Redmine's own default page size when `limit` is omitted. */
export const REDMINE_DEFAULT_LIMIT = 25;

// ==================== Types ====================

/** `{ id, name }` pair Redmine uses for every association. */
export type RedmineRef = { id?: number; name?: string };

/** Pagination envelope fields present on every collection response. */
export type RedminePage = { total_count?: number; offset?: number; limit?: number };

export type RedmineCustomField = { id?: number; name?: string; value?: unknown; multiple?: boolean };

export type RedmineIssue = {
  id?: number;
  project?: RedmineRef;
  tracker?: RedmineRef;
  status?: RedmineRef;
  priority?: RedmineRef;
  author?: RedmineRef;
  assigned_to?: RedmineRef;
  category?: RedmineRef;
  fixed_version?: RedmineRef;
  parent?: { id?: number };
  subject?: string;
  description?: string;
  start_date?: string;
  due_date?: string;
  done_ratio?: number;
  is_private?: boolean;
  estimated_hours?: number | null;
  spent_hours?: number;
  custom_fields?: RedmineCustomField[];
  created_on?: string;
  updated_on?: string;
  closed_on?: string;
  journals?: RedmineJournal[];
  attachments?: RedmineAttachment[];
  relations?: RedmineRelation[];
  children?: RedmineIssue[];
  watchers?: RedmineRef[];
  allowed_statuses?: RedmineRef[];
};

export type RedmineJournal = {
  id?: number;
  user?: RedmineRef;
  notes?: string;
  created_on?: string;
  private_notes?: boolean;
  details?: { property?: string; name?: string; old_value?: string | null; new_value?: string | null }[];
};

export type RedmineAttachment = {
  id?: number;
  filename?: string;
  filesize?: number;
  content_type?: string;
  description?: string;
  content_url?: string;
  author?: RedmineRef;
  created_on?: string;
};

export type RedmineRelation = {
  id?: number;
  issue_id?: number;
  issue_to_id?: number;
  relation_type?: string;
  delay?: number | null;
};

export type RedmineProject = {
  id?: number;
  name?: string;
  identifier?: string;
  description?: string;
  homepage?: string;
  parent?: RedmineRef;
  status?: number;
  is_public?: boolean;
  inherit_members?: boolean;
  created_on?: string;
  updated_on?: string;
  custom_fields?: RedmineCustomField[];
  trackers?: RedmineRef[];
  issue_categories?: RedmineRef[];
  enabled_modules?: RedmineRef[];
  time_entry_activities?: RedmineRef[];
};

export type RedmineUser = {
  id?: number;
  login?: string;
  firstname?: string;
  lastname?: string;
  mail?: string;
  admin?: boolean;
  status?: number;
  created_on?: string;
  last_login_on?: string;
  custom_fields?: RedmineCustomField[];
  memberships?: { project?: RedmineRef; roles?: RedmineRef[] }[];
  groups?: RedmineRef[];
};

export type RedmineTimeEntry = {
  id?: number;
  project?: RedmineRef;
  issue?: { id?: number };
  user?: RedmineRef;
  activity?: RedmineRef;
  hours?: number;
  comments?: string;
  spent_on?: string;
  created_on?: string;
  updated_on?: string;
  custom_fields?: RedmineCustomField[];
};

export type RedmineWikiPage = {
  title?: string;
  parent?: { title?: string };
  text?: string;
  version?: number;
  author?: RedmineRef;
  comments?: string;
  created_on?: string;
  updated_on?: string;
  attachments?: RedmineAttachment[];
};

export type RedmineVersion = {
  id?: number;
  project?: RedmineRef;
  name?: string;
  description?: string;
  status?: string;
  due_date?: string;
  sharing?: string;
  wiki_page_title?: string;
  created_on?: string;
  updated_on?: string;
};

export type RedmineCategory = { id?: number; project?: RedmineRef; name?: string; assigned_to?: RedmineRef };

export type RedmineMembership = {
  id?: number;
  project?: RedmineRef;
  user?: RedmineRef;
  group?: RedmineRef;
  roles?: (RedmineRef & { inherited?: boolean })[];
};

export type RedmineCustomFieldDef = {
  id?: number;
  name?: string;
  customized_type?: string;
  field_format?: string;
  is_required?: boolean;
  is_filter?: boolean;
  possible_values?: ({ value?: string; label?: string } | string)[];
};

export type RedmineSearchResult = {
  id?: number;
  title?: string;
  type?: string;
  url?: string;
  description?: string;
  datetime?: string;
};

/** A collection response, split into its items and its pagination envelope. */
export type RedmineList<T> = { items: T[]; page: RedminePage };

// ==================== Query serialization ====================

export type RedmineQueryValue = string | number | boolean | undefined | null | (string | number)[];
export type RedmineQueryParams = Record<string, RedmineQueryValue>;

/**
 * Append query params onto a URL.
 *
 * Redmine takes multi-valued filters as ONE comma-joined parameter
 * (`issue_id=1,2,3`), not as repeated keys and not as `key[]` — the repeated
 * form is silently ignored, which reads as "the filter matched everything".
 */
export function appendQueryParams(url: URL, query?: RedmineQueryParams): void {
  if (!query) return;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      url.searchParams.set(key, value.join(','));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

/**
 * Merge caller-supplied `cf_<id>` custom-field filters into a query object.
 * Keys that don't look like `cf_<digits>` are dropped rather than forwarded —
 * Redmine ignores unknown filters, so passing one through would quietly widen
 * the result set instead of narrowing it.
 */
export function mergeCustomFieldFilters(
  query: RedmineQueryParams,
  customFields?: Record<string, string>,
): RedmineQueryParams {
  if (!customFields) return query;
  const merged = { ...query };
  for (const [key, value] of Object.entries(customFields)) {
    if (/^cf_\d+$/.test(key)) merged[key] = value;
  }
  return merged;
}

// ==================== Client ====================

/**
 * Paths that are Redmine telling you to sign in, not telling you a resource
 * moved.
 *
 * Following one would answer 200 with an HTML login form, which has no JSON
 * content type and so resolves to `undefined` — a sign-in page reported as an
 * empty result, the worst of the available outcomes. Matched on the PATH only,
 * because Redmine's bounce is `/login?back_url=<the original URL>`: that query
 * string is the one place the original request (and, after the query-param
 * fallback, the key itself) reappears, so it is redacted and reported, never
 * pattern-matched. The alternatives cover the sign-in routes themes and SSO
 * plugins substitute for Redmine's own.
 */
export function isRedmineLoginPath(pathname: string): boolean {
  return /(^|\/)(login|account\/login|signin|sign_in)(\/|$)/i.test(pathname);
}

/**
 * Thin client over the Redmine REST API. One instance per tool call — it holds
 * only a token and a base URL, so construction is free.
 */
export class RedmineClient {
  public readonly baseUrl: string;

  constructor(
    private readonly token: string,
    baseUrl: string,
    private readonly authMode: RedmineAuthMode = 'apiKey',
  ) {
    this.baseUrl = stripTrailingSlashes(baseUrl.trim());
  }

  private authHeaders(): Record<string, string> {
    // An OAuth access token must NOT be sent as X-Redmine-API-Key (Redmine
    // looks that value up as an API key and fails), and vice versa.
    return this.authMode === 'oauth'
      ? { Authorization: `Bearer ${this.token}` }
      : { 'X-Redmine-API-Key': this.token };
  }

  /**
   * One REST call.
   *
   * The redirect handling, the deadline, the `.status`/`.body` tagging and the
   * empty-body handling live in jsonApiRequest — see its header for why each
   * matters. Only Redmine's own concerns stay here: the query-string builder,
   * the dual-mode auth header (which an OAuth connection and an API-key
   * connection must not share), and the login-bounce fallback below.
   *
   * Redirects: up to three SAME-ORIGIN hops are followed. A self-hosted
   * Redmine can sit behind a proxy that rewrites one route — observed on
   * `/time_entries.json`, where every other endpoint answered directly — and
   * refusing at the first hop made that endpoint permanently unusable with a
   * message that named neither the status nor the target. Cross-origin is
   * still never followed and the credential never leaves this instance.
   */
  private send<T>(
    method: string,
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<T> {
    return jsonApiRequest<T>({
      url,
      method,
      headers,
      body,
      timeoutMs: REQUEST_TIMEOUT_MS,
      serviceLabel: 'Redmine API',
      target: `${method} ${this.pathOf(url)}`,
      followSameOriginRedirects: 3,
      isLoginPath: isRedmineLoginPath,
      // The login bounce puts the whole original URL in `back_url`, so once the
      // query-param fallback below has run, the Location itself carries the key.
      secrets: [this.token],
    }) as Promise<T>;
  }

  /** Path + query of an absolute URL, for error text that should not repeat the host. */
  private pathOf(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return url;
    }
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: RedmineQueryParams,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    appendQueryParams(url, query);

    try {
      return await this.send<T>(method, url.toString(), body, this.authHeaders());
    } catch (err: any) {
      const retried = await this.retryPastLoginBounce<T>(method, url, body, err);
      if (retried.handled) return retried.value as T;
      throw retried.error;
    }
  }

  /**
   * One retry past a same-host sign-in bounce, trying the two other ways
   * Redmine accepts an API key.
   *
   * Redmine reads a personal key from `X-Redmine-API-Key`, from a `key` query
   * parameter, and as the HTTP Basic username (`key:x`) — all three
   * documented, all three equivalent. A reverse proxy that strips unknown
   * `X-*` headers on one route therefore breaks only the first, and the symptom
   * is a bounce to `/login` on a host and credential that work everywhere else.
   * Trying the other two turns that into a working call rather than a report.
   *
   * Four deliberate limits:
   *  - Same origin only. A cross-origin bounce is an SSO proxy and gets none of
   *    these; the key would be handed to a host it was never issued for.
   *  - GET only. A write replayed three ways could log the same hours up to
   *    three times, and no diagnostic is worth that.
   *  - API-key mode only. `?key=` and Basic are key presentations; an OAuth
   *    bearer has no equivalent, so there is nothing to fall back to.
   *  - The key goes in a query string on the second attempt, which a proxy or
   *    Redmine access log may record. That is a real cost, accepted only
   *    because the header form has already failed on this exact route.
   */
  private async retryPastLoginBounce<T>(
    method: string,
    url: URL,
    body: unknown,
    error: any,
  ): Promise<{ handled: boolean; value?: T; error?: any }> {
    const redirect: RedirectRefusal | undefined = error?.redirect;
    const eligible =
      error instanceof RedirectRefusedError &&
      redirect?.sameOrigin &&
      redirect.loginBounce &&
      this.authMode === 'apiKey' &&
      method.toUpperCase() === 'GET';
    if (!eligible) return { handled: false, error };

    const withKeyParam = new URL(url.toString());
    withKeyParam.searchParams.set('key', this.token);
    const basic = Buffer.from(`${this.token}:x`).toString('base64');

    // Each attempt ADDS a presentation rather than swapping one in. If a proxy
    // is stripping the header, the extra form is the one that survives; if it is
    // not, keeping the header means the retry is never weaker than the call that
    // just failed. All three carry the same token, so there is nothing to
    // conflict.
    const attempts: ReadonlyArray<{ label: string; url: string; headers: Record<string, string> }> = [
      { label: 'key query parameter', url: withKeyParam.toString(), headers: this.authHeaders() },
      {
        label: 'HTTP Basic',
        url: url.toString(),
        headers: { ...this.authHeaders(), Authorization: `Basic ${basic}` },
      },
    ];

    const failures: string[] = [];
    for (const attempt of attempts) {
      try {
        return { handled: true, value: await this.send<T>(method, attempt.url, body, attempt.headers) };
      } catch (retryErr: any) {
        // A non-redirect failure is Redmine answering for real (403, 404, 422).
        // That is a better error than the bounce, so stop and report it rather
        // than burning the next attempt on a question already answered.
        if (!(retryErr instanceof RedirectRefusedError)) return { handled: false, error: retryErr };
        failures.push(attempt.label);
      }
    }

    const note =
      ` Retried with the ${failures.join(' and then ')} — Redmine bounced those to the sign-in page too, ` +
      'so this is not the auth header being stripped. The route itself is most likely disabled, overridden ' +
      'by a plugin, or behind a proxy rule that requires a session cookie.';
    return { handled: false, error: new RedirectRefusedError(`${error.message}${note}`, redirect!) };
  }

  /** GET a collection and split it into items + pagination envelope. */
  private async list<T>(path: string, key: string, query?: RedmineQueryParams): Promise<RedmineList<T>> {
    const res = await this.request<any>('GET', path, undefined, query);
    const items: T[] = Array.isArray(res?.[key]) ? res[key] : [];
    return {
      items,
      page: { total_count: res?.total_count, offset: res?.offset, limit: res?.limit },
    };
  }

  // ---- Issues ----
  listIssues(query: RedmineQueryParams): Promise<RedmineList<RedmineIssue>> {
    return this.list<RedmineIssue>('/issues.json', 'issues', query);
  }
  getIssue(id: number | string, include?: string[]): Promise<{ issue?: RedmineIssue }> {
    return this.request('GET', `/issues/${encodeURIComponent(String(id))}.json`, undefined, { include });
  }
  createIssue(issue: Record<string, unknown>): Promise<{ issue?: RedmineIssue }> {
    return this.request('POST', '/issues.json', { issue });
  }
  updateIssue(id: number | string, issue: Record<string, unknown>): Promise<void> {
    return this.request('PUT', `/issues/${encodeURIComponent(String(id))}.json`, { issue });
  }
  deleteIssue(id: number | string): Promise<void> {
    return this.request('DELETE', `/issues/${encodeURIComponent(String(id))}.json`);
  }
  addIssueWatcher(id: number | string, userId: number): Promise<void> {
    return this.request('POST', `/issues/${encodeURIComponent(String(id))}/watchers.json`, { user_id: userId });
  }
  removeIssueWatcher(id: number | string, userId: number): Promise<void> {
    return this.request('DELETE', `/issues/${encodeURIComponent(String(id))}/watchers/${userId}.json`);
  }

  // ---- Issue relations ----
  listIssueRelations(issueId: number | string): Promise<RedmineList<RedmineRelation>> {
    return this.list<RedmineRelation>(`/issues/${encodeURIComponent(String(issueId))}/relations.json`, 'relations');
  }
  createIssueRelation(issueId: number | string, relation: Record<string, unknown>): Promise<{ relation?: RedmineRelation }> {
    return this.request('POST', `/issues/${encodeURIComponent(String(issueId))}/relations.json`, { relation });
  }
  deleteIssueRelation(relationId: number | string): Promise<void> {
    return this.request('DELETE', `/relations/${encodeURIComponent(String(relationId))}.json`);
  }

  // ---- Projects ----
  listProjects(query: RedmineQueryParams): Promise<RedmineList<RedmineProject>> {
    return this.list<RedmineProject>('/projects.json', 'projects', query);
  }
  getProject(id: number | string, include?: string[]): Promise<{ project?: RedmineProject }> {
    return this.request('GET', `/projects/${encodeURIComponent(String(id))}.json`, undefined, { include });
  }
  createProject(project: Record<string, unknown>): Promise<{ project?: RedmineProject }> {
    return this.request('POST', '/projects.json', { project });
  }
  updateProject(id: number | string, project: Record<string, unknown>): Promise<void> {
    return this.request('PUT', `/projects/${encodeURIComponent(String(id))}.json`, { project });
  }
  archiveProject(id: number | string): Promise<void> {
    return this.request('PUT', `/projects/${encodeURIComponent(String(id))}/archive.json`);
  }
  unarchiveProject(id: number | string): Promise<void> {
    return this.request('PUT', `/projects/${encodeURIComponent(String(id))}/unarchive.json`);
  }
  deleteProject(id: number | string): Promise<void> {
    return this.request('DELETE', `/projects/${encodeURIComponent(String(id))}.json`);
  }

  // ---- Users ----
  listUsers(query: RedmineQueryParams): Promise<RedmineList<RedmineUser>> {
    return this.list<RedmineUser>('/users.json', 'users', query);
  }
  getUser(id: number | string, include?: string[]): Promise<{ user?: RedmineUser }> {
    return this.request('GET', `/users/${encodeURIComponent(String(id))}.json`, undefined, { include });
  }
  getCurrentUser(include?: string[]): Promise<{ user?: RedmineUser }> {
    return this.request('GET', '/users/current.json', undefined, { include });
  }

  // ---- Time entries ----
  listTimeEntries(query: RedmineQueryParams): Promise<RedmineList<RedmineTimeEntry>> {
    return this.list<RedmineTimeEntry>('/time_entries.json', 'time_entries', query);
  }
  getTimeEntry(id: number | string): Promise<{ time_entry?: RedmineTimeEntry }> {
    return this.request('GET', `/time_entries/${encodeURIComponent(String(id))}.json`);
  }
  createTimeEntry(entry: Record<string, unknown>): Promise<{ time_entry?: RedmineTimeEntry }> {
    return this.request('POST', '/time_entries.json', { time_entry: entry });
  }
  updateTimeEntry(id: number | string, entry: Record<string, unknown>): Promise<void> {
    return this.request('PUT', `/time_entries/${encodeURIComponent(String(id))}.json`, { time_entry: entry });
  }
  deleteTimeEntry(id: number | string): Promise<void> {
    return this.request('DELETE', `/time_entries/${encodeURIComponent(String(id))}.json`);
  }

  // ---- Wiki ----
  listWikiPages(projectId: string): Promise<RedmineList<RedmineWikiPage>> {
    return this.list<RedmineWikiPage>(`/projects/${encodeURIComponent(projectId)}/wiki/index.json`, 'wiki_pages');
  }
  getWikiPage(projectId: string, title: string, version?: number): Promise<{ wiki_page?: RedmineWikiPage }> {
    const base = `/projects/${encodeURIComponent(projectId)}/wiki/${encodeURIComponent(title)}`;
    const path = version ? `${base}/${version}.json` : `${base}.json`;
    return this.request('GET', path, undefined, { include: ['attachments'] });
  }
  updateWikiPage(projectId: string, title: string, page: Record<string, unknown>): Promise<{ wiki_page?: RedmineWikiPage } | void> {
    return this.request('PUT', `/projects/${encodeURIComponent(projectId)}/wiki/${encodeURIComponent(title)}.json`, { wiki_page: page });
  }
  deleteWikiPage(projectId: string, title: string): Promise<void> {
    return this.request('DELETE', `/projects/${encodeURIComponent(projectId)}/wiki/${encodeURIComponent(title)}.json`);
  }

  // ---- Versions ----
  listVersions(projectId: string): Promise<RedmineList<RedmineVersion>> {
    return this.list<RedmineVersion>(`/projects/${encodeURIComponent(projectId)}/versions.json`, 'versions');
  }
  getVersion(id: number | string): Promise<{ version?: RedmineVersion }> {
    return this.request('GET', `/versions/${encodeURIComponent(String(id))}.json`);
  }
  createVersion(projectId: string, version: Record<string, unknown>): Promise<{ version?: RedmineVersion }> {
    return this.request('POST', `/projects/${encodeURIComponent(projectId)}/versions.json`, { version });
  }
  updateVersion(id: number | string, version: Record<string, unknown>): Promise<void> {
    return this.request('PUT', `/versions/${encodeURIComponent(String(id))}.json`, { version });
  }
  deleteVersion(id: number | string): Promise<void> {
    return this.request('DELETE', `/versions/${encodeURIComponent(String(id))}.json`);
  }

  // ---- Issue categories ----
  listIssueCategories(projectId: string): Promise<RedmineList<RedmineCategory>> {
    return this.list<RedmineCategory>(`/projects/${encodeURIComponent(projectId)}/issue_categories.json`, 'issue_categories');
  }
  createIssueCategory(projectId: string, category: Record<string, unknown>): Promise<{ issue_category?: RedmineCategory }> {
    return this.request('POST', `/projects/${encodeURIComponent(projectId)}/issue_categories.json`, { issue_category: category });
  }
  deleteIssueCategory(id: number | string, reassignToId?: number): Promise<void> {
    return this.request('DELETE', `/issue_categories/${encodeURIComponent(String(id))}.json`, undefined, {
      reassign_to_id: reassignToId,
    });
  }

  // ---- Memberships ----
  listMemberships(projectId: string, query: RedmineQueryParams): Promise<RedmineList<RedmineMembership>> {
    return this.list<RedmineMembership>(`/projects/${encodeURIComponent(projectId)}/memberships.json`, 'memberships', query);
  }
  createMembership(projectId: string, membership: Record<string, unknown>): Promise<{ membership?: RedmineMembership }> {
    return this.request('POST', `/projects/${encodeURIComponent(projectId)}/memberships.json`, { membership });
  }
  deleteMembership(id: number | string): Promise<void> {
    return this.request('DELETE', `/memberships/${encodeURIComponent(String(id))}.json`);
  }

  // ---- Lookups (unpaginated: Redmine returns the whole list) ----
  listTrackers(): Promise<RedmineList<RedmineRef>> {
    return this.list<RedmineRef>('/trackers.json', 'trackers');
  }
  listIssueStatuses(): Promise<RedmineList<RedmineRef & { is_closed?: boolean }>> {
    return this.list('/issue_statuses.json', 'issue_statuses');
  }
  listIssuePriorities(): Promise<RedmineList<RedmineRef & { is_default?: boolean }>> {
    return this.list('/enumerations/issue_priorities.json', 'issue_priorities');
  }
  listTimeEntryActivities(): Promise<RedmineList<RedmineRef & { is_default?: boolean }>> {
    return this.list('/enumerations/time_entry_activities.json', 'time_entry_activities');
  }
  listCustomFields(): Promise<RedmineList<RedmineCustomFieldDef>> {
    return this.list<RedmineCustomFieldDef>('/custom_fields.json', 'custom_fields');
  }

  // ---- Search ----
  search(query: RedmineQueryParams): Promise<RedmineList<RedmineSearchResult>> {
    return this.list<RedmineSearchResult>('/search.json', 'results', query);
  }
}

// ==================== Formatting helpers ====================

/** Render an `{ id, name }` association as text, preferring the name. */
function refName(ref?: RedmineRef | null): string {
  if (!ref) return '';
  if (ref.name) return ref.id ? `${ref.name} (#${ref.id})` : ref.name;
  return ref.id ? `#${ref.id}` : '';
}

/**
 * Push `Label: value` onto `parts` unless the value is empty.
 *
 * Deliberately narrower than `unknown`: an object reaching here would render as
 * "[object Object]", which looks like data rather than like a bug.
 */
function pushKV(parts: string[], label: string, value: string | number | null | undefined): void {
  if (value === undefined || value === null || value === '') return;
  parts.push(`${label}: ${value}`);
}

/**
 * Describe the slice of a collection that was actually returned.
 *
 * Redmine caps `limit` at 100, so any list bigger than that comes back cut.
 * Saying so — and naming the exact `offset` that fetches the next page — is
 * what stops a partial answer being reported as the complete one.
 */
export function renderPageLine(page: RedminePage | undefined, shown: number): string | null {
  if (page?.total_count === undefined) {
    return shown > 0 ? `${shown} returned.` : null;
  }
  const total = page.total_count;
  const offset = page.offset ?? 0;
  if (total === 0) return 'Showing 0 of 0.';
  const from = offset + 1;
  const to = offset + shown;
  const more = to < total ? ` — more available; pass offset=${to} to fetch the next page.` : '';
  return `Showing ${from}-${to} of ${total}.${more}`;
}

/**
 * Empty-list message that still carries the pagination context. "No results"
 * and "you paged past the end" are different answers, and only the second one
 * means the caller should go back.
 */
function renderEmptyList(title: string, noun: string, page?: RedminePage): string {
  const offset = page?.offset ?? 0;
  const total = page?.total_count;
  if (total !== undefined && total > 0 && offset >= total) {
    return `# ${title}\n\nNo ${noun} on this page — offset ${offset} is past the end of ${total} total. Lower the offset.`;
  }
  return `No ${noun} found.`;
}

/** Render Redmine custom-field values as `Label: value` lines. */
/**
 * Render one custom-field cell. Redmine types these loosely (string, number,
 * bool, or an array of any of those), so an object is serialized rather than
 * allowed to stringify to "[object Object]" — a silent wrong value reads as
 * data, while visible JSON reads as something to look at.
 */
function stringifyCell(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return JSON.stringify(raw);
}

export function formatCustomFields(fields?: RedmineCustomField[]): string[] {
  if (!Array.isArray(fields) || fields.length === 0) return [];
  const lines: string[] = [];
  for (const field of fields) {
    if (!field?.name) continue;
    const raw = field.value;
    if (raw === undefined || raw === null || raw === '') continue;
    const value = Array.isArray(raw)
      ? raw.filter(v => v !== '' && v !== null && v !== undefined).map(stringifyCell).join(', ')
      : stringifyCell(raw);
    if (!value) continue;
    lines.push(`  ${field.name}: ${value}`);
  }
  return lines;
}

/** Shared shell for list formatters: title, page line, then per-item blocks. */
function renderList<T>(
  title: string,
  noun: string,
  items: T[],
  page: RedminePage | undefined,
  renderItem: (item: T, index: number) => string[],
): string {
  if (items.length === 0) return renderEmptyList(title, noun, page);
  const parts = [`# ${title}`, ''];
  const pageLine = renderPageLine(page, items.length);
  if (pageLine) {
    parts.push(pageLine, '');
  }
  items.forEach((item, index) => {
    parts.push(...renderItem(item, index), '');
  });
  return parts.join('\n').trimEnd();
}

// ==================== Formatters ====================

export function formatIssueList(items: RedmineIssue[], page?: RedminePage): string {
  return renderList('Issues', 'issues', items, page, (issue, i) => {
    const parts = [`## ${i + 1}. #${issue.id ?? '?'} ${issue.subject ?? '(no subject)'}`];
    pushKV(parts, 'Project', refName(issue.project));
    pushKV(parts, 'Tracker', refName(issue.tracker));
    pushKV(parts, 'Status', refName(issue.status));
    pushKV(parts, 'Priority', refName(issue.priority));
    pushKV(parts, 'Assignee', refName(issue.assigned_to) || 'unassigned');
    pushKV(parts, 'Target version', refName(issue.fixed_version));
    pushKV(parts, 'Done', issue.done_ratio !== undefined ? `${issue.done_ratio}%` : '');
    pushKV(parts, 'Due', issue.due_date);
    pushKV(parts, 'Updated', issue.updated_on);
    parts.push(...formatCustomFields(issue.custom_fields));
    return parts;
  });
}

/**
 * The scalar header of an issue: everything that is one key and one value.
 * Split from the association sections below purely so each piece stays small
 * enough to read in one go.
 */
function issueHeaderLines(issue: RedmineIssue): string[] {
  const parts: string[] = [];
  pushKV(parts, 'Project', refName(issue.project));
  pushKV(parts, 'Tracker', refName(issue.tracker));
  pushKV(parts, 'Status', refName(issue.status));
  pushKV(parts, 'Priority', refName(issue.priority));
  pushKV(parts, 'Author', refName(issue.author));
  pushKV(parts, 'Assignee', refName(issue.assigned_to) || 'unassigned');
  pushKV(parts, 'Category', refName(issue.category));
  pushKV(parts, 'Target version', refName(issue.fixed_version));
  pushKV(parts, 'Parent', issue.parent?.id ? `#${issue.parent.id}` : '');
  pushKV(parts, 'Start date', issue.start_date);
  pushKV(parts, 'Due date', issue.due_date);
  pushKV(parts, 'Done', issue.done_ratio !== undefined ? `${issue.done_ratio}%` : '');
  pushKV(parts, 'Estimated hours', issue.estimated_hours ?? '');
  pushKV(parts, 'Spent hours', issue.spent_hours ?? '');
  pushKV(parts, 'Private', issue.is_private ? 'yes' : '');
  pushKV(parts, 'Created', issue.created_on);
  pushKV(parts, 'Updated', issue.updated_on);
  pushKV(parts, 'Closed', issue.closed_on);
  return parts;
}

function subtaskLines(children?: RedmineIssue[]): string[] {
  if (!children?.length) return [];
  return ['', '## Subtasks', '', ...children.map(child => {
    const status = child.status?.name ? ` [${child.status.name}]` : '';
    return `- #${child.id ?? '?'} ${child.subject ?? ''}${status}`;
  })];
}

function relationLines(relations?: RedmineRelation[]): string[] {
  if (!relations?.length) return [];
  return ['', '## Relations', '', ...relations.map(r =>
    `- #${r.id ?? '?'}: issue #${r.issue_id} ${r.relation_type ?? 'relates'} issue #${r.issue_to_id}`)];
}

/** A one-line `Label: a, b, c` for a list of associations, or nothing. */
function refSummaryLines(label: string, refs?: RedmineRef[]): string[] {
  if (!refs?.length) return [];
  return ['', `${label}: ${refs.map(refName).filter(Boolean).join(', ')}`];
}

function attachmentLines(attachments?: RedmineAttachment[]): string[] {
  if (!attachments?.length) return [];
  return ['', '## Attachments', '', ...attachments.map(a => {
    const size = a.filesize !== undefined ? `, ${a.filesize} bytes` : '';
    return `- #${a.id ?? '?'} ${a.filename ?? ''} (${a.content_type ?? 'unknown type'}${size})`;
  })];
}

/** Subtasks, relations, watchers and allowed statuses — each omitted when absent. */
function issueAssociationLines(issue: RedmineIssue): string[] {
  return [
    ...subtaskLines(issue.children),
    ...relationLines(issue.relations),
    ...refSummaryLines('Watchers', issue.watchers),
    // The statuses this issue may legally move to — what updateIssue needs, and
    // not derivable from the global status list, which ignores workflow rules.
    ...refSummaryLines('Allowed next statuses', issue.allowed_statuses),
    ...attachmentLines(issue.attachments),
  ];
}

/** The journal (comment + field-change history) Redmine returns for include=journals. */
function issueHistoryLines(journals?: RedmineJournal[]): string[] {
  if (!journals?.length) return [];
  const parts = ['', '## History', ''];
  for (const journal of journals) {
    const who = refName(journal.user) || 'unknown';
    const privateFlag = journal.private_notes ? ' [private]' : '';
    parts.push(`### ${journal.created_on ?? ''} — ${who}${privateFlag}`);
    for (const detail of journal.details ?? []) {
      const field = detail.name ?? detail.property ?? 'field';
      parts.push(`  - ${field}: ${detail.old_value ?? '(none)'} → ${detail.new_value ?? '(none)'}`);
    }
    if (journal.notes) parts.push('', journal.notes);
    parts.push('');
  }
  return parts;
}

export function formatIssue(issue: RedmineIssue): string {
  const parts = [`# Issue #${issue.id ?? '?'}: ${issue.subject ?? '(no subject)'}`, ''];
  parts.push(...issueHeaderLines(issue));

  const customLines = formatCustomFields(issue.custom_fields);
  if (customLines.length) parts.push('', 'Custom fields:', ...customLines);

  if (issue.description) parts.push('', '## Description', '', issue.description);

  parts.push(...issueAssociationLines(issue), ...issueHistoryLines(issue.journals));

  return parts.join('\n').trimEnd();
}

export function formatProjectList(items: RedmineProject[], page?: RedminePage, requested?: string[]): string {
  return renderList('Projects', 'projects', items, page, (project, i) => {
    const parts = [`## ${i + 1}. ${project.name ?? '(unnamed)'}`];
    pushKV(parts, 'ID', project.id);
    pushKV(parts, 'Identifier', project.identifier);
    pushKV(parts, 'Parent', refName(project.parent));
    pushKV(parts, 'Visibility', visibilityLabel(project.is_public));
    pushKV(parts, 'Status', projectStatusName(project.status));
    pushKV(parts, 'Updated', project.updated_on);
    parts.push(...projectAssociationLines(project, requested));
    return parts;
  });
}

export function formatProject(project: RedmineProject, requested?: string[]): string {
  const parts = [`# Project: ${project.name ?? '(unnamed)'}`, ''];
  pushKV(parts, 'ID', project.id);
  pushKV(parts, 'Identifier', project.identifier);
  pushKV(parts, 'Parent', refName(project.parent));
  pushKV(parts, 'Homepage', project.homepage);
  pushKV(parts, 'Visibility', visibilityLabel(project.is_public));
  pushKV(parts, 'Status', projectStatusName(project.status));
  pushKV(parts, 'Created', project.created_on);
  pushKV(parts, 'Updated', project.updated_on);
  if (project.description) parts.push('', project.description);
  const associations = projectAssociationLines(project, requested);
  if (associations.length) parts.push('', ...associations);
  const customLines = formatCustomFields(project.custom_fields);
  if (customLines.length) parts.push('', 'Custom fields:', ...customLines);
  return parts.join('\n').trimEnd();
}

/**
 * Render one `include`-able association.
 *
 * The `requested` argument is what makes an empty result legible. Redmine
 * filters these by permission, so an association can come back absent for a
 * reason the caller cares about — and a formatter that simply omits the line is
 * indistinguishable from one that forgot to render it. When the caller asked
 * for an association and got nothing, say so explicitly.
 */
function associationLine(
  label: string,
  values: string[],
  key: string,
  requested?: string[],
): string | null {
  if (values.length) return `${label}: ${values.join(', ')}`;
  if (requested?.includes(key)) return `${label}: none visible to this account`;
  return null;
}

/**
 * The association lists `include` can add to a project. Shared by the list and
 * single-project formatters so `include` means the same thing in both —
 * offering the parameter on a tool that then drops the data is worse than not
 * offering it at all.
 */
function projectAssociationLines(project: RedmineProject, requested?: string[]): string[] {
  const names = (refs?: RedmineRef[]) => (refs ?? []).map(refName).filter(Boolean);
  return [
    associationLine('Trackers', names(project.trackers), 'trackers', requested),
    associationLine('Categories', names(project.issue_categories), 'issue_categories', requested),
    associationLine('Modules', (project.enabled_modules ?? []).map(m => m.name ?? '').filter(Boolean), 'enabled_modules', requested),
    associationLine('Time entry activities', names(project.time_entry_activities), 'time_entry_activities', requested),
  ].filter((line): line is string => line !== null);
}

/** Redmine reports visibility as a tri-state: true, false, or absent. */
function visibilityLabel(isPublic?: boolean): string {
  if (isPublic === undefined) return '';
  return isPublic ? 'public' : 'private';
}

/** Redmine encodes project status as an integer; 1/5/9 are the documented values. */
function projectStatusName(status?: number): string {
  if (status === undefined) return '';
  if (status === 1) return 'active';
  if (status === 5) return 'closed';
  if (status === 9) return 'archived';
  return String(status);
}

/** Redmine encodes user status as an integer; 1/2/3 are the documented values. */
function userStatusName(status?: number): string {
  if (status === undefined) return '';
  if (status === 1) return 'active';
  if (status === 2) return 'registered';
  if (status === 3) return 'locked';
  return String(status);
}

function fullName(user?: RedmineUser): string {
  if (!user) return '';
  return [user.firstname, user.lastname].filter(Boolean).join(' ') || user.login || `#${user.id ?? '?'}`;
}

export function formatUserList(items: RedmineUser[], page?: RedminePage): string {
  return renderList('Users', 'users', items, page, (user, i) => {
    const parts = [`## ${i + 1}. ${fullName(user)}`];
    pushKV(parts, 'ID', user.id);
    pushKV(parts, 'Login', user.login);
    pushKV(parts, 'Email', user.mail);
    pushKV(parts, 'Status', userStatusName(user.status));
    pushKV(parts, 'Admin', user.admin ? 'yes' : '');
    pushKV(parts, 'Last login', user.last_login_on);
    return parts;
  });
}

export function formatUser(user: RedmineUser, requested?: string[]): string {
  const parts = [`# User: ${fullName(user)}`, ''];
  pushKV(parts, 'ID', user.id);
  pushKV(parts, 'Login', user.login);
  pushKV(parts, 'Email', user.mail);
  pushKV(parts, 'Status', userStatusName(user.status));
  pushKV(parts, 'Admin', user.admin ? 'yes' : 'no');
  pushKV(parts, 'Created', user.created_on);
  pushKV(parts, 'Last login', user.last_login_on);
  const customLines = formatCustomFields(user.custom_fields);
  if (customLines.length) parts.push('', 'Custom fields:', ...customLines);
  const groupsLine = associationLine('Groups', (user.groups ?? []).map(refName).filter(Boolean), 'groups', requested);
  if (groupsLine) parts.push('', groupsLine);

  if (user.memberships?.length) {
    parts.push('', '## Project memberships', '');
    for (const membership of user.memberships) {
      const roles = (membership.roles ?? []).map(r => r.name ?? '').filter(Boolean).join(', ');
      const roleSuffix = roles ? ` — ${roles}` : '';
      parts.push(`- ${refName(membership.project)}${roleSuffix}`);
    }
  } else if (requested?.includes('memberships')) {
    parts.push('', 'Project memberships: none visible to this account');
  }
  return parts.join('\n').trimEnd();
}

/**
 * How a complete scan is described, when one was run.
 *
 * Present only for `allPages`. Without it the hours line has to say "on this
 * page", because that is all one response can honestly support.
 */
export interface TimeEntryScanContext {
  scanned: {
    /** Redmine's own `total_count`, when it reported one. */
    total?: number;
    /** The scan stopped at the ceiling, so the total below is a floor. */
    truncated: boolean;
    ceiling: number;
  };
  /**
   * Set when the workspace-wide route failed and the entries were collected
   * project by project instead. Reported because that scan covers only the
   * projects visible on the first page of the project list, so its total is a
   * floor for a second, different reason.
   */
  perProject?: {
    scanned: number;
    total?: number;
    failed: string[];
    reason: string;
  };
}

export function formatTimeEntryList(
  items: RedmineTimeEntry[],
  page?: RedminePage,
  scan?: TimeEntryScanContext,
): string {
  const total = items.reduce((sum, entry) => sum + (typeof entry.hours === 'number' ? entry.hours : 0), 0);
  const body = renderList('Time entries', 'time entries', items, page, (entry, i) => {
    const parts = [`## ${i + 1}. ${entry.hours ?? 0}h on ${entry.spent_on ?? '(no date)'}`];
    pushKV(parts, 'ID', entry.id);
    pushKV(parts, 'Project', refName(entry.project));
    pushKV(parts, 'Issue', entry.issue?.id ? `#${entry.issue.id}` : '');
    pushKV(parts, 'User', refName(entry.user));
    pushKV(parts, 'Activity', refName(entry.activity));
    pushKV(parts, 'Comments', entry.comments);
    return parts;
  });

  const notes = scanNotes(items.length, scan);
  if (items.length === 0) return notes.length ? `${body}\n\n${notes.join('\n')}` : body;

  const hoursLabel = scan
    ? scan.scanned.truncated || scan.perProject
      ? `Hours across the ${items.length} entries scanned (a FLOOR, not a total — see the note below)`
      : `Hours across all ${items.length} entries`
    : 'Hours on this page';
  const rounded = Math.round(total * 100) / 100;
  // Without a scan the sum covers THIS PAGE only; renderPageLine above says how
  // much of the set that is, so the two lines together never imply a total they
  // didn't add. With one, the label says what was actually summed.
  const tail = notes.length ? `\n\n${notes.join('\n')}` : '';
  return `${body}\n\n${hoursLabel}: ${rounded}${tail}`;
}

/** The lines that stop a bounded scan from reading as a complete one. */
function scanNotes(returned: number, scan?: TimeEntryScanContext): string[] {
  if (!scan) {
    return returned > 0
      ? ['Note: that sum is this page only. Set allPages=true to total the whole result set.']
      : [];
  }
  const notes: string[] = [];
  if (scan.scanned.truncated) {
    notes.push(
      `⚠ The scan stopped at the ${scan.scanned.ceiling}-entry ceiling${typeof scan.scanned.total === 'number' ? ` (Redmine reported ${scan.scanned.total} matching entries in total)` : ''}. ` +
      'Narrow the window with from/to, projectId or userId and run it again — any per-person total from this response is incomplete.',
    );
  }
  if (scan.perProject) {
    const { scanned, total, failed, reason } = scan.perProject;
    notes.push(
      `⚠ The workspace-wide time-entry list did not work on this instance, so this was collected project by ` +
      `project instead: ${scanned} project(s) scanned${typeof total === 'number' && total > scanned ? ` of ${total} in the workspace — the rest were NOT scanned` : ''}. ` +
      `Reason the global list failed: ${reason}`,
    );
    if (failed.length) {
      notes.push(
        `⚠ ${failed.length} project(s) could not be read and contribute 0 to the total above: ${failed.slice(0, 10).join(', ')}` +
        `${failed.length > 10 ? `, …and ${failed.length - 10} more` : ''}.`,
      );
    }
  }
  return notes;
}

export function formatTimeEntry(entry: RedmineTimeEntry): string {
  const parts = [`# Time entry #${entry.id ?? '?'}`, ''];
  pushKV(parts, 'Hours', entry.hours);
  pushKV(parts, 'Spent on', entry.spent_on);
  pushKV(parts, 'Project', refName(entry.project));
  pushKV(parts, 'Issue', entry.issue?.id ? `#${entry.issue.id}` : '');
  pushKV(parts, 'User', refName(entry.user));
  pushKV(parts, 'Activity', refName(entry.activity));
  pushKV(parts, 'Comments', entry.comments);
  pushKV(parts, 'Created', entry.created_on);
  pushKV(parts, 'Updated', entry.updated_on);
  parts.push(...formatCustomFields(entry.custom_fields));
  return parts.join('\n').trimEnd();
}

export function formatWikiPageList(items: RedmineWikiPage[], page?: RedminePage): string {
  return renderList('Wiki pages', 'wiki pages', items, page, (wiki, i) => {
    const parts = [`## ${i + 1}. ${wiki.title ?? '(untitled)'}`];
    pushKV(parts, 'Version', wiki.version);
    pushKV(parts, 'Parent', wiki.parent?.title);
    pushKV(parts, 'Updated', wiki.updated_on);
    return parts;
  });
}

export function formatWikiPage(wiki: RedmineWikiPage): string {
  const parts = [`# Wiki page: ${wiki.title ?? '(untitled)'}`, ''];
  pushKV(parts, 'Version', wiki.version);
  pushKV(parts, 'Parent', wiki.parent?.title);
  pushKV(parts, 'Author', refName(wiki.author));
  pushKV(parts, 'Comments', wiki.comments);
  pushKV(parts, 'Created', wiki.created_on);
  pushKV(parts, 'Updated', wiki.updated_on);
  if (wiki.attachments?.length) {
    const names = wiki.attachments.map(a => a.filename ?? `#${a.id}`).join(', ');
    parts.push('', `Attachments: ${names}`);
  }
  if (wiki.text) parts.push('', '## Content', '', wiki.text);
  return parts.join('\n').trimEnd();
}

export function formatVersionList(items: RedmineVersion[], page?: RedminePage): string {
  return renderList('Versions', 'versions', items, page, (version, i) => {
    const parts = [`## ${i + 1}. ${version.name ?? '(unnamed)'}`];
    pushKV(parts, 'ID', version.id);
    pushKV(parts, 'Status', version.status);
    pushKV(parts, 'Due date', version.due_date);
    pushKV(parts, 'Sharing', version.sharing);
    pushKV(parts, 'Project', refName(version.project));
    return parts;
  });
}

export function formatVersion(version: RedmineVersion): string {
  const parts = [`# Version: ${version.name ?? '(unnamed)'}`, ''];
  pushKV(parts, 'ID', version.id);
  pushKV(parts, 'Project', refName(version.project));
  pushKV(parts, 'Status', version.status);
  pushKV(parts, 'Due date', version.due_date);
  pushKV(parts, 'Sharing', version.sharing);
  pushKV(parts, 'Wiki page', version.wiki_page_title);
  pushKV(parts, 'Created', version.created_on);
  pushKV(parts, 'Updated', version.updated_on);
  if (version.description) parts.push('', version.description);
  return parts.join('\n').trimEnd();
}

export function formatCategoryList(items: RedmineCategory[], page?: RedminePage): string {
  return renderList('Issue categories', 'issue categories', items, page, (category, i) => {
    const parts = [`## ${i + 1}. ${category.name ?? '(unnamed)'}`];
    pushKV(parts, 'ID', category.id);
    pushKV(parts, 'Project', refName(category.project));
    pushKV(parts, 'Assigned to', refName(category.assigned_to));
    return parts;
  });
}

export function formatMembershipList(items: RedmineMembership[], page?: RedminePage): string {
  return renderList('Project members', 'members', items, page, (membership, i) => {
    const who = refName(membership.user) || refName(membership.group) || '(unknown)';
    const kind = membership.group ? 'group' : 'user';
    const parts = [`## ${i + 1}. ${who} [${kind}]`];
    pushKV(parts, 'Membership ID', membership.id);
    // Redmine lists a role twice when it is held both directly and by
    // inheritance, and pads some names; dedupe on the rendered label so the
    // output does not repeat itself.
    const roles = [...new Set(
      (membership.roles ?? [])
        .map(r => {
          const name = (r.name ?? '').trim() || `#${r.id}`;
          return r.inherited ? `${name} (inherited)` : name;
        })
        .filter(label => label && label !== '#undefined'),
    )].join(', ');
    pushKV(parts, 'Roles', roles);
    return parts;
  });
}

export function formatRelationList(items: RedmineRelation[], page?: RedminePage): string {
  return renderList('Issue relations', 'relations', items, page, (relation, i) => {
    const parts = [`## ${i + 1}. Relation #${relation.id ?? '?'}`];
    pushKV(parts, 'From', relation.issue_id ? `#${relation.issue_id}` : '');
    pushKV(parts, 'Type', relation.relation_type);
    pushKV(parts, 'To', relation.issue_to_id ? `#${relation.issue_to_id}` : '');
    pushKV(parts, 'Delay', relation.delay ?? '');
    return parts;
  });
}

/** Trackers, statuses, priorities and activities all render as id + name + flags. */
export function formatRefList(
  title: string,
  noun: string,
  items: (RedmineRef & { is_closed?: boolean; is_default?: boolean })[],
  page?: RedminePage,
): string {
  return renderList(title, noun, items, page, (ref, i) => {
    const flags = [ref.is_default ? 'default' : '', ref.is_closed ? 'closed status' : ''].filter(Boolean);
    const flagSuffix = flags.length ? ` [${flags.join(', ')}]` : '';
    return [`${i + 1}. ${ref.name ?? '(unnamed)'} — ID: ${ref.id ?? '?'}${flagSuffix}`];
  });
}

export function formatCustomFieldDefList(items: RedmineCustomFieldDef[], page?: RedminePage): string {
  return renderList('Custom fields', 'custom fields', items, page, (field, i) => {
    const parts = [`## ${i + 1}. ${field.name ?? '(unnamed)'}`];
    pushKV(parts, 'ID', field.id);
    // The filter key is the actionable part: it is what listIssues takes.
    pushKV(parts, 'Filter key', field.is_filter && field.id ? `cf_${field.id}` : '(not filterable)');
    pushKV(parts, 'Applies to', field.customized_type);
    pushKV(parts, 'Format', field.field_format);
    pushKV(parts, 'Required', field.is_required ? 'yes' : '');
    const values = (field.possible_values ?? [])
      .map(v => (typeof v === 'string' ? v : v?.value ?? ''))
      .filter(Boolean);
    if (values.length) pushKV(parts, 'Possible values', values.join(', '));
    return parts;
  });
}

export function formatSearchResults(items: RedmineSearchResult[], page?: RedminePage): string {
  return renderList('Search results', 'results', items, page, (result, i) => {
    const parts = [`## ${i + 1}. ${result.title ?? '(untitled)'}`];
    pushKV(parts, 'Type', result.type);
    pushKV(parts, 'ID', result.id);
    pushKV(parts, 'URL', result.url);
    pushKV(parts, 'When', result.datetime);
    if (result.description) parts.push(`  ${result.description}`);
    return parts;
  });
}

// ==================== Session + error helpers ====================

export type RedmineToolLog = {
  info: (msg: string) => void;
  error: (msg: string) => void;
};

/**
 * Build a client from the session. Both auth flows land here: OAuth
 * connections carry a refresh token and expiry, paste-token connections do
 * not, and `authMode` is derived from that rather than stored separately.
 */
export function getRedmineClient(session?: UserSession): RedmineClient {
  if (!session?.redmineAccessToken) {
    throw new UserError('Redmine not connected. Visit the dashboard to connect your Redmine account.');
  }
  if (!session.redmineBaseUrl) {
    // No default is possible — Redmine is self-hosted, so a missing base URL
    // is a broken connection, not something to paper over with a guess.
    throw new UserError('Redmine connection is missing its instance URL. Reconnect from the dashboard and enter your Redmine URL.');
  }
  const authMode = resolveRedmineAuthMode(session.redmineAuthMode, !!session.redmineRefreshToken);
  return new RedmineClient(session.redmineAccessToken, session.redmineBaseUrl, authMode);
}

/** Pull Redmine's `{"errors":[...]}` validation list out of an error body. */
/** How many of Redmine's validation errors a 422 message renders. */
const REDMINE_VALIDATION_ERRORS_SHOWN = 10;

function redmineValidationErrors(body: unknown): string[] {
  if (typeof body !== 'string' || !body.trim()) return [];
  try {
    const parsed = JSON.parse(body) as { errors?: unknown };
    if (!Array.isArray(parsed?.errors)) return [];
    return parsed.errors.map(String).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Translate a thrown client error into a `UserError` the model can act on.
 *
 * The 401/403 split is the important part. Redmine answers a disabled REST API
 * with 403 (since 4.1; older versions used 401, indistinguishable from a bad
 * key), so a bare "check your credentials" would send the user to regenerate a
 * key when an administrator setting is what actually blocks them.
 */
/** Extra context a caller can attach to the generic denial message. */
export interface RedmineErrorHints {
  /**
   * Named when a 403 is expected to mean "not an administrator" rather than
   * "no permission on this project" — Redmine uses the same status for both,
   * and the generic wording sends people to check project rights they cannot
   * change.
   */
  adminOnly?: boolean;
  /**
   * The Redmine permission that governs this endpoint, when it is unambiguous.
   * Naming it turns "you lack some permission" into something a project admin
   * can actually grant. Left unset rather than guessed where Redmine's mapping
   * is not clear-cut.
   */
  permission?: string;
}

/**
 * A refused redirect, rendered with the target named.
 *
 * This used to fall through `describeTransportFailure` below as a bare
 * "fetch failed" and produce one paragraph of guesses for all four causes —
 * which is why `/time_entries.json` on one instance was unusable for as long
 * as it was: the message could not distinguish a proxy rewrite from an SSO hop
 * from a login bounce from a wrong base URL, so there was nothing to act on.
 * The three branches here are the three different fixes.
 */
function describeRefusedRedirect(prefix: string, baseUrlHint: string, error: any): string | null {
  if (!(error instanceof RedirectRefusedError)) return null;
  const r = error.redirect;
  if (!r.sameOrigin) {
    return (
      `${prefix}: ${baseUrlHint} answered HTTP ${r.status} and redirected to a DIFFERENT host ` +
      `(${r.host ?? 'unparseable Location'}). The API key was NOT sent there — it is only valid for the ` +
      'instance you connected. An SSO or access proxy (Cloudflare Access, oauth2-proxy) in front of Redmine ' +
      'looks exactly like this, and it needs its own credential; this MCP cannot authenticate to it.'
    );
  }
  if (r.loginBounce) {
    return (
      `${prefix}: ${baseUrlHint} answered HTTP ${r.status} and bounced this request to ${r.path} on the same ` +
      'host, while the host, base URL and credential are otherwise fine. So the credential was rejected on ' +
      `this one route. ${error.message.includes('Retried with') ? 'All three ways Redmine accepts an API key were tried. ' : ''}` +
      'Check whether a plugin overrides this route, whether a proxy rule on this path requires a session ' +
      'cookie, and whether the module is enabled for the project.'
    );
  }
  return (
    `${prefix}: ${baseUrlHint} answered HTTP ${r.status} and kept redirecting to ${r.path} on the same host ` +
    `after ${r.hopsFollowed} hop(s). Same-origin redirects are followed, so this is a redirect loop rather ` +
    'than a relocation — most likely a proxy rewrite rule pointing at itself.'
  );
}

/**
 * A thrown fetch (as opposed to a rejected response) carries no status, and
 * undici reports every one of them as the bare string "fetch failed". That is
 * undiagnosable, so unwrap the cause and name the case that actually happens:
 * an unreachable host. Redirects no longer arrive here — they are a typed
 * error with a target, handled above.
 */
function describeTransportFailure(prefix: string, baseUrlHint: string, error: any): string | null {
  if (error?.status !== undefined) return null;
  const message = String(error?.message ?? '');
  const cause = String(error?.cause?.message ?? error?.cause?.code ?? '');
  if (!/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|certificate|redirect|socket/i.test(`${message} ${cause}`)) {
    return null;
  }
  return (
    `${prefix}: could not reach ${baseUrlHint} (${cause || message}). The Redmine host, its TLS certificate, ` +
    'or the network path is the problem here — the credential was never evaluated.'
  );
}

export function mapRedmineError(
  prefix: string,
  error: any,
  log: RedmineToolLog,
  hints: RedmineErrorHints = {},
  baseUrlHint = 'the Redmine instance',
): never {
  log.error(`${prefix}: ${error?.message ?? error}${error?.cause ? ` (cause: ${error.cause?.message ?? error.cause})` : ''}`);
  const status = error?.status;

  // Before the status branches below: a RedirectRefusedError carries .status
  // 502 so the REST plane answers sensibly, and 502 is not a case any of them
  // handle — it would otherwise fall through to the generic tail and lose the
  // target that is the entire point of the error.
  const redirected = describeRefusedRedirect(prefix, baseUrlHint, error);
  if (redirected) throw new UserError(redirected);

  const transport = describeTransportFailure(prefix, baseUrlHint, error);
  if (transport) throw new UserError(transport);

  if (status === 401) {
    throw new UserError(
      `${prefix}: Redmine rejected the credential. Reconnect from the dashboard. ` +
      'On Redmine older than 4.1 this response also means the REST API is disabled ' +
      '(Administration → Settings → API).',
    );
  }
  if (status === 403) {
    throw new UserError(
      hints.adminOnly
        ? `${prefix}: this endpoint is administrator-only in Redmine, and the connected account is not an ` +
          'administrator. No project-level permission grants it — an admin has to run this, or grant the ' +
          'account admin rights.'
        : `${prefix}: Redmine denied access. The connected account lacks the ` +
          `${hints.permission ? `\`${hints.permission}\` permission` : 'required permission'} ` +
          'on this project — a project or site admin grants it under Administration → Roles and permissions, ' +
          'or by adding the account to the project with a role that has it. ' +
          '(403 is also what a fully disabled REST API returns, but that would fail every Redmine call, not ' +
          'just this one — so if other Redmine tools are answering, this is permissions.)',
    );
  }
  if (status === 404) {
    throw new UserError(`${prefix}: not found. Check the ID or identifier — Redmine also answers 404 for records you are not allowed to see.`);
  }
  if (status === 422) {
    const errors = redmineValidationErrors(error?.body);
    // Capped: a bulk write against a mis-mapped tracker can be rejected with a
    // very long error list, and joining all of it puts the whole thing in a
    // message that is both logged and shown. The first few name the problem;
    // the count tells the reader there is more.
    const shown = errors.slice(0, REDMINE_VALIDATION_ERRORS_SHOWN);
    const rest = errors.length - shown.length;
    const detail = rest > 0 ? `${shown.join('; ')} (and ${rest} more)` : shown.join('; ');
    throw new UserError(
      errors.length
        ? `${prefix}: Redmine rejected the values — ${detail}`
        : `${prefix}: Redmine rejected the values (422). Check required fields for this tracker or project.`,
    );
  }
  if (status === 429) {
    throw new UserError(`${prefix}: rate limited by Redmine. Retry later.`);
  }
  throw new UserError(`${prefix}: ${error?.message ?? 'Unknown error'}`);
}

// ---- OAuth token refresh (no-op for paste-token connections) ----

/** Refresh this far before the recorded expiry, so an in-flight call doesn't race it. */
const REDMINE_REFRESH_SKEW_MS = 60_000;

const inflightRedmineRefreshById = new Map<string, Promise<void>>();
const inflightRedmineRefreshBySession = new WeakMap<UserSession, Promise<void>>();

/**
 * Refresh the OAuth access token when it is at or near expiry. Single-flight
 * per connection so concurrent tool calls don't each spend a grant — and,
 * more importantly, don't race to spend the SAME rotating refresh token, which
 * would invalidate the connection.
 */
export async function maybeRefreshRedmineToken(
  session: UserSession | undefined,
  log: RedmineToolLog,
): Promise<void> {
  if (!session) return;
  const expiry = session.redmineTokenExpiry;
  // Only OAuth connections carry all of these; paste-token sessions skip out here.
  if (!expiry || !session.redmineRefreshToken || !session.redmineOauthClientId || !session.redmineOauthClientSecret) {
    return;
  }
  if (Date.now() < expiry - REDMINE_REFRESH_SKEW_MS) return;

  const instanceId = session.redmineInstanceId;
  const existing = instanceId
    ? inflightRedmineRefreshById.get(instanceId)
    : inflightRedmineRefreshBySession.get(session);
  if (existing) {
    await existing;
    return;
  }

  const refresh = performRedmineRefresh(session, log).finally(() => {
    if (instanceId) inflightRedmineRefreshById.delete(instanceId);
    else inflightRedmineRefreshBySession.delete(session);
  });
  if (instanceId) inflightRedmineRefreshById.set(instanceId, refresh);
  else inflightRedmineRefreshBySession.set(session, refresh);
  await refresh;
}

/**
 * Perform the refresh_token exchange, update the session in place, and persist.
 * Never throws (best-effort) so single-flight awaiters always resolve cleanly —
 * a failed refresh falls through to the existing token, which may still work.
 *
 * Redmine/Doorkeeper ROTATES refresh tokens, so the new one is written back
 * whenever the response carries it. Keeping the old one after a rotation is
 * what silently kills the connection on the call after next.
 */
async function performRedmineRefresh(session: UserSession, log: RedmineToolLog): Promise<void> {
  const refreshToken = session.redmineRefreshToken;
  const clientId = session.redmineOauthClientId;
  const clientSecret = session.redmineOauthClientSecret;
  const baseUrl = session.redmineBaseUrl;
  if (!refreshToken || !clientId || !clientSecret || !baseUrl) return;

  const { tokenUrl } = redmineOauthUrls(baseUrl);
  const result = await refreshRedmineToken({ tokenUrl, refreshToken, clientId, clientSecret });
  if (!result.ok) {
    log.error(`Redmine token refresh failed (${result.status}); using existing token. ${result.logMessage}`);
    return;
  }

  const newRefresh = result.refreshToken ?? refreshToken;
  const newExpiry = result.expiresIn ? Date.now() + result.expiresIn * 1000 : undefined;
  session.redmineAccessToken = result.accessToken;
  session.redmineRefreshToken = newRefresh;
  session.redmineTokenExpiry = newExpiry;

  const instanceId = session.redmineInstanceId;
  if (instanceId) {
    try {
      const { updateMcpInstanceProviderTokens } = await import('../mcpConnectionStore.js');
      await updateMcpInstanceProviderTokens(instanceId, {
        access_token: result.accessToken,
        refresh_token: newRefresh,
        expiry_date: newExpiry,
        baseUrl: session.redmineBaseUrl,
        // Carried through explicitly: a refresh that dropped this would leave
        // the row looking like a pasted API key.
        authMode: 'oauth',
      } as any);
    } catch (err: any) {
      log.error(`Failed to persist refreshed Redmine tokens for ${instanceId}: ${err?.message ?? err}`);
    }
  }
}

/**
 * Wrap a tool body with the standard refresh + client-fetch + error-mapping
 * pattern. `getRedmineClient` runs BEFORE the callback so a missing token or
 * base URL is surfaced verbatim rather than being re-wrapped by mapRedmineError.
 */
export async function withRedmineClient<T>(
  prefix: string,
  session: UserSession | undefined,
  log: RedmineToolLog,
  fn: (client: RedmineClient) => Promise<T>,
  hints: RedmineErrorHints = {},
): Promise<T> {
  await maybeRefreshRedmineToken(session, log);
  const client = getRedmineClient(session);
  try {
    return await fn(client);
  } catch (error: any) {
    if (error instanceof UserError) throw error;
    mapRedmineError(prefix, error, log, hints, client.baseUrl);
  }
}
