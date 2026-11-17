import assert from 'node:assert/strict';
import { describe, it, before, after, beforeEach } from 'node:test';
import request from 'supertest';
import { createWebOnlyApp } from '../website/webServer.js';
import { createOrUpdateUser, getUserByGoogleId, UserTokens } from '../userStore.js';
import { createMcpInstance, GoogleTokens } from '../mcpConnectionStore.js';

// GET /api/v1/clickup/workspaces/:workspaceId/attachments — the handler body:
// what reaches ClickUp (token, Range), what the caller gets back (bytes,
// headers, 206), and the refusals that keep a login page from being saved as
// the file. ClickUpClient and openAttachment both go through global fetch, so
// stubbing it reaches them; node:test runs each file in its own process.

if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: {
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:8080/auth/callback'],
    },
  });
}

const USER_ID = 8803;
const WS = '90151491867';
const MP4 = `https://t${WS}.p.clickup-attachments.com/t${WS}/7044da6f/7044da6f.mp4?view=open&filename=demo.mp4`;
const ROUTE = `/api/v1/clickup/workspaces/${WS}/attachments?url=${encodeURIComponent(MP4)}`;

const dummyUserTokens: UserTokens = {
  access_token: 'acc', refresh_token: 'ref', scope: 'email',
  token_type: 'Bearer', expiry_date: Date.now() + 3600_000,
};
const dummyGoogleTokens: GoogleTokens = {
  access_token: 'mcp-acc', refresh_token: 'mcp-ref', scope: 'email',
  token_type: 'Bearer', expiry_date: Date.now() + 3600_000,
};

const realFetch = globalThis.fetch;
let sent: Array<{ url: string; headers: Record<string, string> }> = [];
let attachment: () => Response;
let teams: unknown;

function stubFetch(): void {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    sent.push({ url, headers: { ...(init.headers ?? {}) } });
    if (url.includes('api.clickup.com') && url.endsWith('/team')) {
      return new Response(JSON.stringify(teams), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('clickup-attachments.com')) return attachment();
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

describe('REST: ClickUp attachment download', () => {
  const app = createWebOnlyApp();
  let bearer: string;

  before(async () => {
    const created = await createOrUpdateUser(
      { email: 'rest-cu-att@example.com', googleId: 'google-rest-cu-att', name: 'REST CU Attachments' },
      dummyUserTokens,
    );
    bearer = created.apiKey;
    // The file store does not assign the numeric id the connection lookup keys on.
    const user = await getUserByGoogleId('google-rest-cu-att');
    if (user) (user as any).id = USER_ID;
    await createMcpInstance(
      USER_ID, 'clickup', 'Test ClickUp', dummyGoogleTokens, null,
      'clickup', { access_token: 'cu-token' }, null,
    );
    stubFetch();
  });

  after(() => { globalThis.fetch = realFetch; });

  beforeEach(() => {
    sent = [];
    teams = { teams: [{ id: WS }] };
    attachment = () => new Response('MP4BYTES', {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': '8', 'accept-ranges': 'bytes' },
    });
  });

  const auth = () => ({ Authorization: `Bearer ${bearer}` });

  it('streams the file with its type, length and a download name, sending the connection token', async () => {
    const res = await request(app).get(ROUTE).set(auth()).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(res.status, 200);
    assert.equal((res.body as Buffer).toString(), 'MP4BYTES');
    assert.equal(res.headers['content-type'], 'video/mp4');
    assert.equal(res.headers['content-length'], '8');
    assert.equal(res.headers['accept-ranges'], 'bytes');
    assert.match(res.headers['content-disposition'], /filename="demo\.mp4"/);
    const upstream = sent.find((s) => s.url.includes('clickup-attachments.com'))!;
    assert.equal(upstream.headers.Authorization, 'Bearer cu-token');
  });

  it('forwards Range and answers 206 with Content-Range', async () => {
    attachment = () => new Response('0'.repeat(1024), {
      status: 206,
      headers: { 'content-type': 'video/mp4', 'content-length': '1024', 'content-range': 'bytes 0-1023/99999' },
    });
    const res = await request(app).get(ROUTE).set(auth()).set('Range', 'bytes=0-1023');
    assert.equal(res.status, 206);
    assert.equal(res.headers['content-range'], 'bytes 0-1023/99999');
    assert.equal(res.headers['content-length'], '1024');
    assert.equal(sent.find((s) => s.url.includes('clickup-attachments.com'))!.headers.Range, 'bytes=0-1023');
  });

  it('passes a 416 through with Content-Range', async () => {
    attachment = () => new Response(null, { status: 416, headers: { 'content-range': 'bytes */10' } });
    const res = await request(app).get(ROUTE).set(auth()).set('Range', 'bytes=50-60');
    assert.equal(res.status, 416);
    assert.equal(res.headers['content-range'], 'bytes */10');
  });

  it('refuses a malformed Range header before calling ClickUp', async () => {
    const res = await request(app).get(ROUTE).set(auth()).set('Range', 'items=0-1');
    assert.equal(res.status, 400);
    assert.equal(sent.length, 0);
  });

  it('requires url', async () => {
    const res = await request(app).get(`/api/v1/clickup/workspaces/${WS}/attachments`).set(auth());
    assert.equal(res.status, 400);
    assert.match(res.body.error, /`url` is required/);
  });

  it('refuses any other host with 400 and fetches nothing', async () => {
    const res = await request(app)
      .get(`/api/v1/clickup/workspaces/${WS}/attachments?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data')}`)
      .set(auth());
    assert.equal(res.status, 400);
    assert.equal(sent.length, 0);
  });

  it('answers 404 for a workspace the connection cannot see, before touching the attachment', async () => {
    teams = { teams: [{ id: '1' }] };
    const res = await request(app).get(ROUTE).set(auth());
    assert.equal(res.status, 404);
    assert.equal(sent.some((s) => s.url.includes('clickup-attachments.com')), false);
  });

  // The reported failure: a 236 KB login page saved as the recording.
  it('answers 403 instead of streaming the sign-in flow', async () => {
    attachment = () => new Response(null, {
      status: 302,
      headers: { location: `https://id.app.clickup.com/attachments/v1/data/workspaces/${WS}/utils/authz_token` },
    });
    const res = await request(app).get(ROUTE).set(auth());
    assert.equal(res.status, 403);
    assert.match(res.body.error, /did not accept this connection's token/);
  });

  it('never echoes an upstream 401, which here would mean a bad bearer', async () => {
    attachment = () => new Response('unauthorized', { status: 401 });
    const res = await request(app).get(ROUTE).set(auth());
    assert.equal(res.status, 403);
  });

  it('keeps an upstream 404 a 404', async () => {
    attachment = () => new Response('nope', { status: 404 });
    const res = await request(app).get(ROUTE).set(auth());
    assert.equal(res.status, 404);
  });
});
