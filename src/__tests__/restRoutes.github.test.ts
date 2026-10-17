import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import request from 'supertest';
import { createWebOnlyApp } from '../website/webServer.js';
import { createOrUpdateUser, getUserByGoogleId, UserTokens } from '../userStore.js';
import { createMcpInstance, GoogleTokens } from '../mcpConnectionStore.js';

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

  before(async () => {
    const created = await createOrUpdateUser({ email: 'rest-github@example.com', googleId: 'google-rest-github', name: 'GH' }, tokens);
    bearer = created.apiKey;
    const user = await getUserByGoogleId('google-rest-github');
    if (user) (user as any).id = USER_ID;
    await createMcpInstance(USER_ID, 'github', 'GitHub (octo)', googleTokens, null, 'github', { access_token: 'ghp_rest_test_token' }, null);

    // A user with no GitHub connection at all.
    const other = await createOrUpdateUser({ email: 'rest-github-none@example.com', googleId: 'google-rest-github-none', name: 'None' }, tokens);
    otherBearer = other.apiKey;
    const otherUser = await getUserByGoogleId('google-rest-github-none');
    if (otherUser) (otherUser as any).id = OTHER_USER_ID;

    stubFetch();
  });

  after(() => { globalThis.fetch = realFetch; });
  beforeEach(() => { calls = []; rules = []; });

  const auth = () => ({ Authorization: `Bearer ${bearer}` });

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
      when('PUT', `${UP}/pulls/7/merge`, { json: { merged: true, sha: 'm1', message: 'ok' } });
      const ok = await request(app).post(`${G}/pulls/7/merge`).set(auth()).send({ expectedHeadSha: 'h1' });
      assert.equal(ok.status, 200);
      assert.equal(calls[0].body.sha, 'h1');

      rules = [];
      when('PUT', `${UP}/pulls/7/merge`, { json: { merged: false, sha: '', message: 'nope' } });
      assert.equal((await request(app).post(`${G}/pulls/7/merge`).set(auth()).send({})).status, 409);

      rules = [];
      when('PUT', `${UP}/pulls/7/merge`, { status: 405, json: { message: 'Pull Request is not mergeable' } });
      const refused = await request(app).post(`${G}/pulls/7/merge`).set(auth()).send({});
      assert.equal(refused.status, 405);
      assert.match(refused.body.error, /not mergeable/);
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
  });
});
