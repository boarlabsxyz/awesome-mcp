import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  SandboxPool,
  dirUsage,
  poolConfigFromEnv,
  toHostPath,
  workerCommand,
  type PoolConfig,
} from '../../../sandbox/runner/pool.js';
import type { RunOptions } from '../../../sandbox/provider.js';
import type { WorkerCommand, WorkerLike, WorkerRunRequest, WorkerRunResult } from '../../../sandbox/runner/workerProcess.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function config(over: Partial<PoolConfig> = {}): PoolConfig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-'));
  roots.push(dataDir);
  return {
    denoPath: '/usr/bin/deno',
    workerScript: '/app/worker.js',
    pyodideDir: '/app/node_modules/pyodide',
    packageDir: '/app/node_modules/pyodide',
    dataDir,
    memoryMb: 1024,
    maxWorkers: 4,
    maxDiskBytes: 1_000_000,
    maxFiles: 100,
    startTimeoutMs: 1000,
    diskCheckMs: 20,
    ...over,
  };
}

const done = (over: Partial<WorkerRunResult> = {}): WorkerRunResult => ({
  stdout: '', stderr: '', stdoutTotal: 0, stderrTotal: 0, results: [], images: [], imagesDropped: 0, ...over,
});

/** Fake workers: `behave` decides each run; every started worker and command is recorded. */
function fakeWorkers(behave: (req: WorkerRunRequest, w: FakeWorker, cmd: WorkerCommand) => Promise<WorkerRunResult> = async () => done()) {
  const started: Array<{ cmd: WorkerCommand; worker: FakeWorker }> = [];
  const start = async (cmd: WorkerCommand) => {
    const worker = new FakeWorker((req, w) => behave(req, w, cmd));
    started.push({ cmd, worker });
    return worker;
  };
  return { start, started };
}

class FakeWorker implements WorkerLike {
  alive = true;
  private settle?: (r: WorkerRunResult) => void;
  constructor(private readonly behave: (req: WorkerRunRequest, w: FakeWorker) => Promise<WorkerRunResult>) {}
  run(req: WorkerRunRequest): Promise<WorkerRunResult> {
    return new Promise((resolve) => {
      this.settle = resolve;
      void this.behave(req, this).then(resolve);
    });
  }
  kill(): void {
    if (!this.alive) return;
    this.alive = false;
    this.settle?.(done({ stopped: 'crashed' }));
  }
}

const opts = (over: Partial<RunOptions> = {}): RunOptions => ({ language: 'python', envs: { AWESOME_API_TOKEN: 't' }, timeoutMs: 5000, maxOutputChars: 100, ...over });
const create = (pool: SandboxPool, timeoutMs = 60_000) => pool.create({ timeoutMs, allowNet: ['api.example.com', 'pypi.org'], userId: 7 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('workerCommand', () => {
  it('grants Deno only what the sandbox needs', () => {
    const cmd = workerCommand(config(), '/data/abc', ['api.example.com', 'localhost:8080']);
    assert.equal(cmd.command, '/usr/bin/deno');
    assert.ok(cmd.args.includes('--no-prompt'));
    assert.ok(cmd.args.includes('--allow-read=/app/node_modules/pyodide,/data/abc'), 'duplicates collapse');
    assert.ok(cmd.args.includes('--allow-write=/data/abc'));
    assert.ok(cmd.args.includes('--allow-net=api.example.com,localhost:8080'));
    assert.ok(cmd.args.includes('--v8-flags=--max-old-space-size=512,--wasm-max-mem-pages=16384'), '1024 MB is 16384 pages of 64 KiB');
    assert.ok(!cmd.args.some((a) => /^--allow-(env|run|ffi|sys|all)|^-A$/.test(a)));
    assert.deepEqual(Object.keys(cmd.env).sort(), ['DENO_DIR', 'DENO_NO_UPDATE_CHECK', 'NO_COLOR'], 'no inherited environment');
    const workerConfig = JSON.parse(cmd.args.at(-1)!);
    assert.equal(workerConfig.homeDir, '/data/abc');
    assert.ok(workerConfig.packages.includes('pandas'));
  });

  it('omits --allow-net entirely for an empty allowlist: a bare flag would allow every host', () => {
    const cmd = workerCommand(config(), '/data/abc', []);
    assert.ok(!cmd.args.some((a) => a.startsWith('--allow-net')));
  });

  it('refuses allowlist entries that are not host[:port], and paths that would split the permission lists', () => {
    assert.throws(() => workerCommand(config(), '/data/abc', ['evil.com,0.0.0.0']), { name: 'SandboxRefusal' });
    assert.throws(() => workerCommand(config(), '/data/abc', ['http://x']), { name: 'SandboxRefusal' });
    assert.throws(() => workerCommand(config(), '/data/a,b', []), /commas/);
  });
});

describe('toHostPath', () => {
  it('maps /home/user paths into the session directory, relative ones too', () => {
    assert.equal(toHostPath('/data/s1', '/home/user'), '/data/s1');
    assert.equal(toHostPath('/data/s1', '/home/user/a/b.csv'), '/data/s1/a/b.csv');
    assert.equal(toHostPath('/data/s1', 'b.csv'), '/data/s1/b.csv');
    assert.equal(toHostPath('/data/s1', '/home/user/x/../y'), '/data/s1/y');
  });

  it('refuses anything outside /home/user', () => {
    for (const p of ['/etc/passwd', '../../etc/passwd', '/home/user/../other', '/home/username', '/']) {
      assert.throws(() => toHostPath('/data/s1', p), { name: 'SandboxRefusal' }, p);
    }
  });
});

describe('dirUsage and poolConfigFromEnv', () => {
  it('counts bytes and entries, stopping past the cap', async () => {
    const dir = config().dataDir;
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'a'), 'abc');
    fs.writeFileSync(path.join(dir, 'sub', 'b'), 'de');
    assert.deepEqual(await dirUsage(dir, 100), { bytes: 5, entries: 3 });
    assert.ok((await dirUsage(dir, 0)).entries >= 1);
  });

  it('reads limits from the environment, with defaults', () => {
    const d = poolConfigFromEnv({ SANDBOX_PYODIDE_DIR: '/p' });
    assert.equal(d.denoPath, 'deno');
    assert.equal(d.packageDir, '/p', 'the wheels sit beside Pyodide unless told otherwise');
    assert.equal(d.memoryMb, 1024);
    assert.equal(d.maxWorkers, 4);
    assert.equal(d.maxDiskBytes, 500 * 1024 * 1024);
    assert.match(d.workerScript, /worker\.(js|ts)$/);
    const e = poolConfigFromEnv({ SANDBOX_PYODIDE_DIR: '/p', SANDBOX_PACKAGE_DIR: '/w', SANDBOX_MEMORY_MB: '512', SANDBOX_MAX_WORKERS: 'x', SANDBOX_DENO_PATH: '/d' });
    assert.equal(e.packageDir, '/w');
    assert.equal(e.memoryMb, 512);
    assert.equal(e.maxWorkers, 4, 'a bad number falls back');
    assert.equal(e.denoPath, '/d');
    assert.match(poolConfigFromEnv({}).pyodideDir, /node_modules[\\/]pyodide$/);
  });
});

describe('SandboxPool sessions', () => {
  it('creates a directory per session, removes it on kill, and forgets the session', async () => {
    const pool = new SandboxPool(config(), fakeWorkers().start);
    const h = await create(pool);
    const dir = path.join(fs.realpathSync(roots[0]), h.id);
    assert.ok(fs.statSync(dir).isDirectory());
    assert.ok(await pool.endsAt(h.id));
    assert.ok(await pool.connect(h.id));
    await pool.kill(h.id);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(await pool.connect(h.id), null);
    assert.equal(await pool.endsAt(h.id), null);
    await assert.rejects(h.listFiles('/home/user'), { name: 'NotFoundError' });
  });

  it('stops a session after its idle timeout, and setTimeout pushes that back', async () => {
    const pool = new SandboxPool(config(), fakeWorkers().start);
    const h = await create(pool, 60);
    await h.setTimeout(200);
    await sleep(100);
    assert.ok(await pool.connect(h.id), 'still alive: the timeout was extended');
    await sleep(200);
    assert.equal(await pool.connect(h.id), null);
  });

  it('removes session directories an earlier process left, and nothing else', async () => {
    const c = config();
    const stale = path.join(c.dataDir, 'a'.repeat(32));
    fs.mkdirSync(stale);
    fs.writeFileSync(path.join(c.dataDir, 'keep.txt'), 'x');
    await create(new SandboxPool(c, fakeWorkers().start));
    assert.equal(fs.existsSync(stale), false);
    assert.ok(fs.existsSync(path.join(c.dataDir, 'keep.txt')));
  });

  it('refuses a bad allowlist at creation, not at the first run', async () => {
    const pool = new SandboxPool(config(), fakeWorkers().start);
    await assert.rejects(pool.create({ timeoutMs: 1000, allowNet: ['a b'], userId: 1 }), { name: 'SandboxRefusal' });
  });
});

describe('SandboxPool runs', () => {
  it('starts a worker on the first run and keeps it for the next', async () => {
    const workers = fakeWorkers(async (req) => done({ results: [req.code] }));
    const pool = new SandboxPool(config(), workers.start);
    const h = await create(pool);
    const first = await h.runCode('x = 1', opts());
    assert.deepEqual(first.results, ['x = 1']);
    assert.equal(first.restarted, false);
    await h.runCode('x', opts());
    assert.equal(workers.started.length, 1);
    assert.ok(workers.started[0].cmd.args.includes('--allow-net=api.example.com,pypi.org'));
    assert.deepEqual(pool.stats(), { sessions: 1, workers: 1, maxWorkers: 4 });
  });

  it('starts a new worker after one was stopped, and says the variables are gone', async () => {
    const workers = fakeWorkers(async (req, w) => {
      if (req.code === 'loop') { w.alive = false; return done({ stopped: 'timeout' }); }
      return done();
    });
    const pool = new SandboxPool(config(), workers.start);
    const h = await create(pool);
    assert.equal((await h.runCode('loop', opts())).stopped, 'timeout');
    const next = await h.runCode('x', opts());
    assert.equal(next.restarted, true);
    assert.equal(workers.started.length, 2);
  });

  it('refuses a second run in the same session while one is running', async () => {
    let release!: () => void;
    const workers = fakeWorkers(() => new Promise((r) => { release = () => r(done()); }));
    const h = await create(new SandboxPool(config(), workers.start));
    const first = h.runCode('slow', opts());
    await sleep(10);
    await assert.rejects(h.runCode('x', opts()), /already running code/);
    release();
    await first;
  });

  it('makes room by stopping the least recently used idle worker, and refuses when every worker is busy', async () => {
    let release: (() => void) | undefined;
    const workers = fakeWorkers((req) => (req.code === 'slow' ? new Promise((r) => { release = () => r(done()); }) : Promise.resolve(done())));
    const pool = new SandboxPool(config({ maxWorkers: 1 }), workers.start);
    const a = await create(pool);
    const b = await create(pool);
    await a.runCode('x', opts());
    await b.runCode('x', opts()); // a's idle worker makes room
    assert.equal(workers.started[0].worker.alive, false);
    assert.equal((await a.runCode('x', opts())).restarted, true, 'a lost its variables, and is told');

    const busy = a.runCode('slow', opts());
    await sleep(10);
    await assert.rejects(b.runCode('x', opts()), /at capacity/);
    release!();
    await busy;
  });

  it('stops a run that fills the disk past the limit', async () => {
    const c = config({ maxDiskBytes: 1000 });
    const workers = fakeWorkers(async (_req, _w, cmd) => {
      const home = JSON.parse(cmd.args.at(-1)!).homeDir;
      fs.writeFileSync(path.join(home, 'big'), 'x'.repeat(5000));
      return new Promise<WorkerRunResult>(() => {}); // runs until killed
    });
    const h = await create(new SandboxPool(c, workers.start));
    const r = await h.runCode('fill', opts());
    assert.equal(r.stopped, 'disk');
  });

  it('kills the worker when the session ends mid-idle', async () => {
    const workers = fakeWorkers();
    const pool = new SandboxPool(config(), workers.start);
    const h = await create(pool);
    await h.runCode('x', opts());
    await pool.kill(h.id);
    assert.equal(workers.started[0].worker.alive, false);
  });
});

describe('SandboxPool files', () => {
  it('writes, lists and reads files under /home/user, reading only the prefix asked for', async () => {
    const h = await create(new SandboxPool(config(), fakeWorkers().start));
    await h.writeFile('/home/user/data/in.csv', 'a,b\n1,2\n');
    await h.writeFile('note.txt', 'hello');
    const top = await h.listFiles('/home/user');
    assert.deepEqual(top.map((e) => [e.name, e.type]).sort(), [['data', 'dir'], ['note.txt', 'file']]);
    assert.deepEqual(await h.listFiles('data'), [{ name: 'in.csv', path: '/home/user/data/in.csv', type: 'file', size: 8 }]);
    const read = await h.readFile('/home/user/data/in.csv', 3);
    assert.equal(new TextDecoder().decode(read.bytes), 'a,b');
    assert.equal(read.size, 8);
  });

  it('answers not found, not a directory, and is a directory plainly', async () => {
    const h = await create(new SandboxPool(config(), fakeWorkers().start));
    await h.writeFile('f.txt', 'x');
    await assert.rejects(h.readFile('missing.txt', 10), { name: 'NotFoundError', message: 'No file at missing.txt.' });
    await assert.rejects(h.listFiles('nodir'), { name: 'NotFoundError' });
    await assert.rejects(h.listFiles('f.txt'), /not a directory/);
    await assert.rejects(h.readFile('/home/user', 10), /is a directory/);
    await assert.rejects(h.writeFile('/home/user', 'x'), /home directory/);
  });

  it('refuses paths outside /home/user and links that lead out of it', async () => {
    const c = config();
    const h = await create(new SandboxPool(c, fakeWorkers().start));
    await assert.rejects(h.readFile('/etc/passwd', 10), { name: 'SandboxRefusal' });
    const secret = path.join(c.dataDir, 'outside.txt');
    fs.writeFileSync(secret, 'secret');
    fs.symlinkSync(secret, path.join(fs.realpathSync(c.dataDir), h.id, 'link'));
    await assert.rejects(h.readFile('link', 10), /leads outside/);
    await assert.rejects(h.writeFile('link', 'x'), /leads outside/);
  });

  it('refuses a write past the disk limit', async () => {
    const h = await create(new SandboxPool(config({ maxDiskBytes: 10 }), fakeWorkers().start));
    await h.writeFile('a', '12345');
    await assert.rejects(h.writeFile('b', '123456'), /disk limit/);
  });
});
