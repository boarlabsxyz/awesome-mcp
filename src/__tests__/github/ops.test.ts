// src/__tests__/github/ops.test.ts
// Drives the GitHub op* functions against a stubbed client, asserting the
// request shapes and rendered text — with most weight on the behaviours that
// deliberately differ from the reference implementation (see ops.ts header).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UserError } from 'fastmcp';

import type { GitHubClient, PageInfo } from '../../github/apiHelpers.js';
import { parseLinkHeader } from '../../github/apiHelpers.js';
import * as ops from '../../github/ops.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';
type Reply = unknown | ((body: any, query: any) => unknown);
interface Route { method: Method; path: string | RegExp; reply: Reply; status?: number; page?: Partial<PageInfo> }
interface Call { method: Method; path: string; body?: any; query?: any }

function httpError(status: number, body: unknown = {}): any {
  const err: any = new Error(`GitHub API failed: ${status}`);
  err.status = status;
  err.body = JSON.stringify(body);
  err.headers = new Headers();
  return err;
}

function stubClient(routes: Route[]): { client: GitHubClient; calls: Call[] } {
  const calls: Call[] = [];
  const respond = async (method: Method, path: string, body?: any, query?: any) => {
    calls.push({ method, path, body, query });
    const route = routes.find(r => r.method === method && (typeof r.path === 'string' ? r.path === path : r.path.test(path)));
    if (!route) throw new Error(`unexpected ${method} ${path}`);
    const data = typeof route.reply === 'function' ? (route.reply as any)(body, query) : route.reply;
    if (data instanceof Error) throw data;
    return { data, status: route.status ?? 200, page: { next: null, last: null, ...route.page }, headers: new Headers() };
  };
  const client = {
    get: (path: string, query?: any) => respond('GET', path, undefined, query),
    post: (path: string, body?: any) => respond('POST', path, body),
    put: (path: string, body?: any) => respond('PUT', path, body),
    patch: (path: string, body?: any) => respond('PATCH', path, body),
  } as unknown as GitHubClient;
  return { client, calls };
}

const R = '/repos/octo/app';

describe('pageFooter', () => {
  it('never offers a next page past GitHub\'s own last (seen live: next=2, last=1, page 2 empty)', () => {
    const info = parseLinkHeader('<https://api.github.com/repos/o/r/commits?per_page=2&page=2>; rel="next", <https://api.github.com/repos/o/r/commits?per_page=2&page=1>; rel="last"');
    assert.deepEqual(info, { next: null, last: 1 });
    assert.equal(ops.pageFooter(info, 1, 2), 'These are all the results.');
  });

  it('only says "all the results" when GitHub sent no next link', () => {
    assert.equal(ops.pageFooter({ next: null, last: null }, 1, 30), 'These are all the results.');
    assert.match(ops.pageFooter({ next: 3, last: 7 }, 2, 30), /Page 2 of 7\. More results exist: call again with page=3/);
    assert.match(ops.pageFooter({ next: null, last: null }, 4, 0), /past the last page/);
  });
});

describe('opPushFiles', () => {
  const base = (overrides: Route[] = []): Route[] => [
    ...overrides,
    { method: 'GET', path: `${R}/git/ref/heads/main`, reply: { object: { sha: 'head1' } } },
    { method: 'GET', path: `${R}/git/commits/head1`, reply: { tree: { sha: 'tree1' } } },
    { method: 'GET', path: `${R}/git/trees/tree1`, reply: { truncated: false, tree: [
      { path: 'run.sh', mode: '100755', type: 'blob', sha: 'b1' },
      { path: 'src', mode: '040000', type: 'tree', sha: 't2' },
      { path: 'link', mode: '120000', type: 'blob', sha: 'b3' },
    ] } },
    { method: 'POST', path: `${R}/git/trees`, reply: { sha: 'tree2' } },
    { method: 'POST', path: `${R}/git/commits`, reply: { sha: 'commit2' } },
    { method: 'PATCH', path: `${R}/git/refs/heads/main`, reply: {} },
  ];
  const args = (files: Array<{ path: string; content: string }>) => ({ owner: 'octo', repo: 'app', branch: 'main', message: 'm', files });

  it('fast-forwards only (force: false), keeps an executable bit, and reads the exact ref', async () => {
    const { client, calls } = stubClient(base());
    const out = await ops.opPushFiles(client, args([{ path: 'run.sh', content: 'echo' }, { path: './new.txt', content: 'x' }]));

    const tree = calls.find(c => c.method === 'POST' && c.path.endsWith('/git/trees'))!.body;
    assert.equal(tree.base_tree, 'tree1', 'base_tree is the commit TREE, not the commit');
    assert.deepEqual(tree.tree.map((e: any) => [e.path, e.mode]), [['run.sh', '100755'], ['new.txt', '100644']]);
    const ref = calls.find(c => c.method === 'PATCH')!;
    assert.deepEqual(ref.body, { sha: 'commit2', force: false });
    assert.ok(calls.some(c => c.path === `${R}/git/ref/heads/main`), 'singular git/ref — the plural form prefix-matches other branches');
    assert.match(out, /M run\.sh \(kept executable\)/);
    assert.match(out, /A new\.txt/);
  });

  it('reports the race instead of force-pushing over a concurrent commit', async () => {
    const { client } = stubClient(base([{ method: 'PATCH', path: `${R}/git/refs/heads/main`, reply: httpError(422, { message: 'Update is not a fast forward' }) }]));
    await assert.rejects(ops.opPushFiles(client, args([{ path: 'a.txt', content: 'x' }])), /moved while this commit was being built.*nothing was pushed/s);
  });

  it('commits nothing when the tree is unchanged', async () => {
    const { client, calls } = stubClient(base([{ method: 'POST', path: `${R}/git/trees`, reply: { sha: 'tree1' } }]));
    const out = await ops.opPushFiles(client, args([{ path: 'run.sh', content: 'same' }]));
    assert.match(out, /nothing was committed/);
    assert.ok(!calls.some(c => c.path.endsWith('/git/commits') && c.method === 'POST'));
  });

  it('refuses to overwrite a directory or a symlink with a file, before writing anything', async () => {
    for (const path of ['src', 'link']) {
      const { client, calls } = stubClient(base());
      await assert.rejects(ops.opPushFiles(client, args([{ path, content: 'x' }])), /refusing to replace it/);
      assert.ok(!calls.some(c => c.method !== 'GET'), `${path}: nothing written`);
    }
  });

  it('names a missing branch and points at createBranch', async () => {
    const { client } = stubClient([{ method: 'GET', path: `${R}/git/ref/heads/main`, reply: httpError(404) }]);
    await assert.rejects(ops.opPushFiles(client, args([{ path: 'a', content: 'x' }])), /does not exist.*createBranch/);
  });

  it('refuses bad and duplicate paths without any request', async () => {
    for (const files of [[{ path: '../etc', content: '' }], [{ path: '/abs', content: '' }], [{ path: 'a', content: '' }, { path: './a', content: '' }]]) {
      const { client, calls } = stubClient([]);
      await assert.rejects(ops.opPushFiles(client, args(files)), UserError);
      assert.equal(calls.length, 0);
    }
  });
});

describe('opCreateBranch', () => {
  it('reads the real default branch instead of guessing main/master', async () => {
    const { client, calls } = stubClient([
      { method: 'GET', path: R, reply: { default_branch: 'trunk' } },
      { method: 'GET', path: `${R}/git/ref/heads/trunk`, reply: { object: { sha: 'abcdef1234' } } },
      { method: 'POST', path: `${R}/git/refs`, reply: {} },
    ]);
    const out = await ops.opCreateBranch(client, { owner: 'octo', repo: 'app', branch: 'feature/x' });
    assert.deepEqual(calls.at(-1)!.body, { ref: 'refs/heads/feature/x', sha: 'abcdef1234' });
    assert.match(out, /from trunk \(abcdef1\)/);
  });

  it('says plainly when the branch already exists', async () => {
    const { client } = stubClient([
      { method: 'GET', path: `${R}/git/ref/heads/main`, reply: { object: { sha: 's' } } },
      { method: 'POST', path: `${R}/git/refs`, reply: httpError(422, { message: 'Reference already exists' }) },
    ]);
    await assert.rejects(ops.opCreateBranch(client, { owner: 'octo', repo: 'app', branch: 'x', fromBranch: 'main' }), /already exists.*nothing was changed/);
  });
});

describe('opCreateOrUpdateFile', () => {
  const args = { owner: 'octo', repo: 'app', path: 'docs/a.md', content: 'héllo', message: 'm', branch: 'main' };

  it('creates when the existence check 404s, sending base64 UTF-8', async () => {
    const { client, calls } = stubClient([
      { method: 'GET', path: `${R}/contents/docs/a.md`, reply: httpError(404) },
      { method: 'PUT', path: `${R}/contents/docs/a.md`, status: 201, reply: { content: { sha: 'new' }, commit: { sha: 'c1' } } },
    ]);
    const out = await ops.opCreateOrUpdateFile(client, args);
    const put = calls.find(c => c.method === 'PUT')!.body;
    assert.equal(Buffer.from(put.content, 'base64').toString('utf8'), 'héllo');
    assert.equal(put.sha, undefined);
    assert.match(out, /^Created docs\/a\.md/);
  });

  it('does NOT treat a non-404 failure of the existence check as "file absent"', async () => {
    const { client, calls } = stubClient([{ method: 'GET', path: `${R}/contents/docs/a.md`, reply: httpError(403, { message: 'rate limited' }) }]);
    await assert.rejects(ops.opCreateOrUpdateFile(client, args), (e: any) => e.status === 403);
    assert.ok(!calls.some(c => c.method === 'PUT'));
  });

  it('says when it overwrote without a conflict check', async () => {
    const { client, calls } = stubClient([
      { method: 'GET', path: `${R}/contents/docs/a.md`, reply: { type: 'file', sha: 'old', path: 'docs/a.md' } },
      { method: 'PUT', path: `${R}/contents/docs/a.md`, reply: { content: { sha: 'new' }, commit: { sha: 'c1' } } },
    ]);
    const out = await ops.opCreateOrUpdateFile(client, args);
    assert.equal(calls.find(c => c.method === 'PUT')!.body.sha, 'old');
    assert.match(out, /^Updated.*without checking/s);
  });

  it('refuses a directory', async () => {
    const { client } = stubClient([{ method: 'GET', path: `${R}/contents/docs/a.md`, reply: [] }]);
    await assert.rejects(ops.opCreateOrUpdateFile(client, args), /is a directory/);
  });
});

describe('opGetFileContents', () => {
  const file = (over: object) => ({ type: 'file', name: 'f', path: 'f', size: 5, sha: 'blob1', ...over });

  it('decodes text and surfaces the blob SHA', async () => {
    const { client } = stubClient([{ method: 'GET', path: `${R}/contents/f`, reply: file({ content: Buffer.from('hello').toString('base64'), encoding: 'base64' }) }]);
    const out = await ops.opGetFileContents(client, { owner: 'octo', repo: 'app', path: 'f' });
    assert.match(out, /Blob SHA: blob1/);
    assert.match(out, /--- content ---\nhello/);
  });

  it('describes a binary file instead of decoding it as garbage', async () => {
    const { client } = stubClient([{ method: 'GET', path: `${R}/contents/f`, reply: file({ content: Buffer.from([0x89, 0x50, 0, 1]).toString('base64'), encoding: 'base64', download_url: 'https://raw/x' }) }]);
    assert.match(await ops.opGetFileContents(client, { owner: 'octo', repo: 'app', path: 'f' }), /binary file.*https:\/\/raw\/x/s);
  });

  it('never reports a >1 MB file as empty', async () => {
    const { client } = stubClient([{ method: 'GET', path: `${R}/contents/f`, reply: file({ size: 5_000_000, content: '', encoding: 'none' }) }]);
    const out = await ops.opGetFileContents(client, { owner: 'octo', repo: 'app', path: 'f' });
    assert.match(out, /content was NOT returned/);
    assert.doesNotMatch(out, /--- content ---/);
  });

  it('truncates long text and says so', async () => {
    const big = 'x'.repeat(ops.FILE_CONTENT_MAX_CHARS + 10);
    const { client } = stubClient([{ method: 'GET', path: `${R}/contents/f`, reply: file({ content: Buffer.from(big).toString('base64'), encoding: 'base64' }) }]);
    assert.match(await ops.opGetFileContents(client, { owner: 'octo', repo: 'app', path: 'f' }), /file truncated: showing 100,000 of 100,010 characters/);
  });

  it('lists the root directory, folders first, passing ref through', async () => {
    const { client, calls } = stubClient([{ method: 'GET', path: `${R}/contents`, reply: [
      { type: 'file', name: 'b.md', path: 'b.md', size: 10, sha: '1' },
      { type: 'dir', name: 'src', path: 'src', size: 0, sha: '2' },
    ] }]);
    const out = await ops.opGetFileContents(client, { owner: 'octo', repo: 'app', path: '', ref: 'v1' });
    assert.equal(calls[0].query.ref, 'v1');
    assert.ok(out.indexOf('src/') < out.indexOf('b.md'));
  });
});

describe('opGetPullRequestStatus', () => {
  const routes = (statuses: unknown[], runs: unknown): Route[] => [
    { method: 'GET', path: `${R}/pulls/7`, reply: { head: { sha: 'headsha1' } } },
    { method: 'GET', path: `${R}/commits/headsha1/status`, reply: { state: 'pending', total_count: statuses.length, statuses } },
    { method: 'GET', path: `${R}/commits/headsha1/check-runs`, reply: runs },
  ];
  const args = { owner: 'octo', repo: 'app', pullNumber: 7 };

  it('reads Actions check runs — an Actions-only repo is not "pending forever"', async () => {
    const { client } = stubClient(routes([], { total_count: 2, check_runs: [
      { name: 'build', status: 'completed', conclusion: 'success' },
      { name: 'test', status: 'completed', conclusion: 'failure' },
    ] }));
    const out = await ops.opGetPullRequestStatus(client, args);
    assert.match(out, /FAILING \(1 failed\)/);
    assert.match(out, /test: failure/);
  });

  it('passes when everything passed', async () => {
    const { client } = stubClient(routes([{ state: 'success', context: 'ci/legacy', description: null, target_url: null }],
      { total_count: 1, check_runs: [{ name: 'build', status: 'completed', conclusion: 'skipped' }] }));
    assert.match(await ops.opGetPullRequestStatus(client, args), /PASSING/);
  });

  it('says no checks reported, rather than echoing the legacy "pending" of an empty status', async () => {
    const { client } = stubClient(routes([], { total_count: 0, check_runs: [] }));
    const out = await ops.opGetPullRequestStatus(client, args);
    assert.match(out, /NO CHECKS have reported/);
    assert.doesNotMatch(out, /PENDING/);
  });

  it('degrades to statuses when check runs cannot be read', async () => {
    const { client } = stubClient(routes([{ state: 'pending', context: 'ci', description: null, target_url: null }], httpError(403, { message: 'Resource not accessible by personal access token' })));
    const out = await ops.opGetPullRequestStatus(client, args);
    assert.match(out, /PENDING/);
    assert.match(out, /Check runs: could not be read/);
  });

  it('does not call green statuses PASSING when the check runs could not be read', async () => {
    const { client } = stubClient(routes([{ state: 'success', context: 'ci', description: null, target_url: null }], httpError(403, { message: 'Resource not accessible by personal access token' })));
    const out = await ops.opGetPullRequestStatus(client, args);
    assert.match(out, /UNKNOWN — every commit status passed, but check runs could not be read/);
    assert.doesNotMatch(out, /PASSING/);
  });

  it('does not call a truncated list PASSING: a failure may sit past the first page', async () => {
    const { client } = stubClient(routes([], { total_count: 140, check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] }));
    const out = await ops.opGetPullRequestStatus(client, args);
    assert.match(out, /UNKNOWN — the first 1 checks passed, but 139 more were not read/);
    assert.doesNotMatch(out, /PASSING/);
  });

  it('still reports a failure on the first page as FAILING, not UNKNOWN', async () => {
    const { client } = stubClient(routes([], { total_count: 140, check_runs: [{ name: 'build', status: 'completed', conclusion: 'failure' }] }));
    assert.match(await ops.opGetPullRequestStatus(client, args), /FAILING \(1 failed\)/);
  });
});

describe('issue ops', () => {
  it('createIssue flags labels and assignees GitHub silently dropped', async () => {
    const { client } = stubClient([{ method: 'POST', path: `${R}/issues`, reply: { number: 3, title: 't', html_url: 'u', labels: [{ name: 'Bug' }], assignees: [] } }]);
    const out = await ops.opCreateIssue(client, { owner: 'octo', repo: 'app', title: 't', labels: ['bug', 'p1'], assignees: ['ann'] });
    assert.match(out, /did not apply: labels \[p1\]; assignees \[ann\]/);
    assert.doesNotMatch(out, /\[bug/i, 'label matching is case-insensitive');
  });

  it('updateIssue refuses an empty update and a stateReason without a state', async () => {
    const { client, calls } = stubClient([]);
    await assert.rejects(ops.opUpdateIssue(client, { owner: 'octo', repo: 'app', issueNumber: 1 }), /Nothing to update/);
    await assert.rejects(ops.opUpdateIssue(client, { owner: 'octo', repo: 'app', issueNumber: 1, stateReason: 'completed' }), /only takes effect together with state/);
    await assert.rejects(ops.opUpdateIssue(client, { owner: 'octo', repo: 'app', issueNumber: 1, state: 'open', stateReason: 'not_planned' }), /does not go with/);
    assert.equal(calls.length, 0);
  });

  it('updateIssue sends only the given fields, mapping stateReason and a null milestone', async () => {
    const { client, calls } = stubClient([{ method: 'PATCH', path: `${R}/issues/1`, reply: { number: 1, title: 't', state: 'closed', state_reason: 'not_planned', labels: [], assignees: [], html_url: 'u' } }]);
    await ops.opUpdateIssue(client, { owner: 'octo', repo: 'app', issueNumber: 1, state: 'closed', stateReason: 'not_planned', milestone: null });
    assert.deepEqual(calls[0].body, { state: 'closed', state_reason: 'not_planned', milestone: null });
  });

  it('listIssues marks pull requests and joins labels with commas', async () => {
    const { client, calls } = stubClient([{ method: 'GET', path: `${R}/issues`, page: { next: 2 }, reply: [
      { number: 1, title: 'bug', state: 'open', user: { login: 'a' }, labels: [], comments: 0, created_at: '', updated_at: '2026-01-02T00:00:00Z', html_url: '' },
      { number: 2, title: 'pr', state: 'open', user: { login: 'b' }, labels: [], comments: 1, created_at: '', updated_at: '2026-01-02T00:00:00Z', html_url: '', pull_request: {} },
    ] }]);
    const out = await ops.opListIssues(client, { owner: 'octo', repo: 'app', labels: ['a', 'b'] });
    assert.equal(calls[0].query.labels, 'a,b');
    assert.match(out, /#2 \[PR\]/);
    assert.match(out, /1 of these are pull requests/);
    assert.match(out, /page=2/);
  });
});

describe('repository and pull request writes map camelCase onto GitHub\'s fields', () => {
  it('createRepository sends auto_init (the reference sent autoInit, which GitHub ignores)', async () => {
    const { client, calls } = stubClient([{ method: 'POST', path: '/user/repos', reply: { full_name: 'me/x', private: true, html_url: 'u', default_branch: 'main' } }]);
    await ops.opCreateRepository(client, { name: 'x', private: true, autoInit: true });
    assert.equal(calls[0].body.auto_init, true);
    assert.equal(calls[0].body.autoInit, undefined);
  });

  it('mergePullRequest forwards expectedHeadSha as GitHub\'s sha guard', async () => {
    const { client, calls } = stubClient([{ method: 'GET', path: `${R}/pulls/4`, reply: { number: 4, state: 'open', merged: false } }, { method: 'PUT', path: `${R}/pulls/4/merge`, reply: { merged: true, sha: 'm1', message: 'ok' } }]);
    await ops.opMergePullRequest(client, { owner: 'octo', repo: 'app', pullNumber: 4, mergeMethod: 'squash', expectedHeadSha: 'h1' });
    assert.deepEqual(calls.find(c => c.method === 'PUT')!.body, { merge_method: 'squash', commit_title: undefined, commit_message: undefined, sha: 'h1' });
  });

  it('createPullRequestReview validates before submitting anything', async () => {
    const { client, calls } = stubClient([]);
    const base = { owner: 'octo', repo: 'app', pullNumber: 4 };
    await assert.rejects(ops.opCreatePullRequestReview(client, { ...base, event: 'REQUEST_CHANGES' }), /needs a body/);
    await assert.rejects(ops.opCreatePullRequestReview(client, { ...base, event: 'APPROVE', comments: [{ path: 'a', body: 'b' }] }), /exactly one of line or position/);
    await assert.rejects(ops.opCreatePullRequestReview(client, { ...base, event: 'APPROVE', comments: [{ path: 'a', body: 'b', position: 2, side: 'LEFT' }] }), /side only applies with line/);
    assert.equal(calls.length, 0);
  });

  it('forkRepository says when GitHub returned an existing fork rather than making one', async () => {
    const { client } = stubClient([{ method: 'POST', path: `${R}/forks`, status: 202, reply: { full_name: 'me/app', html_url: 'u', created_at: '2020-01-01T00:00:00Z' } }]);
    assert.match(await ops.opForkRepository(client, { owner: 'octo', repo: 'app' }), /already existed.*Nothing new was created/s);
  });
});

describe('remaining reads render what GitHub returned, and say where the page is', () => {
  const user = { login: 'ann' };

  it('searchRepositories numbers across pages and flags an incomplete search', async () => {
    const { client, calls } = stubClient([{ method: 'GET', path: '/search/repositories', page: { next: 3 }, reply: {
      total_count: 1500, incomplete_results: true,
      items: [{ full_name: 'a/b', description: 'd', private: true, html_url: 'u', stargazers_count: 5, language: 'Go', updated_at: '2026-01-02T00:00:00Z' }],
    } }]);
    const out = await ops.opSearchRepositories(client, { query: 'mcp', page: 2, perPage: 10 });
    assert.equal(calls[0].query.per_page, 10);
    assert.match(out, /^Found 1,500 repositories/);
    assert.match(out, /INCOMPLETE/);
    assert.match(out, /only ever returns the first 1,000/);
    assert.match(out, /11\. a\/b — ★5 · Go · private/);
    assert.match(out, /page=3/);
  });

  it('searchCode asks for text matches and shows fragments', async () => {
    const { client } = stubClient([{ method: 'GET', path: '/search/code', reply: {
      total_count: 1, incomplete_results: false,
      items: [{ path: 'src/a.ts', html_url: 'u', repository: { full_name: 'o/r' }, text_matches: [{ fragment: 'const   x\n= 1' }] }],
    } }]);
    const out = await ops.opSearchCode(client, { query: 'x' });
    assert.match(out, /o\/r — src\/a\.ts/);
    assert.match(out, /> const x = 1/);
    assert.equal(ops.READS.searchCode({ query: 'x' }).accept, 'application/vnd.github.text-match+json');
  });

  it('searchIssues names each result\'s repository; searchUsers marks organizations', async () => {
    const { client } = stubClient([
      { method: 'GET', path: '/search/issues', reply: { total_count: 1, incomplete_results: false, items: [
        { number: 9, title: 'T', state: 'open', user, labels: ['bug'], comments: 0, created_at: '', updated_at: '2026-01-01', html_url: 'u', repository_url: 'https://api.github.com/repos/o/r', pull_request: {} },
      ] } },
      { method: 'GET', path: '/search/users', reply: { total_count: 2, incomplete_results: false, items: [{ login: 'ann', type: 'User', html_url: 'u1' }, { login: 'acme', type: 'Organization', html_url: 'u2' }] } },
    ]);
    assert.match(await ops.opSearchIssues(client, { query: 'x' }), /o\/r#9 \[PR\] \[open\] T .*labels: bug/);
    const users = await ops.opSearchUsers(client, { query: 'x' });
    assert.match(users, /- ann — u1/);
    assert.match(users, /- acme \(Organization\)/);
  });

  it('listCommits maps filters and shows the first line of each message', async () => {
    const { client, calls } = stubClient([{ method: 'GET', path: `${R}/commits`, reply: [
      { sha: 'abcdef123456', html_url: 'u', author: null, commit: { message: 'fix: thing\n\nbody', author: { name: 'Ann', date: '2026-02-03T00:00:00Z' } } },
    ] }]);
    const out = await ops.opListCommits(client, { owner: 'octo', repo: 'app', sha: 'dev', path: 'src', author: 'ann' });
    assert.deepEqual([calls[0].query.sha, calls[0].query.path, calls[0].query.author], ['dev', 'src', 'ann']);
    assert.match(out, /- abcdef1 2026-02-03 Ann: fix: thing$/m);
  });

  it('empty lists say so, and an empty later page says it is past the end', async () => {
    const empty = () => stubClient([
      { method: 'GET', path: /.*/, reply: [] },
    ]).client;
    assert.match(await ops.opListCommits(empty(), { owner: 'octo', repo: 'app' }), /No commits found/);
    assert.match(await ops.opListIssues(empty(), { owner: 'octo', repo: 'app', page: 3 }), /past the last page/);
    assert.match(await ops.opListPullRequests(empty(), { owner: 'octo', repo: 'app' }), /No open pull requests/);
    assert.match(await ops.opGetPullRequestFiles(empty(), { owner: 'octo', repo: 'app', pullNumber: 1, includePatch: true }), /changes no files/);
    assert.match(await ops.opGetPullRequestComments(empty(), { owner: 'octo', repo: 'app', pullNumber: 1 }), /No inline review comments/);
    assert.match(await ops.opGetPullRequestReviews(empty(), { owner: 'octo', repo: 'app', pullNumber: 1, page: 2 }), /past the last page/);
  });

  const pr = {
    number: 4, title: 'Add', state: 'open', draft: true, user, mergeable: null,
    head: { ref: 'f', sha: 'headsha', label: 'octo:f' }, base: { ref: 'main', sha: 'basesha123' },
    html_url: 'u', body: 'desc', created_at: 'c', updated_at: 'u', labels: [], requested_reviewers: [user],
  };

  it('getPullRequest says when mergeability is still being computed', async () => {
    const { client } = stubClient([{ method: 'GET', path: `${R}/pulls/4`, reply: pr }]);
    const out = await ops.opGetPullRequest(client, { owner: 'octo', repo: 'app', pullNumber: 4 });
    assert.match(out, /State: draft/);
    assert.match(out, /not computed yet/);
    assert.match(out, /Head: octo:f @ headsha/);
    assert.match(out, /Requested reviewers: @ann/);
  });

  it('listPullRequests shows merged ones as merged', async () => {
    const { client } = stubClient([{ method: 'GET', path: `${R}/pulls`, reply: [{ ...pr, state: 'closed', draft: false, merged_at: '2026-01-01' }] }]);
    assert.match(await ops.opListPullRequests(client, { owner: 'octo', repo: 'app', state: 'all' }), /#4 \[merged\] Add/);
  });

  it('getPullRequestFiles caps a diff and explains a missing one', async () => {
    const { client } = stubClient([{ method: 'GET', path: `${R}/pulls/4/files`, reply: [
      { filename: 'big.ts', status: 'modified', additions: 1, deletions: 1, patch: 'x'.repeat(5000) },
      { filename: 'img.png', status: 'added', additions: 0, deletions: 0 },
      { filename: 'new.ts', previous_filename: 'old.ts', status: 'renamed', additions: 0, deletions: 0 },
    ] }]);
    const out = await ops.opGetPullRequestFiles(client, { owner: 'octo', repo: 'app', pullNumber: 4, includePatch: true });
    assert.match(out, /diff truncated: showing 3,000 of 5,000/);
    assert.match(out, /A img\.png[\s\S]*binary file, or too large/);
    assert.match(out, /R old\.ts → new\.ts/);
  });

  it('review comments mark outdated lines and replies; reviews show verdicts', async () => {
    const { client } = stubClient([
      { method: 'GET', path: `${R}/pulls/4/comments`, reply: [{ id: 1, user, body: 'nit', path: 'a.ts', line: null, original_line: 7, in_reply_to_id: 99, created_at: '2026-01-01', html_url: 'u' }] },
      { method: 'GET', path: `${R}/pulls/4/reviews`, reply: [{ id: 2, user, state: 'APPROVED', body: 'lgtm', submitted_at: '2026-01-02', html_url: 'u' }] },
    ]);
    assert.match(await ops.opGetPullRequestComments(client, { owner: 'octo', repo: 'app', pullNumber: 4 }), /a\.ts:7 \(outdated\).*reply to 99/);
    assert.match(await ops.opGetPullRequestReviews(client, { owner: 'octo', repo: 'app', pullNumber: 4 }), /@ann: APPROVED · 2026-01-02\n {2}lgtm/);
  });

  it('getIssue points a pull request at getPullRequest and caps the body', async () => {
    const { client } = stubClient([{ method: 'GET', path: `${R}/issues/4`, reply: {
      number: 4, title: 'T', state: 'closed', state_reason: 'completed', user, labels: [], assignees: [], milestone: { number: 2, title: 'v1' },
      comments: 3, created_at: 'c', updated_at: 'u', closed_at: 'x', html_url: 'u', body: 'b'.repeat(25_000), pull_request: {},
    } }]);
    const out = await ops.opGetIssue(client, { owner: 'octo', repo: 'app', issueNumber: 4 });
    assert.match(out, /^Pull request #4/);
    assert.match(out, /State: closed \(completed\)/);
    assert.match(out, /Milestone: v1 \(#2\)/);
    assert.match(out, /use getPullRequest/);
    assert.match(out, /body truncated/);
  });

  it('getFileContents describes symlinks and submodules instead of reading them', async () => {
    const { client } = stubClient([
      { method: 'GET', path: `${R}/contents/l`, reply: { type: 'symlink', path: 'l', target: '../x', size: 0, sha: 's', name: 'l' } },
      { method: 'GET', path: `${R}/contents/m`, reply: { type: 'submodule', path: 'm', submodule_git_url: 'git://x', size: 0, sha: 's', name: 'm' } },
    ]);
    assert.match(await ops.opGetFileContents(client, { owner: 'octo', repo: 'app', path: 'l' }), /symlink to \.\.\/x/);
    assert.match(await ops.opGetFileContents(client, { owner: 'octo', repo: 'app', path: 'm' }), /submodule pointing at git:\/\/x/);
  });
});

describe('remaining writes', () => {
  it('createRepository without autoInit says the repo has no branch yet', async () => {
    const { client } = stubClient([{ method: 'POST', path: '/user/repos', reply: { full_name: 'me/x', private: false, html_url: 'u' } }]);
    assert.match(await ops.opCreateRepository(client, { name: 'x' }), /public[\s\S]*no commits yet/);
  });

  it('forkRepository reports a fresh fork as asynchronous, and passes the organization', async () => {
    const { client, calls } = stubClient([{ method: 'POST', path: `${R}/forks`, reply: { full_name: 'acme/app', html_url: 'u', created_at: new Date().toISOString() } }]);
    const out = await ops.opForkRepository(client, { owner: 'octo', repo: 'app', organization: 'acme' });
    assert.deepEqual(calls[0].body, { organization: 'acme' });
    assert.match(out, /Forked octo\/app to acme\/app[\s\S]*asynchronously/);
  });

  it('createPullRequest maps maintainerCanModify; addIssueComment returns the comment URL', async () => {
    const { client, calls } = stubClient([
      { method: 'POST', path: `${R}/pulls`, reply: { number: 8, title: 'T', draft: true, head: { ref: 'f', sha: 's', label: 'octo:f' }, base: { ref: 'main', sha: 'b' }, html_url: 'u', user: null, state: 'open', created_at: '', updated_at: '' } },
      { method: 'POST', path: `${R}/issues/3/comments`, reply: { id: 1, html_url: 'https://c' } },
    ]);
    assert.match(await ops.opCreatePullRequest(client, { owner: 'octo', repo: 'app', title: 'T', head: 'f', base: 'main', draft: true, maintainerCanModify: false }), /Created draft pull request #8/);
    assert.equal(calls[0].body.maintainer_can_modify, false);
    assert.match(await ops.opAddIssueComment(client, { owner: 'octo', repo: 'app', issueNumber: 3, body: 'x' }), /https:\/\/c/);
  });

  it('createPullRequestReview submits inline comments in GitHub\'s field names', async () => {
    const { client, calls } = stubClient([{ method: 'POST', path: `${R}/pulls/4/reviews`, reply: { id: 1, state: 'CHANGES_REQUESTED', html_url: 'u' } }]);
    const out = await ops.opCreatePullRequestReview(client, { owner: 'octo', repo: 'app', pullNumber: 4, event: 'REQUEST_CHANGES', body: 'fix', commitId: 'c1', comments: [{ path: 'a', body: 'here', line: 3, side: 'RIGHT' }] });
    assert.equal(calls[0].body.commit_id, 'c1');
    assert.deepEqual(calls[0].body.comments, [{ path: 'a', body: 'here', line: 3, side: 'RIGHT', position: undefined }]);
    assert.match(out, /CHANGES_REQUESTED with 1 inline comment/);
  });

  it('mergePullRequest reports a merge GitHub declined', async () => {
    const { client } = stubClient([{ method: 'GET', path: `${R}/pulls/4`, reply: { number: 4, state: 'open', merged: false } }, { method: 'PUT', path: `${R}/pulls/4/merge`, reply: { merged: false, sha: '', message: 'Base branch was modified' } }]);
    assert.match(await ops.opMergePullRequest(client, { owner: 'octo', repo: 'app', pullNumber: 4 }), /did NOT merge.*Base branch was modified/);
  });

  it('mergePullRequest on an ALREADY-merged PR says so and merges nothing (GitHub would answer success)', async () => {
    const { client, calls } = stubClient([{ method: 'GET', path: `${R}/pulls/2`, reply: {
      number: 2, state: 'closed', merged: true, merged_at: '2026-10-20T10:00:00Z', merged_by: { login: 'ann' }, merge_commit_sha: 'sq1',
    } }]);
    const out = await ops.opMergePullRequest(client, { owner: 'octo', repo: 'app', pullNumber: 2, mergeMethod: 'merge' });
    assert.match(out, /^#2 was already merged by @ann on 2026-10-20; nothing was merged by this call\. Merge commit: sq1$/);
    assert.doesNotMatch(out, /\(merge\)/, 'no merge method is claimed for a merge this call did not make');
    assert.deepEqual(calls.map(c => c.method), ['GET']);
  });

  it('mergePullRequest refuses a closed, unmerged PR with 409 before calling merge', async () => {
    const { client, calls } = stubClient([{ method: 'GET', path: `${R}/pulls/5`, reply: { number: 5, state: 'closed', merged: false } }]);
    await assert.rejects(ops.opMergePullRequest(client, { owner: 'octo', repo: 'app', pullNumber: 5 }), (e: any) => {
      assert.match(e.message, /closed without being merged; reopen it/);
      assert.equal(e.status, 409);
      return true;
    });
    assert.deepEqual(calls.map(c => c.method), ['GET']);
  });

  it('refuses .github/workflows/ writes up front, naming the real reason instead of GitHub\'s 404', async () => {
    const { client, calls } = stubClient([]);
    await assert.rejects(ops.opPushFiles(client, { owner: 'octo', repo: 'app', branch: 'main', message: 'm', files: [
      { path: 'README.md', content: 'x' }, { path: '.github/workflows/ci.yml', content: 'y' },
    ] }), (e: any) => {
      assert.match(e.message, /"\.github\/workflows\/ci\.yml" is a GitHub Actions workflow file/);
      assert.match(e.message, /does not request the `workflow` scope/);
      assert.equal(e.status, 403);
      return true;
    });
    await assert.rejects(ops.opCreateOrUpdateFile(client, { owner: 'octo', repo: 'app', path: './.github/workflows/x.yml', content: 'y', message: 'm', branch: 'main' } as any), /workflow file/);
    assert.equal(calls.length, 0, 'nothing reached GitHub — not even a blob');
    // Only the workflows directory: other .github files are ordinary.
    ops.assertNoWorkflowPaths(['.github/CODEOWNERS', '.github/dependabot.yml', 'docs/.github/workflows/x.yml']);
  });

  it('updatePullRequestBranch sends the head guard and says it is asynchronous', async () => {
    const { client, calls } = stubClient([{ method: 'PUT', path: `${R}/pulls/4/update-branch`, reply: { message: 'Updating pull request branch.' } }]);
    const out = await ops.opUpdatePullRequestBranch(client, { owner: 'octo', repo: 'app', pullNumber: 4, expectedHeadSha: 'h' });
    assert.deepEqual(calls[0].body, { expected_head_sha: 'h' });
    assert.match(out, /asynchronously/);
  });

  it('pushFiles notes paths whose old mode it could not see in a truncated tree', async () => {
    const { client } = stubClient([
      { method: 'GET', path: `${R}/git/ref/heads/main`, reply: { object: { sha: 'h' } } },
      { method: 'GET', path: `${R}/git/commits/h`, reply: { tree: { sha: 't' } } },
      { method: 'GET', path: `${R}/git/trees/t`, reply: { truncated: true, tree: [] } },
      { method: 'POST', path: `${R}/git/trees`, reply: { sha: 't2' } },
      { method: 'POST', path: `${R}/git/commits`, reply: { sha: 'c' } },
      { method: 'PATCH', path: `${R}/git/refs/heads/main`, reply: {} },
    ]);
    const out = await ops.opPushFiles(client, { owner: 'octo', repo: 'app', branch: 'main', message: 'm', files: [{ path: 'deep/x.sh', content: '' }] });
    assert.match(out, /too large for GitHub to list in full[\s\S]*deep\/x\.sh/);
  });
});
