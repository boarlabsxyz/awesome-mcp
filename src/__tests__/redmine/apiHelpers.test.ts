// src/__tests__/redmine/apiHelpers.test.ts
// Exercises the RedmineClient request layer against a stubbed global fetch,
// plus the session/refresh helpers around it.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { UserError } from 'fastmcp';

import {
  RedmineClient,
  getRedmineClient,
  maybeRefreshRedmineToken,
  withRedmineClient,
} from '../../redmine/apiHelpers.js';
import { resolveRedmineAuthMode } from '../../redmine/authMode.js';
import type { UserSession } from '../../userSession.js';

const BASE = 'https://redmine.example.com';
const log = { info: () => {}, error: () => {} };

type Recorded = { url: string; init: RequestInit };
let recorded: Recorded[] = [];
let respond: (url: string, init: RequestInit) => { status?: number; json?: unknown; text?: string; contentType?: string | null };
const realFetch = globalThis.fetch;

beforeEach(() => {
  recorded = [];
  respond = () => ({ status: 200, json: {} });
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    recorded.push({ url, init });
    const r = respond(url, init);
    const status = r.status ?? 200;
    const contentType = r.contentType === undefined ? 'application/json' : r.contentType;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
      json: async () => r.json,
      text: async () => r.text ?? (r.json ? JSON.stringify(r.json) : ''),
    } as any as Response;
  }) as any;
});

afterEach(() => { globalThis.fetch = realFetch; });

// ---------------------------------------------------------------------------
// Request layer
// ---------------------------------------------------------------------------

describe('RedmineClient.request', () => {
  test('sends X-Redmine-API-Key for a pasted key and never a bearer', async () => {
    const client = new RedmineClient('KEY', BASE, 'apiKey');
    await client.getCurrentUser();
    const headers = recorded[0].init.headers as Record<string, string>;
    assert.equal(headers['X-Redmine-API-Key'], 'KEY');
    assert.equal(headers.Authorization, undefined);
  });

  // The two credentials are not interchangeable: Redmine looks an
  // X-Redmine-API-Key value up as an API key and rejects an OAuth token.
  test('sends a bearer for OAuth and never the API-key header', async () => {
    const client = new RedmineClient('TOK', BASE, 'oauth');
    await client.getCurrentUser();
    const headers = recorded[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer TOK');
    assert.equal(headers['X-Redmine-API-Key'], undefined);
  });

  // Node's fetch keeps custom headers across an origin change, so following a
  // redirect would hand X-Redmine-API-Key to the Location host.
  test('refuses to follow redirects', async () => {
    const client = new RedmineClient('KEY', BASE);
    await client.getCurrentUser();
    assert.equal(recorded[0].init.redirect, 'error');
  });

  test('strips trailing slashes from the base URL', async () => {
    const client = new RedmineClient('KEY', `${BASE}///`);
    assert.equal(client.baseUrl, BASE);
    await client.getCurrentUser();
    assert.ok(recorded[0].url.startsWith(`${BASE}/users/current.json`));
  });

  test('joins array filters with commas rather than repeating the key', async () => {
    const client = new RedmineClient('KEY', BASE);
    await client.listIssues({ issue_id: [1, 2, 3], project_id: 'p' });
    const url = new URL(recorded[0].url);
    assert.equal(url.searchParams.get('issue_id'), '1,2,3');
    assert.equal(url.searchParams.getAll('issue_id').length, 1);
  });

  test('returns undefined for 204 and for a non-JSON body', async () => {
    const client = new RedmineClient('KEY', BASE);
    respond = () => ({ status: 204 });
    assert.equal(await client.deleteIssue(1), undefined);
    respond = () => ({ status: 200, contentType: 'text/html', text: '<html>' });
    assert.equal(await client.getCurrentUser(), undefined);
  });

  // The status and body are what mapRedmineError branches on, so they must
  // survive the throw.
  test('stashes status and body on the thrown error', async () => {
    const client = new RedmineClient('KEY', BASE);
    respond = () => ({ status: 422, text: '{"errors":["Subject cannot be blank"]}' });
    await assert.rejects(
      () => client.createIssue({ subject: '' }),
      (err: any) => {
        assert.equal(err.status, 422);
        assert.match(err.body, /Subject cannot be blank/);
        return true;
      },
    );
  });

  test('a timeout surfaces as an explicit timeout error', async () => {
    const client = new RedmineClient('KEY', BASE);
    globalThis.fetch = (async () => {
      const err: any = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }) as any;
    await assert.rejects(() => client.getCurrentUser(), /timed out after 30000ms/);
  });

  test('splits a collection into items and the pagination envelope', async () => {
    const client = new RedmineClient('KEY', BASE);
    respond = () => ({ status: 200, json: { issues: [{ id: 1 }], total_count: 90, offset: 25, limit: 25 } });
    const res = await client.listIssues({});
    assert.deepEqual(res.items, [{ id: 1 }]);
    assert.deepEqual(res.page, { total_count: 90, offset: 25, limit: 25 });
  });

  test('a collection response missing its array yields an empty list, not a crash', async () => {
    const client = new RedmineClient('KEY', BASE);
    respond = () => ({ status: 200, json: { total_count: 0 } });
    assert.deepEqual((await client.listIssues({})).items, []);
  });
});

describe('RedmineClient routes', () => {
  const client = () => new RedmineClient('KEY', BASE);
  const lastCall = () => ({ url: new URL(recorded[0].url), method: recorded[0].init.method });

  test('issue, project and time-entry routes use the documented paths', async () => {
    await client().getIssue(7);
    assert.equal(lastCall().url.pathname, '/issues/7.json');

    recorded = [];
    await client().updateIssue(7, { subject: 'x' });
    assert.equal(lastCall().method, 'PUT');
    assert.equal(lastCall().url.pathname, '/issues/7.json');

    recorded = [];
    await client().archiveProject('plat');
    assert.equal(lastCall().method, 'PUT');
    assert.equal(lastCall().url.pathname, '/projects/plat/archive.json');

    recorded = [];
    await client().listTimeEntries({ project_id: 'p' });
    assert.equal(lastCall().url.pathname, '/time_entries.json');
  });

  test('wiki, version, category and membership routes are project-scoped where Redmine requires it', async () => {
    await client().listWikiPages('plat');
    assert.equal(lastCall().url.pathname, '/projects/plat/wiki/index.json');

    recorded = [];
    await client().getWikiPage('plat', 'Release Process', 2);
    assert.equal(lastCall().url.pathname, '/projects/plat/wiki/Release%20Process/2.json');

    recorded = [];
    await client().createVersion('plat', { name: '2.1' });
    assert.equal(lastCall().method, 'POST');
    assert.equal(lastCall().url.pathname, '/projects/plat/versions.json');

    recorded = [];
    await client().deleteMembership(9);
    assert.equal(lastCall().method, 'DELETE');
    assert.equal(lastCall().url.pathname, '/memberships/9.json');
  });

  test('enumerations and search sit on their own paths', async () => {
    await client().listIssuePriorities();
    assert.equal(lastCall().url.pathname, '/enumerations/issue_priorities.json');

    recorded = [];
    await client().listTimeEntryActivities();
    assert.equal(lastCall().url.pathname, '/enumerations/time_entry_activities.json');

    recorded = [];
    await client().search({ q: 'login' });
    assert.equal(lastCall().url.pathname, '/search.json');
    assert.equal(lastCall().url.searchParams.get('q'), 'login');
  });

  test('deleteIssueCategory passes reassign_to_id as a query param', async () => {
    await client().deleteIssueCategory(3, 4);
    assert.equal(lastCall().url.searchParams.get('reassign_to_id'), '4');
  });
});

// ---------------------------------------------------------------------------
// Session + error mapping
// ---------------------------------------------------------------------------

describe('withRedmineClient', () => {
  const session = { redmineAccessToken: 'KEY', redmineBaseUrl: BASE } as unknown as UserSession;

  test('passes the result through on success', async () => {
    const out = await withRedmineClient('Failed', session, log, async () => 'ok');
    assert.equal(out, 'ok');
  });

  test('maps an API failure to a UserError', async () => {
    await assert.rejects(
      () => withRedmineClient('Failed to list issues', session, log, async () => {
        throw Object.assign(new Error('boom'), { status: 403 });
      }),
      (err: any) => {
        assert.ok(err instanceof UserError);
        assert.match(err.message, /Enable REST API/);
        return true;
      },
    );
  });

  // A UserError raised inside a tool body is already user-facing; re-wrapping
  // it would bury the specific message under a generic prefix.
  test('lets a UserError from the body through untouched', async () => {
    await assert.rejects(
      () => withRedmineClient('Failed', session, log, async () => { throw new UserError('Issue not found.'); }),
      (err: any) => {
        assert.equal(err.message, 'Issue not found.');
        return true;
      },
    );
  });

  test('a missing connection is reported before the body runs', async () => {
    let ran = false;
    await assert.rejects(
      () => withRedmineClient('Failed', {} as UserSession, log, async () => { ran = true; return ''; }),
      /not connected/,
    );
    assert.equal(ran, false);
  });
});

describe('getRedmineClient auth mode', () => {
  test('uses the stored mode in preference to the refresh-token heuristic', () => {
    // An OAuth connection whose provider returned no refresh token: the
    // heuristic alone would wrongly pick apiKey.
    const session = {
      redmineAccessToken: 'TOK', redmineBaseUrl: BASE, redmineAuthMode: 'oauth',
    } as unknown as UserSession;
    assert.ok(getRedmineClient(session) instanceof RedmineClient);
  });

  test('resolveRedmineAuthMode falls back for rows written before the field existed', () => {
    assert.equal(resolveRedmineAuthMode('oauth', false), 'oauth');
    assert.equal(resolveRedmineAuthMode('apiKey', true), 'apiKey');
    assert.equal(resolveRedmineAuthMode(undefined, true), 'oauth');
    assert.equal(resolveRedmineAuthMode(undefined, false), 'apiKey');
    assert.equal(resolveRedmineAuthMode('nonsense', true), 'oauth');
  });
});

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

describe('maybeRefreshRedmineToken', () => {
  const oauthSession = (over: Record<string, unknown> = {}) => ({
    redmineAccessToken: 'OLD',
    redmineBaseUrl: BASE,
    redmineRefreshToken: 'RT1',
    redmineOauthClientId: 'cid',
    redmineOauthClientSecret: 'secret',
    redmineTokenExpiry: Date.now() - 1000,
    redmineAuthMode: 'oauth',
    ...over,
  }) as unknown as UserSession;

  test('is a no-op for a paste-token session', async () => {
    const session = { redmineAccessToken: 'KEY', redmineBaseUrl: BASE } as unknown as UserSession;
    await maybeRefreshRedmineToken(session, log);
    assert.equal(recorded.length, 0);
  });

  test('is a no-op while the token is still comfortably valid', async () => {
    await maybeRefreshRedmineToken(oauthSession({ redmineTokenExpiry: Date.now() + 3_600_000 }), log);
    assert.equal(recorded.length, 0);
  });

  // Doorkeeper rotates the refresh token, so the new one has to land on the
  // session or the next refresh presents a dead token.
  test('swaps in the rotated access AND refresh token', async () => {
    respond = () => ({ status: 200, json: { access_token: 'NEW', refresh_token: 'RT2', expires_in: 7200 } });
    const session = oauthSession();
    await maybeRefreshRedmineToken(session, log);
    assert.equal(session.redmineAccessToken, 'NEW');
    assert.equal(session.redmineRefreshToken, 'RT2');
    assert.ok((session.redmineTokenExpiry as number) > Date.now());
    assert.match(recorded[0].url, /\/oauth\/token$/);
  });

  test('keeps the existing refresh token when the response omits one', async () => {
    respond = () => ({ status: 200, json: { access_token: 'NEW', expires_in: 7200 } });
    const session = oauthSession();
    await maybeRefreshRedmineToken(session, log);
    assert.equal(session.redmineRefreshToken, 'RT1');
  });

  // Best-effort: a failed refresh must not throw, because the existing token
  // may still work and a throw would fail the tool call outright.
  test('leaves the session untouched and does not throw when the refresh fails', async () => {
    respond = () => ({ status: 401, text: 'invalid_grant' });
    const session = oauthSession();
    await maybeRefreshRedmineToken(session, log);
    assert.equal(session.redmineAccessToken, 'OLD');
    assert.equal(session.redmineRefreshToken, 'RT1');
  });

  // Concurrent tool calls must not each spend the same rotating refresh token.
  test('single-flights concurrent refreshes', async () => {
    respond = () => ({ status: 200, json: { access_token: 'NEW', refresh_token: 'RT2', expires_in: 7200 } });
    const session = oauthSession();
    await Promise.all([
      maybeRefreshRedmineToken(session, log),
      maybeRefreshRedmineToken(session, log),
      maybeRefreshRedmineToken(session, log),
    ]);
    assert.equal(recorded.length, 1, 'one grant for three concurrent callers');
  });
});
