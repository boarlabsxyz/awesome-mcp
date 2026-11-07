import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';
import { SandboxPool } from '../../../sandbox/runner/pool.js';
import { createRunnerApp } from '../../../sandbox/runner/server.js';
import { runnerClient } from '../../../sandbox/runner/client.js';
import { secretsInEnv, startupProblem } from '../../../sandbox/runner/main.js';
import { sandboxProvider } from '../../../sandbox/engine.js';
import type { WorkerLike, WorkerRunRequest } from '../../../sandbox/runner/workerProcess.js';

const SECRET = 's'.repeat(40);

class EchoWorker implements WorkerLike {
  alive = true;
  async run(req: WorkerRunRequest) {
    if (req.code === 'full') throw Object.assign(new Error('The sandbox runner is at capacity'), { name: 'SandboxRefusal' });
    return { stdout: `ran ${req.language}`, stderr: '', stdoutTotal: 6, stderrTotal: 0, results: [JSON.stringify(req.envs)], images: [], imagesDropped: 0 };
  }
  kill() { this.alive = false; }
}

let server: Server;
let base: string;
let dataDir: string;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-http-'));
  const pool = new SandboxPool({
    denoPath: 'deno', workerScript: 'w.js', pyodideDir: '/p', packageDir: '/p', dataDir,
    memoryMb: 256, maxWorkers: 2, maxDiskBytes: 1_000_000, maxFiles: 100, startTimeoutMs: 1000, diskCheckMs: 1000,
  }, async () => new EchoWorker());
  server = createRunnerApp(pool, SECRET).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('runner HTTP API through its client', () => {
  it('runs code, keeps files, and reports the sandbox until it is killed', async () => {
    const client = runnerClient(`${base}/`, SECRET);
    const h = await client.create({ timeoutMs: 60_000, allowNet: ['api.example.com'], userId: 7 });
    const run = await h.runCode('print(1)', { language: 'python', envs: { AWESOME_API_TOKEN: 't' }, timeoutMs: 5000, maxOutputChars: 100 });
    assert.equal(run.stdout, 'ran python');
    assert.deepEqual(run.results, ['{"AWESOME_API_TOKEN":"t"}']);

    await h.writeFile('/home/user/a.bin', 'héllo');
    assert.deepEqual((await h.listFiles('/home/user')).map((e) => e.name), ['a.bin']);
    const read = await h.readFile('/home/user/a.bin', 3);
    assert.equal(read.size, 6);
    assert.deepEqual([...read.bytes], [0x68, 0xc3, 0xa9], 'bytes survive the base64 trip');

    await h.setTimeout(120_000);
    assert.ok((await client.endsAt(h.id))!.getTime() > Date.now() + 100_000);
    assert.ok(await client.connect(h.id));
    await client.kill(h.id);
    assert.equal(await client.connect(h.id), null);
    assert.equal(await client.endsAt(h.id), null);
  });

  it('turns 404 and 409 back into the engine’s own errors', async () => {
    const client = runnerClient(base, SECRET);
    const h = await client.create({ timeoutMs: 60_000, allowNet: [], userId: 7 });
    await assert.rejects(h.readFile('/home/user/nope', 10), { name: 'NotFoundError', message: 'No file at /home/user/nope.' });
    await assert.rejects(h.readFile('/etc/passwd', 10), { name: 'SandboxRefusal' });
    await assert.rejects(h.runCode('full', { language: 'python', envs: {}, timeoutMs: 1000, maxOutputChars: 10 }), { name: 'SandboxRefusal', message: 'The sandbox runner is at capacity' });
    await client.kill(h.id);
    await assert.rejects(h.listFiles('/home/user'), { name: 'NotFoundError' });
  });

  it('refuses a wrong secret and a malformed body, but answers /health to anyone', async () => {
    await assert.rejects(runnerClient(base, 'wrong').create({ timeoutMs: 1000, allowNet: [], userId: 1 }), /failed \(401\).*does not match/);
    const bad = await fetch(`${base}/sandboxes`, { method: 'POST', headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }, body: '{"userId":"x"}' });
    assert.equal(bad.status, 400);
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.maxWorkers, 2);
  });

  it('says the runner is unreachable rather than failing obscurely', async () => {
    await assert.rejects(runnerClient('http://127.0.0.1:9', SECRET).create({ timeoutMs: 1000, allowNet: [], userId: 1 }), /could not be reached/);
  });

  it('will not build an app without a secret', () => {
    assert.throws(() => createRunnerApp({} as never, ''), /SANDBOX_RUNNER_SECRET/);
  });
});

describe('runner startup and engine choice', () => {
  it('refuses to start while holding credentials, or without a long secret', () => {
    assert.deepEqual(secretsInEnv({ DATABASE_URL: 'postgres://', REDIS_URL: 'redis://', GITHUB_TOKEN: 'x', SANDBOX_RUNNER_SECRET: SECRET, RAILWAY_TOKEN: 'r', PORT: '8080', EMPTY_SECRET: '' }), ['DATABASE_URL', 'REDIS_URL', 'GITHUB_TOKEN']);
    assert.match(String(startupProblem({ SANDBOX_RUNNER_SECRET: SECRET, COOKIE_SECRET: 'c' })), /COOKIE_SECRET/);
    assert.match(String(startupProblem({ SANDBOX_RUNNER_SECRET: 'short' })), /at least 32/);
    assert.equal(startupProblem({ SANDBOX_RUNNER_SECRET: SECRET, PORT: '8080' }), null);
  });

  it('picks the runner over HTTP, the local pool, or nothing', () => {
    assert.equal(sandboxProvider({}), null);
    assert.equal(sandboxProvider({ SANDBOX_RUNNER_URL: 'http://runner:8080' }), null, 'a URL without its secret cannot be called');
    assert.ok(sandboxProvider({ SANDBOX_RUNNER_URL: 'http://runner:8080', SANDBOX_RUNNER_SECRET: SECRET }));
    const local = sandboxProvider({ SANDBOX_RUNNER: 'local' });
    assert.ok(local instanceof SandboxPool);
    assert.equal(sandboxProvider({ SANDBOX_RUNNER: 'local' }), local, 'one pool per process: sessions live in it');
  });
});
