// src/__tests__/github/connect.test.ts
// Connect-time pieces: paste-token validation, the OAuth exchange, instance
// naming, and the session factory that both flows land in.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateGitHubToken, buildGitHubInstanceName, fetchGitHubUser } from '../../github/connectToken.js';
import { exchangeGitHubOauthCode, refreshGitHubToken, GITHUB_OAUTH_SCOPES } from '../../github/oauthCallback.js';
import { createGitHubSession } from '../../userSession.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function recordingFetch(handler: (url: string, init: RequestInit) => Response) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: any, init: any) => {
    seen.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  return { fetchImpl, seen };
}

describe('validateGitHubToken', () => {
  it('probes GET /user with the headers GitHub requires', async () => {
    const { fetchImpl, seen } = recordingFetch(() => json(200, { login: 'octocat' }));
    const result = await validateGitHubToken({ token: ' ghp_abc ', fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(seen[0].url, 'https://api.github.com/user');
    const headers = seen[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer ghp_abc');
    assert.ok(headers['User-Agent']);
  });

  it('words 401 as a dead token and 403 as NOT a dead token', async () => {
    const dead = await validateGitHubToken({ token: 't', fetchImpl: recordingFetch(() => json(401, {})).fetchImpl });
    const refused = await validateGitHubToken({ token: 't', fetchImpl: recordingFetch(() => json(403, {})).fetchImpl });
    assert.equal(dead.ok, false);
    assert.equal(refused.ok, false);
    if (!dead.ok) assert.match(dead.userMessage, /invalid, expired or revoked/);
    if (!refused.ok) {
      assert.match(refused.userMessage, /not a bad token/);
      assert.doesNotMatch(refused.userMessage, /revoked/);
    }
  });

  it('rejects a blank token without a request', async () => {
    const { fetchImpl, seen } = recordingFetch(() => json(200, {}));
    const result = await validateGitHubToken({ token: '   ', fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(seen.length, 0);
  });
});

describe('fetchGitHubUser', () => {
  it('returns nulls rather than failing a connect over a display name', async () => {
    assert.deepEqual(await fetchGitHubUser('t', recordingFetch(() => json(500, {})).fetchImpl), { login: null, email: null });
    assert.deepEqual(await fetchGitHubUser('t', recordingFetch(() => json(200, { login: 'ann', email: null })).fetchImpl), { login: 'ann', email: null });
  });
});

describe('buildGitHubInstanceName', () => {
  it('names the connection after the login, normalising the catalog\'s "GitHub MCP Server"', () => {
    assert.equal(buildGitHubInstanceName({ serviceName: 'GitHub MCP Server', login: 'ann' }), 'GitHub (ann)');
    // What the paste route hands over after stripping " MCP" itself.
    assert.equal(buildGitHubInstanceName({ serviceName: 'GitHub Server', login: 'ann' }), 'GitHub (ann)');
    assert.equal(buildGitHubInstanceName({ serviceName: 'GitHub MCP Server' }), 'GitHub');
    assert.equal(buildGitHubInstanceName({ serviceName: 'GitHub', providedInstanceName: 'Work', login: 'ann' }), 'Work');
  });
});

describe('exchangeGitHubOauthCode', () => {
  const input = { tokenUrl: 'https://github.com/login/oauth/access_token', code: 'c', clientId: 'id', clientSecret: 's', redirectUri: 'https://app/connect/github/callback' };

  it('exchanges the code, then names the account', async () => {
    const { fetchImpl, seen } = recordingFetch(url => url.includes('access_token')
      ? json(200, { access_token: 'gho_x', token_type: 'bearer', scope: 'repo' })
      : json(200, { login: 'ann', email: 'ann@example.com' }));
    const result = await exchangeGitHubOauthCode({ ...input, fetchImpl });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.accessToken, 'gho_x');
      assert.equal(result.refreshToken, null, 'an OAuth App token never expires and has no refresh token');
      assert.equal(result.expiresIn, null);
      assert.equal(result.login, 'ann');
    }
    const body = new URLSearchParams(String(seen[0].init.body));
    assert.equal(body.get('redirect_uri'), input.redirectUri);
    assert.equal((seen[0].init.headers as Record<string, string>).Accept, 'application/json');
  });

  it('treats GitHub\'s 200-with-error-body as a failure, keeping the reason in the log', async () => {
    const { fetchImpl } = recordingFetch(() => json(200, { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' }));
    const result = await exchangeGitHubOauthCode({ ...input, fetchImpl });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.logMessage, /bad_verification_code/);
  });

  it('carries a GitHub App\'s expiring token and refresh token through', async () => {
    const { fetchImpl } = recordingFetch(url => url.includes('access_token')
      ? json(200, { access_token: 'ghu_x', refresh_token: 'ghr_y', expires_in: 28800 })
      : json(200, { login: 'ann' }));
    const result = await exchangeGitHubOauthCode({ ...input, fetchImpl });
    assert.ok(result.ok && result.refreshToken === 'ghr_y' && result.expiresIn === 28800);
  });
});

describe('refreshGitHubToken', () => {
  it('sends a refresh_token grant and returns the rotated token', async () => {
    const { fetchImpl, seen } = recordingFetch(() => json(200, { access_token: 'ghu_new', refresh_token: 'ghr_new', expires_in: 28800 }));
    const result = await refreshGitHubToken({ tokenUrl: 'https://github.com/login/oauth/access_token', refreshToken: 'ghr_old', clientId: 'id', clientSecret: 's', fetchImpl });
    assert.ok(result.ok && result.refreshToken === 'ghr_new');
    assert.equal(new URLSearchParams(String(seen[0].init.body)).get('grant_type'), 'refresh_token');
  });
});

describe('GITHUB_OAUTH_SCOPES', () => {
  it('does not request `workflow` (CI rewrite) or anything no tool uses', () => {
    assert.deepEqual(GITHUB_OAUTH_SCOPES, ['repo']);
  });
});

describe('createGitHubSession', () => {
  const user = { id: 1, apiKey: 'k-gh-test', email: 'a@b.c' } as any;
  const conn = (providerTokens: object, instanceId = 'gh-1') => ({ instanceId, mcpSlug: 'github', provider: 'github', providerTokens } as any);

  it('carries refresh plumbing for a GitHub App token and none for a PAT', () => {
    const app = createGitHubSession(user, conn({ access_token: 'ghu', refresh_token: 'ghr', expiry_date: 123 }, 'gh-app'));
    assert.equal(app.githubAccessToken, 'ghu');
    assert.equal(app.githubRefreshToken, 'ghr');
    assert.equal(app.githubTokenExpiry, 123);
    assert.equal(app.githubInstanceId, 'gh-app');

    const pat = createGitHubSession(user, conn({ access_token: 'ghp' }, 'gh-pat'));
    assert.equal(pat.githubRefreshToken, undefined);
    assert.equal(pat.githubTokenExpiry, undefined);
  });

  it('rebuilds a cached session when the stored token changed', () => {
    const first = createGitHubSession(user, conn({ access_token: 'one' }, 'gh-rot'));
    const second = createGitHubSession(user, conn({ access_token: 'two' }, 'gh-rot'));
    assert.notEqual(first, second);
    assert.equal(second.githubAccessToken, 'two');
  });

  it('refuses a connection with no token', () => {
    assert.throws(() => createGitHubSession(user, conn({}, 'gh-none')), /access token missing/);
  });
});
