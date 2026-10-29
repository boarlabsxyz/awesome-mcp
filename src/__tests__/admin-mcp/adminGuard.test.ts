import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { UserError } from 'fastmcp';
import { isAdminEmail, adminEmails } from '../../auth/admin.js';
import { requireAdminForEveryTool, NOT_ADMIN_MESSAGE } from '../../admin-mcp/adminGuard.js';
import { instrumentServer } from '../../usage/instrumentServer.js';
import {
  __setUsagePoolForTests,
  __pendingUsageEvents,
  __resetUsageBufferForTests,
} from '../../usage/usageStore.js';

const saved = process.env.ADMIN_EMAILS;
beforeEach(() => { process.env.ADMIN_EMAILS = ' Boss@Example.com ,ops@example.com,, '; });
afterEach(() => {
  if (saved === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = saved;
});

describe('isAdminEmail', () => {
  it('matches case-insensitively and ignores surrounding whitespace and empty entries', () => {
    assert.deepEqual(adminEmails(), ['boss@example.com', 'ops@example.com']);
    assert.equal(isAdminEmail('boss@example.com'), true);
    assert.equal(isAdminEmail('  OPS@EXAMPLE.COM '), true);
  });

  it('refuses everything else, including non-strings and the empty string', () => {
    for (const v of ['someone@example.com', '', '   ', undefined, null, 42, {}]) {
      assert.equal(isAdminEmail(v), false, String(v));
    }
  });

  it('reads the list on every call, so a change takes effect without a reload', () => {
    assert.equal(isAdminEmail('new@example.com'), false);
    process.env.ADMIN_EMAILS = 'new@example.com';
    assert.equal(isAdminEmail('new@example.com'), true);
  });

  it('treats an unset list as no admins at all', () => {
    delete process.env.ADMIN_EMAILS;
    assert.equal(isAdminEmail('boss@example.com'), false);
  });
});

function makeFakeServer() {
  const tools: any[] = [];
  return {
    tools,
    addTool(tool: any) { tools.push(tool); },
    addTools(list: any[]) { tools.push(...list); },
  };
}

describe('requireAdminForEveryTool', () => {
  it('runs the tool for an admin and returns its result unchanged', async () => {
    const server = requireAdminForEveryTool(makeFakeServer() as any) as any;
    server.addTool({ name: 't', execute: async (args: any) => `hello ${args.x}` });
    assert.equal(await server.tools[0].execute({ x: 1 }, { session: { email: 'boss@example.com' } }), 'hello 1');
  });

  it('refuses a non-admin, and the tool body never runs', async () => {
    let ran = false;
    const server = requireAdminForEveryTool(makeFakeServer() as any) as any;
    server.addTool({ name: 't', execute: async () => { ran = true; return 'secret'; } });
    await assert.rejects(
      server.tools[0].execute({}, { session: { email: 'member@example.com' } }),
      (err: any) => err instanceof UserError && err.message === NOT_ADMIN_MESSAGE,
    );
    assert.equal(ran, false);
  });

  it('refuses a call with no session at all', async () => {
    const server = requireAdminForEveryTool(makeFakeServer() as any) as any;
    server.addTool({ name: 't', execute: async () => 'secret' });
    await assert.rejects(server.tools[0].execute({}, {}), UserError);
    await assert.rejects(server.tools[0].execute({}, undefined), UserError);
  });

  it('guards tools added through addTools too', async () => {
    const server = requireAdminForEveryTool(makeFakeServer() as any) as any;
    server.addTools([{ name: 'a', execute: async () => 'A' }, { name: 'b', execute: async () => 'B' }]);
    for (const tool of server.tools) {
      await assert.rejects(tool.execute({}, { session: { email: 'member@example.com' } }), UserError);
    }
  });

  it('applied outside instrumentServer, still records the refused attempt', async () => {
    __resetUsageBufferForTests();
    __setUsagePoolForTests({ query: () => new Promise(() => {}) });
    try {
      const server = requireAdminForEveryTool(instrumentServer(makeFakeServer() as any, 'admin')) as any;
      server.addTool({ name: 'getUsageOverview', execute: async () => 'data' });
      await assert.rejects(server.tools[0].execute({}, { session: { email: 'member@example.com', userId: 5 } }), UserError);
      const events = __pendingUsageEvents();
      assert.equal(events.length, 1);
      assert.equal(events[0].mcpSlug, 'admin');
      assert.equal(events[0].ok, false);
      assert.equal(events[0].errorKind, 'UserError');
      assert.equal(events[0].userId, 5);
    } finally {
      __setUsagePoolForTests(null);
      __resetUsageBufferForTests();
    }
  });
});

// The Admin MCP must be constructed inside the guard: a bare server would
// work, pass every other test, and answer anyone whose session got created.
describe('src/admin-mcp/server.ts is built inside the admin guard', () => {
  const file = resolve(dirname(fileURLToPath(import.meta.url)), '../../admin-mcp/server.ts');
  const source = readFileSync(file, 'utf8').replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  it('wraps every FastMCP construction in requireAdminForEveryTool(instrumentServer(...))', () => {
    const constructions = source.match(/new FastMCP\b/g) ?? [];
    const guarded = source.match(/requireAdminForEveryTool\(\s*instrumentServer\(\s*new FastMCP\b/g) ?? [];
    assert.ok(constructions.length >= 1);
    assert.equal(guarded.length, constructions.length);
  });

  it('registers tools only through the guarded server', () => {
    const registrations = source.match(/^\s*(\w+)\.addTool\(/gm) ?? [];
    assert.ok(registrations.length >= 6);
    for (const r of registrations) assert.match(r, /adminServer\.addTool\(/);
  });
});
