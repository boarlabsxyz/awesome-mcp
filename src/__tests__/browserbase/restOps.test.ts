// src/__tests__/browserbase/restOps.test.ts
// The REST-plane ops, driven against stubs. The route test covers the happy
// paths through Express; these cover the two failure branches that are awkward
// to provoke through a real request.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  performExtract,
  performGetSession,
  performListSessions,
  performNavigate,
  performObserve,
  performReleaseSession,
  performStartSession,
} from '../../browserbase/restOps.js';
import { BrowserbaseAccessDenied } from '../../browserbase/accessRules.js';
import type { BrowserbaseClient } from '../../browserbase/apiHelpers.js';

function stubClient(overrides: Record<string, any> = {}): BrowserbaseClient {
  return {
    listSessions: async () => [],
    getSession: async (id: string) => ({ id, status: 'RUNNING' }),
    releaseSession: async (id: string) => ({ id, status: 'REQUEST_RELEASE' }),
    ...overrides,
  } as unknown as BrowserbaseClient;
}

function stubProxy(replies: Record<string, string | Error>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const proxy = async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    const reply = replies[name];
    if (reply instanceof Error) throw reply;
    return reply ?? '';
  };
  return { proxy: proxy as any, calls };
}

describe('performStartSession', () => {
  it('returns the id, the dashboard link and the threading note', async () => {
    const { proxy } = stubProxy({ start: '{"sessionId":"sess-1"}' });
    const result = await performStartSession(proxy, stubClient());
    assert.equal(result.sessionId, 'sess-1');
    assert.match(result.dashboardUrl, /browserbase\.com\/sessions\/sess-1/);
    assert.equal(result.session?.status, 'RUNNING');
    assert.match(result.note, /every later call/);
  });

  it('reuses a requested id and forwards it upstream', async () => {
    const { proxy, calls } = stubProxy({ start: 'Reattached.' });
    const result = await performStartSession(proxy, stubClient(), 'sess-existing');
    assert.deepEqual(calls[0].args, { sessionId: 'sess-existing' });
    assert.equal(result.sessionId, 'sess-existing');
  });

  it('throws a 502-tagged error when no id can be read', async () => {
    // Answering 201 with nothing usable would leave a browser running that the
    // caller cannot address or close.
    const { proxy } = stubProxy({ start: 'Browser ready.' });
    await assert.rejects(() => performStartSession(proxy, stubClient()), (err: any) => {
      assert.equal(err.status, 502);
      assert.match(err.message, /returned no id this endpoint could read/);
      assert.match(err.message, /GET \/api\/v1\/browserbase\/sessions to find and release it/);
      return true;
    });
  });

  it('still reports the id when the detail read fails', async () => {
    // Best-effort: failing a create that succeeded invites a retry that starts
    // a second billing browser.
    const { proxy } = stubProxy({ start: '{"sessionId":"sess-1"}' });
    const client = stubClient({ getSession: async () => { throw new Error('boom'); } });
    const result = await performStartSession(proxy, client);
    assert.equal(result.sessionId, 'sess-1');
    assert.equal(result.session, undefined);
  });
});

describe('performNavigate', () => {
  it('enforces rules before spending a browser call', async () => {
    const { proxy, calls } = stubProxy({ navigate: 'ok' });
    await assert.rejects(
      () => performNavigate(proxy, 'sess-1', { url: 'https://other.test' }, { allowedDomains: ['example.com'] }),
      (err: any) => err instanceof BrowserbaseAccessDenied,
    );
    assert.equal(calls.length, 0);
  });

  it('passes the normalised URL and the path session id', async () => {
    const { proxy, calls } = stubProxy({ navigate: 'loaded' });
    const result = await performNavigate(proxy, 'sess-1', { url: 'https://example.com/p' });
    assert.deepEqual(calls[0].args, { url: 'https://example.com/p', sessionId: 'sess-1' });
    assert.deepEqual(result, { sessionId: 'sess-1', result: 'loaded' });
  });
});

describe('performObserve / performExtract', () => {
  it('forwards the instruction', async () => {
    const { proxy, calls } = stubProxy({ observe: 'found' });
    const result = await performObserve(proxy, 'sess-1', { instruction: 'find it' });
    assert.deepEqual(calls[0].args, { instruction: 'find it', sessionId: 'sess-1' });
    assert.equal(result.result, 'found');
  });

  it('omits an absent extract instruction entirely', async () => {
    // Sending `instruction: undefined` is not the same as omitting the key.
    const { proxy, calls } = stubProxy({ extract: 'text' });
    await performExtract(proxy, 'sess-1', {});
    assert.deepEqual(calls[0].args, { sessionId: 'sess-1' });

    const withIt = stubProxy({ extract: 'text' });
    await performExtract(withIt.proxy, 'sess-1', { instruction: 'prices' });
    assert.deepEqual(withIt.calls[0].args, { instruction: 'prices', sessionId: 'sess-1' });
  });
});

describe('performListSessions / performGetSession / performReleaseSession', () => {
  it('counts the running sessions alongside the list', async () => {
    const client = stubClient({
      listSessions: async () => [{ id: 'a', status: 'RUNNING' }, { id: 'b', status: 'COMPLETED' }],
    });
    const result = await performListSessions(client);
    assert.equal(result.sessions.length, 2);
    assert.equal(result.running, 1);
  });

  it('passes a status filter through', async () => {
    let seen: string | undefined = 'unset';
    const client = stubClient({ listSessions: async (s?: string) => { seen = s; return []; } });
    await performListSessions(client, 'RUNNING');
    assert.equal(seen, 'RUNNING');
    await performListSessions(client);
    assert.equal(seen, undefined);
  });

  it('returns the session record as-is', async () => {
    assert.deepEqual(await performGetSession(stubClient(), 'sess-1'), { id: 'sess-1', status: 'RUNNING' });
  });

  it('reports the released id and the status upstream now gives', async () => {
    assert.deepEqual(await performReleaseSession(stubClient(), 'sess-1'), {
      sessionId: 'sess-1', released: true, status: 'REQUEST_RELEASE',
    });
  });

  it('still reports released when upstream answers with no status', async () => {
    const client = stubClient({ releaseSession: async () => undefined });
    const result = await performReleaseSession(client, 'sess-1');
    assert.equal(result.released, true);
    assert.equal(result.status, undefined);
  });
});
