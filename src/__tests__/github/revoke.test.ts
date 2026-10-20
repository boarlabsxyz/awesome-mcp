// src/__tests__/github/revoke.test.ts
// Which GitHub revocation a delete/reconnect performs. The grant is the only
// way to get GitHub's consent screen back, and it kills every token the
// account holds for the app — so it must never be spent when the same account
// backs another connector.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { revokeGitHubConnection } from '../../github/revoke.js';

const APP = { clientId: 'Ov23cid', clientSecret: 'sec' };
const conn = (instanceId: string, token: string, provider = 'github') => ({ instanceId, provider, providerTokens: { access_token: token } });

/** Answers GET /user from `logins` (token → login, or a status), and DELETEs with `deleteStatus`. */
function github(logins: Record<string, string | number>, deleteStatus = 204) {
  const calls: Array<{ method: string; path: string; auth: string; body?: any }> = [];
  const fetchImpl = (async (url: any, init: any) => {
    const path = new URL(String(url)).pathname;
    const auth = String(init.headers.Authorization);
    calls.push({ method: init.method, path, auth, body: init.body ? JSON.parse(init.body) : undefined });
    if (init.method === 'DELETE') return new Response(null, { status: deleteStatus });
    const who = logins[auth.replace('Bearer ', '')];
    return typeof who === 'number'
      ? new Response('{}', { status: who })
      : new Response(JSON.stringify({ login: who }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('revokeGitHubConnection', () => {
  it('revokes the GRANT when no other connector uses the account, so consent is asked again', async () => {
    const { fetchImpl, calls } = github({});
    const result = await revokeGitHubConnection(conn('a', 'gho_aaa'), [conn('a', 'gho_aaa')], { ...APP, fetchImpl });
    assert.equal(result.outcome, 'grant');
    assert.match(result.message, /asks GitHub for consent again, including organization access/);
    const del = calls.find(c => c.method === 'DELETE')!;
    assert.equal(del.path, '/applications/Ov23cid/grant');
    assert.equal(del.auth, `Basic ${Buffer.from('Ov23cid:sec').toString('base64')}`);
    assert.deepEqual(del.body, { access_token: 'gho_aaa' });
  });

  it('revokes only the TOKEN when another connector uses the same account', async () => {
    const { fetchImpl, calls } = github({ gho_aaa: 'Me', gho_bbb: 'me' });
    const result = await revokeGitHubConnection(conn('a', 'gho_aaa'), [conn('a', 'gho_aaa'), conn('b', 'gho_bbb')], { ...APP, fetchImpl });
    assert.equal(result.outcome, 'token');
    assert.match(result.message, /would have disconnected it too/);
    assert.equal(calls.find(c => c.method === 'DELETE')!.path, '/applications/Ov23cid/token');
  });

  it('still revokes the grant when the other connector is a DIFFERENT account', async () => {
    const { fetchImpl } = github({ gho_aaa: 'me', ghu_bbb: 'someone-else' });
    const result = await revokeGitHubConnection(conn('a', 'gho_aaa'), [conn('b', 'ghu_bbb')], { ...APP, fetchImpl });
    assert.equal(result.outcome, 'grant');
  });

  it('treats an account it cannot identify as shared — a guess must not break a connector', async () => {
    const { fetchImpl } = github({ gho_aaa: 'me', gho_bbb: 401 });
    const result = await revokeGitHubConnection(conn('a', 'gho_aaa'), [conn('b', 'gho_bbb')], { ...APP, fetchImpl });
    assert.equal(result.outcome, 'token');
  });

  it('ignores pasted tokens and other providers when looking for a shared account', async () => {
    const { fetchImpl, calls } = github({});
    const result = await revokeGitHubConnection(conn('a', 'gho_aaa'),
      [conn('b', 'ghp_pasted'), conn('c', 'gho_x', 'slack')], { ...APP, fetchImpl });
    assert.equal(result.outcome, 'grant');
    assert.equal(calls.filter(c => c.method === 'GET').length, 0, 'no account lookups were needed');
  });

  it('does not try to revoke a pasted token, and says where to delete it', async () => {
    for (const token of ['ghp_classic', 'github_pat_finegrained']) {
      const { fetchImpl, calls } = github({});
      const result = await revokeGitHubConnection(conn('a', token), [], { ...APP, fetchImpl });
      assert.equal(result.outcome, 'not-oauth');
      assert.match(result.message, /Personal access tokens/);
      assert.equal(calls.length, 0);
    }
  });

  it('does nothing without an OAuth app configured', async () => {
    const { fetchImpl, calls } = github({});
    const result = await revokeGitHubConnection(conn('a', 'gho_aaa'), [], { clientId: '', clientSecret: '', fetchImpl });
    assert.equal(result.outcome, 'no-app');
    assert.equal(calls.length, 0);
  });

  it('counts a 404 (token already gone) as done, and anything else as failed with a manual fallback', async () => {
    assert.equal((await revokeGitHubConnection(conn('a', 'gho_aaa'), [], { ...APP, fetchImpl: github({}, 404).fetchImpl })).outcome, 'grant');
    const failed = await revokeGitHubConnection(conn('a', 'gho_aaa'), [], { ...APP, fetchImpl: github({}, 500).fetchImpl });
    assert.equal(failed.outcome, 'failed');
    assert.match(failed.message, /github\.com\/settings\/applications/);
    const unreachable = await revokeGitHubConnection(conn('a', 'gho_aaa'), [], {
      ...APP, fetchImpl: (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch,
    });
    assert.equal(unreachable.outcome, 'failed');
    assert.match(unreachable.message, /ECONNRESET/);
  });
});
