// Entry point of the sandbox runner service (railway.sandbox-runner.json,
// Dockerfile.sandbox-runner): the worker pool behind its HTTP API. It refuses
// to start while it holds anything worth stealing — a Deno escape lands here,
// so the database, Redis and every credential stay on the other services.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { SandboxPool, poolConfigFromEnv } from './pool.js';
import { createRunnerApp } from './server.js';

const SECRET_NAME = /^(DATABASE_URL|REDIS_URL|GOOGLE_CREDENTIALS)$|SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY/;

/** Set variables that look like credentials, other than the runner's own secret. Railway's are held to the same rule (RAILWAY_TOKEN would be one). */
export function secretsInEnv(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((k) => env[k] && k !== 'SANDBOX_RUNNER_SECRET' && SECRET_NAME.test(k));
}

/** Why the runner cannot start, or null. */
export function startupProblem(env: NodeJS.ProcessEnv): string | null {
  const leaked = secretsInEnv(env);
  if (leaked.length) return `The sandbox runner must hold no credentials, but these are set: ${leaked.join(', ')}. Remove them from this service.`;
  if ((env.SANDBOX_RUNNER_SECRET ?? '').length < 32) return 'SANDBOX_RUNNER_SECRET must be set to at least 32 characters (the same value as on the Sandbox MCP service).';
  return null;
}

async function main(): Promise<void> {
  const problem = startupProblem(process.env);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  const config = poolConfigFromEnv(process.env);
  const deno = spawnSync(config.denoPath, ['--version'], { encoding: 'utf8' });
  if (deno.status !== 0) {
    console.error(`Deno is not runnable at ${config.denoPath} (SANDBOX_DENO_PATH): ${deno.error?.message ?? deno.stderr}`);
    process.exit(1);
  }
  const app = createRunnerApp(new SandboxPool(config), process.env.SANDBOX_RUNNER_SECRET!);
  const port = Number(process.env.PORT) || 8080;
  // '::' so Railway's private network (IPv6) reaches it.
  app.listen(port, '::', () => {
    console.error(`Sandbox runner on :${port} — ${deno.stdout.split('\n')[0]}, ${config.maxWorkers} workers of ${config.memoryMb} MB`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
