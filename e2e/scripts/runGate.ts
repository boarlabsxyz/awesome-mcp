// Runs the deploy gate: exactly the files listed in tests/gate.manifest.ts.
//
// A thin spawner rather than a glob in package.json, so `npm run test:gate`
// and the manifest can't drift — and so the gate's contents stay greppable
// from one place. Fails loudly if a listed file is missing, which is what
// catches a renamed test that would otherwise silently drop out of the gate.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { GATE, gateFiles } from '../tests/gate.manifest.ts';

const e2eRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = gateFiles();

const missing = files.filter((f) => !existsSync(resolve(e2eRoot, f)));
if (missing.length) {
  console.error(
    `[e2e] gate manifest references files that do not exist:\n  ${missing.join('\n  ')}`,
  );
  process.exit(1);
}

const services = Object.keys(GATE);
console.error(
  `[e2e] gate: ${files.length} smoke tests across ${services.length} services ` +
    `(1 read + 1 write each) — ${services.join(', ')}`,
);

const child = spawn(
  process.execPath,
  ['--import', 'tsx', '--test', ...files],
  { cwd: e2eRoot, stdio: 'inherit' },
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
