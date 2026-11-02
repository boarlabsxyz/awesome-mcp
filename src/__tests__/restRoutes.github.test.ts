import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { UserTokens } from '../userStore.js';
import type { GoogleTokens } from '../mcpConnectionStore.js';

// A throwaway store, set before anything reads DATA_DIR. The shared on-disk
// store keeps every connection earlier runs created, and REST auth resolves
// the user's FIRST GitHub connection — so a test that puts access rules on the
// one it just created would be testing a different connector.
const dataDir = mkdtempSync(join(tmpdir(), 'rest-github-'));
process.env.DATA_DIR = dataDir;
delete process.env.DATABASE_URL;

const { createWebOnlyApp } = await import('../website/webServer.js');
const { createOrUpdateUser, getUserByGoogleId } = await import('../userStore.js');
const { createMcpInstance, updateMcpInstanceProviderTokens } = await import('../mcpConnectionStore.js');

// Drives the /api/v1/github/* handler bodies end to end: real auth (a
// file-store user plus a GitHub connection), real routing and validation, and
// a stubbed global fetch standing in for api.github.com. Same harness as
// restRoutes.providers.test.ts, plus response HEADERS — GitHub's pagination and
// rate-limit answers live there, and the status mapping is what is under test.

if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: {
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:8080/auth/callback'],
    },
  });
}

const USER_ID = 8811;
const OTHER_USER_ID = 8812;
const tokens: UserTokens = { access_token: 'acc', refresh_token: 'ref', scope: 'email', token_type: 'Bearer', expiry_date: Date.now() + 3600_000 };
const googleTokens: GoogleTokens = { access_token: 'mcp-acc', refresh_token: 'mcp-ref', scope: 'email', token_type: 'Bearer', expiry_date: Date.now() + 3600_000 };

interface Recorded { url: string; method: string; body: any; headers: Record<string, string> }
interface Canned { status?: number; json?: unknown; headers?: Record<string, string> }

const realFetch = globalThis.fetch;
let calls: Recorded[] = [];
/** [method, url-substring, reply]; first match wins. */
let rules: Array<[string, string, Canned]> = [];

function stubFetch(): void {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined, headers: init.headers ?? {} });
    const hit = rules.find(([m, frag]) => m === method && url.includes(frag))?.[2] ?? { status: 599, json: { message: `unstubbed ${method} ${url}` } };
    return new Response(hit.json === undefined ? null : JSON.stringify(hit.json), {
      status: hit.status ?? 200,
      headers: { 'content-type': 'application/json', ...hit.headers },
    });
  }) as typeof fetch;
}

const when = (method: string, fragment: string, canned: Canned) => rules.push([method, fragment, canned]);
const G = '/api/v1/github/repos/octo/app';
const UP = 'https://api.github.com/repos/octo/app';

describe('REST data plane: GitHub handler bodies', () => {
  const app = createWebOnlyApp();
  let bearer: string;
  let otherBearer: string;
  let githubInstanceId: string;

  before(async () => {
    const created = await createOrUpdateUser({ email: 'rest-github@example.com', googleId: 'google-rest-github', name: 'GH' }, tokens);
    bearer = created.apiKey;
    const user = await getUserByGoogleId('google-rest-github');
    if (user) (user as any).id = USER_ID;
    githubInstanceId = (await createMcpInstance(USER_ID, 'github', 'GitHub (octo)', googleTokens, null, 'github', { access_token: 'ghp_rest_test_token' }, null)).instanceId;

    // A user with no GitHub connection at all.
    const other = await createOrUpdateUser({ email: 'rest-github-none@example.com', googleId: 'google-rest-github-none', name: 'None' }, tokens);
    otherBearer = other.apiKey;
    const otherUser = await getUserByGoogleId('google-rest-github-none');
    if (otherUser) (otherUser as any).id = OTHER_USER_ID;

    stubFetch();
  });

  after(() => {
    globalThis.fetch = realFetch;
    rmSync(dataDir, { recursive: true, force: true });
  });
  beforeEach(() => { calls = []; rules = []; });

  const auth = () => ({ Authorization: `Bearer ${bearer}` });

  describe('access rules', () => {
    // The API key reaches exactly what the MCP tools do: the rules are applied
    // inside GitHubClient, which both surfaces share.
    before(async () => {
      await updateMcpInstanceProviderTokens(githubInstanceId, {
        access_token: 'ghp_rest_test_token', accessRules: { allowedOwners: ['octo'] },
      } as any);
    });
    after(async () => {
      await updateMcpInstanceProviderTokens(githubInstanceId, { access_token: 'ghp_rest_test_token' } as any);
    });

    it('answers 403 for an excluded owner without calling GitHub', async () => {
      const res = await request(app).get('/api/v1/github/repos/elsewhere/app/issues').set(auth());
      assert.equal(res.status, 403);
      assert.match(res.body.error, /do not allow "elsewhere"/);
      assert.equal(calls.length, 0);
    });

    it('refuses a write into an excluded owner the same way', async () => {
      const res = await request(app).post('/api/v1/github/repos/elsewhere/app/issues').set(auth()).send({ title: 't' });
      assert.equal(res.status, 403);
      assert.equal(calls.length, 0);
    });

    it('refuses a fork into an excluded organization, which only the body names', async () => {
      const res = await request(app).post(`${G}/forks`).set(auth()).send({ organization: 'elsewhere' });
      assert.equal(res.status, 403);
      assert.equal(calls.length, 0);
    });

    for (const path of ['pulls', 'branches', 'issues/1', 'pulls/1/reviews', 'pulls/1/update-branch']) {
      it(`refuses POST ${path} into an excluded owner`, async () => {
        const res = await request(app).post(`/api/v1/github/repos/elsewhere/app/${path}`).set(auth())
          .send({ title: 't', head: 'h', base: 'b', branch: 'x', event: 'APPROVE', state: 'closed' });
        assert.equal(res.status, 403);
        assert.equal(calls.length, 0);
      });
    }

    it('reports the rules alongside the organizations they exclude', async () => {
      when('GET', 'api.github.com/user/orgs', { json: [{ login: 'octo' }, { login: 'elsewhere' }] });
      when('GET', 'api.github.com/users/me/orgs', { json: [] });
      when('GET', 'api.github.com/user/repos', { json: [] });
      when('GET', 'api.github.com/user', { json: { login: 'me' } });
      const res = await request(app).get('/api/v1/github/organizations').set(auth());
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.accessRules, ['octo']);
      const allowed = Object.fromEntries(res.body.organizations.map((o: any) => [o.login, o.allowed]));
      assert.equal(allowed.elsewhere, false);
      assert.equal(allowed.octo, true);
    });

    it('still serves an allowed owner', async () => {
      when('GET', `${UP}/issues/1`, { json: { number: 1 } });
      assert.equal((await request(app).get(`${G}/issues/1`).set(auth())).status, 200);
    });

    it('filters search hits and says how many it hid', async () => {
      when('GET', '/search/issues', { json: { total_count: 2, incomplete_results: false, items: [
        { number: 1, repository_url: 'https://api.github.com/repos/octo/app' },
        { number: 2, repository_url: 'https://api.github.com/repos/elsewhere/app' },
      ] } });
      const res = await request(app).get('/api/v1/github/search/issues?q=bug').set(auth());
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.items.map((i: any) => i.number), [1]);
      assert.equal(res.body.hiddenByAccessRules, 1);
      assert.equal(res.body.total_count, 2);
    });
  });

  describe('reads', () => {
    it('lists issues as {items, page}, mapping query params onto GitHub\'s and reading Link for the next page', async () => {
      when('GET', `${UP}/issues`, {
        json: [{ number: 1, title: 'Bug', state: 'open', labels: [], comments: 0, user: { login: 'a' }, created_at: '', updated_at: '', html_url: '' }],
        headers: { link: `<${UP}/issues?page=3>; rel="next", <${UP}/issues?page=5>; rel="last"` },
      });
      const res = await request(app).get(`${G}/issues?labels=bug,p1&state=all&page=2&perPage=50`).set(auth());
      assert.equal(res.status, 200);
      assert.equal(res.body.items[0].title, 'Bug');
      assert.deepEqual(res.body.page, { next: 3, last: 5 });
      const sent = new URL(calls[0].url);
      assert.equal(sent.searchParams.get('labels'), 'bug,p1');
      assert.equal(sent.searchParams.get('per_page'), '50');
      assert.equal(calls[0].headers.Authorization, 'Bearer ghp_rest_test_token');
    });

    it('renders the MCP tool\'s text on ?format=text', async () => {
      when('GET', `${UP}/issues/12`, { json: { number: 12, title: 'Crash', state: 'open', labels: [], comments: 2, user: { login: 'a' }, created_at: 'c', updated_at: 'u', html_url: 'h', body: 'details' } });
      const res = await request(app).get(`${G}/issues/12?format=text`).set(auth());
      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /text\/plain/);
      assert.match(res.text, /^Issue #12 in octo\/app: Crash/);
    });

    it('maps the contents wildcard onto the file path, and the bare route onto the root', async () => {
      when('GET', `${UP}/contents`, { json: [] });
      await request(app).get(`${G}/contents/src/lib/index.ts?ref=main`).set(auth());
      await request(app).get(`${G}/contents`).set(auth());
      assert.equal(new URL(calls[0].url).pathname, '/repos/octo/app/contents/src/lib/index.ts');
      assert.equal(new URL(calls[0].url).searchParams.get('ref'), 'main');
      assert.equal(new URL(calls[1].url).pathname, '/repos/octo/app/contents');
    });

    it('answers search with GitHub\'s totals plus the page', async () => {
      when('GET', '/search/repositories', { json: { total_count: 2, incomplete_results: true, items: [{ full_name: 'a/b' }] } });
      const res = await request(app).get('/api/v1/github/search/repositories?q=mcp').set(auth());
      assert.equal(res.body.total_count, 2);
      assert.equal(res.body.incomplete_results, true);
      assert.deepEqual(res.body.page, { next: null, last: null });
    });

    it('answers the PR checks route with the structured verdict', async () => {
      when('GET', `${UP}/pulls/7`, { json: { head: { sha: 'abc123' } } });
      when('GET', '/commits/abc123/status', { json: { total_count: 0, statuses: [] } });
      when('GET', '/commits/abc123/check-runs', { json: { total_count: 1, check_runs: [{ name: 'ci', status: 'completed', conclusion: 'failure' }] } });
      const res = await request(app).get(`${G}/pulls/7/status`).set(auth());
      assert.equal(res.status, 200);
      assert.equal(res.body.verdict, 'failing');
      assert.equal(res.body.headSha, 'abc123');
    });

    it('answers unknown, not passing, when green checks run past the first page', async () => {
      when('GET', `${UP}/pulls/7`, { json: { head: { sha: 'abc123' } } });
      when('GET', '/commits/abc123/status', { json: { total_count: 0, statuses: [] } });
      when('GET', '/commits/abc123/check-runs', { json: { total_count: 101, check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] } });
      const res = await request(app).get(`${G}/pulls/7/status`).set(auth());
      assert.equal(res.body.verdict, 'unknown');
      assert.equal(res.body.unread, 100);
    });

    it('rejects a query the tool\'s schema rejects, before calling GitHub', async () => {
      for (const path of [`${G}/issues?perPage=500`, `${G}/issues/abc`, '/api/v1/github/search/code', `${G}/issues?state=sideways`]) {
        const res = await request(app).get(path).set(auth());
        assert.equal(res.status, 400, path);
        assert.ok(res.body.issues, path);
      }
      assert.equal(calls.length, 0);
    });
  });

  describe('organizations', () => {
    const stubOrganizations = () => {
      when('GET', 'api.github.com/user/orgs', { json: [{ login: 'octo' }] });
      when('GET', 'api.github.com/users/me/orgs', { json: [] });
      when('GET', 'api.github.com/user/repos', { json: [{ owner: { login: 'octo', type: 'Organization' } }] });
      when('GET', 'api.github.com/user', { json: { login: 'me' } });
    };

    it('answers JSON with no rules on an unrestricted connection', async () => {
      stubOrganizations();
      const res = await request(app).get('/api/v1/github/organizations').set(auth());
      assert.equal(res.status, 200);
      assert.equal(res.body.account, 'me');
      assert.equal(res.body.accessRules, null);
      assert.equal(res.body.organizations[0].login, 'octo');
      assert.equal(res.body.organizations[0].allowed, true);
      assert.equal(typeof res.body.truncated, 'boolean');
    });

    it('answers with the MCP tool text on ?format=text', async () => {
      stubOrganizations();
      const res = await request(app).get('/api/v1/github/organizations?format=text').set(auth());
      assert.equal(res.status, 200);
      assert.match(res.text, /GitHub account: me/);
    });
  });

  describe('status mapping', () => {
    it('a used-up rate limit is 429 with Retry-After, not "Permission denied"', async () => {
      const reset = Math.floor(Date.now() / 1000) + 120;
      when('GET', `${UP}/pulls`, { status: 403, json: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } });
      const res = await request(app).get(`${G}/pulls`).set(auth());
      assert.equal(res.status, 429);
      assert.ok(Number(res.headers['retry-after']) > 0);
      assert.match(res.body.error, /rate limit/);
    });

    it('a rejected stored credential is 502, never an echoed 401', async () => {
      when('GET', `${UP}/pulls`, { status: 401, json: { message: 'Bad credentials' } });
      const res = await request(app).get(`${G}/pulls`).set(auth());
      assert.equal(res.status, 502);
      assert.match(res.body.error, /Reconnect GitHub/);
    });

    it('a 404 stays 404 and says it may be a visibility problem', async () => {
      when('GET', `${UP}/pulls/99`, { status: 404, json: { message: 'Not Found' } });
      const res = await request(app).get(`${G}/pulls/99`).set(auth());
      assert.equal(res.status, 404);
      assert.match(res.body.error, /does not exist, a name is misspelled, or the connected account has no access/);
    });

    it('a user with no GitHub connection gets 403, not a crash', async () => {
      const res = await request(app).get(`${G}/pulls`).set({ Authorization: `Bearer ${otherBearer}` });
      assert.equal(res.status, 403);
      assert.match(res.body.error, /GitHub connection required/);
      assert.equal(calls.length, 0);
    });
  });

  describe('writes', () => {
    it('creates an issue (201), with path params winning over the body and dropped labels reported', async () => {
      when('POST', `${UP}/issues`, { status: 201, json: { number: 5, title: 'T', labels: [], assignees: [], html_url: 'h' } });
      const res = await request(app).post(`${G}/issues`).set(auth()).send({ owner: 'evil', repo: 'elsewhere', title: 'T', labels: ['bug'] });
      assert.equal(res.status, 201);
      assert.equal(res.body.issue.number, 5);
      assert.deepEqual(res.body.notApplied, ['labels [bug]']);
      assert.ok(calls[0].url.startsWith(`${UP}/issues`), 'the URL, not the body, picks the repository');
    });

    it('comments on an issue (201)', async () => {
      when('POST', `${UP}/issues/12/comments`, { status: 201, json: { id: 9, html_url: 'h' } });
      const res = await request(app).post(`${G}/issues/12/comments`).set(auth()).send({ body: 'CI passed' });
      assert.equal(res.status, 201);
      assert.equal(res.body.id, 9);
    });

    const stubPush = () => {
      when('GET', '/git/ref/heads/main', { json: { object: { sha: 'head1' } } });
      when('GET', '/git/commits/head1', { json: { tree: { sha: 'tree1' } } });
      when('GET', '/git/trees/tree1', { json: { truncated: false, tree: [] } });
      when('POST', '/git/trees', { status: 201, json: { sha: 'tree2' } });
      when('POST', '/git/commits', { status: 201, json: { sha: 'c2' } });
    };

    it('pushes a body far past the 100 kb default (201), fast-forward only', async () => {
      stubPush();
      when('PATCH', '/git/refs/heads/main', { json: {} });
      const big = 'x'.repeat(300_000);
      const res = await request(app).post(`${G}/push`).set(auth()).send({ branch: 'main', message: 'gen', files: [{ path: 'gen/a.txt', content: big }] });
      assert.equal(res.status, 201, `expected a commit, got ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
      assert.equal(res.body.commitSha, 'c2');
      assert.equal(calls.find(c => c.method === 'PATCH')!.body.force, false);
    });

    it('answers 409 when the branch moved during the push', async () => {
      stubPush();
      when('PATCH', '/git/refs/heads/main', { status: 422, json: { message: 'Update is not a fast forward' } });
      const res = await request(app).post(`${G}/push`).set(auth()).send({ branch: 'main', message: 'm', files: [{ path: 'a', content: 'x' }] });
      assert.equal(res.status, 409);
      assert.match(res.body.error, /nothing was pushed/);
    });

    it('writes one file from the wildcard path: 201 created', async () => {
      when('GET', `${UP}/contents/docs/a.md`, { status: 404, json: { message: 'Not Found' } });
      when('PUT', `${UP}/contents/docs/a.md`, { status: 201, json: { content: { sha: 'b1' }, commit: { sha: 'c1' } } });
      const res = await request(app).post(`${G}/contents/docs/a.md`).set(auth()).send({ content: 'hi', message: 'm', branch: 'main' });
      assert.equal(res.status, 201);
      assert.equal(res.body.created, true);
      assert.equal(res.body.path, 'docs/a.md');
    });

    it('merges (200), answers 409 for merged:false, and passes GitHub\'s 405 through', async () => {
      const open = () => when('GET', `${UP}/pulls/7`, { json: { number: 7, state: 'open', merged: false } });
      open();
      when('PUT', `${UP}/pulls/7/merge`, { json: { merged: true, sha: 'm1', message: 'ok' } });
      const ok = await request(app).post(`${G}/pulls/7/merge`).set(auth()).send({ expectedHeadSha: 'h1' });
      assert.equal(ok.status, 200);
      assert.equal(calls.find(c => c.method === 'PUT')!.body.sha, 'h1');

      rules = [];
      open();
      when('PUT', `${UP}/pulls/7/merge`, { json: { merged: false, sha: '', message: 'nope' } });
      assert.equal((await request(app).post(`${G}/pulls/7/merge`).set(auth()).send({})).status, 409);

      rules = []; calls = [];
      when('GET', `${UP}/pulls/7`, { json: { number: 7, state: 'closed', merged: true, merge_commit_sha: 'sq1' } });
      const again = await request(app).post(`${G}/pulls/7/merge`).set(auth()).send({});
      assert.equal(again.status, 200, 'the PR is merged — what the caller wanted');
      assert.equal(again.body.merged, false, 'but this call did not merge it');
      assert.equal(again.body.alreadyMerged, true);
      assert.equal(again.body.sha, 'sq1');
      assert.ok(!calls.some(c => c.method === 'PUT'));

      rules = [];
      open();
      when('PUT', `${UP}/pulls/7/merge`, { status: 405, json: { message: 'Pull Request is not mergeable' } });
      const refused = await request(app).post(`${G}/pulls/7/merge`).set(auth()).send({});
      assert.equal(refused.status, 405);
      assert.match(refused.body.error, /not mergeable/);
    });

    it('refuses a workflow push with 403 and its real reason, before any call', async () => {
      const res = await request(app).post(`${G}/push`).set(auth()).send({ branch: 'main', message: 'm', files: [{ path: '.github/workflows/ci.yml', content: 'x' }] });
      assert.equal(res.status, 403);
      assert.match(res.body.error, /workflow file/);
      assert.equal(calls.length, 0);
    });

    it('rejects a body the tool\'s schema rejects, and a refusal the op makes, before any write', async () => {
      const bad = await request(app).post(`${G}/push`).set(auth()).send({ branch: 'main', message: 'm', files: 'not-an-array' });
      assert.equal(bad.status, 400);
      assert.ok(bad.body.issues);
      const traversal = await request(app).post(`${G}/push`).set(auth()).send({ branch: 'main', message: 'm', files: [{ path: '../x', content: '' }] });
      assert.equal(traversal.status, 400);
      assert.match(traversal.body.error, /not a clean repository path/);
      assert.equal(calls.length, 0);
    });

    it('creates a repository (201)', async () => {
      when('POST', '/user/repos', { status: 201, json: { full_name: 'me/new', private: true } });
      const res = await request(app).post('/api/v1/github/repos').set(auth()).send({ name: 'new', private: true, autoInit: true });
      assert.equal(res.status, 201);
      assert.equal(res.body.full_name, 'me/new');
      assert.deepEqual(calls[0].body, { name: 'new', private: true, auto_init: true });
    });

    it('answers 202 for a new fork, since GitHub has only queued it', async () => {
      when('POST', `${UP}/forks`, { status: 202, json: { full_name: 'me/app', created_at: new Date().toISOString() } });
      const res = await request(app).post(`${G}/forks`).set(auth()).send({});
      assert.equal(res.status, 202);
      assert.equal(res.body.preExisting, false);
    });

    it('answers 200 for a fork that already existed, which made nothing', async () => {
      when('POST', `${UP}/forks`, { status: 202, json: { full_name: 'me/app', created_at: '2020-01-01T00:00:00Z' } });
      const res = await request(app).post(`${G}/forks`).set(auth()).send({});
      assert.equal(res.status, 200);
      assert.equal(res.body.preExisting, true);
    });

    it('creates a branch from the default branch (201)', async () => {
      when('GET', `${UP}/git/ref/heads/main`, { json: { object: { sha: 'abc123' } } });
      when('GET', UP, { json: { default_branch: 'main' } });
      when('POST', `${UP}/git/refs`, { status: 201, json: {} });
      const res = await request(app).post(`${G}/branches`).set(auth()).send({ branch: 'feature/x' });
      assert.equal(res.status, 201);
      assert.deepEqual(res.body, { branch: 'feature/x', from: 'main', sha: 'abc123' });
      assert.equal(calls.at(-1)!.body.ref, 'refs/heads/feature/x');
    });

    it('answers 409 for a branch that already exists', async () => {
      when('GET', `${UP}/git/ref/heads/main`, { json: { object: { sha: 'abc123' } } });
      when('POST', `${UP}/git/refs`, { status: 422, json: { message: 'Reference already exists' } });
      const res = await request(app).post(`${G}/branches`).set(auth()).send({ branch: 'x', fromBranch: 'main' });
      assert.equal(res.status, 409);
    });

    it('updates an issue, reporting what changed and what GitHub dropped', async () => {
      when('PATCH', `${UP}/issues/7`, { json: { number: 7, state: 'closed', title: 'T', labels: [], assignees: [], html_url: 'h' } });
      const res = await request(app).post(`${G}/issues/7`).set(auth()).send({ state: 'closed', labels: ['bug'] });
      assert.equal(res.status, 200);
      assert.equal(res.body.issue.state, 'closed');
      assert.deepEqual(res.body.changed, ['labels', 'state']);
      assert.deepEqual(res.body.notApplied, ['labels [bug]']);
    });

    it('400s an issue update with nothing in it, before GitHub is called', async () => {
      const res = await request(app).post(`${G}/issues/7`).set(auth()).send({});
      assert.equal(res.status, 400);
      assert.equal(calls.length, 0);
    });

    it('opens a pull request (201)', async () => {
      when('POST', `${UP}/pulls`, { status: 201, json: { number: 3, title: 'T', head: { ref: 'h' }, base: { ref: 'b' } } });
      const res = await request(app).post(`${G}/pulls`).set(auth()).send({ title: 'T', head: 'h', base: 'b', maintainerCanModify: true });
      assert.equal(res.status, 201);
      assert.equal(res.body.number, 3);
      assert.equal(calls[0].body.maintainer_can_modify, true);
    });

    it('submits a review (201) and counts its inline comments', async () => {
      when('POST', `${UP}/pulls/3/reviews`, { json: { id: 1, state: 'COMMENTED', html_url: 'h' } });
      const res = await request(app).post(`${G}/pulls/3/reviews`).set(auth())
        .send({ event: 'COMMENT', body: 'see', comments: [{ path: 'a.ts', body: 'x', line: 2 }] });
      assert.equal(res.status, 201);
      assert.equal(res.body.inlineComments, 1);
    });

    it('400s a review the op refuses, before GitHub is called', async () => {
      const res = await request(app).post(`${G}/pulls/3/reviews`).set(auth()).send({ event: 'REQUEST_CHANGES' });
      assert.equal(res.status, 400);
      assert.equal(calls.length, 0);
    });

    it('answers 202 for a branch update, since GitHub has only queued it', async () => {
      when('PUT', `${UP}/pulls/3/update-branch`, { status: 202, json: { message: 'Updating pull request branch.' } });
      const res = await request(app).post(`${G}/pulls/3/update-branch`).set(auth()).send({ expectedHeadSha: 'abc' });
      assert.equal(res.status, 202);
      assert.equal(res.body.accepted, true);
      assert.equal(calls[0].body.expected_head_sha, 'abc');
    });

    it('rejects a non-numeric pull number from the path', async () => {
      const res = await request(app).post(`${G}/pulls/abc/update-branch`).set(auth()).send({});
      assert.equal(res.status, 400);
      assert.equal(calls.length, 0);
    });
  });
});
