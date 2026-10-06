import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UserError } from 'fastmcp';

import {
  callHostedTool,
  explainHostedError,
  hostedMcpUrl,
  parseSessionId,
  proxyHostedTool,
  readRpcBody,
  textOfResult,
} from '../../browserbase/mcpProxyClient.js';

const URL_UNDER_TEST = 'https://mcp.example.test/mcp';

/** A Response-alike with just the surface the client reads. */
function response(
  body: string,
  { status = 200, contentType = 'application/json', sessionId = 'mcp-sess-1' } = {},
): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase();
        if (key === 'content-type') return contentType;
        if (key === 'mcp-session-id') return sessionId;
        return null;
      },
    },
    text: async () => body,
  };
}

/**
 * Stub fetch that answers the handshake then the tool call. Records every
 * request so the tests can assert on headers and redirect policy.
 */
function stubFetch(toolFrame: any, options: { contentType?: string } = {}) {
  const calls: Array<{ url: string; init: any; payload: any }> = [];
  const impl = async (url: any, init: any) => {
    const payload = JSON.parse(init.body);
    calls.push({ url: String(url), init, payload });
    if (payload.method === 'initialize') {
      return response(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { protocolVersion: '2025-03-26' } }));
    }
    if (payload.method === 'notifications/initialized') {
      return response('', { status: 202 });
    }
    const frame = { jsonrpc: '2.0', id: payload.id, ...toolFrame };
    const contentType = options.contentType ?? 'application/json';
    const body = contentType.includes('text/event-stream')
      ? `event: message\ndata: ${JSON.stringify(frame)}\n\n`
      : JSON.stringify(frame);
    return response(body, { contentType });
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('readRpcBody', () => {
  it('reads a plain JSON body', async () => {
    const res = response(JSON.stringify({ id: 7, result: { ok: true } }));
    assert.deepEqual(await readRpcBody(res, 7), { id: 7, result: { ok: true } });
  });

  it('reads the matching frame out of an SSE stream', async () => {
    // The hosted server answers tools/call with text/event-stream, so a client
    // that only does res.json() gets a parse error and blames the tool.
    const stream = [
      'event: message',
      `data: ${JSON.stringify({ id: 1, result: 'wrong one' })}`,
      '',
      'event: message',
      `data: ${JSON.stringify({ id: 2, result: 'right one' })}`,
      '',
    ].join('\n');
    const res = response(stream, { contentType: 'text/event-stream' });
    assert.equal((await readRpcBody(res, 2)).result, 'right one');
  });

  it('returns undefined for a 202 notification ack', async () => {
    assert.equal(await readRpcBody(response('', { status: 202 }), 1), undefined);
  });

  it('fails loudly when no SSE frame carries the request id', async () => {
    const res = response(`data: ${JSON.stringify({ id: 99, result: 'x' })}\n`, {
      contentType: 'text/event-stream',
    });
    await assert.rejects(() => readRpcBody(res, 1), /No SSE frame carried a response for request id 1/);
  });
});

describe('textOfResult', () => {
  it('joins text blocks and names non-text ones', () => {
    assert.equal(
      textOfResult({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }),
      'a\n[image block]\nb',
    );
  });

  it('falls back to JSON for a result with no content array', () => {
    assert.equal(textOfResult({ sessionId: 'x' }), '{"sessionId":"x"}');
  });
});

describe('callHostedTool', () => {
  it('handshakes, calls the tool, and returns its text', async () => {
    const { impl, calls } = stubFetch({ result: { content: [{ type: 'text', text: 'done' }] } });
    const result = await callHostedTool('bb_key', 'navigate', { url: 'https://x.test' }, {
      fetchImpl: impl,
      url: URL_UNDER_TEST,
    });

    assert.equal(result.text, 'done');
    assert.equal(result.isError, false);
    assert.deepEqual(calls.map(c => c.payload.method), [
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    assert.deepEqual(calls[2].payload.params, { name: 'navigate', arguments: { url: 'https://x.test' } });
  });

  it('reads a tool result delivered over SSE', async () => {
    const { impl } = stubFetch({ result: { content: [{ type: 'text', text: 'from sse' }] } }, {
      contentType: 'text/event-stream',
    });
    const result = await callHostedTool('bb_key', 'extract', {}, { fetchImpl: impl, url: URL_UNDER_TEST });
    assert.equal(result.text, 'from sse');
  });

  it('sends the key as a bearer header, never in the URL', async () => {
    const { impl, calls } = stubFetch({ result: { content: [] } });
    await callHostedTool('bb_secret', 'start', {}, { fetchImpl: impl, url: URL_UNDER_TEST });
    for (const call of calls) {
      assert.equal(call.init.headers.authorization, 'Bearer bb_secret');
      // The query-param form is a deprecated fallback upstream, and putting a
      // credential in a URL is the thing the connector exists to avoid.
      assert.ok(!call.url.includes('bb_secret'), `key leaked into URL: ${call.url}`);
    }
  });

  it('refuses to follow redirects, so the key cannot be replayed elsewhere', async () => {
    const { impl, calls } = stubFetch({ result: { content: [] } });
    await callHostedTool('bb_key', 'start', {}, { fetchImpl: impl, url: URL_UNDER_TEST });
    for (const call of calls) assert.equal(call.init.redirect, 'error');
  });

  it('uses the protocol version the server negotiated, not the one requested', async () => {
    const { impl, calls } = stubFetch({ result: { content: [] } });
    await callHostedTool('bb_key', 'start', {}, { fetchImpl: impl, url: URL_UNDER_TEST });
    // initialize asks for the preferred version; everything after it must send
    // back what the server actually agreed to.
    assert.equal(calls[0].init.headers['mcp-protocol-version'], '2025-06-18');
    assert.equal(calls[1].init.headers['mcp-protocol-version'], '2025-03-26');
    assert.equal(calls[2].init.headers['mcp-protocol-version'], '2025-03-26');
  });

  it('carries the transport session id across the three requests of one call', async () => {
    const { impl, calls } = stubFetch({ result: { content: [] } });
    await callHostedTool('bb_key', 'start', {}, { fetchImpl: impl, url: URL_UNDER_TEST });
    assert.equal(calls[0].init.headers['mcp-session-id'], undefined);
    assert.equal(calls[1].init.headers['mcp-session-id'], 'mcp-sess-1');
    assert.equal(calls[2].init.headers['mcp-session-id'], 'mcp-sess-1');
  });

  it('surfaces isError as a tool-level failure, distinct from a transport one', async () => {
    const { impl } = stubFetch({ result: { isError: true, content: [{ type: 'text', text: 'page blew up' }] } });
    const result = await callHostedTool('bb_key', 'act', { action: 'x' }, {
      fetchImpl: impl,
      url: URL_UNDER_TEST,
    });
    assert.equal(result.isError, true);
    assert.equal(result.text, 'page blew up');
  });

  it('raises a JSON-RPC error with its code and data', async () => {
    const { impl } = stubFetch({ error: { code: -32602, message: 'bad params', data: { field: 'url' } } });
    await assert.rejects(
      () => callHostedTool('bb_key', 'navigate', {}, { fetchImpl: impl, url: URL_UNDER_TEST }),
      /tools\/call failed \(-32602\): bad params — \{"field":"url"\}/,
    );
  });

  it('maps a 401 to an actionable UserError rather than a status dump', async () => {
    const impl = (async () => response('nope', { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(
      () => callHostedTool('bad', 'start', {}, { fetchImpl: impl, url: URL_UNDER_TEST }),
      (err: any) => {
        assert.ok(err instanceof UserError);
        assert.match(err.message, /rejected the API key/i);
        assert.match(err.message, /Reconnect from the dashboard/i);
        // Tagged on `.status`, which is what sendUpstreamError reads — the
        // divergence from ClickUp's symbol-tagged status.
        assert.equal((err as any).status, 401);
        return true;
      },
    );
  });

  it('points at the real hosted endpoint by default', () => {
    // A constant, not an env var: an operator-set URL here would be a
    // credential-forwarding target.
    assert.equal(hostedMcpUrl(), 'https://mcp.browserbase.com/mcp');
  });
});

describe('proxyHostedTool', () => {
  it('returns the text on success', async () => {
    const { impl } = stubFetch({ result: { content: [{ type: 'text', text: 'ok' }] } });
    assert.equal(
      await proxyHostedTool('bb_key', 'observe', { instruction: 'x' }, { fetchImpl: impl, url: URL_UNDER_TEST }),
      'ok',
    );
  });

  it('turns a tool-level failure into a UserError', async () => {
    const { impl } = stubFetch({ result: { isError: true, content: [{ type: 'text', text: 'nope' }] } });
    await assert.rejects(
      () => proxyHostedTool('bb_key', 'act', { action: 'x' }, { fetchImpl: impl, url: URL_UNDER_TEST }),
      (err: any) => err instanceof UserError && /nope/.test(err.message),
    );
  });

  it('rewrites "no active session" into the sessionId contract, through the whole stack', async () => {
    const { impl } = stubFetch({ result: { isError: true, content: [{ type: 'text', text: 'No active session' }] } });
    await assert.rejects(
      () => proxyHostedTool('bb_key', 'navigate', {}, { fetchImpl: impl, url: URL_UNDER_TEST }),
      (err: any) => {
        assert.match(err.message, /run 'start'/);
        assert.match(err.message, /navigate/);
        return true;
      },
    );
  });
});

describe('explainHostedError', () => {
  it('explains the no-active-session failure and names the tool', () => {
    const message = explainHostedError('extract', 'Error: No active session');
    assert.match(message, /run 'start' to get a sessionId/);
    assert.match(message, /'extract'/);
    assert.match(message, /getBrowserSession/);
  });

  it('leaves every other message untouched', () => {
    assert.equal(explainHostedError('act', 'element not found'), 'element not found');
  });
});

describe('parseSessionId', () => {
  it('reads the documented JSON shape', () => {
    assert.equal(parseSessionId('{"sessionId":"abc12345"}'), 'abc12345');
    assert.equal(parseSessionId('{"id":"abc12345"}'), 'abc12345');
  });

  it('reads the labelled text forms the hosted server actually emits', () => {
    assert.equal(parseSessionId('Session started. sessionId: abc12345'), 'abc12345');
    assert.equal(parseSessionId('"sessionId": "abc12345"'), 'abc12345');
    assert.equal(parseSessionId('session_id=abc12345'), 'abc12345');
  });

  it('falls back to a bare UUID anywhere in the text', () => {
    const uuid = '3f0b2c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b';
    assert.equal(parseSessionId(`Created browser ${uuid} in us-west-2`), uuid);
  });

  it('returns undefined rather than guessing', () => {
    // The caller turns this into a loud failure: a start with no id means a
    // browser is running that nothing can address or close.
    assert.equal(parseSessionId('Browser ready.'), undefined);
    assert.equal(parseSessionId(''), undefined);
  });
});
