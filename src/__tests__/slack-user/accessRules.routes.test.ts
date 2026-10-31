// src/__tests__/slack-user/accessRules.routes.test.ts
// Drives the dashboard's Slack Access Rules GET end to end: the NDJSON stream
// the modal's progress display reads, the refusals that must stay plain status
// codes, and the page's own stream reader run against what the route sends.
// Shaped after src/__tests__/github/accessRules.routes.test.ts. File backend,
// throwaway DATA_DIR — set before anything that reads it is imported.
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'crypto';
import request from 'supertest';

const dir = mkdtempSync(join(tmpdir(), 'slack-rules-routes-'));
process.env.DATA_DIR = dir;
delete process.env.DATABASE_URL;
if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: { client_id: 'test.apps.googleusercontent.com', client_secret: 's', redirect_uris: ['http://localhost:8080/auth/callback'] },
  });
}

const { createWebOnlyApp } = await import('../../website/webServer.js');
const { createSession } = await import('../../website/sessionStore.js');
const { createOrUpdateUser, getUserByGoogleId } = await import('../../userStore.js');
const { createMcpInstance } = await import('../../mcpConnectionStore.js');

const COOKIE_SECRET = process.env.COOKIE_SECRET || 'dev-secret-change-me';
const signCookie = (val: string) =>
  `s:${val}.${crypto.createHmac('sha256', COOKIE_SECRET).update(val).digest('base64').replace(/=+$/, '')}`;

const OWNER_ID = 9402;
const EMPTY_GOOGLE = { access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0 };
const slackOk = (body: Record<string, unknown>) =>
  new Response(JSON.stringify({ ok: true, ...body }), { status: 200, headers: { 'content-type': 'application/json' } });

/** Pull the page's real stream reader out of its inline script. */
function pageStreamReader(): (response: unknown, onProgress: (event: any) => void) => Promise<any> {
  const html = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'public', 'dashboard.html'), 'utf8',
  );
  const match = html.match(/async function readAccessRulesStream\(response, onProgress\) \{[\s\S]*?\n {4}\}/);
  assert.ok(match, 'readAccessRulesStream not found in dashboard.html — was it renamed?');
  return new Function(`return (${match[0]});`)();
}

const parseLines = (text: string) => text.trim().split('\n').map(line => JSON.parse(line));

describe('Slack Access Rules dashboard GET', () => {
  const app = createWebOnlyApp();
  const realFetch = globalThis.fetch;
  let cookie: string;
  let instanceId: string;
  let strangersId: string;
  let noTokenId: string;
  let failingId: string;

  before(async () => {
    await createOrUpdateUser({ email: 'slack-rules@example.com', googleId: 'google-slack-rules', name: 'Slack' },
      { access_token: 'a', refresh_token: 'r', scope: 'email', token_type: 'Bearer', expiry_date: Date.now() + 3600_000 });
    const user = await getUserByGoogleId('google-slack-rules');
    if (user) (user as any).id = OWNER_ID;
    cookie = `session=${signCookie(await createSession('google-slack-rules'))}`;

    const make = async (userId: number, tokens: unknown) =>
      (await createMcpInstance(userId, 'slack', 'Slack', EMPTY_GOOGLE, null, 'slack', tokens as any, null)).instanceId;
    instanceId = await make(OWNER_ID, {
      access_token: 'xoxp-mine',
      accessRules: { allowedOrgs: [], blacklistUsers: ['U1', 'U2'], whitelistChannels: [], blacklistChannels: [], allowPublicOnly: false },
    });
    strangersId = await make(OWNER_ID + 1, { access_token: 'xoxp-theirs' });
    noTokenId = await make(OWNER_ID, {});
    // Its blacklist entry is not an array, so the route throws after the sweep.
    failingId = await make(OWNER_ID, { access_token: 'xoxp-failing', accessRules: { blacklistUsers: 7 } });

    globalThis.fetch = (async (input: any) => {
      const method = new URL(String(input)).pathname.split('/').pop();
      switch (method) {
        case 'team.info': return slackOk({ team: { id: 'T_HOME', name: 'Home', domain: 'home' } });
        case 'conversations.list': return slackOk({ channels: [] });
        case 'users.conversations': return slackOk({ channels: [] });
        case 'users.list': return slackOk({ members: [{ id: 'U9', team_id: 'T_HOME' }] });
        case 'users.info': return slackOk({ user: { id: 'U1', name: 'someone' } });
        default: return slackOk({});
      }
    }) as typeof fetch;
  });

  after(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (id: string) =>
    request(app).get(`/api/instances/${id}/access-rules`).set('Cookie', cookie)
      .buffer(true).parse((res, done) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => done(null, text));
      });

  it('streams every stage in order, then one result carrying the rules', async () => {
    const res = await get(instanceId);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /application\/x-ndjson/);

    const events = parseLines(res.body);
    const stages = [...new Set(events.filter(e => e.type === 'progress').map(e => e.stage))];
    assert.deepEqual(stages, [
      'channels', 'memberChannels', 'dms', 'users', 'channelInfo', 'dmUsers', 'names', 'blacklistUsers',
    ]);

    const last = events.at(-1);
    assert.equal(last.type, 'result');
    assert.equal(events.filter(e => e.type === 'result').length, 1);
    assert.equal(last.currentOrg.id, 'T_HOME');
    assert.deepEqual(last.currentRules.blacklistUsers, ['U1', 'U2']);
    assert.equal(last.blacklistUserDetails.length, 2);
  });

  it('skips the sweep stages on a cached reopen, and still ends in a result', async () => {
    const res = await get(instanceId);
    const events = parseLines(res.body);
    const stages = [...new Set(events.filter(e => e.type === 'progress').map(e => e.stage))];
    assert.deepEqual(stages, ['blacklistUsers']);
    assert.equal(events.at(-1).type, 'result');
  });

  it('keeps plain status codes for refusals that come before the sweep', async () => {
    const stranger = await request(app).get(`/api/instances/${strangersId}/access-rules`).set('Cookie', cookie);
    assert.equal(stranger.status, 404);
    assert.equal(stranger.body.error, 'Slack connection not found');

    const noToken = await request(app).get(`/api/instances/${noTokenId}/access-rules`).set('Cookie', cookie);
    assert.equal(noToken.status, 400);
    assert.equal(noToken.body.error, 'No Slack token found');
  });

  it('reports a failure after the 200 as an error line, not a truncated stream', async () => {
    const res = await get(failingId);
    assert.equal(res.status, 200);
    const last = parseLines(res.body).at(-1);
    assert.deepEqual(last, { type: 'error', error: 'Failed to load access rules' });
  });

  it('the page reader returns the result and passes progress along, across split chunks', async () => {
    const body = (await get(instanceId)).body as string;
    // A chunk boundary falls wherever the network puts it, usually mid-line.
    const bytes = new TextEncoder().encode(body);
    const middle = Math.floor(bytes.length / 2);
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, middle));
        controller.enqueue(bytes.slice(middle));
        controller.close();
      },
    }));
    const seen: string[] = [];
    const data = await pageStreamReader()(response, event => seen.push(event.stage));
    assert.equal(data.type, 'result');
    assert.ok(seen.includes('blacklistUsers'));
  });

  it('the page reader refuses a stream that ends with no final line', async () => {
    const response = new Response('{"type":"progress","stage":"channels","done":1}\n');
    await assert.rejects(() => pageStreamReader()(response, () => {}), /closed before loading finished/);
  });

  it('the page reader surfaces an error line', async () => {
    const response = new Response('{"type":"error","error":"Failed to load access rules"}\n');
    await assert.rejects(() => pageStreamReader()(response, () => {}), /Failed to load access rules/);
  });
});
