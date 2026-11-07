import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Captures the registered tools by patching FastMCP.addTool before importing
// the server (the calendarWriteTools.test.ts trick), so the tool surface and
// the wiring from each execute to its op are checked without a vendor.
const toolMap = new Map<string, { execute: (...args: any[]) => any; parameters: any; annotations?: any }>();
const FastMCPModule = await import('fastmcp');
const origAddTool = FastMCPModule.FastMCP.prototype.addTool;
FastMCPModule.FastMCP.prototype.addTool = function (tool: any) {
  toolMap.set(tool.name, tool);
  return origAddTool.call(this, tool);
};
await import('../../sandbox/server.js');
FastMCPModule.FastMCP.prototype.addTool = origAddTool;

describe('Sandbox MCP server', () => {
  it('registers the six sandbox tools plus listRestEndpoints, and not mintRestBearerForCurl', () => {
    for (const name of ['runCode', 'writeFile', 'listFiles', 'readFile', 'sandboxStatus', 'resetSandbox', 'listRestEndpoints']) {
      assert.ok(toolMap.has(name), name);
    }
    assert.equal(toolMap.has('mintRestBearerForCurl'), false, 'each run carries its own bearer');
    assert.equal(toolMap.get('resetSandbox')!.annotations.destructiveHint, true);
  });

  it('applies the schema defaults: python, 120 s, /home/user', () => {
    assert.deepEqual(toolMap.get('runCode')!.parameters.parse({ code: 'print(1)' }), { language: 'python', code: 'print(1)', timeoutSec: 120 });
    assert.equal(toolMap.get('runCode')!.parameters.safeParse({ code: 'x', timeoutSec: 301 }).success, false);
    assert.deepEqual(toolMap.get('listFiles')!.parameters.parse({}), { path: '/home/user' });
  });

  it('refuses every tool, listRestEndpoints included, to a caller who is not an admin', async () => {
    const saved = process.env.ADMIN_EMAILS;
    process.env.ADMIN_EMAILS = 'boss@example.com';
    try {
      for (const [name, tool] of toolMap) {
        await assert.rejects(tool.execute({}, { session: { userId: 7, email: 'someone@example.com' } }), /administrators only/, name);
      }
    } finally {
      if (saved === undefined) delete process.env.ADMIN_EMAILS;
      else process.env.ADMIN_EMAILS = saved;
    }
  });

  it('every tool says what is missing when this service has no E2B key', async () => {
    const saved = process.env.E2B_API_KEY;
    const savedAdmins = process.env.ADMIN_EMAILS;
    delete process.env.E2B_API_KEY;
    process.env.ADMIN_EMAILS = 'admin@example.com';
    try {
      const session = { userId: 7, instanceId: 'sbx1', email: 'admin@example.com' };
      const calls: Array<[string, unknown]> = [
        ['runCode', { language: 'python', code: 'print(1)', timeoutSec: 120 }],
        ['writeFile', { path: '/home/user/a', content: 'x' }],
        ['listFiles', { path: '/home/user' }],
        ['readFile', { path: '/home/user/a', maxChars: 10 }],
        ['sandboxStatus', {}],
        ['resetSandbox', {}],
      ];
      for (const [name, args] of calls) {
        await assert.rejects(toolMap.get(name)!.execute(args, { session }), /E2B_API_KEY/, name);
      }
    } finally {
      if (saved !== undefined) process.env.E2B_API_KEY = saved;
      if (savedAdmins === undefined) delete process.env.ADMIN_EMAILS;
      else process.env.ADMIN_EMAILS = savedAdmins;
    }
  });
});
