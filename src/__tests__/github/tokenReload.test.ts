// src/__tests__/github/tokenReload.test.ts
// A Reconnect writes a new token from the dashboard process, while an MCP
// session already open keeps the UserSession it was built with. On a 401,
// withGitHubClient re-reads the stored credential and retries once — but only
// when storage actually holds a different token. Runs against the file
// backend in a throwaway DATA_DIR so no shared data/ file is touched.
import assert from 'node:assert/strict';
import { describe, it, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'gh-reload-'));
process.env.DATA_DIR = dir;
delete process.env.DATABASE_URL;

const { createMcpInstance, updateMcpInstanceProviderTokens } = await import('../../mcpConnectionStore.js');
const { withGitHubClient, reloadStoredGitHubToken } = await import('../../github/apiHelpers.js');

const log = { info: () => {}, error: () => {} };
const EMPTY_GOOGLE = { access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0 };
const unauthorized = () => Object.assign(new Error('GitHub API GET /user failed: 401'), { status: 401, body: '{"message":"Bad credentials"}' });

async function storedInstance(token: string): Promise<string> {
  const conn = await createMcpInstance(1, 'github', `GitHub (${token})`, EMPTY_GOOGLE, null, 'github', { access_token: token } as any, null);
  return conn.instanceId;
}

describe('withGitHubClient — reloading a token replaced by Reconnect', () => {
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('retries once with the stored token when it differs from the one that got 401', async () => {
    const instanceId = await storedInstance('old');
    await updateMcpInstanceProviderTokens(instanceId, { access_token: 'new' } as any);
    const session: any = { githubAccessToken: 'old', githubInstanceId: instanceId };
    const tokensSeen: string[] = [];
    const out = await withGitHubClient('Failed', session, log, async client => {
      const token: string = (client as any).token; // the credential this attempt actually sends
      tokensSeen.push(token);
      if (token === 'old') throw unauthorized();
      return 'ok';
    });
    assert.equal(out, 'ok');
    assert.deepEqual(tokensSeen, ['old', 'new']);
    assert.equal(session.githubAccessToken, 'new', 'the session keeps the fresh token for later calls');
  });

  it('does not retry when storage holds the same token — a dead credential stays a 401', async () => {
    const instanceId = await storedInstance('same');
    const session: any = { githubAccessToken: 'same', githubInstanceId: instanceId };
    let calls = 0;
    await assert.rejects(
      withGitHubClient('Failed to list issues', session, log, async () => { calls += 1; throw unauthorized(); }),
      /Failed to list issues/,
    );
    assert.equal(calls, 1);
  });

  it('reports the retry error, not the first one, when the fresh token also fails', async () => {
    const instanceId = await storedInstance('stale');
    await updateMcpInstanceProviderTokens(instanceId, { access_token: 'also-bad' } as any);
    const session: any = { githubAccessToken: 'stale', githubInstanceId: instanceId };
    let calls = 0;
    await assert.rejects(
      withGitHubClient('Failed', session, log, async () => { calls += 1; throw unauthorized(); }),
      /Failed/,
    );
    assert.equal(calls, 2);
    assert.equal(session.githubAccessToken, 'also-bad');
  });

  it('never retries anything but a 401', async () => {
    const instanceId = await storedInstance('x');
    await updateMcpInstanceProviderTokens(instanceId, { access_token: 'y' } as any);
    const session: any = { githubAccessToken: 'x', githubInstanceId: instanceId };
    let calls = 0;
    await assert.rejects(withGitHubClient('Failed', session, log, async () => {
      calls += 1;
      throw Object.assign(new Error('GitHub API GET /x failed: 404'), { status: 404, body: '{}' });
    }));
    assert.equal(calls, 1);
  });

  it('reload is a no-op without an instance id, and for an unknown instance', async () => {
    assert.equal(await reloadStoredGitHubToken({ githubAccessToken: 't' } as any, log), false);
    assert.equal(await reloadStoredGitHubToken({ githubAccessToken: 't', githubInstanceId: 'missing' } as any, log), false);
    assert.equal(await reloadStoredGitHubToken(undefined, log), false);
  });
});
