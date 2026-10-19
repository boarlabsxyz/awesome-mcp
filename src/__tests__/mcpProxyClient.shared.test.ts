// src/__tests__/mcpProxyClient.shared.test.ts
// The shared Streamable-HTTP MCP transport, tested directly rather than only
// through Browserbase. Both properties pinned here were silent failures found
// in review: a `sanitizeText` hook that was declared and never called, and a
// deadline that stopped covering the response body the moment fetch resolved.
// Neither showed up in a passing suite, which is exactly why they are tests.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type McpProxyTarget, callProxyTool } from '../util/mcpProxyClient.js';

const URL_UNDER_TEST = 'https://mcp.example.test/mcp';

function target(over: Partial<McpProxyTarget> = {}): McpProxyTarget {
  return {
    url: URL_UNDER_TEST,
    clientInfo: { name: 'test', version: '1.0.0' },
    timeoutMs: 200,
    label: 'Test MCP',
    ...over,
  };
}

function res(body: unknown, { status = 200, text }: { status?: number; text?: () => Promise<string> } = {}): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'Err',
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'application/json' : 'sess-1') },
    text: text ?? (async () => (typeof body === 'string' ? body : JSON.stringify(body))),
    body: null,
  };
}

/**
 * Answer the handshake, then hand `final` to the tools/call request.
 *
 * `final` receives the AbortSignal, because the behaviour under test is
 * whether the deadline reaches the BODY read: a real Response rejects
 * `text()` when its signal aborts, so a stub that ignores the signal would
 * pass whether or not the fix is present.
 */
function scripted(final: (id: number, signal: AbortSignal) => any) {
  return (async (_u: any, init: any) => {
    const b = JSON.parse(init.body);
    if (b.method === 'initialize') return res({ jsonrpc: '2.0', id: b.id, result: { protocolVersion: '2025-06-18' } });
    if (b.method === 'notifications/initialized') return { ...res(''), status: 202 };
    return final(b.id, init.signal);
  }) as any;
}

/** A body read that never completes on its own, exactly as a stalled stream behaves. */
function stalledBody(signal: AbortSignal): () => Promise<string> {
  return () =>
    new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const err: any = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
}

describe('callProxyTool: sanitizeText is actually applied', () => {
  it('runs the hook over a non-OK response body', async () => {
    // Browserbase passes safeErrorText here believing redaction and the size
    // cap are in force. Before this, the hook was never called at all.
    const fetchImpl = (async () => res('SECRET-TOKEN leaked', { status: 500 })) as any;
    await assert.rejects(
      () => callProxyTool(target({ sanitizeText: t => t.replace('SECRET-TOKEN', '[redacted]') }), 'x', {}, { fetchImpl }),
      (err: any) => {
        assert.match(err.message, /\[redacted\]/);
        assert.doesNotMatch(err.message, /SECRET-TOKEN/);
        return true;
      },
    );
  });

  it('runs the hook over a JSON-RPC error message and its data', async () => {
    const fetchImpl = scripted(id =>
      res({ jsonrpc: '2.0', id, error: { code: -32000, message: 'SECRET-TOKEN in message', data: { note: 'SECRET-TOKEN in data' } } }),
    );
    await assert.rejects(
      () => callProxyTool(target({ sanitizeText: t => t.replaceAll('SECRET-TOKEN', '[redacted]') }), 'x', {}, { fetchImpl }),
      (err: any) => {
        assert.doesNotMatch(err.message, /SECRET-TOKEN/);
        return true;
      },
    );
  });

  it('CAPS a huge error.data, which previously had no size limit at all', async () => {
    // The 214 KB failure the hook exists for: a caller that puts err.message
    // straight into a UserError would hand all of it to the model.
    const huge = 'x'.repeat(200_000);
    const fetchImpl = scripted(id => res({ jsonrpc: '2.0', id, error: { code: -1, message: 'boom', data: { huge } } }));
    await assert.rejects(
      () => callProxyTool(target(), 'x', {}, { fetchImpl }),
      (err: any) => {
        assert.ok(err.message.length < 2000, `expected a capped message, got ${err.message.length} chars`);
        assert.match(err.message, /truncated/);
        return true;
      },
    );
  });

  it('passes text through unchanged when no sanitiser is configured', async () => {
    const fetchImpl = (async () => res('plain upstream detail', { status: 503 })) as any;
    await assert.rejects(() => callProxyTool(target(), 'x', {}, { fetchImpl }), /plain upstream detail/);
  });
});

describe('callProxyTool: the deadline covers the response BODY', () => {
  it('times out when the upstream sends headers and then stalls the body', async () => {
    // `fetch` resolves as soon as the headers arrive. Clearing the timer there
    // left an SSE stream the upstream could stall with no limit at all, and
    // target.timeoutMs was never enforced.
    const fetchImpl = scripted((_id, signal) => res(null, { text: stalledBody(signal) }));
    const started = Date.now();
    await assert.rejects(
      () => callProxyTool(target({ timeoutMs: 150 }), 'stalls', {}, { fetchImpl }),
      /timed out after 150ms/,
    );
    // Proves the deadline fired rather than the promise simply never settling.
    assert.ok(Date.now() - started < 5000, 'the call should have been aborted by its own deadline');
  });

  it('still returns normally when the body arrives in time', async () => {
    const fetchImpl = scripted(id => res({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok' }] } }));
    const out = await callProxyTool(target(), 'x', {}, { fetchImpl });
    assert.equal(out.text, 'ok');
    assert.equal(out.isError, false);
  });
});
