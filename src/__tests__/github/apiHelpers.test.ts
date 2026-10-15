// src/__tests__/github/apiHelpers.test.ts
// GitHubClient request shape, Link-header paging, and — most of the value —
// the error mapping that tells apart the causes GitHub answers with one status.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { UserError } from 'fastmcp';

import {
  GitHubClient,
  parseLinkHeader,
  describeGitHubError,
  mapGitHubError,
  maybeRefreshGitHubToken,
  withGitHubClient,
  slashPath,
} from '../../github/apiHelpers.js';
import { RedirectRefusedError } from '../../util/jsonApiRequest.js';
import { GITHUB_API_VERSION } from '../../github/constants.js';

const log = { info: () => {}, error: () => {} };

/** A thrown request error shaped like jsonApiRequest's. */
function apiError(status: number, body: unknown, headers: Record<string, string> = {}): any {
  const err: any = new Error(`GitHub API GET /x failed: ${status}`);
  err.status = status;
  err.body = typeof body === 'string' ? body : JSON.stringify(body);
  err.headers = new Headers(headers);
  return err;
}

type Seen = { url: string; init: RequestInit };

function fetchSequence(responses: Response[]): { fetchImpl: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    seen.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra request');
    return next;
  }) as typeof fetch;
  return { fetchImpl, seen };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

describe('parseLinkHeader', () => {
  it('reads next and last page numbers', () => {
    const link = '<https://api.github.com/repos/o/r/issues?page=3&per_page=30>; rel="next", <https://api.github.com/repos/o/r/issues?page=9&per_page=30>; rel="last"';
    assert.deepEqual(parseLinkHeader(link), { next: 3, last: 9 });
  });

  it('reports no next page on the last page, and tolerates a missing header', () => {
    assert.deepEqual(parseLinkHeader('<https://api.github.com/x?page=1>; rel="first", <https://api.github.com/x?page=2>; rel="prev"'), { next: null, last: null });
    assert.deepEqual(parseLinkHeader(null), { next: null, last: null });
  });
});

describe('slashPath', () => {
  it('encodes segments but keeps the separators GitHub resolves as directories', () => {
    assert.equal(slashPath('docs/my file#1.md'), 'docs/my%20file%231.md');
    assert.equal(slashPath('feature/x'), 'feature/x');
  });
});

describe('GitHubClient.request', () => {
  it('sends auth, API version and the User-Agent GitHub requires, and drops empty query values', async () => {
    const { fetchImpl, seen } = fetchSequence([json(200, [{ id: 1 }], { link: '<https://api.github.com/x?page=2>; rel="next"' })]);
    const client = new GitHubClient('tok_secret_123', { fetchImpl });
    const res = await client.get('/repos/o/r/issues', { state: 'open', labels: undefined, since: '' });

    const headers = seen[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer tok_secret_123');
    assert.equal(headers['X-GitHub-Api-Version'], GITHUB_API_VERSION);
    assert.ok(headers['User-Agent'], 'GitHub 403s a request with no User-Agent');
    assert.equal(seen[0].url, 'https://api.github.com/repos/o/r/issues?state=open');
    assert.deepEqual(res.page, { next: 2, last: null });
  });

  it('follows a same-origin 301 for a renamed repository on a read', async () => {
    const { fetchImpl, seen } = fetchSequence([
      new Response(null, { status: 301, headers: { location: 'https://api.github.com/repositories/42/issues' } }),
      json(200, []),
    ]);
    await new GitHubClient('tok_secret_123', { fetchImpl }).get('/repos/old/name/issues');
    assert.equal(seen.length, 2);
    assert.equal(seen[1].url, 'https://api.github.com/repositories/42/issues');
  });

  it('puts the response headers on a thrown error, so a 403 can be diagnosed', async () => {
    const { fetchImpl } = fetchSequence([json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' })]);
    await assert.rejects(
      new GitHubClient('tok_secret_123', { fetchImpl }).get('/user'),
      (err: any) => err.status === 403 && err.headers.get('x-ratelimit-remaining') === '0',
    );
  });
});

describe('describeGitHubError — one status, several causes', () => {
  it('a 403 with no remaining quota is a rate limit, not a permission problem', () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    const msg = describeGitHubError(apiError(403, { message: 'API rate limit exceeded' }, {
      'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset), 'x-ratelimit-resource': 'core', 'x-ratelimit-limit': '5000',
    }));
    assert.match(msg, /rate limit of 5000 is used up/);
    assert.match(msg, /nothing was done/);
    assert.doesNotMatch(msg, /permission/i);
  });

  it('names the separate search budget when that is what ran out', () => {
    const msg = describeGitHubError(apiError(403, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-resource': 'code_search' }));
    assert.match(msg, /code_search/);
    assert.match(msg, /10 for code search/);
  });

  it('a retry-after is the secondary limit', () => {
    const msg = describeGitHubError(apiError(403, { message: 'You have exceeded a secondary rate limit' }, { 'retry-after': '30', 'x-ratelimit-remaining': '4000' }));
    assert.match(msg, /secondary rate limit/);
    assert.match(msg, /30 s/);
  });

  it('a SAML SSO block names the authorization URL', () => {
    const msg = describeGitHubError(apiError(403, { message: 'Resource protected by organization SAML enforcement.' }, {
      'x-github-sso': 'required; url=https://github.com/orgs/acme/sso?authorization_request=abc',
    }));
    assert.match(msg, /SAML single sign-on/);
    assert.match(msg, /https:\/\/github\.com\/orgs\/acme\/sso\?authorization_request=abc/);
  });

  it('a fine-grained token missing a permission names the permission', () => {
    const msg = describeGitHubError(apiError(403, { message: 'Resource not accessible by personal access token' }, {
      'x-accepted-github-permissions': 'contents=write',
    }));
    assert.match(msg, /fine-grained/);
    assert.match(msg, /contents=write/);
  });

  it('a missing OAuth scope names what is needed AND what is held', () => {
    const msg = describeGitHubError(apiError(404, { message: 'Not Found' }, {
      'x-accepted-oauth-scopes': 'repo', 'x-oauth-scopes': 'read:user, gist',
    }), { resource: 'repository acme/private' });
    assert.match(msg, /repository acme\/private was not found/);
    assert.match(msg, /\[repo\]/);
    assert.match(msg, /\[read:user, gist\]/);
  });

  it('does not report a scope as missing when a held scope implies it', () => {
    const msg = describeGitHubError(apiError(403, { message: 'Must have admin rights to Repository.' }, {
      'x-accepted-oauth-scopes': 'public_repo, repo', 'x-oauth-scopes': 'repo',
    }));
    assert.doesNotMatch(msg, /needs one of the OAuth scopes/);
    assert.match(msg, /Must have admin rights/);
  });

  it('a token with no scope header (fine-grained / GitHub App) is not told it holds no scopes', () => {
    const msg = describeGitHubError(apiError(404, { message: 'Not Found' }, { 'x-accepted-oauth-scopes': 'repo' }));
    assert.doesNotMatch(msg, /holds \[none\]/);
    assert.match(msg, /does not exist, a name is misspelled, or the connected account has no access/);
  });

  it('a workflow-scope refusal explains why this connector cannot write workflows', () => {
    const msg = describeGitHubError(apiError(403, { message: 'refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope' }));
    assert.match(msg, /deliberately does not request the `workflow` scope/);
  });

  it('an empty repository 409 points at the tool that can make the first commit', () => {
    assert.match(describeGitHubError(apiError(409, { message: 'Git Repository is empty.' })), /createOrUpdateFile/);
  });

  it('a 422 lists GitHub\'s own validation errors', () => {
    const msg = describeGitHubError(apiError(422, {
      message: 'Validation Failed',
      errors: [{ resource: 'PullRequest', code: 'custom', message: 'No commits between main and feature' }, { resource: 'Issue', field: 'title', code: 'missing_field' }],
    }));
    assert.match(msg, /No commits between main and feature/);
    assert.match(msg, /Issue\.title missing_field/);
  });

  it('a 5xx on a write says the outcome is unknown rather than inviting a blind retry', () => {
    assert.match(describeGitHubError(apiError(502, ''), { write: true }), /may or may not have been applied/);
    assert.match(describeGitHubError(apiError(502, '')), /Retry shortly/);
  });

  it('a refused redirect to /repositories/<id> on a write is explained as a rename', () => {
    const err = new RedirectRefusedError('redirected', {
      status: 307, location: 'https://api.github.com/repositories/42/issues', resolved: 'https://api.github.com/repositories/42/issues',
      host: 'api.github.com', path: '/repositories/42/issues', sameOrigin: true, loginBounce: false, hopsFollowed: 0,
    });
    assert.match(describeGitHubError(err), /renamed or transferred/);
  });

  it('a 401 says to reconnect', () => {
    assert.match(describeGitHubError(apiError(401, { message: 'Bad credentials' })), /Reconnect GitHub/);
  });
});

describe('mapGitHubError', () => {
  it('throws a UserError with the prefix, and passes UserErrors through untouched', () => {
    assert.throws(() => mapGitHubError('Failed to x', apiError(404, {}), log), (e: any) => e instanceof UserError && /^Failed to x: /.test(e.message));
    const original = new UserError('already worded');
    assert.throws(() => mapGitHubError('Failed', original, log), (e: any) => e === original);
  });
});

describe('withGitHubClient', () => {
  it('reports a missing connection verbatim', async () => {
    await assert.rejects(withGitHubClient('Failed', {} as any, log, async () => 'x'), /GitHub not connected/);
  });
});

describe('maybeRefreshGitHubToken', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('is a no-op for a token with no expiry (OAuth App token or PAT)', async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return json(200, {}); }) as typeof fetch;
    const session: any = { githubAccessToken: 'a', githubRefreshToken: 'r', githubOauthClientId: 'c', githubOauthClientSecret: 's' };
    await maybeRefreshGitHubToken(session, log);
    assert.equal(called, false);
  });

  it('refreshes an expiring GitHub App token once for concurrent callers and keeps the ROTATED refresh token', async () => {
    let grants = 0;
    globalThis.fetch = (async () => {
      grants += 1;
      return json(200, { access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 28800 });
    }) as typeof fetch;
    // No instance id, so nothing is persisted to a real store in this test.
    const session: any = {
      githubAccessToken: 'old', githubRefreshToken: 'old-refresh', githubTokenExpiry: Date.now() - 1000,
      githubOauthClientId: 'c', githubOauthClientSecret: 's',
    };
    await Promise.all([maybeRefreshGitHubToken(session, log), maybeRefreshGitHubToken(session, log)]);
    assert.equal(grants, 1, 'a rotating refresh token must not be spent twice');
    assert.equal(session.githubAccessToken, 'new-access');
    assert.equal(session.githubRefreshToken, 'rotated-refresh');
    assert.ok(session.githubTokenExpiry > Date.now());
  });

  it('keeps the existing token when the refresh fails (GitHub answers 200 with an error body)', async () => {
    globalThis.fetch = (async () => json(200, { error: 'bad_refresh_token' })) as typeof fetch;
    const session: any = {
      githubAccessToken: 'old', githubRefreshToken: 'old-refresh', githubTokenExpiry: Date.now() - 1000,
      githubOauthClientId: 'c', githubOauthClientSecret: 's',
    };
    await maybeRefreshGitHubToken(session, log);
    assert.equal(session.githubAccessToken, 'old');
    assert.equal(session.githubRefreshToken, 'old-refresh');
  });
});
