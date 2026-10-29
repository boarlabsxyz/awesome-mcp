// src/__tests__/mcpProxyClient.modern.test.ts
// The `protocol: 'modern'` path of the shared MCP proxy client: one stateless
// tools/call carrying the 2026-07-28 `_meta` envelope, and the narrow fallback
// to the legacy handshake when — and only when — the server says it is legacy.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type McpProxyTarget,
  MODERN_PROTOCOL_VERSION,
  callProxyTool,
  isLegacyOnlyAnswer,
} from '../util/mcpProxyClient.js';

const target: McpProxyTarget = {
  url: 'https://mcp.example.test/mcp',
  clientInfo: { name: 'test-client', version: '1.0.0' },
  headers: () => ({ authorization: 'Bearer tok' }),
  timeoutMs: 5_000,
  label: 'Example MCP',
  protocol: 'modern',
};

function response(body: string, { status = 200, contentType = 'application/json' } = {}): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
    body: { cancel: async () => {} },
  };
}

function recording(handler: (payload: any, init: any) => any) {
  const calls: Array<{ init: any; payload: any }> = [];
  const impl = (async (_url: any, init: any) => {
    const payload = JSON.parse(init.body);
    calls.push({ init, payload });
    return handler(payload, init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const okResult = (payload: any) =>
  response(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { content: [{ type: 'text', text: 'hello' }] } }));

describe('callProxyTool — modern protocol', () => {
  it('sends ONE tools/call with the envelope and the mirrored headers, and no handshake', async () => {
    const { impl, calls } = recording(okResult);
    const result = await callProxyTool(target, 'list_projects', { a: 1 }, { fetchImpl: impl });

    assert.equal(result.text, 'hello');
    assert.equal(calls.length, 1);
    const { payload, init } = calls[0];
    assert.equal(payload.method, 'tools/call');
    assert.equal(payload.params.name, 'list_projects');
    assert.deepEqual(payload.params.arguments, { a: 1 });
    assert.equal(payload.params._meta['io.modelcontextprotocol/protocolVersion'], MODERN_PROTOCOL_VERSION);
    assert.deepEqual(payload.params._meta['io.modelcontextprotocol/clientInfo'], target.clientInfo);
    assert.equal(init.headers['mcp-protocol-version'], MODERN_PROTOCOL_VERSION);
    assert.equal(init.headers['mcp-method'], 'tools/call');
    assert.equal(init.headers['mcp-name'], 'list_projects');
    assert.equal(init.headers.authorization, 'Bearer tok');
    assert.equal(init.redirect, 'error');
  });

  it('declares NO capabilities, so a server cannot answer with a form this proxy cannot show', async () => {
    const { impl, calls } = recording(okResult);
    await callProxyTool(target, 'execute_sql', {}, { fetchImpl: impl });
    assert.deepEqual(calls[0].payload.params._meta['io.modelcontextprotocol/clientCapabilities'], {});
  });

  it('reads a tool result delivered over SSE', async () => {
    const { impl } = recording(payload =>
      response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { content: [{ type: 'text', text: 'streamed' }] } })}\n\n`, {
        contentType: 'text/event-stream',
      }));
    const result = await callProxyTool(target, 'x', {}, { fetchImpl: impl });
    assert.equal(result.text, 'streamed');
  });

  it('falls back to the legacy handshake when the server lists only 2025 versions', async () => {
    const { impl, calls } = recording(payload => {
      if (payload.params?._meta) {
        return response(JSON.stringify({ jsonrpc: '2.0', id: payload.id, error: { code: -32022, message: 'Unsupported', data: { supported: ['2025-06-18'] } } }), { status: 400 });
      }
      if (payload.method === 'initialize') {
        return response(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { protocolVersion: '2025-06-18' } }));
      }
      if (payload.method === 'notifications/initialized') return response('', { status: 202 });
      return okResult(payload);
    });
    const result = await callProxyTool(target, 'list_projects', {}, { fetchImpl: impl });
    assert.equal(result.text, 'hello');
    assert.deepEqual(calls.map(c => c.payload.method), ['tools/call', 'initialize', 'notifications/initialized', 'tools/call']);
  });

  it('does NOT fall back on an ordinary 400 — a bad argument would only fail twice', async () => {
    const { impl, calls } = recording(payload =>
      response(JSON.stringify({ jsonrpc: '2.0', id: payload.id, error: { code: -32602, message: 'Invalid params: project_id is required' } }), { status: 400 }));
    await assert.rejects(
      () => callProxyTool(target, 'get_project', {}, { fetchImpl: impl }),
      (err: any) => err.status === 400 && /project_id is required/.test(err.message),
    );
    assert.equal(calls.length, 1);
  });

  it('routes 401 through the target explanation with the status attached', async () => {
    const { impl } = recording(() => response('{"message":"No access token provided"}', { status: 401 }));
    await assert.rejects(
      () => callProxyTool({ ...target, explainUnauthorized: () => 'reconnect please' }, 'x', {}, { fetchImpl: impl }),
      (err: any) => err.status === 401 && err.message === 'reconnect please',
    );
  });

  it('leaves legacy targets on the handshake they always used', async () => {
    const { impl, calls } = recording(payload => {
      if (payload.method === 'initialize') {
        return response(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { protocolVersion: '2025-06-18' } }));
      }
      if (payload.method === 'notifications/initialized') return response('', { status: 202 });
      return okResult(payload);
    });
    await callProxyTool({ ...target, protocol: undefined }, 'x', {}, { fetchImpl: impl });
    assert.equal(calls[0].payload.method, 'initialize');
    assert.equal(calls[2].payload.params._meta, undefined);
  });
});

describe('isLegacyOnlyAnswer', () => {
  it('is true for an unsupported-version error that does not list the modern revision', () => {
    assert.equal(isLegacyOnlyAnswer({ error: { code: -32022, data: { supported: ['2025-06-18'] } } }), true);
  });
  it('is false when the server says it DOES support the modern revision', () => {
    assert.equal(isLegacyOnlyAnswer({ error: { code: -32022, data: { supported: [MODERN_PROTOCOL_VERSION] } } }), false);
  });
  it('is true for a stateful 2025 server refusing a request before initialize', () => {
    assert.equal(isLegacyOnlyAnswer({ error: { code: -32000, message: 'Bad Request: Server not initialized' } }), true);
  });
  it('is false for anything else', () => {
    assert.equal(isLegacyOnlyAnswer({ error: { code: -32602, message: 'Invalid params' } }), false);
    assert.equal(isLegacyOnlyAnswer(undefined), false);
  });
});
