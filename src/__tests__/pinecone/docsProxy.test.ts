import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { searchPineconeDocs } from '../../pinecone/docsProxy.js';

const URL_UNDER_TEST = 'https://docs.example.test/mcp';

/** A Response-alike carrying one JSON-RPC body. */
function response(body: unknown, { status = 200 } = {}): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'application/json' : 'sess-1') },
    text: async () => JSON.stringify(body),
  };
}

/**
 * Answer the three requests one proxied call makes: initialize, the
 * initialized notification, then tools/call.
 */
function scriptedFetch(toolResult: unknown) {
  const calls: Array<{ body: any; headers: any }> = [];
  const impl = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ body, headers: init.headers });
    if (body.method === 'initialize') return response({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } });
    if (body.method === 'notifications/initialized') return { ...response(''), status: 202, text: async () => '' };
    return response({ jsonrpc: '2.0', id: body.id, result: toolResult });
  }) as any;
  return { impl, calls };
}

describe('searchPineconeDocs', () => {
  it('calls the assistant tool get_context with the query', async () => {
    const { impl, calls } = scriptedFetch({ content: [{ type: 'text', text: 'the answer' }] });
    const out = await searchPineconeDocs('how do namespaces work', { fetchImpl: impl, url: URL_UNDER_TEST });
    assert.equal(out, 'the answer');
    const toolCall = calls.find(c => c.body.method === 'tools/call');
    assert.equal(toolCall?.body.params.name, 'get_context');
    assert.equal(toolCall?.body.params.arguments.query, 'how do namespaces work');
  });

  it('sends NO credential — the endpoint is public and never asked for one', async () => {
    const { impl, calls } = scriptedFetch({ content: [{ type: 'text', text: 'x' }] });
    await searchPineconeDocs('q', { fetchImpl: impl, url: URL_UNDER_TEST });
    for (const call of calls) {
      assert.equal(call.headers.authorization, undefined);
      assert.equal(call.headers['Api-Key'], undefined);
      assert.equal(call.headers['x-bb-api-key'], undefined);
    }
  });

  it('reports a transport failure as transient and NOT as a key problem', async () => {
    // Blaming the API key here would send the user to re-issue a credential
    // this call never touches.
    const impl = (async () => { throw new Error('network down'); }) as any;
    await assert.rejects(
      () => searchPineconeDocs('q', { fetchImpl: impl, url: URL_UNDER_TEST }),
      /nothing to do with your API key/,
    );
  });

  it('says every other tool is unaffected, so the model does not give up', async () => {
    const impl = (async () => { throw new Error('nope'); }) as any;
    await assert.rejects(
      () => searchPineconeDocs('q', { fetchImpl: impl, url: URL_UNDER_TEST }),
      /Every other tool in this connector is unaffected/,
    );
  });

  it('reports an empty answer as empty, not as an error', async () => {
    const { impl } = scriptedFetch({ content: [{ type: 'text', text: '   ' }] });
    const out = await searchPineconeDocs('obscure', { fetchImpl: impl, url: URL_UNDER_TEST });
    assert.match(out, /returned nothing/);
    assert.match(out, /not an error/);
  });

  it('surfaces a tool-level error from the assistant', async () => {
    const { impl } = scriptedFetch({ content: [{ type: 'text', text: 'bad query' }], isError: true });
    await assert.rejects(
      () => searchPineconeDocs('q', { fetchImpl: impl, url: URL_UNDER_TEST }),
      /could not answer that: bad query/,
    );
  });

  it('caps a very long answer rather than flooding the model context', async () => {
    const { impl } = scriptedFetch({ content: [{ type: 'text', text: 'x'.repeat(200_000) }] });
    const out = await searchPineconeDocs('q', { fetchImpl: impl, url: URL_UNDER_TEST });
    assert.ok(out.length < 100_000, `expected a capped answer, got ${out.length} chars`);
    assert.match(out, /truncated/);
  });
});
