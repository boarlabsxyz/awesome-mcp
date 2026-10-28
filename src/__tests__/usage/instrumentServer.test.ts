import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { UserError } from 'fastmcp';
import { instrumentServer } from '../../usage/instrumentServer.js';
import {
  __setUsagePoolForTests,
  __pendingUsageEvents,
  __resetUsageBufferForTests,
} from '../../usage/usageStore.js';

// A stand-in with the two registration methods instrumentServer replaces.
function makeFakeServer() {
  const tools: any[] = [];
  return {
    tools,
    addTool(tool: any) { tools.push(tool); },
    addTools(list: any[]) { tools.push(...list); },
  };
}

const context = {
  session: { userId: 42, instanceId: 'inst-1', email: 'a@b.c' },
  sessionId: 'sess-1',
  client: { version: { name: 'claude-ai', version: '1.2.3' } },
};

beforeEach(() => {
  __resetUsageBufferForTests();
  // Never resolves: events stay in the buffer where the test can read them.
  __setUsagePoolForTests({ query: () => new Promise(() => {}) });
});

afterEach(() => {
  __setUsagePoolForTests(null);
  __resetUsageBufferForTests();
});

function onlyEvent() {
  const events = __pendingUsageEvents();
  assert.equal(events.length, 1);
  return events[0];
}

describe('instrumentServer', () => {
  it('records a successful call with session, client and argument summary', async () => {
    const server = instrumentServer(makeFakeServer() as any, 'google-docs') as any;
    server.addTool({ name: 'searchGoogleDocs', execute: async () => 'found 3' });

    const result = await server.tools[0].execute({ query: 'roadmap', limit: 5 }, context);
    assert.equal(result, 'found 3');

    const e = onlyEvent();
    assert.equal(e.mcpSlug, 'google-docs');
    assert.equal(e.tool, 'searchGoogleDocs');
    assert.equal(e.surface, 'mcp');
    assert.equal(e.ok, true);
    assert.equal(e.userId, 42);
    assert.equal(e.instanceId, 'inst-1');
    assert.equal(e.sessionId, 'sess-1');
    assert.equal(e.clientName, 'claude-ai');
    assert.equal(e.clientVersion, '1.2.3');
    assert.deepEqual(e.argKeys, ['query', 'limit']);
    assert.deepEqual(e.argPreview, { query: 'roadmap' });
    assert.ok(e.durationMs >= 0);
  });

  it('records a thrown error and rethrows the SAME error', async () => {
    const server = instrumentServer(makeFakeServer() as any, 'clickup') as any;
    const thrown = new UserError('Task 123 not found');
    server.addTool({ name: 'getTask', execute: async () => { throw thrown; } });

    await assert.rejects(server.tools[0].execute({ taskId: '123' }, context), (err) => err === thrown);
    const e = onlyEvent();
    assert.equal(e.ok, false);
    assert.equal(e.errorKind, 'UserError');
    assert.equal(e.errorMessage, 'Task 123 not found');
  });

  it('counts an isError result as a failure but returns it unchanged', async () => {
    const server = instrumentServer(makeFakeServer() as any, 'slack') as any;
    const payload = { isError: true, content: [{ type: 'text', text: 'nope' }] };
    server.addTool({ name: 'postMessage', execute: async () => payload });

    assert.equal(await server.tools[0].execute({}, context), payload);
    const e = onlyEvent();
    assert.equal(e.ok, false);
    assert.equal(e.errorKind, 'isError');
  });

  it('wraps tools added through addTools too', async () => {
    const server = instrumentServer(makeFakeServer() as any, 'hubspot') as any;
    server.addTools([
      { name: 'a', execute: async () => 'A' },
      { name: 'b', execute: async () => 'B' },
    ]);
    await server.tools[1].execute({}, context);
    assert.equal(onlyEvent().tool, 'b');
  });

  it('keeps the rest of the tool definition intact', () => {
    const server = instrumentServer(makeFakeServer() as any, 'github') as any;
    const annotations = { readOnlyHint: true };
    server.addTool({ name: 't', description: 'd', annotations, execute: async () => '' });
    assert.equal(server.tools[0].description, 'd');
    assert.equal(server.tools[0].annotations, annotations);
  });

  it('a recording failure never changes the tool result', async () => {
    const server = instrumentServer(makeFakeServer() as any, 'github') as any;
    server.addTool({ name: 't', execute: async () => 'ok' });
    // Arguments whose keys throw when read break summarisation, not the call.
    const hostile = new Proxy({}, { ownKeys() { throw new Error('boom'); } });
    assert.equal(await server.tools[0].execute(hostile, context), 'ok');
  });

  it('tolerates a missing session (unauthenticated or stdio)', async () => {
    const server = instrumentServer(makeFakeServer() as any, 'github') as any;
    server.addTool({ name: 't', execute: async () => 'ok' });
    await server.tools[0].execute({}, {});
    const e = onlyEvent();
    assert.equal(e.userId, null);
    assert.equal(e.clientName, null);
  });
});
