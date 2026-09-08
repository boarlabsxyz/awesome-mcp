/**
 * Local preview for the public site — the real Express app, no build, no
 * deploy, no database.
 *
 *   npm run dev:docs            # http://localhost:8099/docs
 *   PORT=3000 npm run dev:docs
 *
 * Serves /docs, /dashboard, /integrations, /updates and every static asset
 * exactly as production does, so route behaviour (extensionless docs URLs, the
 * styled 404, asset MIME types) is what you actually see.
 *
 * The API routes are registered but will fail without credentials — that is
 * expected and fine for checking pages. The dashboard will render its
 * signed-out state.
 *
 * Why the symlink below: webServer.ts resolves publicDir as `<dir>/../public`.
 * Compiled, that is dist/public (the Dockerfile copies it there). Run through
 * tsx it resolves to src/public, which does not exist — so every page would
 * 404. Rather than make you build first, we point src/public at the real
 * directory. It is a symlink, so edits to public/ show up on refresh with no
 * rebuild and no copy step.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const linkPath = path.join(repoRoot, 'src', 'public');

if (!fs.existsSync(linkPath)) {
  fs.symlinkSync(path.join('..', 'public'), linkPath, 'dir');
  console.error(`[dev-docs] linked src/public -> ../public (gitignored, safe to delete)`);
} else if (!fs.lstatSync(linkPath).isSymbolicLink()) {
  console.error(`[dev-docs] src/public exists and is not a symlink — leaving it alone`);
}

// Imported after the symlink exists: webServer resolves publicDir at module load.
const { createWebOnlyApp } = await import('../src/website/webServer.js');

const port = Number(process.env.PORT) || 8099;
createWebOnlyApp().listen(port, () => {
  console.error(`\n  Docs      http://localhost:${port}/docs`);
  console.error(`  Dashboard http://localhost:${port}/dashboard`);
  console.error(`  Updates   http://localhost:${port}/updates\n`);
});
