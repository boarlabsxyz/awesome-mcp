// Which sandbox engine this service uses. Both run the same worker pool
// (runner/pool.ts: Pyodide under Deno, one process per user):
//   - SANDBOX_RUNNER_URL: the runner service, over HTTP — production, because
//     the runner holds no secrets and this service does (DATABASE_URL,
//     REDIS_URL), so a sandbox escape there reaches nothing worth having;
//   - SANDBOX_RUNNER=local: the pool in this process — local development.
import type { SandboxProvider } from './provider.js';
import { runnerClient } from './runner/client.js';
import { SandboxPool, poolConfigFromEnv } from './runner/pool.js';

let localPool: SandboxPool | undefined;

/** The configured engine, or null when there is none (the tools then say so). */
export function sandboxProvider(env: NodeJS.ProcessEnv = process.env): SandboxProvider | null {
  if (env.SANDBOX_RUNNER_URL) return env.SANDBOX_RUNNER_SECRET ? runnerClient(env.SANDBOX_RUNNER_URL, env.SANDBOX_RUNNER_SECRET) : null;
  if (env.SANDBOX_RUNNER === 'local') return (localPool ??= new SandboxPool(poolConfigFromEnv(env)));
  return null;
}
