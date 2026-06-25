import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UserError } from 'fastmcp';
import { registerGetSecurityToken } from '../sharedTools/getSecurityToken.js';
import { registerListRestEndpoints } from '../sharedTools/listRestEndpoints.js';
import { REST_CATALOG } from '../restCatalog.js';

interface CapturedTool {
  name: string;
  description: string;
  parameters: any;
  execute: (args: any, ctx: any) => Promise<any>;
}

function makeStubServer() {
  const tools: CapturedTool[] = [];
  return {
    addTool(tool: CapturedTool) { tools.push(tool); },
    tools,
  };
}

describe('sharedTools.getSecurityToken', () => {
  it('registers a tool named getSecurityToken', () => {
    const stub = makeStubServer();
    registerGetSecurityToken(stub as any);
    assert.equal(stub.tools.length, 1);
    assert.equal(stub.tools[0].name, 'getSecurityToken');
  });

  it('execute throws UserError when session has no userId', async () => {
    const stub = makeStubServer();
    registerGetSecurityToken(stub as any);
    const tool = stub.tools[0];
    await assert.rejects(
      () => tool.execute({}, { session: undefined }),
      (err: any) => err instanceof UserError && err.message.includes('Not authenticated'),
    );
    await assert.rejects(
      () => tool.execute({}, { session: { userId: undefined } }),
      (err: any) => err instanceof UserError,
    );
  });

  it('execute returns a JSON payload with token + expiresAt when session has userId', async () => {
    const stub = makeStubServer();
    registerGetSecurityToken(stub as any);
    const tool = stub.tools[0];
    const result = await tool.execute({}, { session: { userId: 42 } });
    const payload = JSON.parse(result);
    assert.ok(typeof payload.token === 'string' && payload.token.length > 0);
    assert.equal(payload.tokenType, 'Bearer');
    assert.equal(payload.expiresIn, 5 * 60);
    assert.ok(payload.baseUrl.endsWith('/api/v1'));
    assert.ok(typeof payload.expiresAt === 'string');
    // expiresAt should parse as a future ISO timestamp.
    assert.ok(new Date(payload.expiresAt).getTime() > Date.now());
  });
});

describe('sharedTools.listRestEndpoints', () => {
  it('registers a tool named listRestEndpoints', () => {
    const stub = makeStubServer();
    registerListRestEndpoints(stub as any);
    assert.equal(stub.tools.length, 1);
    assert.equal(stub.tools[0].name, 'listRestEndpoints');
  });

  it('execute returns every endpoint when no service filter is given', async () => {
    const stub = makeStubServer();
    registerListRestEndpoints(stub as any);
    const tool = stub.tools[0];
    const result = await tool.execute({}, { session: { userId: 1 } });
    const payload = JSON.parse(result);
    assert.equal(payload.count, REST_CATALOG.length);
    assert.equal(payload.endpoints.length, REST_CATALOG.length);
    assert.ok(payload.baseUrl.endsWith('/api/v1'));
    assert.ok(payload.auth.includes('Bearer'));
  });

  it('execute filters by service when service is provided', async () => {
    const stub = makeStubServer();
    registerListRestEndpoints(stub as any);
    const tool = stub.tools[0];
    const result = await tool.execute({ service: 'calendar' }, { session: { userId: 1 } });
    const payload = JSON.parse(result);
    assert.ok(payload.endpoints.length > 0);
    for (const e of payload.endpoints) assert.equal(e.service, 'calendar');
  });

  it('endpoint entries carry the canonical fields', async () => {
    const stub = makeStubServer();
    registerListRestEndpoints(stub as any);
    const tool = stub.tools[0];
    const result = await tool.execute({}, { session: { userId: 1 } });
    const payload = JSON.parse(result);
    const sample = payload.endpoints[0];
    for (const k of ['service', 'method', 'path', 'summary', 'mcpTool', 'status']) {
      assert.ok(k in sample, `missing field ${k}`);
    }
  });
});
