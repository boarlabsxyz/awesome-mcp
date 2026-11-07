// Downloads the bundled Pyodide packages (packages.ts) into the package
// directory, so workers load them from disk with no CDN access. Run at image
// build time (Dockerfile.sandbox-runner) and once for local development:
// `npm run sandbox:prefetch`. The only step that may write there or reach
// cdn.jsdelivr.net.
import { spawnSync } from 'node:child_process';
import { BUNDLED_PACKAGES } from './packages.js';
import { poolConfigFromEnv } from './pool.js';

const config = poolConfigFromEnv(process.env);
const workerConfig = { mode: 'prefetch', pyodideDir: config.pyodideDir, packageDir: config.packageDir, packages: BUNDLED_PACKAGES, maxImages: 0, maxImageBytes: 0 };
const result = spawnSync(config.denoPath, [
  'run', '--quiet', '--no-prompt', '--no-config', '--no-lock', '--no-remote', '--no-npm',
  `--allow-read=${config.pyodideDir},${config.packageDir}`,
  `--allow-write=${config.packageDir}`,
  '--allow-net=cdn.jsdelivr.net',
  config.workerScript,
  JSON.stringify(workerConfig),
], { stdio: 'inherit', env: { DENO_NO_UPDATE_CHECK: '1', NO_COLOR: '1' } });
if (result.error) console.error(`Could not run ${config.denoPath}: ${result.error.message}`);
process.exit(result.status ?? 1);
