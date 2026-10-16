// src/__tests__/github/tokenReload.test.ts
// A Reconnect writes a new token from the dashboard process, while an MCP
// session already open keeps the UserSession it was built with. On a 401 the
// client re-reads the stored credential and re-sends THAT request once — but
// only when storage holds a different token, and never the requests before it
// in the same op, which already ran. Runs against the file backend in a
// throwaway DATA_DIR so no shared data/ file is touched.
import assert from 'node:assert/strict';
import { describe, it, after, afterEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'gh-reload-'));
process.env.DATA_DIR = dir;
delete process.env.DATABASE_URL;

const { createMcpInstance, updateMcpInstanceProviderTokens } = await import('../../mcpConnectionStore.js');
const { GitHubClient, withGitHubClient, reloadStoredGitHubToken } = await import('../../github/apiHelpers.js');

const log = { info: () => {}, error: () => {} };
const EMPTY_GOOGLE = { access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0 };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function storedInstance(token: string): Promise<string> {
  const conn = await createMcpInstance(1, 'github', `GitHub (${token})`, EMPTY_GOOGLE, null, 'github', { access_token: token } as any, null);
  return conn.instanceId;
}

/** Records every request as `METHOD path token`, answering 401 to any token in `dead`. */
function stubGitHub(dead: Set<string>) {
  const seen: string[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const token = String(init.headers.Authorization).replace('Bearer ', '');
    const path = new URL(String(url)).pathname;
    seen.push(`${init.method} ${path} ${token}`);
    if (dead.has(token)) return json(401, { message: 'Bad credentials' });
    return init.method === 'POST' ? json(201, { number: 1 }) : json(200, { number: 1 });
  }) as typeof fetch;
  return seen;
}

describe('a token replaced by Reconnect is picked up at the request that failed', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('re-sends only the rejected request — a write that already ran is not replayed', async () => {
    // The shape CodeRabbit flagged: create (succeeds), then re-read (401).
    // Replaying the whole callback would file the issue twice.
    const instanceId = await storedInstance('old');
    await updateMcpInstanceProviderTokens(instanceId, { access_token: 'new' } as any);
    const session: any = { githubAccessToken: 'old', githubInstanceId: instanceId };
    const seen: string[] = [];
    let firstDone = false;
    globalThis.fetch = (async (url: any, init: any) => {
      // The write goes through on the old token; the read after it is refused.
      if (firstDone && String(init.headers.Authorization).endsWith(' old')) {
        seen.push(`${init.method} ${new URL(String(url)).pathname} old`);
        return json(401, { message: 'Bad credentials' });
      }
      firstDone = true;
      seen.push(`${init.method} ${new URL(String(url)).pathname} ${String(init.headers.Authorization).slice(7)}`);
      return json(init.method === 'POST' ? 201 : 200, { number: 1 });
    }) as typeof fetch;

    const out = await withGitHubClient('Failed', session, log, async client => {
      await client.post('/repos/o/r/issues', { title: 't' });
      const { data } = await client.get<{ number: number }>('/repos/o/r/issues/1');
      return data.number;
    });
    assert.equal(out, 1);
    assert.deepEqual(seen, [
      'POST /repos/o/r/issues old',
      'GET /repos/o/r/issues/1 old',
      'GET /repos/o/r/issues/1 new',
    ]);
    assert.equal(session.githubAccessToken, 'new', 'the session keeps the fresh token for later calls');
  });

  it('later requests in the same op use the fresh token without another 401', async () => {
    const instanceId = await storedInstance('stale');
    await updateMcpInstanceProviderTokens(instanceId, { access_token: 'fresh' } as any);
    const session: any = { githubAccessToken: 'stale', githubInstanceId: instanceId };
    const seen = stubGitHub(new Set(['stale']));
    await withGitHubClient('Failed', session, log, async client => {
      await client.get('/a');
      await client.get('/b');
    });
    assert.deepEqual(seen, ['GET /a stale', 'GET /a fresh', 'GET /b fresh']);
  });

  it('does not retry when storage holds the same token — a dead credential stays a 401', async () => {
    const instanceId = await storedInstance('same');
    const session: any = { githubAccessToken: 'same', githubInstanceId: instanceId };
    const seen = stubGitHub(new Set(['same']));
    await assert.rejects(
      withGitHubClient('Failed to list issues', session, log, client => client.get('/repos/o/r/issues')),
      /Failed to list issues/,
    );
    assert.equal(seen.length, 1);
  });

  it('reports the 401 when the fresh token is refused too, after exactly one retry', async () => {
    const instanceId = await storedInstance('bad1');
    await updateMcpInstanceProviderTokens(instanceId, { access_token: 'bad2' } as any);
    const session: any = { githubAccessToken: 'bad1', githubInstanceId: instanceId };
    const seen = stubGitHub(new Set(['bad1', 'bad2']));
    await assert.rejects(withGitHubClient('Failed', session, log, client => client.get('/x')), /Failed/);
    assert.deepEqual(seen, ['GET /x bad1', 'GET /x bad2']);
  });

  it('never retries anything but a 401', async () => {
    let asked = 0;
    globalThis.fetch = (async () => json(404, { message: 'Not Found' })) as typeof fetch;
    const client = new GitHubClient('t', { onUnauthorized: async () => { asked += 1; return 'other'; } });
    await assert.rejects(client.get('/x'), (e: any) => e.status === 404);
    assert.equal(asked, 0);
  });

  it('concurrent 401s on one client read the store once', async () => {
    let asked = 0;
    globalThis.fetch = (async (_url: any, init: any) =>
      String(init.headers.Authorization).endsWith(' old') ? json(401, {}) : json(200, {})) as typeof fetch;
    const client = new GitHubClient('old', { onUnauthorized: async () => { asked += 1; return 'new'; } });
    await Promise.all([client.get('/a'), client.get('/b'), client.get('/c')]);
    assert.equal(asked, 1);
  });

  it('reload is a no-op without an instance id, and for an unknown instance', async () => {
    assert.equal(await reloadStoredGitHubToken({ githubAccessToken: 't' } as any, log), false);
    assert.equal(await reloadStoredGitHubToken({ githubAccessToken: 't', githubInstanceId: 'missing' } as any, log), false);
    assert.equal(await reloadStoredGitHubToken(undefined, log), false);
  });
});
