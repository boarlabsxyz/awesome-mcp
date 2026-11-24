// The three HubSpot search tools after their guard moved out of a Zod refine
// and into execute (assertSearchCriteria), shared with the REST search routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const tools = new Map<string, any>();
const FastMCPModule = await import('fastmcp');
const origAddTool = FastMCPModule.FastMCP.prototype.addTool;
FastMCPModule.FastMCP.prototype.addTool = function (tool: any) {
  tools.set(tool.name, tool);
  return origAddTool.call(this, tool);
};
const { searchObjectsRestSchema } = await import('../../hubspot/server.js');
FastMCPModule.FastMCP.prototype.addTool = origAddTool;

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const session = { hubspotAccessToken: 'hs-token' };

test('search tool schemas keep .shape (no refine), so the schema walkers can read them', () => {
  for (const name of ['searchCompanies', 'searchContacts', 'searchDeals']) {
    const shape = tools.get(name).parameters.shape;
    assert.deepEqual(Object.keys(shape).sort(), ['filters', 'limit', 'properties', 'query']);
  }
});

test('a search with neither query nor filters is refused in execute, before HubSpot', async () => {
  const real = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
  try {
    await assert.rejects(tools.get('searchDeals').execute({ limit: 10 }, { log, session }), /query and\/or at least one filter/);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = real;
  }
});

test('a search renders the matches with the same formatter as before', async () => {
  const real = globalThis.fetch;
  let sent: any;
  globalThis.fetch = (async (_url: any, init: any) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ total: 1, results: [{ id: 'c1', properties: { name: 'Acme' } }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const out = await tools.get('searchCompanies').execute({ query: 'acme', limit: 10 }, { log, session });
    assert.match(out, /Acme/);
    assert.equal(sent.query, 'acme');
    assert.ok(Array.isArray(sent.properties) && sent.properties.includes('domain'), 'default company properties requested');
  } finally {
    globalThis.fetch = real;
  }
});

test('the REST body schema is strict and defaults limit to 10', () => {
  const schema = searchObjectsRestSchema('contacts');
  assert.equal(schema.safeParse({ query: 'a' }).data?.limit, 10);
  assert.equal(schema.safeParse({ query: 'a', q: 'b' }).success, false);
});
