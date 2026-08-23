// Runs the full regression suite: every tests/**/*.smoke.ts.
//
// Why a script instead of a glob in package.json: Node 20's `node --test` does
// not expand glob patterns (that landed in Node 22), and `sh` won't expand `**`
// without globstar — so `--test "tests/**/*.smoke.ts"` exits with
// "Could not find ..." and, because it never runs a test, LOOKS like a pass.
// The nightly workflow pins Node 20, so the glob form silently ran nothing.
//
// Discovering the files here and passing explicit paths works on every Node
// version, and an empty discovery is a loud failure rather than a green run.

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const e2eRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testsRoot = join(e2eRoot, 'tests');

function findSmokeTests(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findSmokeTests(full));
    else if (entry.name.endsWith('.smoke.ts')) found.push(relative(e2eRoot, full));
  }
  return found.sort();
}

const files = findSmokeTests(testsRoot);
if (files.length === 0) {
  console.error(`[e2e] no *.smoke.ts files found under ${testsRoot}`);
  process.exit(1);
}

console.error(`[e2e] full regression: ${files.length} smoke tests`);

const child = spawn(
  process.execPath,
  ['--import', 'tsx', '--test', ...files],
  { cwd: e2eRoot, stdio: 'inherit' },
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
