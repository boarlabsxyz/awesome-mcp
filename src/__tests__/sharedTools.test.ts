import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UserError } from 'fastmcp';
import { registerMintRestBearerForCurl } from '../sharedTools/mintRestBearerForCurl.js';
import { registerListRestEndpoints } from '../sharedTools/listRestEndpoints.js';
import { REST_CATALOG, REST_SERVICE_NOTES } from '../restCatalog.js';

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

describe('sharedTools.mintRestBearerForCurl', () => {
  it('registers a tool named mintRestBearerForCurl', () => {
    const stub = makeStubServer();
    registerMintRestBearerForCurl(stub as any);
    assert.equal(stub.tools.length, 1);
    assert.equal(stub.tools[0].name, 'mintRestBearerForCurl');
  });

  it('execute throws UserError when session has no userId', async () => {
    const stub = makeStubServer();
    registerMintRestBearerForCurl(stub as any);
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
    registerMintRestBearerForCurl(stub as any);
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
  it('carries a service-wide note once, only for the services it returns', async () => {
    const stub = makeStubServer();
    registerListRestEndpoints(stub as any);
    const github = JSON.parse(await stub.tools[0].execute({ service: 'github' }, { session: { userId: 1 } }));
    assert.deepEqual(github.serviceNotes, { github: REST_SERVICE_NOTES.github });
    assert.match(github.serviceNotes.github, /OLDEST one on the account/);
    const docs = JSON.parse(await stub.tools[0].execute({ service: 'docs' }, { session: { userId: 1 } }));
    assert.equal(docs.serviceNotes, undefined);
  });

  it('registers a tool named listRestEndpoints', () => {
    const stub = makeStubServer();
    registerListRestEndpoints(stub as any);
    assert.equal(stub.tools.length, 1);
    assert.equal(stub.tools[0].name, 'listRestEndpoints');
  });

  it('execute returns only an index of services when no service filter is given', async () => {
    const stub = makeStubServer();
    registerListRestEndpoints(stub as any);
    const tool = stub.tools[0];
    const result = await tool.execute({}, { session: { userId: 1 } });
    const payload = JSON.parse(result);
    assert.equal(payload.endpoints, undefined, 'no endpoint list: the whole catalog is too large for a client');
    assert.ok(result.length < 5000, `the index stays small (${result.length} chars)`);
    assert.equal(payload.totalEndpoints, REST_CATALOG.length);
    const counted = payload.services.reduce((n: number, s: any) => n + s.live + s.planned, 0);
    assert.equal(counted, REST_CATALOG.length, 'every catalog entry is counted under its service');
    const storage = payload.services.find((s: any) => s.service === 'storage');
    assert.equal(storage.live, REST_CATALOG.filter(e => e.service === 'storage' && e.status === 'live').length);
    assert.match(payload.next, /service/);
    assert.ok(payload.baseUrl.endsWith('/api/v1'));
    assert.ok(payload.auth.includes('Bearer'));
  });

  it('names every service in the service parameter', () => {
    const stub = makeStubServer();
    registerListRestEndpoints(stub as any);
    const describe = stub.tools[0].parameters.shape.service.description;
    assert.match(describe, /\bstorage\b/);
    assert.match(describe, /\bdocs\b/);
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
    const result = await tool.execute({ service: 'calendar' }, { session: { userId: 1 } });
    const payload = JSON.parse(result);
    const sample = payload.endpoints[0];
    for (const k of ['service', 'method', 'path', 'summary', 'mcpTool', 'status']) {
      assert.ok(k in sample, `missing field ${k}`);
    }
  });
});
