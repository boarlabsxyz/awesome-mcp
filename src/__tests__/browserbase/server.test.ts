import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { UserError } from 'fastmcp';

// ---------------------------------------------------------------------------
// Capture the tools off the FastMCP instance.
//
// server.ts registers via browserbaseServer.addTool(), and FastMCP keeps them
// in a private #tools field unreachable at runtime — so addTool is patched
// before the import, exactly as src/__tests__/clickup/server.test.ts does it.
// ---------------------------------------------------------------------------

const toolMap = new Map<string, { execute: (...a: any[]) => any; parameters: any; annotations?: any; description: string }>();

const FastMCPModule = await import('fastmcp');
const origAddTool = FastMCPModule.FastMCP.prototype.addTool;
FastMCPModule.FastMCP.prototype.addTool = function (tool: any) {
  toolMap.set(tool.name, tool);
  return origAddTool.call(this, tool);
};
await import('../../browserbase/server.js');
FastMCPModule.FastMCP.prototype.addTool = origAddTool;

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const log = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };
const SESSION = { browserbaseAccessToken: 'bb_live_k', browserbaseInstanceId: undefined } as any;

function run(name: string, args: any, session: any = SESSION) {
  const tool = toolMap.get(name);
  assert.ok(tool, `tool ${name} was never registered`);
  return tool.execute(args, { log, session });
}

/**
 * Drive both upstreams from one stub.
 *
 * `mcp.browserbase.com` gets the three-request MCP handshake; `api.browserbase.com`
 * gets REST JSON. Routing on host is what lets a tool body that touches both be
 * exercised in one test.
 */
function mockBothUpstreams(opts: { toolText?: string; toolIsError?: boolean; rest?: any; restStatus?: number } = {}) {
  const calls: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: u, body });

    if (u.includes('mcp.browserbase.com')) {
      if (body?.method === 'initialize') {
        return jsonRes({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } });
      }
      if (body?.method === 'notifications/initialized') return jsonRes('', 202);
      return jsonRes({
        jsonrpc: '2.0',
        id: body.id,
        result: { isError: opts.toolIsError === true, content: [{ type: 'text', text: opts.toolText ?? '' }] },
      });
    }
    return jsonRes(opts.rest ?? {}, opts.restStatus ?? 200);
  }) as any;
  return calls;
}

function jsonRes(body: unknown, status = 200): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

describe('browserbase server registration', () => {
  it('registers the nine tools, plus the two shared REST companions', () => {
    for (const name of [
      'start', 'end', 'navigate', 'act', 'observe', 'extract',
      'listBrowserSessions', 'getBrowserSession', 'forceEndBrowserSession',
    ]) {
      assert.ok(toolMap.has(name), `missing ${name}`);
    }
    // Registered because the REST entries are catalogued: without
    // mintRestBearerForCurl the only credential is the permanent dashboard key.
    assert.ok(toolMap.has('mintRestBearerForCurl'));
    assert.ok(toolMap.has('listRestEndpoints'));
  });

  it('marks the reads read-only and the force-close destructive', () => {
    for (const name of ['observe', 'extract', 'listBrowserSessions', 'getBrowserSession']) {
      assert.equal(toolMap.get(name)!.annotations?.readOnlyHint, true, name);
    }
    for (const name of ['start', 'end', 'navigate', 'act', 'forceEndBrowserSession']) {
      assert.equal(toolMap.get(name)!.annotations?.readOnlyHint, false, name);
    }
    assert.equal(toolMap.get('forceEndBrowserSession')!.annotations?.destructiveHint, true);
  });

  it('tells the model to thread sessionId, in every browser tool description', () => {
    // The #1 expected failure is a dropped id, and a model that reads only the
    // description has to know the contract.
    for (const name of ['start', 'end', 'navigate', 'act', 'observe', 'extract']) {
      assert.match(toolMap.get(name)!.description, /sessionId/, name);
    }
  });

  it('states the allowlist ceiling on act rather than implying containment', () => {
    assert.match(toolMap.get('act')!.description, /applies to navigate only|does not constrain/i);
  });
});

describe('browserbase tools require a connection', () => {
  for (const [name, args] of [
    ['start', {}],
    ['end', { sessionId: 's' }],
    ['navigate', { url: 'https://x.test', sessionId: 's' }],
    ['act', { action: 'click', sessionId: 's' }],
    ['observe', { instruction: 'find', sessionId: 's' }],
    ['extract', { sessionId: 's' }],
    ['listBrowserSessions', {}],
    ['getBrowserSession', { sessionId: 's' }],
    ['forceEndBrowserSession', { sessionId: 's' }],
  ] as Array<[string, any]>) {
    it(`${name} refuses an unconnected session`, async () => {
      await assert.rejects(() => run(name, args, {} as any), (err: any) => {
        assert.ok(err instanceof UserError);
        assert.match(err.message, /Browserbase not connected/);
        return true;
      });
    });
  }
});

describe('browser tools against both upstreams', () => {
  it('start returns the sessionId and the threading instruction', async () => {
    mockBothUpstreams({ toolText: '{"sessionId":"sess-1"}', rest: { id: 'sess-1', status: 'RUNNING', expiresAt: 'T9' } });
    const text = await run('start', {});
    assert.match(text, /sess-1/);
    assert.match(text, /pass sessionId: "sess-1" to every following browser call/);
    assert.match(text, /Expires: T9/);
  });

  it('navigate sends the url upstream and reports it', async () => {
    const calls = mockBothUpstreams({ toolText: 'loaded' });
    const text = await run('navigate', { url: 'https://example.com/p', sessionId: 'sess-1' });
    const toolCall = calls.find(c => c.body?.method === 'tools/call');
    assert.deepEqual(toolCall!.body.params, {
      name: 'navigate',
      arguments: { url: 'https://example.com/p', sessionId: 'sess-1' },
    });
    assert.match(text, /Navigated to https:\/\/example\.com\/p/);
  });

  it('act, observe and extract forward their one argument', async () => {
    for (const [name, args, expected] of [
      ['act', { action: 'click it', sessionId: 's' }, { action: 'click it', sessionId: 's' }],
      ['observe', { instruction: 'find it', sessionId: 's' }, { instruction: 'find it', sessionId: 's' }],
      ['extract', { instruction: 'prices', sessionId: 's' }, { instruction: 'prices', sessionId: 's' }],
    ] as Array<[string, any, any]>) {
      const calls = mockBothUpstreams({ toolText: 'ok' });
      await run(name, args);
      const toolCall = calls.find(c => c.body?.method === 'tools/call');
      assert.deepEqual(toolCall!.body.params.arguments, expected, name);
    }
  });

  it('end reports a clean close', async () => {
    mockBothUpstreams({ toolText: '' });
    assert.match(await run('end', { sessionId: 'sess-1' }), /closed \(sess-1\)/);
  });

  it('explains the sessionId contract when upstream has no active session', async () => {
    mockBothUpstreams({ toolIsError: true, toolText: 'No active session' });
    await assert.rejects(() => run('observe', { instruction: 'x' }), (err: any) => {
      assert.match(err.message, /run 'start' to get a sessionId/);
      return true;
    });
  });
});

describe('getRules reads the connection on every call', () => {
  it('treats a session with no instance id as unrestricted', async () => {
    // Nothing to look up. Must NOT fail closed — the opposite of Slack, whose
    // default has to be "read nothing".
    mockBothUpstreams({ toolText: 'loaded' });
    const text = await run('navigate', { url: 'https://anything.test', sessionId: 's' });
    assert.match(text, /Navigated to https:\/\/anything\.test/);
  });

  it('degrades to unrestricted when the lookup throws', async () => {
    // A database blip must not break every call while protecting nothing the
    // user asked to protect — the stored default is "no restriction".
    mockBothUpstreams({ toolText: 'loaded' });
    const session = { browserbaseAccessToken: 'k', browserbaseInstanceId: 'no-such-instance' } as any;
    const text = await run('navigate', { url: 'https://anything.test', sessionId: 's' }, session);
    assert.match(text, /Navigated to/);
  });

  it('enforces the stored rules when the connection has them', async () => {
    const { createMcpInstance } = await import('../../mcpConnectionStore.js');
    const conn = await createMcpInstance(
      9401, 'browserbase', 'BB Rules Fixture',
      { access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0 } as any, null,
      'browserbase',
      { access_token: 'k', accessRules: { allowedDomains: ['example.com'], blockedDomains: [] } } as any,
      null,
    );
    const session = { browserbaseAccessToken: 'k', browserbaseInstanceId: conn.instanceId } as any;

    mockBothUpstreams({ toolText: 'loaded' });
    assert.match(await run('navigate', { url: 'https://app.example.com', sessionId: 's' }, session), /Navigated to/);

    await assert.rejects(
      () => run('navigate', { url: 'https://other.test', sessionId: 's' }, session),
      (err: any) => {
        assert.equal(err.name, 'BrowserbaseAccessDenied');
        assert.match(err.message, /Domain Rules/);
        return true;
      },
    );
  });

  it('surfaces the rules in start output so the caller knows they are on', async () => {
    const { createMcpInstance } = await import('../../mcpConnectionStore.js');
    const conn = await createMcpInstance(
      9402, 'browserbase', 'BB Rules Fixture 2',
      { access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0 } as any, null,
      'browserbase',
      { access_token: 'k', accessRules: { allowedDomains: ['example.com'], blockedDomains: ['ads.test'] } } as any,
      null,
    );
    const session = { browserbaseAccessToken: 'k', browserbaseInstanceId: conn.instanceId } as any;
    mockBothUpstreams({ toolText: '{"sessionId":"sess-9"}', rest: { id: 'sess-9', status: 'RUNNING' } });
    const text = await run('start', {}, session);
    assert.match(text, /example\.com/);
    assert.match(text, /ads\.test/);
    assert.match(text, /navigate only/i);
  });
});

describe('session cost-control tools', () => {
  it('listBrowserSessions leads with how many are billing', async () => {
    mockBothUpstreams({ rest: [{ id: 'a', status: 'RUNNING' }, { id: 'b', status: 'COMPLETED' }] });
    const text = await run('listBrowserSessions', {});
    assert.match(text, /1 still RUNNING and billing/);
    assert.match(text, /forceEndBrowserSession/);
  });

  it('getBrowserSession says whether the id is still usable', async () => {
    mockBothUpstreams({ rest: { id: 'a', status: 'RUNNING' } });
    assert.match(await run('getBrowserSession', { sessionId: 'a' }), /This session is live/);
  });

  it('forceEndBrowserSession confirms the release', async () => {
    mockBothUpstreams({ rest: { id: 'a', status: 'REQUEST_RELEASE' } });
    const text = await run('forceEndBrowserSession', { sessionId: 'a' });
    assert.match(text, /Requested release of session a/);
    assert.match(text, /no longer billing/);
  });

  it('maps an upstream 404 to an actionable message', async () => {
    mockBothUpstreams({ rest: 'nope', restStatus: 404 });
    await assert.rejects(
      () => run('getBrowserSession', { sessionId: 'gone' }),
      /has no record of that id/,
    );
  });
});
