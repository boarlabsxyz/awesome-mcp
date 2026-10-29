import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Drift guard: every MCP server must be constructed inside instrumentServer().
//
// FastMCP gives no per-call hook, so usage analytics wrap `addTool` — which only
// works if the wrap happens before the first tool is registered, i.e. at
// construction. A server built with a bare `new FastMCP(...)` would work
// perfectly and simply never appear in /admin, which reads as "nobody uses it".
//
// Static scan for the same reason as sharedToolsRegistration.test.ts:
// importing src/google-docs/server.ts starts the whole application.

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function serverFiles(): string[] {
  return readdirSync(SRC, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== '__tests__')
    .map((d) => resolve(SRC, d.name, 'server.ts'))
    .filter(existsSync);
}

function stripComments(source: string): string {
  // Line comments first — see sharedToolsRegistration.test.ts for why the
  // order matters.
  return source.replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('every FastMCP server is instrumented for usage analytics', () => {
  const files = serverFiles().filter((f) => /new FastMCP\b/.test(stripComments(readFileSync(f, 'utf8'))));

  it('finds the servers to check', () => {
    assert.ok(files.length >= 15, `expected at least 15 servers, found ${files.length}`);
  });

  for (const file of files) {
    const rel = file.slice(SRC.length + 1);
    it(rel, () => {
      const source = stripComments(readFileSync(file, 'utf8'));
      const constructions = source.match(/new FastMCP\b/g) ?? [];
      const wrapped = source.match(/instrumentServer\(\s*new FastMCP\b/g) ?? [];
      assert.equal(
        wrapped.length,
        constructions.length,
        `${rel} constructs a FastMCP server outside instrumentServer(new FastMCP(...), '<slug>') — its tool calls will not be recorded`,
      );
      assert.match(source, /import\s*\{\s*instrumentServer\s*\}\s*from\s*'\.\.\/usage\/instrumentServer\.js'/);
    });
  }
});
