import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UserError } from 'fastmcp';

import {
  formatSession,
  opAct,
  formatSessionList,
  opEnd,
  opExtract,
  opGetBrowserSession,
  opListBrowserSessions,
  opNavigate,
  opObserve,
  opStart,
} from '../../browserbase/ops.js';
import { BrowserbaseAccessDenied } from '../../browserbase/accessRules.js';
import type { BrowserbaseClient, BrowserbaseSession } from '../../browserbase/apiHelpers.js';

/** A client stub with only the methods the ops touch. */
function stubClient(overrides: Partial<Record<keyof BrowserbaseClient, any>> = {}): BrowserbaseClient {
  return {
    listSessions: async () => [],
    getSession: async (id: string) => ({ id, status: 'RUNNING' } as BrowserbaseSession),
    releaseSession: async (id: string) => ({ id, status: 'REQUEST_RELEASE' } as BrowserbaseSession),
    ...overrides,
  } as unknown as BrowserbaseClient;
}

/** A proxy stub that records calls and returns canned text per tool. */
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

describe('opStart', () => {
  it('leads with the sessionId and tells the caller to thread it', async () => {
    const { proxy } = stubProxy({ start: '{"sessionId":"sess-abc123"}' });
    const text = await opStart(proxy, stubClient(), {});
    assert.match(text, /sess-abc123/);
    // The reminder is the whole reason this op is not a passthrough: dropping
    // the id fails later with an opaque "no active session".
    assert.match(text, /pass sessionId: "sess-abc123" to every following browser call/);
    assert.match(text, /end when finished so it stops billing/);
  });

  it('reports the expiry so the cost is visible at creation', async () => {
    const { proxy } = stubProxy({ start: '{"sessionId":"sess-abc123"}' });
    const client = stubClient({
      getSession: async () => ({ id: 'sess-abc123', status: 'RUNNING', expiresAt: '2026-10-05T12:00:00Z' }),
    });
    const text = await opStart(proxy, client, {});
    assert.match(text, /Expires: 2026-10-05T12:00:00Z/);
  });

  it('still succeeds when the detail read fails', async () => {
    // Best-effort: the session exists either way, and failing a create that
    // worked would invite a retry that starts a second browser.
    const { proxy } = stubProxy({ start: '{"sessionId":"sess-abc123"}' });
    const client = stubClient({ getSession: async () => { throw new Error('boom'); } });
    const text = await opStart(proxy, client, {});
    assert.match(text, /sess-abc123/);
    assert.match(text, /browserbase\.com\/sessions\/sess-abc123/);
  });

  it('refuses to report success when no id can be read', async () => {
    const { proxy } = stubProxy({ start: 'Browser ready.' });
    await assert.rejects(
      () => opStart(proxy, stubClient(), {}),
      (err: any) => {
        assert.ok(err instanceof UserError);
        // A 200 with no id would leave a browser running that nothing can
        // address or close, so this has to be loud.
        assert.match(err.message, /did not return an id/);
        assert.match(err.message, /listBrowserSessions/);
        return true;
      },
    );
  });

  it('keeps a reattach id when the response omits one', async () => {
    const { proxy, calls } = stubProxy({ start: 'Reattached.' });
    const text = await opStart(proxy, stubClient(), { sessionId: 'sess-existing' });
    assert.deepEqual(calls[0].args, { sessionId: 'sess-existing' });
    assert.match(text, /sess-existing/);
  });

  it('surfaces the connection rules and their ceiling', async () => {
    const { proxy } = stubProxy({ start: '{"sessionId":"sess-abc123"}' });
    const text = await opStart(proxy, stubClient(), {}, { allowedDomains: ['example.com'] });
    assert.match(text, /example\.com/);
    assert.match(text, /navigate only/i);
  });
});

describe('opEnd', () => {
  it('reports a clean close', async () => {
    const { proxy, calls } = stubProxy({ end: '' });
    const text = await opEnd(proxy, stubClient(), { sessionId: 'sess-1' });
    assert.deepEqual(calls[0], { name: 'end', args: { sessionId: 'sess-1' } });
    assert.match(text, /closed \(sess-1\)/);
    assert.match(text, /no longer billing/);
  });

  it('falls back to the REST release when the browser-control call fails', async () => {
    // The ticket's scenario is "no session left running and billing", so a
    // failed proxy call must not be reported as a close.
    const { proxy } = stubProxy({ end: new Error('transport exploded') });
    let released: string | undefined;
    const client = stubClient({
      releaseSession: async (id: string) => { released = id; return { id, status: 'REQUEST_RELEASE' }; },
    });
    const text = await opEnd(proxy, client, { sessionId: 'sess-1' });
    assert.equal(released, 'sess-1');
    assert.match(text, /closed via the Browserbase REST API/);
    // Which path closed it matters for whether the browser is reusable.
    assert.match(text, /transport exploded/);
  });

  it('reports the session as possibly still billing when both paths fail', async () => {
    const { proxy } = stubProxy({ end: new Error('proxy down') });
    const client = stubClient({ releaseSession: async () => { throw new Error('rest down'); } });
    await assert.rejects(
      () => opEnd(proxy, client, { sessionId: 'sess-1' }),
      (err: any) => {
        assert.match(err.message, /proxy down/);
        assert.match(err.message, /rest down/);
        assert.match(err.message, /may still be running and billing/);
        return true;
      },
    );
  });

  it('has nothing to fall back to without a sessionId, and says so', async () => {
    const { proxy } = stubProxy({ end: new Error('no active session') });
    await assert.rejects(
      () => opEnd(proxy, stubClient(), {}),
      (err: any) => {
        assert.match(err.message, /No sessionId was passed/);
        assert.match(err.message, /forceEndBrowserSession/);
        return true;
      },
    );
  });
});

describe('opNavigate', () => {
  it('enforces domain rules BEFORE spending a browser call', async () => {
    const { proxy, calls } = stubProxy({ navigate: 'ok' });
    await assert.rejects(
      () => opNavigate(proxy, { url: 'https://other.test', sessionId: 's' }, { allowedDomains: ['example.com'] }),
      (err: any) => err instanceof BrowserbaseAccessDenied,
    );
    assert.equal(calls.length, 0, 'a denied URL must cost no browser time');
  });

  it('passes the normalised URL and the session id through', async () => {
    const { proxy, calls } = stubProxy({ navigate: 'loaded' });
    const text = await opNavigate(proxy, { url: 'https://example.com/pricing', sessionId: 'sess-1' });
    assert.deepEqual(calls[0].args, { url: 'https://example.com/pricing', sessionId: 'sess-1' });
    assert.match(text, /Navigated to https:\/\/example\.com\/pricing/);
  });
});

describe('opExtract', () => {
  it('omits the instruction key entirely when none was given', async () => {
    // Sending `instruction: undefined` upstream is not the same as omitting it.
    const { proxy, calls } = stubProxy({ extract: 'page text' });
    await opExtract(proxy, { sessionId: 'sess-1' });
    assert.deepEqual(calls[0].args, { sessionId: 'sess-1' });
  });

  it('says plainly when nothing came back rather than returning blank', async () => {
    const { proxy } = stubProxy({ extract: '' });
    const text = await opExtract(proxy, { sessionId: 'sess-1' });
    assert.match(text, /Nothing was extracted/);
  });
});

describe('formatSessionList', () => {
  it('leads with how many are still billing', async () => {
    const text = formatSessionList([
      { id: 'a', status: 'RUNNING', region: 'us-west-2', createdAt: 'T1', expiresAt: 'T9' },
      { id: 'b', status: 'COMPLETED' },
    ]);
    assert.match(text, /2 session\(s\), 1 still RUNNING and billing/);
    assert.match(text, /forceEndBrowserSession/);
    assert.match(text, /expires T9/);
  });

  it('does not nag when nothing is running', () => {
    const text = formatSessionList([{ id: 'b', status: 'COMPLETED' }]);
    assert.match(text, /none currently running/);
    assert.ok(!/forceEndBrowserSession/.test(text));
  });

  it('distinguishes an empty account from an empty filter', () => {
    assert.match(formatSessionList([]), /No browser sessions on this account/);
    assert.match(formatSessionList([], 'RUNNING'), /No browser sessions with status RUNNING/);
  });

  it('reports the list through the op', async () => {
    const client = stubClient({ listSessions: async () => [{ id: 'a', status: 'RUNNING' }] });
    assert.match(await opListBrowserSessions(client, {}), /1 still RUNNING/);
  });
});

describe('formatSession field coverage', () => {
  it('renders every optional field when present', () => {
    const text = formatSession({
      id: 's1', status: 'RUNNING', region: 'us-west-2', createdAt: 'C', startedAt: 'S',
      expiresAt: 'E', endedAt: 'X', keepAlive: true, contextId: 'ctx-1', projectId: 'p1',
    });
    for (const expected of [
      /Session: s1/, /Status: RUNNING/, /Region: us-west-2/, /Created: C/, /Started: S/,
      /Expires: E/, /Ended: X/, /Keep-alive: on/, /Context: ctx-1/, /Project: p1/,
      /browserbase\.com\/sessions\/s1/,
    ]) assert.match(text, expected);
  });

  it('omits every field the payload does not carry', () => {
    // A bare id is a legitimate payload; printing "Status: undefined" would be
    // worse than saying nothing.
    const text = formatSession({ id: 's1' });
    assert.match(text, /Session: s1/);
    for (const absent of [/Status:/, /Region:/, /Created:/, /Started:/, /Expires:/, /Ended:/, /Keep-alive:/, /Context:/, /Project:/]) {
      assert.ok(!absent.test(text), `${absent} should be absent`);
    }
    // The dashboard link is unconditional — it is the only route to a replay.
    assert.match(text, /Dashboard/);
  });

  it('hides expiry on a row that is not running', () => {
    const text = formatSessionList([{ id: 'a', status: 'COMPLETED', expiresAt: 'T9' }]);
    assert.ok(!/expires T9/.test(text));
  });

  it('labels a row whose status the payload omits', () => {
    assert.match(formatSessionList([{ id: 'a' }]), /status unknown/);
  });
});

describe('empty upstream text gets a plain statement, not a blank response', () => {
  it('act and observe say what happened when the page returns nothing', async () => {
    const act = stubProxy({ act: '' });
    assert.match(await opAct(act.proxy, { action: 'x', sessionId: 's' }), /Action performed/);

    const observe = stubProxy({ observe: '' });
    assert.match(await opObserve(observe.proxy, { instruction: 'x', sessionId: 's' }), /Nothing matching that instruction/);
  });

  it('navigate still confirms the destination with no upstream text', async () => {
    const { proxy } = stubProxy({ navigate: '' });
    const text = await opNavigate(proxy, { url: 'https://example.com/', sessionId: 's' });
    assert.match(text, /Navigated to https:\/\/example\.com\//);
  });

  it('omits the session reminder when no id was passed', async () => {
    // Nothing to remind the caller of, and inventing one would be wrong.
    const { proxy } = stubProxy({ act: 'done' });
    const text = await opAct(proxy, { action: 'x' });
    assert.ok(!/pass sessionId/.test(text));
  });
});

describe('formatSession / opGetBrowserSession', () => {
  it('warns that keep-alive survives a disconnect', () => {
    const text = formatSession({ id: 'a', status: 'RUNNING', keepAlive: true });
    assert.match(text, /will NOT stop when you disconnect/);
  });

  it('says whether the session can still be used', async () => {
    const running = await opGetBrowserSession(stubClient(), { sessionId: 'a' });
    assert.match(running, /This session is live/);

    const dead = await opGetBrowserSession(
      stubClient({ getSession: async () => ({ id: 'a', status: 'TIMED_OUT' }) }),
      { sessionId: 'a' },
    );
    assert.match(dead, /not running/);
    assert.match(dead, /Run start to create a new one/);
  });
});
