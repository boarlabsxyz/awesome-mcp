import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PINECONE_WRITE_TOOLS } from '../../pinecone/accessRules.js';

// ---------------------------------------------------------------------------
// Capture the tools off the FastMCP instance.
//
// server.ts registers via pineconeServer.addTool(), and FastMCP keeps them in a
// private #tools field unreachable at runtime — so addTool is patched before
// the import, exactly as src/__tests__/browserbase/server.test.ts does it.
// ---------------------------------------------------------------------------

const toolMap = new Map<string, { execute: (...a: any[]) => any; parameters: any; annotations?: any; description: string }>();

const FastMCPModule = await import('fastmcp');
const origAddTool = FastMCPModule.FastMCP.prototype.addTool;
FastMCPModule.FastMCP.prototype.addTool = function (tool: any) {
  toolMap.set(tool.name, tool);
  return origAddTool.call(this, tool);
};
await import('../../pinecone/server.js');
FastMCPModule.FastMCP.prototype.addTool = origAddTool;

/** The nine tools Pinecone's own MCP server exposes, which this one mirrors. */
const EXPECTED_TOOLS = [
  'list-indexes',
  'describe-index',
  'describe-index-stats',
  'search-records',
  'cascading-search',
  'rerank-documents',
  'search-docs',
  'create-index-for-model',
  'upsert-records',
];

/**
 * The two shared tools every service with a `live` REST entry must register.
 * Not Pinecone's own, so they are excluded from the nine-tool check and
 * asserted separately.
 */
const SHARED_TOOLS = ['mintRestBearerForCurl', 'listRestEndpoints'];

/** This connector's own tools, excluding the two shared REST helpers. */
function pineconeTools(): Array<[string, any]> {
  return [...toolMap.entries()].filter(([n]) => !SHARED_TOOLS.includes(n));
}

describe('pinecone server registration', () => {
  it('registers exactly the nine upstream tool names', () => {
    // Names match pinecone-io/pinecone-mcp so a model that has used one works
    // with the other; a rename here silently breaks that. Anything registered
    // beyond these and the two shared tools is caught here too.
    const own = [...toolMap.keys()].filter(n => !SHARED_TOOLS.includes(n));
    assert.deepEqual(own.sort(), [...EXPECTED_TOOLS].sort());
  });

  it('registers the two shared REST tools, which live catalog entries require', () => {
    // Without them a caller cannot mint a short-lived bearer or discover the
    // endpoints, and is pushed onto the permanent dashboard API key instead.
    for (const name of SHARED_TOOLS) {
      assert.ok(toolMap.has(name), `${name} must be registered once a REST entry is live`);
    }
  });

  it('marks the two write tools as writes and everything else as a read', () => {
    for (const name of EXPECTED_TOOLS) {
      const tool = toolMap.get(name)!;
      const isWrite = (PINECONE_WRITE_TOOLS as readonly string[]).includes(name);
      assert.equal(
        tool.annotations?.readOnlyHint,
        !isWrite,
        `${name} readOnlyHint should be ${!isWrite}`,
      );
    }
  });

  it('does not port the upstream analytics parameters', () => {
    // llm_provider / llm_model attribute usage to a model vendor upstream and
    // would be prompt noise on every tool here.
    for (const [name, tool] of pineconeTools()) {
      const keys = Object.keys(tool.parameters?.shape ?? {});
      assert.ok(!keys.includes('llm_provider'), `${name} should not take llm_provider`);
      assert.ok(!keys.includes('llm_model'), `${name} should not take llm_model`);
    }
  });

  it('gives every tool a description', () => {
    for (const [name, tool] of pineconeTools()) {
      assert.ok(tool.description && tool.description.length > 40, `${name} needs a real description`);
    }
  });

  it('describes every parameter, so a model is never guessing', () => {
    for (const [name, tool] of pineconeTools()) {
      const shape = tool.parameters?.shape ?? {};
      for (const [field, schema] of Object.entries<any>(shape)) {
        // A .describe() may sit on the outer wrapper or on the inner type,
        // depending on whether it was applied before or after .optional() —
        // both are real descriptions, so accept either.
        let s = schema;
        let described = Boolean(s?.description);
        while (!described && s?._def?.innerType) {
          s = s._def.innerType;
          described = Boolean(s?.description);
        }
        assert.ok(described, `${name}.${field} needs a .describe()`);
      }
    }
  });

  it('warns in the description that a write is refused under read-only', () => {
    for (const name of PINECONE_WRITE_TOOLS) {
      assert.match(toolMap.get(name)!.description, /read-only/i, `${name} should mention read-only`);
    }
  });

  it('tells search-docs callers it works without a working connection', () => {
    // It is the tool that explains how to fix the connection, so a model must
    // know it is still worth calling when everything else is failing.
    assert.match(toolMap.get('search-docs')!.description, /does not use your API key/);
  });

  it('warns that upsert-records overwrites an existing id', () => {
    assert.match(toolMap.get('upsert-records')!.description, /OVERWRITTEN/);
  });

  it('points search-records at describe-index for the wrong index kind', () => {
    assert.match(toolMap.get('search-records')!.description, /integrated-embedding/);
  });
});
