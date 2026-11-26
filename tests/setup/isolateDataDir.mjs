// Preloaded into every `node --test` worker (see the `test` scripts in
// package.json). A test file that does not set DATA_DIR itself gets a private
// one, removed on exit.
//
// Without this, every such file shares ./data: the file-fallback stores
// (users, connections, catalog) of parallel test processes overwrite each
// other's JSON, a torn write leaves "Unexpected non-whitespace character after
// JSON", and unrelated suites fail. Tests also wrote into the developer's own
// data/ folder.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Only inside a test worker, never in the runner itself: workers inherit the
// runner's environment, so a dir set there would be shared again.
if (process.env.NODE_TEST_CONTEXT && !process.env.DATA_DIR) {
  const dir = mkdtempSync(join(tmpdir(), 'amcp-test-data-'));
  process.env.DATA_DIR = dir;
  process.on('exit', () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
}
