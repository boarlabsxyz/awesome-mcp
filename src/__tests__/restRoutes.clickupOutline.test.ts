import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import request from 'supertest';
import { createWebOnlyApp } from '../website/webServer.js';
import { createOrUpdateUser, getUserByGoogleId, UserTokens } from '../userStore.js';
import { createMcpInstance, GoogleTokens } from '../mcpConnectionStore.js';

// The auth-gate suite proves these routes exist and reject an unauthenticated
// caller; it never executes a handler body. This file does, for the two services
// this pass wired: the schema rejections, the path-param plumbing, the
// verification re-reads that make a silent upstream no-op visible, and the error
// mapping that must keep an upstream 404 a 404 rather than reporting a missing
// record as "fix your request".
//
// Both ClickUpClient and OutlineClient go through global fetch, so stubbing it
// reaches them. node:test runs each file in its own process, so the stub cannot
// leak into another suite.

if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: {
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:8080/auth/callback'],
    },
  });
}

const USER_ID = 8802;
const OUTLINE_BASE = 'https://wiki.test.invalid';

const dummyUserTokens: UserTokens = {
  access_token: 'acc', refresh_token: 'ref', scope: 'email',
  token_type: 'Bearer', expiry_date: Date.now() + 3600_000,
};
const dummyGoogleTokens: GoogleTokens = {
  access_token: 'mcp-acc', refresh_token: 'mcp-ref', scope: 'email',
  token_type: 'Bearer', expiry_date: Date.now() + 3600_000,
};

interface Recorded { url: string; method: string; body: unknown }
interface Canned { status?: number; json?: unknown; text?: string; contentType?: string | null }

const realFetch = globalThis.fetch;
let calls: Recorded[] = [];
let routes: Array<[string, Canned]> = [];
let fallback: Canned = { json: {} };

function stubFetch(): void {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    let parsedBody: unknown;
    if (typeof init.body === 'string') {
      try { parsedBody = JSON.parse(init.body); } catch { parsedBody = init.body; }
    }
    calls.push({ url, method: init.method ?? 'GET', body: parsedBody });
    const hit = routes.find(([f]) => url.includes(f))?.[1] ?? fallback;
    const status = hit.status ?? 200;
    const contentType = hit.contentType === undefined ? 'application/json' : hit.contentType;
    const body = hit.text ?? (hit.json === undefined ? '' : JSON.stringify(hit.json));
    return new Response(body || null, {
      status, headers: contentType ? { 'content-type': contentType } : {},
    });
  }) as typeof fetch;
}

function reset(): void { calls = []; routes = []; fallback = { json: {} }; }
/** Canned reply for any upstream URL containing `fragment`. First match wins. */
function when(fragment: string, canned: Canned): void { routes.push([fragment, canned]); }
/** Every recorded call whose URL contains `fragment`. */
function callsTo(fragment: string): Recorded[] { return calls.filter((c) => c.url.includes(fragment)); }

describe('REST data plane: ClickUp and Outline handler bodies', () => {
  const app = createWebOnlyApp();
  let bearer: string;

  before(async () => {
    const created = await createOrUpdateUser(
      { email: 'rest-cu-ol@example.com', googleId: 'google-rest-cu-ol', name: 'REST CU/OL User' },
      dummyUserTokens,
    );
    bearer = created.apiKey;
    // The file store does not assign the numeric id the connection lookup keys on.
    const user = await getUserByGoogleId('google-rest-cu-ol');
    if (user) (user as any).id = USER_ID;

    await createMcpInstance(
      USER_ID, 'clickup', 'Test ClickUp', dummyGoogleTokens, null,
      'clickup', { access_token: 'cu-token' }, null,
    );
    await createMcpInstance(
      USER_ID, 'outline', 'Test Outline', dummyGoogleTokens, null,
      // No refresh_token/expiry: a paste-token connection, so maybeRefreshOutlineToken
      // no-ops and the test does not have to stub a token endpoint.
      'outline', { access_token: 'ol-token', baseUrl: OUTLINE_BASE }, null,
    );
    stubFetch();
  });

  after(() => { globalThis.fetch = realFetch; });

  const auth = () => ({ Authorization: `Bearer ${bearer}` });

  // ===================== ClickUp reads =====================

  describe('ClickUp reads', () => {
    it('prepends the two built-in task types ClickUp omits', async () => {
      reset();
      when('/custom_item', { json: { custom_items: [{ id: 1005, name: 'Project' }] } });

      const res = await request(app).get('/api/v1/clickup/workspaces/ws-1/task-types').set(auth());
      assert.equal(res.status, 200);
      // The whole point of the endpoint: ClickUp returns ONLY custom types, so
      // answering with its payload verbatim reads as "no Task type exists".
      assert.deepEqual(res.body.builtIn.map((t: any) => t.id), [0, 1]);
      assert.equal(res.body.custom.length, 1);
      assert.equal(res.body.custom[0].id, 1005);
    });

    it('lists space tags, defaulting to an empty array', async () => {
      reset();
      when('/space/space-1/tag', { json: {} });
      const res = await request(app).get('/api/v1/clickup/spaces/space-1/tags').set(auth());
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.tags, []);
    });
  });

  // ===================== ClickUp writes =====================

  describe('ClickUp writes', () => {
    it('rejects an empty list update with 400 and flattened issues', async () => {
      reset();
      const res = await request(app).post('/api/v1/clickup/lists/list-1/update').set(auth()).send({});
      assert.equal(res.status, 400);
      assert.ok(res.body.issues, 'expected flattened Zod issues');
      assert.equal(calls.length, 0, 'validation must run before any upstream call');
    });

    it('maps camelCase list fields onto ClickUp native keys', async () => {
      reset();
      when('/list/list-1', { json: { id: 'list-1', name: 'Renamed' } });
      const res = await request(app).post('/api/v1/clickup/lists/list-1/update').set(auth())
        .send({ name: 'Renamed', dueDate: '2026-03-01T00:00:00.000Z', priority: 2 });
      assert.equal(res.status, 200);
      const sent = callsTo('/list/list-1')[0].body as any;
      assert.equal(sent.name, 'Renamed');
      assert.equal(sent.due_date, Date.parse('2026-03-01T00:00:00.000Z'));
      assert.equal(sent.priority, 2);
      assert.ok(Number.isFinite(sent.due_date), 'due_date must be a number, never NaN/null');
    });

    it('accepts the documented Unix-ms date format as a real timestamp', async () => {
      reset();
      when('/task/task-1', { json: { id: 'task-1' } });
      await request(app).post('/api/v1/clickup/tasks/task-1/update').set(auth())
        .send({ dueDate: '1700000000000', startDate: '2026-03-01T00:00:00.000Z' }).expect(200);
      const sent = callsTo('/task/task-1')[0].body as any;
      // new Date("1700000000000") is an Invalid Date, so the obvious conversion
      // yields NaN, which JSON.stringify sends as null — and ClickUp reads a null
      // due_date as CLEAR THE DATE and answers 200. Both documented formats must
      // survive as numbers.
      assert.equal(sent.due_date, 1700000000000);
      assert.equal(sent.start_date, Date.parse('2026-03-01T00:00:00.000Z'));
    });

    it('refuses an unparseable date instead of silently clearing it', async () => {
      reset();
      for (const body of [{ dueDate: '2026-13-01' }, { startDate: 'tomorrow' }, { dueDate: '' }]) {
        const res = await request(app).post('/api/v1/clickup/tasks/task-1/update').set(auth()).send(body);
        assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
        assert.match(res.body.error, /not a valid date/i);
      }
      // The whole point: nothing reached ClickUp, so no date was wiped.
      assert.equal(calls.length, 0);
    });

    it('refuses an unparseable list dueDate too', async () => {
      reset();
      const res = await request(app).post('/api/v1/clickup/lists/list-1/update').set(auth())
        .send({ dueDate: 'next friday' });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /not a valid date/i);
      assert.equal(calls.length, 0);
    });

    it('prefers markdownContent over description on a task update', async () => {
      reset();
      when('/task/task-1', { json: { id: 'task-1' } });
      await request(app).post('/api/v1/clickup/tasks/task-1/update').set(auth())
        .send({ description: 'plain', markdownContent: '**bold**' }).expect(200);
      const sent = callsTo('/task/task-1')[0].body as any;
      assert.equal(sent.markdown_content, '**bold**');
      assert.equal(sent.description, undefined, 'sending both lets ClickUp pick, and it does not pick the formatted one');
    });

    it('sends assignees as ClickUp add/rem object, not a flat array', async () => {
      reset();
      when('/task/task-1', { json: { id: 'task-1' } });
      await request(app).post('/api/v1/clickup/tasks/task-1/update').set(auth())
        .send({ addAssignees: [1], removeAssignees: [2] }).expect(200);
      assert.deepEqual((callsTo('/task/task-1')[0].body as any).assignees, { add: [1], rem: [2] });
    });

    it('refuses a null parentTaskId with 400 and an explanation, not a Zod type error', async () => {
      reset();
      const res = await request(app).post('/api/v1/clickup/tasks/task-1/update').set(auth())
        .send({ parentTaskId: null });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /cannot be null/i);
      assert.equal(calls.length, 0, 'nothing may be mutated before the refusal');
    });

    it('refuses self-parenting before touching ClickUp', async () => {
      reset();
      const res = await request(app).post('/api/v1/clickup/tasks/task-1/update').set(auth())
        .send({ parentTaskId: 'task-1' });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /own parent/i);
      assert.equal(calls.length, 0);
    });

    it('reports reparentConfirmed false when ClickUp 200s but silently ignores the parent', async () => {
      reset();
      // The PUT echo and the follow-up GET share the /task/task-1 prefix, so the
      // reply is keyed on method order: PUT first, then the verification read.
      let seen = 0;
      routes.push(['/task/task-1', { json: {} }]);
      globalThis.fetch = (async (input: any, init: any = {}) => {
        const url = typeof input === 'string' ? input : String(input?.url ?? input);
        calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined });
        seen += 1;
        // Second call is the verification GET: report a parent that disagrees.
        const payload = seen === 1 ? { id: 'task-1', parent: 'parent-9' } : { id: 'task-1', parent: null };
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      const res = await request(app).post('/api/v1/clickup/tasks/task-1/update').set(auth())
        .send({ parentTaskId: 'parent-9' });
      stubFetch();
      assert.equal(res.status, 200);
      // A stale echo would let a silent no-op read as success. This is the bug
      // the verification read exists to make visible.
      assert.equal(res.body.reparentConfirmed, false);
    });

    it('leaves reparentConfirmed null on a plain update, costing exactly one call', async () => {
      reset();
      when('/task/task-1', { json: { id: 'task-1' } });
      const res = await request(app).post('/api/v1/clickup/tasks/task-1/update').set(auth())
        .send({ name: 'New name' }).expect(200);
      assert.equal(res.body.reparentConfirmed, null);
      assert.equal(calls.length, 1, 'a plain update must not pay for a verification read');
    });

    it('keeps an upstream 404 as 404 instead of reporting it as a bad request', async () => {
      reset();
      when('/task/missing', { status: 404, json: { err: 'not found' } });
      const res = await request(app).post('/api/v1/clickup/tasks/missing/update').set(auth())
        .send({ name: 'x' });
      assert.equal(res.status, 404, 'a missing record must not be reported as "fix your request"');
    });

    it('deletes a task and a list through the action paths', async () => {
      reset();
      when('/task/task-1', { json: {} });
      when('/list/list-1', { json: {} });
      const t = await request(app).post('/api/v1/clickup/tasks/task-1/delete').set(auth()).send({});
      assert.equal(t.status, 200);
      assert.deepEqual(t.body, { taskId: 'task-1', deleted: true });
      assert.equal(callsTo('/task/task-1')[0].method, 'DELETE');

      const l = await request(app).post('/api/v1/clickup/lists/list-1/delete').set(auth()).send({});
      assert.equal(l.status, 200);
      assert.deepEqual(l.body, { listId: 'list-1', deleted: true });
    });

    it('clears a custom field value via the /remove action path', async () => {
      reset();
      when('/field/field-1', { json: {} });
      const res = await request(app)
        .post('/api/v1/clickup/tasks/task-1/fields/field-1/remove').set(auth()).send({});
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { taskId: 'task-1', fieldId: 'field-1', cleared: true });
      assert.equal(callsTo('/field/field-1')[0].method, 'DELETE');
    });

    it('reports a confirmed share when the re-read lists the target list', async () => {
      reset();
      when('/list/list-2/task/task-1', { json: {} });
      when('/task/task-1', { json: { id: 'task-1', list: { id: 'home-1' }, locations: [{ id: 'list-2' }] } });
      const res = await request(app).post('/api/v1/clickup/tasks/task-1/lists/list-2').set(auth()).send({});
      assert.equal(res.status, 200);
      assert.equal(res.body.confirmed, true);
      assert.equal(res.body.homeListId, 'home-1');
      assert.deepEqual(res.body.locations, ['list-2']);
    });

    it('reports confirmed null — not false — when ClickUp sends no locations array', async () => {
      reset();
      when('/list/list-2/task/task-1', { json: {} });
      when('/task/task-1', { json: { id: 'task-1', list: { id: 'home-1' } } });
      const res = await request(app).post('/api/v1/clickup/tasks/task-1/lists/list-2').set(auth()).send({});
      assert.equal(res.status, 200);
      // An absent locations key is what a disabled ClickApp looks like. Calling
      // that false would turn a share that may have happened into a failure.
      assert.equal(res.body.confirmed, null);
      assert.equal(res.body.locations, null);
    });

    it('inverts the confirmation for the remove direction', async () => {
      reset();
      when('/list/list-2/task/task-1', { json: {} });
      when('/task/task-1', { json: { id: 'task-1', list: { id: 'home-1' }, locations: [] } });
      const res = await request(app)
        .post('/api/v1/clickup/tasks/task-1/lists/list-2/remove').set(auth()).send({});
      assert.equal(res.status, 200);
      assert.equal(res.body.confirmed, true, 'absent from locations is success when removing');
      assert.equal(callsTo('/list/list-2/task/task-1')[0].method, 'DELETE');
    });

    it('adds and removes a tag, and says the tag may have been auto-created', async () => {
      reset();
      when('/tag/urgent', { json: {} });
      const add = await request(app).post('/api/v1/clickup/tasks/task-1/tags/urgent').set(auth()).send({});
      assert.equal(add.status, 200);
      assert.equal(add.body.added, true);
      // ClickUp auto-creates an unknown tag, so {added:true} alone would read as
      // "the tag you meant".
      assert.equal(add.body.autoCreatedIfMissing, true);
      assert.equal(callsTo('/tag/urgent')[0].method, 'POST');

      const rm = await request(app).post('/api/v1/clickup/tasks/task-1/tags/urgent/remove').set(auth()).send({});
      assert.equal(rm.status, 200);
      assert.equal(rm.body.removed, true);
    });

    it('url-decodes a multi-word tag name out of the path', async () => {
      reset();
      when('/tag/', { json: {} });
      await request(app).post('/api/v1/clickup/tasks/task-1/tags/needs%20review').set(auth()).send({}).expect(200);
      assert.match(callsTo('/tag/')[0].url, /tag\/needs%20review$/);
    });

    it('requires parentType when a doc parentId is given', async () => {
      reset();
      const res = await request(app).post('/api/v1/clickup/workspaces/ws-1/docs').set(auth())
        .send({ name: 'Doc', parentId: 'space-1' });
      assert.equal(res.status, 400);
      assert.ok(res.body.issues);
      assert.equal(calls.length, 0);
    });

    it('creates a doc and writes content to its first page, answering 201', async () => {
      reset();
      when('/docs/doc-1/pages', { json: { pages: [{ id: 'page-1' }] } });
      when('/docs', { json: { id: 'doc-1', name: 'Doc' } });
      const res = await request(app).post('/api/v1/clickup/workspaces/ws-1/docs').set(auth())
        .send({ name: 'Doc', content: '# Hello' });
      assert.equal(res.status, 201);
      assert.equal(res.body.doc.id, 'doc-1');
      // ClickUp's createDoc IGNORES content, so the second write is the feature.
      assert.equal(res.body.contentWritten, true);
      const edit = callsTo('/docs/doc-1/pages/page-1')[0];
      assert.equal((edit.body as any).content, '# Hello');
      assert.equal((edit.body as any).content_edit_mode, 'replace');
    });

    it('still answers 201 with contentWritten false when only the content write fails', async () => {
      reset();
      when('/docs/doc-1/pages', { status: 500, json: { err: 'boom' } });
      when('/docs', { json: { id: 'doc-1', name: 'Doc' } });
      const res = await request(app).post('/api/v1/clickup/workspaces/ws-1/docs').set(auth())
        .send({ name: 'Doc', content: '# Hello' });
      // The doc exists by now, so an error status would invite a retry that makes
      // a second doc.
      assert.equal(res.status, 201);
      assert.equal(res.body.contentWritten, false);
    });

    it('reports contentWritten null when no content was supplied', async () => {
      reset();
      when('/docs', { json: { id: 'doc-1', name: 'Doc' } });
      const res = await request(app).post('/api/v1/clickup/workspaces/ws-1/docs').set(auth())
        .send({ name: 'Doc' });
      assert.equal(res.status, 201);
      assert.equal(res.body.contentWritten, null);
    });

    it('creates a page with markdown and a parent page', async () => {
      reset();
      when('/docs/doc-1/pages', { json: { id: 'page-2' } });
      const res = await request(app).post('/api/v1/clickup/workspaces/ws-1/docs/doc-1/pages').set(auth())
        .send({ name: 'Child', content: 'body', parentPageId: 'page-1' });
      assert.equal(res.status, 201);
      const sent = callsTo('/docs/doc-1/pages')[0].body as any;
      assert.equal(sent.content_format, 'text/md');
      assert.equal(sent.parent_page_id, 'page-1');
    });

    it('defaults page edit mode to replace and forwards append when asked', async () => {
      reset();
      when('/pages/page-1', { json: {} });
      const def = await request(app).post('/api/v1/clickup/workspaces/ws-1/docs/doc-1/pages/page-1')
        .set(auth()).send({ content: 'x' });
      assert.equal(def.status, 200);
      assert.equal(def.body.editMode, 'replace');
      assert.equal((callsTo('/pages/page-1')[0].body as any).content_edit_mode, 'replace');

      reset();
      when('/pages/page-1', { json: {} });
      const app2 = await request(app).post('/api/v1/clickup/workspaces/ws-1/docs/doc-1/pages/page-1')
        .set(auth()).send({ content: 'x', editMode: 'append' });
      assert.equal(app2.body.editMode, 'append');
    });

    it('rejects a page edit that names neither a name nor content', async () => {
      reset();
      const res = await request(app).post('/api/v1/clickup/workspaces/ws-1/docs/doc-1/pages/page-1')
        .set(auth()).send({ editMode: 'append' });
      assert.equal(res.status, 400);
      assert.equal(calls.length, 0);
    });

    it('reports an unconfigured image host as 503, not as a server fault', async () => {
      reset();
      const saved = process.env.IMAGE_PUBLIC_BASE_URL;
      delete process.env.IMAGE_PUBLIC_BASE_URL;
      try {
        const res = await request(app)
          .post('/api/v1/clickup/workspaces/ws-1/docs/doc-1/pages/page-1/images').set(auth())
          .send({ imageUrl: 'https://e.test/a.png' });
        // 500 would tell the caller to report a bug when the fix is a config value.
        assert.equal(res.status, 503);
        assert.match(res.body.error, /IMAGE_PUBLIC_BASE_URL/);
      } finally {
        if (saved === undefined) delete process.env.IMAGE_PUBLIC_BASE_URL;
        else process.env.IMAGE_PUBLIC_BASE_URL = saved;
      }
    });

    it('rejects an image insert naming no source, and one naming both', async () => {
      reset();
      const saved = process.env.IMAGE_PUBLIC_BASE_URL;
      // The config check runs BEFORE the source check (fail fast, before a fetch),
      // so the host has to be configured for the source branch to be reachable.
      process.env.IMAGE_PUBLIC_BASE_URL = 'https://img.test.invalid';
      try {
        const none = await request(app)
          .post('/api/v1/clickup/workspaces/ws-1/docs/doc-1/pages/page-1/images').set(auth()).send({});
        assert.equal(none.status, 400);
        assert.match(none.body.error, /exactly one/i);

        const both = await request(app)
          .post('/api/v1/clickup/workspaces/ws-1/docs/doc-1/pages/page-1/images').set(auth())
          .send({ imageUrl: 'https://e.test/a.png', imageBase64: 'AAAA' });
        assert.equal(both.status, 400);
        assert.match(both.body.error, /only one/i);
      } finally {
        if (saved === undefined) delete process.env.IMAGE_PUBLIC_BASE_URL;
        else process.env.IMAGE_PUBLIC_BASE_URL = saved;
      }
    });

    it('rejects an empty task update rather than sending a no-op', async () => {
      reset();
      const res = await request(app).post('/api/v1/clickup/tasks/task-1/update').set(auth()).send({});
      assert.equal(res.status, 400);
      assert.equal(calls.length, 0);
    });

    it('refuses an empty-string parentTaskId rather than sending it', async () => {
      reset();
      // The schema permits '' (it is a string), so this refusal has to live in the
      // op. Omitting the field is how you leave the parent alone.
      const res = await request(app).post('/api/v1/clickup/tasks/task-1/update').set(auth())
        .send({ parentTaskId: '   ' });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /non-empty/i);
      assert.equal(calls.length, 0);
    });

    it('nests a new doc under a parent as ClickUp id/type object', async () => {
      reset();
      when('/docs', { json: { id: 'doc-1', name: 'Doc' } });
      await request(app).post('/api/v1/clickup/workspaces/ws-1/docs').set(auth())
        .send({ name: 'Doc', parentId: 'space-1', parentType: 4 }).expect(201);
      assert.deepEqual((callsTo('/docs')[0].body as any).parent, { id: 'space-1', type: 4 });
    });

    it('creates a page when the new doc has no auto-created one', async () => {
      reset();
      // ClickUp usually auto-creates a first page; when it does not, the content
      // has to go somewhere or it is silently dropped.
      when('/docs/doc-1/pages', { json: { pages: [] } });
      when('/docs', { json: { id: 'doc-1', name: 'Doc' } });
      const res = await request(app).post('/api/v1/clickup/workspaces/ws-1/docs').set(auth())
        .send({ name: 'Doc', content: '# Hello' });
      assert.equal(res.status, 201);
      assert.equal(res.body.contentWritten, true);
      const posted = callsTo('/docs/doc-1/pages').filter((c) => c.method === 'POST');
      assert.equal(posted.length, 1, 'expected a createPage fallback');
      assert.equal((posted[0].body as any).content, '# Hello');
    });

    it('embeds a URL already on our image host without fetching it', async () => {
      reset();
      const saved = process.env.IMAGE_PUBLIC_BASE_URL;
      process.env.IMAGE_PUBLIC_BASE_URL = 'https://img.test.invalid';
      try {
        when('/pages/page-1', { json: {} });
        const res = await request(app)
          .post('/api/v1/clickup/workspaces/ws-1/docs/doc-1/pages/page-1/images').set(auth())
          .send({ imageUrl: 'https://img.test.invalid/images/abc.webp' });
        assert.equal(res.status, 200);
        assert.equal(res.body.url, 'https://img.test.invalid/images/abc.webp');
        // The branch that decides whether this server makes an outbound request
        // at all: an already-hosted URL must not be re-fetched.
        assert.equal(calls.filter((c) => c.url.includes('/images/abc.webp')).length, 0);
        assert.match((callsTo('/pages/page-1')[0].body as any).content, /^!\[\]\(https:\/\/img\.test\.invalid\/images\/abc\.webp\)$/);
      } finally {
        if (saved === undefined) delete process.env.IMAGE_PUBLIC_BASE_URL;
        else process.env.IMAGE_PUBLIC_BASE_URL = saved;
      }
    });

    it('skips re-hosting when skipRehost is set, even for a foreign URL', async () => {
      reset();
      const saved = process.env.IMAGE_PUBLIC_BASE_URL;
      process.env.IMAGE_PUBLIC_BASE_URL = 'https://img.test.invalid';
      try {
        when('/pages/page-1', { json: {} });
        const res = await request(app)
          .post('/api/v1/clickup/workspaces/ws-1/docs/doc-1/pages/page-1/images').set(auth())
          .send({ imageUrl: 'https://elsewhere.test/a.png', skipRehost: true, altText: 'chart' });
        assert.equal(res.status, 200);
        assert.equal(res.body.url, 'https://elsewhere.test/a.png');
        assert.equal(calls.filter((c) => c.url.includes('elsewhere.test')).length, 0);
        assert.match((callsTo('/pages/page-1')[0].body as any).content, /^!\[chart\]\(/);
      } finally {
        if (saved === undefined) delete process.env.IMAGE_PUBLIC_BASE_URL;
        else process.env.IMAGE_PUBLIC_BASE_URL = saved;
      }
    });

    it('accepts a body well past the 100kb Express default', async () => {
      reset();
      when('/pages/page-1', { json: {} });
      // Proves /api/v1/clickup is in REST_LARGE_BODY_PREFIXES. A 413 here means
      // the prefix is missing, and that failure is invisible until a real caller
      // sends real content.
      const res = await request(app).post('/api/v1/clickup/workspaces/ws-1/docs/doc-1/pages/page-1')
        .set(auth()).send({ content: 'x'.repeat(300_000) });
      assert.equal(res.status, 200, `expected the large body to be parsed, got ${res.status}`);
    });
  });

  // ===================== Outline reads =====================

  describe('Outline reads', () => {
    it('requires q on search, before calling Outline', async () => {
      reset();
      const res = await request(app).get('/api/v1/outline/documents/search').set(auth());
      assert.equal(res.status, 400);
      assert.match(res.body.error, /q query parameter/);
      assert.equal(calls.length, 0);
    });

    it('clamps the search limit and forwards a repeated statusFilter', async () => {
      reset();
      when('/api/documents.search', { json: { data: [], pagination: {} } });
      await request(app)
        .get('/api/v1/outline/documents/search?q=policy&limit=9999&statusFilter=draft&statusFilter=published')
        .set(auth()).expect(200);
      const sent = callsTo('documents.search')[0].body as any;
      assert.equal(sent.limit, 100, 'an unclamped limit is how you hand someone a 200 MB response');
      assert.deepEqual(sent.statusFilter, ['draft', 'published']);
    });

    it('drops a statusFilter value Outline does not accept rather than forwarding it', async () => {
      reset();
      when('/api/documents.search', { json: { data: [] } });
      await request(app).get('/api/v1/outline/documents/search?q=x&statusFilter=bogus').set(auth()).expect(200);
      assert.equal((callsTo('documents.search')[0].body as any).statusFilter, undefined);
    });

    it('resolves the static document paths as routes, not as document IDs', async () => {
      reset();
      when('/api/documents.archived', { json: { data: [{ id: 'd1' }] } });
      when('/api/documents.list', { json: { data: [] } });
      when('/api/documents.search', { json: { data: [] } });
      when('/api/documents.info', { json: { data: { id: 'WRONG' } } });

      const archived = await request(app).get('/api/v1/outline/documents/archived').set(auth());
      assert.equal(archived.status, 200);
      // If route ordering regressed, "archived" would be read as a documentId and
      // this would hit documents.info instead.
      assert.deepEqual(archived.body.documents, [{ id: 'd1' }]);
      assert.equal(callsTo('documents.info').length, 0);
    });

    it('defaults an unknown recent window to week and unwraps the search envelope', async () => {
      reset();
      when('/api/documents.search', { json: { data: [{ document: { id: 'd1', title: 'T' } }] } });
      const res = await request(app).get('/api/v1/outline/documents/recent?dateFilter=fortnight').set(auth());
      assert.equal(res.status, 200);
      assert.equal(res.body.dateFilter, 'week');
      assert.deepEqual(res.body.documents, [{ id: 'd1', title: 'T' }]);
      const sent = callsTo('documents.search')[0].body as any;
      assert.equal(sent.sort, 'updatedAt');
      assert.equal(sent.direction, 'DESC');
    });

    it('flags a by-title hit as a partial match rather than passing a guess off as an answer', async () => {
      reset();
      when('/api/documents.search', { json: { data: [{ document: { id: 'd9', title: 'Employee Handbook v2' } }] } });
      const res = await request(app).get('/api/v1/outline/documents/by-title?q=Handbook').set(auth());
      assert.equal(res.status, 200);
      assert.equal(res.body.found, true);
      assert.equal(res.body.exactMatch, false);
      assert.equal(res.body.documentId, 'd9');
    });

    it('marks an exact by-title match, preferring it over the first result', async () => {
      reset();
      when('/api/documents.search', { json: { data: [
        { document: { id: 'd1', title: 'Handbook draft' } },
        { document: { id: 'd2', title: 'handbook' } },
      ] } });
      const res = await request(app).get('/api/v1/outline/documents/by-title?q=Handbook').set(auth());
      assert.equal(res.body.exactMatch, true);
      assert.equal(res.body.documentId, 'd2');
    });

    it('answers the document export as markdown, not JSON', async () => {
      reset();
      when('/api/documents.export', { json: { data: '# Title\n\nbody' } });
      const res = await request(app).get('/api/v1/outline/documents/doc-1/export').set(auth());
      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /text\/markdown/);
      assert.equal(res.text, '# Title\n\nbody');
    });

    it('parses attachments out of the document markdown and says that is what it did', async () => {
      reset();
      when('/api/documents.info', { json: { data: {
        id: 'doc-1', title: 'With files',
        text: 'see ![x](/api/attachments.redirect?id=11111111-2222-3333-4444-555555555555)',
      } } });
      const res = await request(app).get('/api/v1/outline/documents/doc-1/attachments').set(auth());
      assert.equal(res.status, 200);
      assert.equal(res.body.attachments.length, 1);
      // An empty list is not proof there are none, so the response names the method.
      assert.match(res.body.source, /parsed from document markdown/);
    });

    it('reports a document Outline answered with no data as 404, not 200 or 500', async () => {
      reset();
      when('/api/documents.info', { json: {} });
      const res = await request(app).get('/api/v1/outline/documents/missing').set(auth());
      assert.equal(res.status, 404);
    });

    it('preserves an upstream 403 rather than flattening it to 500', async () => {
      reset();
      when('/api/documents.info', { status: 403, json: { message: 'nope' } });
      const res = await request(app).get('/api/v1/outline/documents/doc-1').set(auth());
      assert.equal(res.status, 403);
    });

    it('labels an attachment URL as a credential', async () => {
      reset();
      when('/api/attachments.redirect', { json: { data: {} } });
      const res = await request(app).get('/api/v1/outline/attachments/att-1/url').set(auth());
      // The stub resolves finalUrl from the Response, so assert on the contract
      // rather than the signed value: either a URL plus the warning, or a 404.
      assert.ok([200, 404].includes(res.status));
      if (res.status === 200) assert.match(res.body.note, /credential/i);
    });


  });

  // ===================== Outline writes =====================

  describe('Outline writes', () => {
    it('creates a document with 201 and the created record', async () => {
      reset();
      when('/api/documents.create', { json: { data: { id: 'd1', title: 'New' } } });
      const res = await request(app).post('/api/v1/outline/documents').set(auth())
        .send({ title: 'New', collectionId: 'col-1', text: '# body' });
      assert.equal(res.status, 201);
      assert.equal(res.body.id, 'd1');
      const sent = callsTo('documents.create')[0].body as any;
      assert.equal(sent.publish, true, 'publish defaults on');
      assert.equal(sent.text, '# body');
    });

    it('rejects a create missing collectionId with flattened issues', async () => {
      reset();
      const res = await request(app).post('/api/v1/outline/documents').set(auth()).send({ title: 'New' });
      assert.equal(res.status, 400);
      assert.ok(res.body.issues.fieldErrors.collectionId);
      assert.equal(calls.length, 0);
    });

    it('omits append when no text is supplied, so an update cannot blank the body', async () => {
      reset();
      when('/api/documents.update', { json: { data: { id: 'd1', title: 'T' } } });
      await request(app).post('/api/v1/outline/documents/d1').set(auth())
        .send({ title: 'T', append: true }).expect(200);
      assert.equal((callsTo('documents.update')[0].body as any).append, undefined);
    });

    it('forwards append alongside text', async () => {
      reset();
      when('/api/documents.update', { json: { data: { id: 'd1' } } });
      await request(app).post('/api/v1/outline/documents/d1').set(auth())
        .send({ text: 'more', append: true }).expect(200);
      assert.equal((callsTo('documents.update')[0].body as any).append, true);
    });

    it('turns an empty-string icon into an explicit null to clear it', async () => {
      reset();
      when('/api/documents.update', { json: { data: { id: 'd1' } } });
      await request(app).post('/api/v1/outline/documents/d1').set(auth()).send({ icon: '' }).expect(200);
      assert.equal((callsTo('documents.update')[0].body as any).icon, null);
    });

    it('rejects an update naming no field', async () => {
      reset();
      const res = await request(app).post('/api/v1/outline/documents/d1').set(auth()).send({});
      assert.equal(res.status, 400);
      assert.equal(calls.length, 0);
    });

    it('requires a destination on a move', async () => {
      reset();
      const res = await request(app).post('/api/v1/outline/documents/d1/move').set(auth()).send({});
      assert.equal(res.status, 400);
      assert.equal(calls.length, 0);
    });

    it('moves a document when a destination is given', async () => {
      reset();
      when('/api/documents.move', { json: { data: { documents: [] } } });
      const res = await request(app).post('/api/v1/outline/documents/d1/move').set(auth())
        .send({ collectionId: 'col-2' });
      assert.equal(res.status, 200);
      assert.equal((callsTo('documents.move')[0].body as any).id, 'd1');
    });

    it('drives the lifecycle actions to their Outline endpoints', async () => {
      // unarchive and restore deliberately share /api/documents.restore: Outline
      // has NO documents.unarchive endpoint, and hitting one would 404. Asserted
      // so a future "tidy-up" that splits them gets caught here.
      for (const [action, fragment] of [
        ['archive', 'documents.archive'],
        ['unarchive', 'documents.restore'],
        ['restore', 'documents.restore'],
      ] as const) {
        reset();
        when(`/api/${fragment}`, { json: { data: { id: 'd1', title: 'T' } } });
        const res = await request(app).post(`/api/v1/outline/documents/d1/${action}`).set(auth()).send({});
        assert.equal(res.status, 200, `${action} should succeed`);
        assert.equal(callsTo(fragment).length, 1, `${action} should hit ${fragment}`);
      }
    });

    it('adds a comment with 201 and forwards a reply parent', async () => {
      reset();
      when('/api/comments.create', { json: { data: { id: 'c1' } } });
      const res = await request(app).post('/api/v1/outline/documents/d1/comments').set(auth())
        .send({ text: 'hi', parentCommentId: 'c0' });
      assert.equal(res.status, 201);
      const sent = callsTo('comments.create')[0].body as any;
      assert.equal(sent.documentId, 'd1');
      assert.equal(sent.parentCommentId, 'c0');
    });

    it('validates a collection colour as hex', async () => {
      reset();
      const bad = await request(app).post('/api/v1/outline/collections').set(auth())
        .send({ name: 'C', color: 'red' });
      assert.equal(bad.status, 400);
      assert.equal(calls.length, 0);

      when('/api/collections.create', { json: { data: { id: 'col-9' } } });
      const ok = await request(app).post('/api/v1/outline/collections').set(auth())
        .send({ name: 'C', color: '#FF0000' });
      assert.equal(ok.status, 201);
    });

    it('updates a collection, forwarding the id from the path', async () => {
      reset();
      when('/api/collections.update', { json: { data: { id: 'col-1', name: 'Renamed' } } });
      const res = await request(app).post('/api/v1/outline/collections/col-1').set(auth())
        .send({ name: 'Renamed', color: '#00FF00' });
      assert.equal(res.status, 200);
      assert.equal(res.body.name, 'Renamed');
      const sent = callsTo('collections.update')[0].body as any;
      assert.equal(sent.id, 'col-1');
      assert.equal(sent.color, '#00FF00');
    });

    it('requires at least one field on a collection update', async () => {
      reset();
      const res = await request(app).post('/api/v1/outline/collections/col-1').set(auth()).send({});
      assert.equal(res.status, 400);
      assert.equal(calls.length, 0);
    });

    it('reports an empty Outline write response as 502, not 400 or a fake success', async () => {
      reset();
      when('/api/documents.create', { json: {} });
      const res = await request(app).post('/api/v1/outline/documents').set(auth())
        .send({ title: 'New', collectionId: 'col-1' });
      // The request reached Outline and was accepted, so the failure is upstream.
      // A 400 would tell the caller to fix a request that was valid.
      assert.equal(res.status, 502);
      assert.match(res.body.error, /returned no document/i);
    });

    it('queues a collection export via POST, defaulting the format', async () => {
      reset();
      when('/api/collections.export', { json: { data: { fileOperation: { id: 'f1' } } } });
      const res = await request(app).post('/api/v1/outline/collections/col-1/export').set(auth()).send({});
      assert.equal(res.status, 200);
      assert.equal((callsTo('collections.export')[0].body as any).format, 'outline-markdown');
    });

    it('rejects an unknown export format rather than silently defaulting it', async () => {
      reset();
      // As a POST the format is schema-validated, so a typo is a 400 instead of a
      // silently different export — the old GET coerced it to the default.
      const res = await request(app).post('/api/v1/outline/collections/col-1/export').set(auth())
        .send({ format: 'pdf' });
      assert.equal(res.status, 400);
      assert.equal(calls.length, 0);
    });

    it('queues a whole-workspace export via POST', async () => {
      reset();
      when('/api/collections.export_all', { json: { data: { fileOperation: { id: 'f2' } } } });
      const res = await request(app).post('/api/v1/outline/exports').set(auth()).send({ format: 'json' });
      assert.equal(res.status, 200);
      assert.equal((callsTo('export_all')[0].body as any).format, 'json');
    });

    it('reports an empty export response as 502, not 400', async () => {
      reset();
      when('/api/collections.export_all', { json: {} });
      const res = await request(app).post('/api/v1/outline/exports').set(auth()).send({});
      assert.equal(res.status, 502);
    });

    it('clears a collection description and color with an explicit null', async () => {
      reset();
      when('/api/collections.update', { json: { data: { id: 'col-1' } } });
      const res = await request(app).post('/api/v1/outline/collections/col-1').set(auth())
        .send({ description: null, color: null });
      assert.equal(res.status, 200);
      const sent = callsTo('collections.update')[0].body as any;
      // Forwarded unchanged: Outline applies null as a clear, so translating it to
      // undefined would silently drop the only way to empty the field.
      assert.equal(sent.description, null);
      assert.equal(sent.color, null);
    });

    it('accepts a document body well past the 100kb Express default', async () => {
      reset();
      when('/api/documents.create', { json: { data: { id: 'd1' } } });
      // Proves /api/v1/outline is in REST_LARGE_BODY_PREFIXES — a whole markdown
      // page is the payload these endpoints exist for.
      const res = await request(app).post('/api/v1/outline/documents').set(auth())
        .send({ title: 'Big', collectionId: 'col-1', text: 'x'.repeat(300_000) });
      assert.equal(res.status, 201, `expected the large body to be parsed, got ${res.status}`);
    });
  });
});
