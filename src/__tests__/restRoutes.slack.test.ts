import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { UserTokens } from '../userStore.js';
import type { GoogleTokens } from '../mcpConnectionStore.js';

// A throwaway store, set before anything reads DATA_DIR — REST auth resolves
// the user's FIRST slack-bot connection, and the shared on-disk store keeps
// every connection earlier runs created.
const dataDir = mkdtempSync(join(tmpdir(), 'rest-slack-'));
process.env.DATA_DIR = dataDir;
delete process.env.DATABASE_URL;

const { createWebOnlyApp } = await import('../website/webServer.js');
const { createOrUpdateUser, getUserByGoogleId } = await import('../userStore.js');
const { createMcpInstance } = await import('../mcpConnectionStore.js');
const { mintRestToken } = await import('../website/restTokenStore.js');

// Drives the /api/v1/slack/* handler bodies end to end: real auth (a file-store
// user plus a slack-bot connection), real routing and body validation, and a
// stubbed global fetch standing in for slack.com/api — which SlackClient calls
// form-encoded, so the recorded body is parsed as URLSearchParams.

if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: {
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:8080/auth/callback'],
    },
  });
}

const USER_ID = 8911;
const tokens: UserTokens = { access_token: 'acc', refresh_token: 'ref', scope: 'email', token_type: 'Bearer', expiry_date: Date.now() + 3600_000 };
const googleTokens: GoogleTokens = { access_token: 'mcp-acc', refresh_token: 'mcp-ref', scope: 'email', token_type: 'Bearer', expiry_date: Date.now() + 3600_000 };

interface Recorded { method: string; params: URLSearchParams }

const realFetch = globalThis.fetch;
let calls: Recorded[] = [];
/** Slack method → JSON reply. Unlisted methods answer ok:false. */
let replies: Record<string, unknown> = {};

/** What a files.slack.com download answers: the bytes and their content type. */
let fileReply: { body: string; type: string } = { body: '', type: 'application/octet-stream' };

function stubFetch(): void {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    if (String(input).startsWith('https://files.slack.com/')) {
      return new Response(fileReply.body, { status: 200, headers: { 'content-type': fileReply.type } });
    }
    const method = String(input).replace('https://slack.com/api/', '');
    calls.push({ method, params: new URLSearchParams(String(init.body ?? '')) });
    const json = replies[method] ?? { ok: false, error: `unstubbed_${method}` };
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const callsTo = (method: string) => calls.filter(c => c.method === method);
const BASE = '/api/v1/slack/channels/C0C9';

/** 20 section blocks — the size of message the ticket asked to post from a file. */
const TWENTY_BLOCKS = Array.from({ length: 20 }, (_, i) => ({
  type: 'section', text: { type: 'mrkdwn', text: `Line ${i + 1}` },
}));

describe('REST data plane: Slack handler bodies', () => {
  const app = createWebOnlyApp();
  /** The permanent dashboard API key: reads only. */
  let apiKey: string;
  /** A 5-minute bearer, as mintRestBearerForCurl returns — the only credential the writes take. */
  let bearer: string;
  const origWrites = process.env.SLACK_WRITES_ENABLED;

  before(async () => {
    const created = await createOrUpdateUser({ email: 'rest-slack@example.com', googleId: 'google-rest-slack', name: 'Slack' }, tokens);
    apiKey = created.apiKey;
    const user = await getUserByGoogleId('google-rest-slack');
    if (user) (user as any).id = USER_ID;
    await createMcpInstance(USER_ID, 'slack-bot', 'Slack Bot', googleTokens, null, 'slack-bot', { access_token: 'xoxb-rest-test' }, null);
    bearer = (await mintRestToken(USER_ID)).token;
    stubFetch();
  });

  after(() => {
    globalThis.fetch = realFetch;
    if (origWrites === undefined) delete process.env.SLACK_WRITES_ENABLED;
    else process.env.SLACK_WRITES_ENABLED = origWrites;
    rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    calls = [];
    replies = {};
    process.env.SLACK_WRITES_ENABLED = 'true';
  });

  const auth = () => ({ Authorization: `Bearer ${bearer}` });

  describe('write credentials', () => {
    // The permanent dashboard key never expires and a curl has no confirmation
    // step, so it must not be able to post or edit as the bot. It still reads.
    for (const [label, path] of [
      ['post', `${BASE}/messages`],
      ['reply', `${BASE}/threads/1.0`],
      ['edit', `${BASE}/messages/1.0/edit`],
    ]) {
      it(`refuses the permanent API key on ${label}, before calling Slack`, async () => {
        const res = await request(app).post(path).set({ Authorization: `Bearer ${apiKey}` }).send({ text: 'x' });
        assert.equal(res.status, 403);
        assert.match(res.body.error, /mintRestBearerForCurl/);
        assert.equal(calls.length, 0);
      });
    }

    it('still serves reads to the permanent API key', async () => {
      replies['conversations.history'] = { ok: true, messages: [], has_more: false };
      const res = await request(app).get(`${BASE}/messages`).set({ Authorization: `Bearer ${apiKey}` });
      assert.equal(res.status, 200);
    });
  });

  describe('POST /channels/{id}/messages', () => {
    it('posts a 20-block message exactly as sent and answers with what Slack stored', async () => {
      replies['chat.postMessage'] = { ok: true, ts: '1792342127.272519', channel: 'C0C9', message: { text: 'fallback', blocks: TWENTY_BLOCKS } };
      const res = await request(app).post(`${BASE}/messages`).set(auth()).send({ text: 'fallback', blocks: TWENTY_BLOCKS });

      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.ts, '1792342127.272519');
      assert.equal(res.body.channel, 'C0C9');
      assert.deepEqual(res.body.message.blocks, TWENTY_BLOCKS);

      const [sent] = callsTo('chat.postMessage');
      assert.equal(sent.params.get('channel'), 'C0C9');
      assert.equal(sent.params.get('text'), 'fallback');
      assert.deepEqual(JSON.parse(sent.params.get('blocks')!), TWENTY_BLOCKS);
    });

    it('takes the channel from the path, never from the body', async () => {
      replies['chat.postMessage'] = { ok: true, ts: '1.1', channel: 'C0C9' };
      const res = await request(app).post(`${BASE}/messages`).set(auth()).send({ channelId: 'C_OTHER', text: 'x' });
      assert.equal(res.status, 201);
      assert.equal(callsTo('chat.postMessage')[0].params.get('channel'), 'C0C9');
    });

    it('refuses a Slack-native field name instead of silently dropping it', async () => {
      const res = await request(app).post(`${BASE}/messages`).set(auth()).send({ text: 'x', unfurl_links: false });
      assert.equal(res.status, 400);
      assert.ok(JSON.stringify(res.body.issues).includes('unfurl_links'), JSON.stringify(res.body));
      assert.equal(calls.length, 0);
    });

    it('refuses an illegal content combination with 400 before calling Slack', async () => {
      const res = await request(app).post(`${BASE}/messages`).set(auth()).send({ text: 'x', markdownText: '- a' });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /markdownText or text/);
      assert.equal(calls.length, 0);
    });

    it('answers 503 when this deployment has Slack writes off', async () => {
      delete process.env.SLACK_WRITES_ENABLED;
      const res = await request(app).post(`${BASE}/messages`).set(auth()).send({ text: 'x' });
      assert.equal(res.status, 503);
      assert.match(res.body.error, /disabled/);
      assert.equal(calls.length, 0);
    });

    it('accepts a body past the 100kb global limit (validation, not 413)', async () => {
      const res = await request(app).post(`${BASE}/messages`).set(auth()).send({ text: 'x'.repeat(300_000), bogus: 1 });
      assert.equal(res.status, 400, `expected validation, not 413; got ${res.status}`);
    });

    it('reports link-preview flags as requested, not confirmed', async () => {
      replies['chat.postMessage'] = { ok: true, ts: '2.2', channel: 'C0C9', message: {} };
      const res = await request(app).post(`${BASE}/messages`).set(auth()).send({ text: 'x', unfurlMedia: false });
      assert.equal(res.status, 201);
      assert.deepEqual(res.body.linkPreviews, { requested: { unfurlMedia: false }, confirmed: null });
      assert.equal(callsTo('chat.postMessage')[0].params.get('unfurl_media'), 'false');
    });

    it('maps an archived channel to 403 and a revoked connection token to 502', async () => {
      replies['chat.postMessage'] = { ok: false, error: 'is_archived' };
      assert.equal((await request(app).post(`${BASE}/messages`).set(auth()).send({ text: 'x' })).status, 403);
      replies['chat.postMessage'] = { ok: false, error: 'invalid_auth' };
      assert.equal((await request(app).post(`${BASE}/messages`).set(auth()).send({ text: 'x' })).status, 502);
    });
  });

  describe('POST /channels/{id}/threads/{ts}', () => {
    it('replies in the path thread and confirms a broadcast only from Slack', async () => {
      replies['chat.postMessage'] = { ok: true, ts: '3.3', channel: 'C0C9', message: { subtype: 'thread_broadcast' } };
      const res = await request(app).post(`${BASE}/threads/1792342127.272519`).set(auth()).send({ text: 'r', broadcast: true });
      assert.equal(res.status, 201);
      assert.equal(res.body.threadTs, '1792342127.272519');
      assert.equal(res.body.broadcast, true);
      const [sent] = callsTo('chat.postMessage');
      assert.equal(sent.params.get('thread_ts'), '1792342127.272519');
      assert.equal(sent.params.get('reply_broadcast'), 'true');

      replies['chat.postMessage'] = { ok: true, ts: '3.4', channel: 'C0C9', message: {} };
      const unconfirmed = await request(app).post(`${BASE}/threads/1792342127.272519`).set(auth()).send({ text: 'r', broadcast: true });
      assert.equal(unconfirmed.body.broadcast, null);
    });
  });

  describe('POST /channels/{id}/messages/{ts}/edit', () => {
    it('edits the path ts with new blocks and returns the new content', async () => {
      const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'done' } }, { type: 'context', elements: [{ type: 'mrkdwn', text: 'c' }] }];
      replies['chat.update'] = { ok: true, ts: '1792342127.272519', channel: 'C0C9', text: 'done', message: { text: 'done', blocks } };
      const res = await request(app).post(`${BASE}/messages/1792342127.272519/edit`).set(auth()).send({ text: 'done', blocks });

      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.message.blocks, blocks);
      assert.equal(res.body.text, 'done');
      const [sent] = callsTo('chat.update');
      assert.equal(sent.params.get('ts'), '1792342127.272519');
      assert.deepEqual(JSON.parse(sent.params.get('blocks')!), blocks);
    });

    it('maps the edit refusals to 403 and 404', async () => {
      replies['chat.update'] = { ok: false, error: 'cant_update_message' };
      const denied = await request(app).post(`${BASE}/messages/1.0/edit`).set(auth()).send({ text: 'x' });
      assert.equal(denied.status, 403);
      assert.match(denied.body.error, /only be edited by/);

      replies['chat.update'] = { ok: false, error: 'message_not_found' };
      assert.equal((await request(app).post(`${BASE}/messages/1.0/edit`).set(auth()).send({ text: 'x' })).status, 404);
    });

    it('refuses an empty blocks array, which on an edit would delete every block', async () => {
      const res = await request(app).post(`${BASE}/messages/1.0/edit`).set(auth()).send({ blocks: [] });
      assert.equal(res.status, 400);
      assert.equal(calls.length, 0);
    });
  });

  describe('GET reads', () => {
    const stored = {
      type: 'message', ts: '1792342127.272519', text: 'fallback', bot_id: 'B1',
      blocks: [{ type: 'section' }], edited: { user: 'B1', ts: '1792342200.0' },
      metadata: { event_type: 'check', event_payload: { id: 7 } },
    };

    it('returns Slack message objects with metadata requested', async () => {
      replies['conversations.history'] = { ok: true, messages: [stored], has_more: false };
      const res = await request(app).get(`${BASE}/messages`).set(auth());
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.messages[0], stored);
      assert.equal(callsTo('conversations.history')[0].params.get('include_all_metadata'), 'true');
    });

    it('serves the MCP line format with ?format=text', async () => {
      replies['conversations.replies'] = { ok: true, messages: [{ ...stored, user: 'U9' }], has_more: false };
      replies['users.info'] = { ok: true, user: { id: 'U9', name: 'nine', real_name: 'Nine', profile: { display_name: 'Nine' } } };
      replies['auth.test'] = { ok: true, url: 'https://boarlabs.slack.com/' };
      const res = await request(app).get(`${BASE}/threads/1792342127.272519?format=text`).set(auth());
      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /text\/plain/);
      assert.match(res.text, /\(ts: 1792342127\.272519\) Nine: fallback/);
    });
  });

  // The REST coverage pass: openDm, findCanvasSections, downloadFile.
  describe('POST /api/v1/slack/dms', () => {
    it('opens a 1-on-1 DM and answers its channel id', async () => {
      replies['conversations.open'] = { ok: true, channel: { id: 'D42' } };
      const res = await request(app).post('/api/v1/slack/dms').set(auth()).send({ userId: 'U1' });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { channelId: 'D42', users: ['U1'], kind: 'im' });
      assert.equal(callsTo('conversations.open')[0].params.get('users'), 'U1');
    });

    it('opens a group DM with userIds', async () => {
      replies['conversations.open'] = { ok: true, channel: { id: 'G7' } };
      const res = await request(app).post('/api/v1/slack/dms').set(auth()).send({ userIds: ['U1', 'U2'] });
      assert.equal(res.status, 200);
      assert.equal(res.body.kind, 'mpim');
      assert.equal(callsTo('conversations.open')[0].params.get('users'), 'U1,U2');
    });

    it('refuses both or neither with 400, before calling Slack', async () => {
      for (const body of [{}, { userId: 'U1', userIds: ['U2', 'U3'] }]) {
        const res = await request(app).post('/api/v1/slack/dms').set(auth()).send(body);
        assert.equal(res.status, 400);
        assert.match(res.body.error, /not both or neither/);
      }
      assert.equal(calls.length, 0);
    });

    it('refuses an unknown key (strict body) and the permanent API key', async () => {
      const strict = await request(app).post('/api/v1/slack/dms').set(auth()).send({ users: 'U1' });
      assert.equal(strict.status, 400);
      const key = await request(app).post('/api/v1/slack/dms').set({ Authorization: `Bearer ${apiKey}` }).send({ userId: 'U1' });
      assert.equal(key.status, 403);
      assert.equal(calls.length, 0);
    });
  });

  describe('GET /api/v1/slack/canvases/:canvasId/sections', () => {
    it('looks sections up by text and header type', async () => {
      replies['canvases.sections.lookup'] = { ok: true, sections: [{ id: 'temp:C:1' }, { id: 'temp:C:2' }] };
      const res = await request(app).get('/api/v1/slack/canvases/F9/sections?containsText=Intro&sectionTypes=h1,h2').set(auth());
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { canvasId: 'F9', sections: [{ id: 'temp:C:1' }, { id: 'temp:C:2' }] });
      const sent = callsTo('canvases.sections.lookup')[0].params;
      assert.equal(sent.get('canvas_id'), 'F9');
      assert.deepEqual(JSON.parse(sent.get('criteria')!), { contains_text: 'Intro', section_types: ['h1', 'h2'] });
    });

    it('answers 400 with no criteria, and for an unknown header type', async () => {
      const none = await request(app).get('/api/v1/slack/canvases/F9/sections').set(auth());
      assert.equal(none.status, 400);
      assert.match(none.body.error, /containsText and\/or sectionTypes/);
      const bad = await request(app).get('/api/v1/slack/canvases/F9/sections?sectionTypes=h9').set(auth());
      assert.equal(bad.status, 400);
      assert.ok(bad.body.issues);
      assert.equal(calls.length, 0);
    });

    it('maps a Slack canvas_not_found to 404', async () => {
      replies['canvases.sections.lookup'] = { ok: false, error: 'canvas_not_found' };
      const res = await request(app).get('/api/v1/slack/canvases/F9/sections?containsText=x').set(auth());
      assert.equal(res.status, 404);
    });
  });

  describe('GET /api/v1/slack/files/:fileId/download', () => {
    const shared = { id: 'F1', name: 'a.txt', mimetype: 'text/plain', channels: ['C1'], url_private_download: 'https://files.slack.com/f/a.txt' };

    it('requires channelId', async () => {
      const res = await request(app).get('/api/v1/slack/files/F1/download').set(auth());
      assert.equal(res.status, 400);
      assert.match(res.body.error, /channelId/);
      assert.equal(calls.length, 0);
    });

    it('refuses a file not shared in the named channel with 403', async () => {
      replies['files.info'] = { ok: true, file: shared };
      const res = await request(app).get('/api/v1/slack/files/F1/download?channelId=C2').set(auth());
      assert.equal(res.status, 403);
      assert.match(res.body.error, /not shared in channel C2/);
    });

    it('answers 422 for a file hosted outside Slack, and 404 with no download URL', async () => {
      replies['files.info'] = { ok: true, file: { ...shared, is_external: true } };
      const ext = await request(app).get('/api/v1/slack/files/F1/download?channelId=C1').set(auth());
      assert.equal(ext.status, 422);
      replies['files.info'] = { ok: true, file: { id: 'F1', channels: ['C1'] } };
      const gone = await request(app).get('/api/v1/slack/files/F1/download?channelId=C1').set(auth());
      assert.equal(gone.status, 404);
    });

    it('streams the bytes with an RFC 6266 disposition for non-Latin and emoji names', async () => {
      for (const name of ['звіт.pdf', 'plan 📈.csv']) {
        replies['files.info'] = { ok: true, file: { ...shared, name, mimetype: 'application/pdf' } };
        fileReply = { body: '%PDF-1.7', type: 'application/pdf' };
        const res = await request(app).get('/api/v1/slack/files/F1/download?channelId=C1').set(auth())
          .buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
        assert.equal(res.status, 200, `${name}: ${res.status}`);
        assert.equal((res.body as Buffer).toString(), '%PDF-1.7');
        assert.match(res.headers['content-type'], /application\/pdf/);
        assert.ok(res.headers['content-disposition'].includes(`filename*=UTF-8''${encodeURIComponent(name)}`));
        assert.match(res.headers['content-disposition'], /^attachment; filename="[\x20-\x7e]+"/);
      }
    });

    it('downloads a real .html file, and answers 403 when Slack sends a sign-in page instead', async () => {
      replies['files.info'] = { ok: true, file: { ...shared, name: 'page.html', mimetype: 'text/html' } };
      fileReply = { body: '<h1>Report</h1>', type: 'text/html; charset=utf-8' };
      const html = await request(app).get('/api/v1/slack/files/F1/download?channelId=C1').set(auth());
      assert.equal(html.status, 200);
      assert.equal(html.text, '<h1>Report</h1>');

      replies['files.info'] = { ok: true, file: shared };
      fileReply = { body: '<html>Sign in</html>', type: 'text/html' };
      const signIn = await request(app).get('/api/v1/slack/files/F1/download?channelId=C1').set(auth());
      assert.equal(signIn.status, 403);
      assert.match(signIn.body.error, /files:read/);
    });

    it('answers 403 naming the scope when files.info lacks files:read', async () => {
      replies['files.info'] = { ok: false, error: 'missing_scope' };
      const res = await request(app).get('/api/v1/slack/files/F1/download?channelId=C1').set(auth());
      assert.equal(res.status, 403);
      assert.match(res.body.error, /files:read/);
    });
  });
});
