// src/__tests__/github/accessRules.test.ts
// The per-connector owner allowlist: parsing, enforcement inside GitHubClient
// (the one place every MCP tool and REST route passes), search filtering,
// discovery for the dashboard, and the two ways stored rules could be lost.
// Store-backed cases run against the file backend in a throwaway DATA_DIR.
import assert from 'node:assert/strict';
import { describe, it, after, afterEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'gh-rules-'));
process.env.DATA_DIR = dir;
delete process.env.DATABASE_URL;

const { createMcpInstance, getMcpConnectionByInstanceId } = await import('../../mcpConnectionStore.js');
const rules = await import('../../github/accessRules.js');
const { GitHubClient, withGitHubClient, maybeRefreshGitHubToken } = await import('../../github/apiHelpers.js');
const { discoverGitHubOwners, REPO_DISCOVERY_MAX_PAGES } = await import('../../github/ownerDiscovery.js');
const { uniqueGitHubInstanceName } = await import('../../github/connectToken.js');
const ops = await import('../../github/ops.js');

const log = { info: () => {}, error: () => {} };
const EMPTY_GOOGLE = { access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0 };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A fetch that records `METHOD /path` and answers from a handler. */
function stub(handler: (method: string, path: string, url: URL, init: any) => Response) {
  const seen: string[] = [];
  const fetchImpl = (async (input: any, init: any) => {
    const url = new URL(String(input));
    seen.push(`${init.method} ${url.pathname}`);
    return handler(init.method, url.pathname, url, init);
  }) as typeof fetch;
  return { fetchImpl, seen };
}

const policy = (...owners: string[]) => new Set(owners);

describe('includeConnectedAccount', () => {
  const clientFor = (login: unknown) => ({ get: async () => ({ data: { login } }) }) as any;

  it('adds the connected account first, and only once', async () => {
    assert.deepEqual(await rules.includeConnectedAccount({ allowedOwners: ['acme'] }, clientFor('Me')), { allowedOwners: ['me', 'acme'] });
    assert.deepEqual(await rules.includeConnectedAccount({ allowedOwners: ['acme', 'me'] }, clientFor('me')), { allowedOwners: ['acme', 'me'] });
  });

  it('throws rather than store rules when GitHub names no account', async () => {
    await assert.rejects(rules.includeConnectedAccount({ allowedOwners: ['acme'] }, clientFor(undefined)), /did not return/);
  });
});

describe('owner parsing', () => {
  it('accepts a login, @login or a github.com URL, lower-cased', () => {
    assert.equal(rules.normalizeOwner('Acme-Inc'), 'acme-inc');
    assert.equal(rules.normalizeOwner('@octo'), 'octo');
    assert.equal(rules.normalizeOwner('https://github.com/Acme/repo'), 'acme');
  });

  it('refuses what cannot be a GitHub login, so no rule silently matches nothing', () => {
    for (const bad of ['', '-acme', 'acme-', 'ac--me', 'a b', 'x'.repeat(40), 'acme/repo', null]) {
      assert.equal(rules.normalizeOwner(bad), null, String(bad));
    }
  });

  it('refuses a non-string instead of stringifying it into "[object Object]"', () => {
    assert.equal(rules.normalizeOwner({ login: 'acme' }), null);
    assert.equal(rules.normalizeOwner(42), null);
  });

  it('parses the dashboard body: null clears, names are normalised, junk and empty lists are refused', () => {
    assert.deepEqual(rules.parseGitHubAccessRulesBody(null), { ok: true, rules: null });
    assert.deepEqual(rules.parseGitHubAccessRulesBody({ allowedOwners: ['Me', '@acme', 'https://github.com/ACME'] }),
      { ok: true, rules: { allowedOwners: ['me', 'acme'] } });
    for (const bad of [undefined, {}, { allowedOwners: [] }, { allowedOwners: 'acme' }, { allowedOwners: ['ok', 'not ok'] }, { allowedOwners: [{}] }]) {
      assert.equal(rules.parseGitHubAccessRulesBody(bad).ok, false, JSON.stringify(bad));
    }
    const named = rules.parseGitHubAccessRulesBody({ allowedOwners: ['not ok'] });
    assert.equal(named.ok, false);
    assert.match((named as any).error, /"not ok" is not a GitHub user or organization name/);
  });

  it('absent rules are unrestricted; a stored list is a set', () => {
    assert.equal(rules.policyFromRules(undefined), null);
    assert.equal(rules.policyFromRules({}), null);
    assert.deepEqual([...rules.policyFromRules({ allowedOwners: ['Acme', 'bad name'] })!], ['acme']);
  });

  it('reads the owner from a repo path and from every search item shape', () => {
    assert.equal(rules.ownerFromPath('/repos/acme/app/issues'), 'acme');
    assert.equal(rules.ownerFromPath('/search/code'), null);
    assert.equal(rules.searchItemOwner({ repository_url: 'https://api.github.com/repos/acme/app' + '/' }), 'acme');
    assert.equal(rules.searchItemOwner({ repository: { full_name: 'acme/app' } }), 'acme');
    assert.equal(rules.searchItemOwner({ full_name: 'acme/app' }), 'acme');
    assert.equal(rules.searchItemOwner({}), null);
  });
});

describe('GitHubClient under access rules', () => {
  it('refuses a request into an excluded owner BEFORE anything is sent', async () => {
    const { fetchImpl, seen } = stub(() => json(200, {}));
    const client = new GitHubClient('t', { fetchImpl, allowedOwners: policy('me', 'acme') });
    await assert.rejects(client.post('/repos/other/app/issues', { title: 't' }), (e: any) => {
      assert.ok(e instanceof rules.GitHubAccessDenied);
      assert.equal(e.status, 403);
      assert.match(e.message, /do not allow "other" \(allowed: acme, me\)/);
      return true;
    });
    assert.deepEqual(seen, []);
  });

  it('matches owners case-insensitively and lets allowed ones through', async () => {
    const { fetchImpl, seen } = stub(() => json(200, { number: 1 }));
    const client = new GitHubClient('t', { fetchImpl, allowedOwners: policy('acme') });
    await client.get('/repos/ACME/app/issues/1');
    assert.deepEqual(seen, ['GET /repos/ACME/app/issues/1']);
  });

  it('checks a fork destination in the body, not just the source in the path', async () => {
    const { fetchImpl } = stub(() => json(202, {}));
    const client = new GitHubClient('t', { fetchImpl, allowedOwners: policy('acme') });
    await assert.rejects(client.post('/repos/acme/app/forks', { organization: 'elsewhere' }), rules.GitHubAccessDenied);
    await client.post('/repos/acme/app/forks', {});
  });

  it('does not follow a rename redirect under rules — /repositories/<id> names no owner', async () => {
    const { fetchImpl, seen } = stub((_m, path) => path.startsWith('/repositories/')
      ? json(200, { full_name: 'other/app' })
      : new Response(null, { status: 301, headers: { location: 'https://api.github.com/repositories/42' } }));
    const restricted = new GitHubClient('t', { fetchImpl, allowedOwners: policy('acme') });
    await assert.rejects(restricted.get('/repos/acme/app'));
    assert.deepEqual(seen, ['GET /repos/acme/app']);

    const open = new GitHubClient('t', { fetchImpl });
    assert.equal((await open.get<any>('/repos/acme/app')).data.full_name, 'other/app', 'unrestricted still follows');
  });

  it('filters search results by owner and counts what it hid; users search is untouched', async () => {
    const { fetchImpl } = stub((_m, path) => path === '/search/users'
      ? json(200, { total_count: 1, items: [{ login: 'other' }] })
      : json(200, { total_count: 3, incomplete_results: false, items: [
        { full_name: 'acme/a', repository_url: 'https://api.github.com/repos/acme/a' },
        { full_name: 'other/b', repository_url: 'https://api.github.com/repos/other/b' },
        { title: 'owner unknown' },
      ] }));
    const client = new GitHubClient('t', { fetchImpl, allowedOwners: policy('acme') });
    const res = await client.get<any>('/search/issues', { q: 'x' });
    assert.deepEqual(res.data.items.map((i: any) => i.full_name), ['acme/a']);
    assert.equal(res.hiddenByAccessRules, 2, 'an item whose owner is unknown is dropped too');
    assert.equal(res.data.total_count, 3, 'GitHub\'s count is left as GitHub\'s');
    assert.equal((await client.get<any>('/search/users', { q: 'x' })).data.items.length, 1);
  });

  it('the search op says how many results the rules hid', async () => {
    const { fetchImpl } = stub(() => json(200, { total_count: 2, incomplete_results: false, items: [
      { full_name: 'acme/a', html_url: 'u', owner: { login: 'acme' } },
      { full_name: 'other/b', html_url: 'u', owner: { login: 'other' } },
    ] }));
    const client = new GitHubClient('t', { fetchImpl, allowedOwners: policy('acme') });
    const out = await ops.opSearchRepositories(client, { query: 'x' } as any);
    assert.match(out, /1 result\(s\) on this page are in organizations this connector's access rules exclude/);
    assert.doesNotMatch(out, /other\/b/);
  });
});

describe('rules are read from storage on every call', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  after(() => rmSync(dir, { recursive: true, force: true }));

  async function connector(providerTokens: Record<string, unknown>) {
    const conn = await createMcpInstance(1, 'github', `GitHub ${Math.random()}`, EMPTY_GOOGLE, null, 'github', providerTokens as any, null);
    return { githubAccessToken: providerTokens.access_token, githubInstanceId: conn.instanceId } as any;
  }

  it('applies the stored rules to an op run through withGitHubClient', async () => {
    const session = await connector({ access_token: 'tok', accessRules: { allowedOwners: ['me', 'acme'] } });
    const { fetchImpl, seen } = stub(() => json(200, {}));
    globalThis.fetch = fetchImpl;
    await assert.rejects(
      withGitHubClient('Failed to get issue', session, log, client => client.get('/repos/other/app/issues/1')),
      /do not allow "other"/,
    );
    assert.deepEqual(seen, []);
  });

  it('no stored rules means unrestricted', async () => {
    const session = await connector({ access_token: 'tok' });
    const { fetchImpl, seen } = stub(() => json(200, {}));
    globalThis.fetch = fetchImpl;
    await withGitHubClient('Failed', session, log, client => client.get('/repos/anyone/app'));
    assert.deepEqual(seen, ['GET /repos/anyone/app']);
  });

  it('fails CLOSED when the rules cannot be read, rather than running unrestricted', async () => {
    const session: any = { githubAccessToken: 'tok', githubInstanceId: 'inst' };
    await assert.rejects(
      rules.loadGitHubOwnerPolicy(session, async () => { throw new Error('connection refused'); }),
      (e: any) => {
        assert.match(e.message, /connection refused.*refused rather than run unrestricted/);
        assert.equal(e.status, 503);
        return true;
      },
    );
  });

  it('a token refresh keeps the stored rules — the store replaces the whole record', async () => {
    const session = await connector({
      access_token: 'old', refresh_token: 'r', expiry_date: Date.now() - 1000,
      accessRules: { allowedOwners: ['me', 'acme'] },
    });
    Object.assign(session, { githubRefreshToken: 'r', githubTokenExpiry: Date.now() - 1000, githubOauthClientId: 'c', githubOauthClientSecret: 's' });
    globalThis.fetch = (async () => json(200, { access_token: 'new', refresh_token: 'r2', expires_in: 28800 })) as typeof fetch;
    await maybeRefreshGitHubToken(session, log);
    const stored = (await getMcpConnectionByInstanceId(session.githubInstanceId))!.providerTokens as any;
    assert.equal(stored.access_token, 'new');
    assert.equal(stored.refresh_token, 'r2');
    assert.deepEqual(stored.accessRules, { allowedOwners: ['me', 'acme'] });
  });
});

describe('owner discovery for the dashboard', () => {
  it('lists repository owners and orgs, never the account itself, and keeps saved owners', async () => {
    const { fetchImpl } = stub((_m, path) => {
      if (path === '/user') return json(200, { login: 'Me' });
      if (path === '/user/repos') return json(200, [
        { owner: { login: 'me', type: 'User' } },
        { owner: { login: 'Acme', type: 'Organization' } },
        { owner: { login: 'friend', type: 'User' } },
      ]);
      return json(200, [{ login: 'beta' }]);
    });
    const result = await discoverGitHubOwners(new GitHubClient('t', { fetchImpl }), { savedOwners: ['acme', 'gone-org'] });
    assert.equal(result.self, 'Me');
    assert.deepEqual(result.owners.map(o => [o.login, o.type, o.saved, o.discovered]), [
      ['Acme', 'Organization', true, true],
      ['beta', 'Organization', false, true],
      ['friend', 'User', false, true],
      ['gone-org', null, true, false],
    ]);
    assert.equal(result.truncated, false);
  });

  it('treats a 403 from /user/orgs (no read:org scope) as expected, not as a failure', async () => {
    const { fetchImpl } = stub((_m, path) => {
      if (path === '/user') return json(200, { login: 'me' });
      if (path === '/user/repos') return json(200, [{ owner: { login: 'acme', type: 'Organization' } }]);
      return json(403, { message: 'Must have admin rights' });
    });
    const result = await discoverGitHubOwners(new GitHubClient('t', { fetchImpl }));
    assert.deepEqual(result.owners.map(o => o.login), ['acme']);
  });

  it('reports a repository scan cut short instead of quietly shortening the list', async () => {
    const { fetchImpl, seen } = stub((_m, path, url) => {
      if (path === '/user') return json(200, { login: 'me' });
      if (path === '/user/orgs') return json(403, {});
      const page = Number(url.searchParams.get('page'));
      return json(200, [{ owner: { login: `org${page}`, type: 'Organization' } }], {
        link: `<https://api.github.com/user/repos?page=${page + 1}>; rel="next"`,
      });
    });
    const result = await discoverGitHubOwners(new GitHubClient('t', { fetchImpl }));
    assert.equal(seen.filter(s => s === 'GET /user/repos').length, REPO_DISCOVERY_MAX_PAGES);
    assert.equal(result.truncated, true);
    assert.match(result.notes[0], /add it by name/);
  });
});

describe('uniqueGitHubInstanceName', () => {
  it('suffixes a repeat connect for the same account instead of refusing it', () => {
    assert.equal(uniqueGitHubInstanceName('GitHub (me)', []), 'GitHub (me)');
    assert.equal(uniqueGitHubInstanceName('GitHub (me)', ['GitHub (me)']), 'GitHub (me) 2');
    assert.equal(uniqueGitHubInstanceName('GitHub (me)', ['GitHub (me)', 'GitHub (me) 2']), 'GitHub (me) 3');
  });
});
