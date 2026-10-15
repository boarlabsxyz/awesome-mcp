// src/__tests__/github/ops.test.ts
// Drives the GitHub op* functions against a stubbed client, asserting the
// request shapes and rendered text — with most weight on the behaviours that
// deliberately differ from the reference implementation (see ops.ts header).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UserError } from 'fastmcp';

import type { GitHubClient, PageInfo } from '../../github/apiHelpers.js';
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
    const { client, calls } = stubClient([{ method: 'PUT', path: `${R}/pulls/4/merge`, reply: { merged: true, sha: 'm1', message: 'ok' } }]);
    await ops.opMergePullRequest(client, { owner: 'octo', repo: 'app', pullNumber: 4, mergeMethod: 'squash', expectedHeadSha: 'h1' });
    assert.deepEqual(calls[0].body, { merge_method: 'squash', commit_title: undefined, commit_message: undefined, sha: 'h1' });
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
