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
    maxRssBytes: 2_000_000_000,
    watchMs: 20,
    ...over,
  };
}

const done = (over: Partial<WorkerRunResult> = {}): WorkerRunResult => ({
  stdout: '', stderr: '', stdoutTotal: 0, stderrTotal: 0, results: [], resultsTotal: 0, images: [], imagesDropped: 0, ...over,
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

let nextPid = 1000;

class FakeWorker implements WorkerLike {
  alive = true;
  readonly pid = nextPid++;
  private settle?: (r: WorkerRunResult) => void;
  constructor(private readonly behave: (req: WorkerRunRequest, w: FakeWorker) => Promise<WorkerRunResult>) {}
  run(req: WorkerRunRequest): Promise<WorkerRunResult> {
    return new Promise((resolve) => {
      this.settle = resolve;
      void this.behave(req, this).then(resolve);
    });
  }
  kill(reason?: 'disk' | 'memory'): void {
    if (!this.alive) return;
    this.alive = false;
    this.settle?.(done({ stopped: reason ?? 'crashed' }));
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
    assert.equal(cmd.cwd, '/data/abc', 'JavaScript relative paths land in /home/user');
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

  it('accepts bracketed IPv6 hosts, as URL.host gives them', () => {
    assert.ok(workerCommand(config(), '/data/abc', ['[::1]:8080', '[2001:db8::1]']).args.includes('--allow-net=[::1]:8080,[2001:db8::1]'));
    assert.throws(() => workerCommand(config(), '/data/abc', ['[::1]x']), { name: 'SandboxRefusal' });
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
    assert.equal((await dirUsage(dir, 1)).entries, 2, 'stops as soon as the count passes the cap');
  });

  it('counts what user code hid behind chmod 000', async () => {
    const dir = config().dataDir;
    fs.mkdirSync(path.join(dir, 'hidden'));
    fs.writeFileSync(path.join(dir, 'hidden', 'big'), 'x'.repeat(100));
    fs.chmodSync(path.join(dir, 'hidden'), 0o000);
    assert.deepEqual(await dirUsage(dir, 100), { bytes: 100, entries: 2 });
  });

  it('reads limits from the environment, with defaults', () => {
    const d = poolConfigFromEnv({ SANDBOX_PYODIDE_DIR: '/p' });
    assert.equal(d.denoPath, 'deno');
    assert.equal(d.maxRssBytes, 2048 * 1024 * 1024, 'WebAssembly memory plus 1 GB for the rest');
    assert.equal(poolConfigFromEnv({ SANDBOX_PYODIDE_DIR: '/p', SANDBOX_MAX_RSS_MB: '3000' }).maxRssBytes, 3000 * 1024 * 1024);
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

  it('removes a directory whose permissions user code took away, and survives an idle cleanup that fails', async () => {
    const c = config();
    const pool = new SandboxPool(c, fakeWorkers().start);
    const h = await create(pool);
    const dir = path.join(fs.realpathSync(c.dataDir), h.id);
    fs.mkdirSync(path.join(dir, 'locked'));
    fs.writeFileSync(path.join(dir, 'locked', 'f'), 'x');
    fs.chmodSync(path.join(dir, 'locked'), 0o000);
    await pool.kill(h.id);
    assert.equal(fs.existsSync(dir), false);

    // A failure the timer cannot surface is logged, never an unhandled rejection that ends the runner.
    const h2 = await create(pool, 30);
    const errors: string[] = [];
    const original = console.error;
    console.error = (m: string) => errors.push(m);
    try {
      fs.rmSync(path.join(fs.realpathSync(c.dataDir), h2.id), { recursive: true });
      fs.writeFileSync(path.join(fs.realpathSync(c.dataDir), h2.id), 'a file where the directory was');
      fs.chmodSync(fs.realpathSync(c.dataDir), 0o500);
      await sleep(100);
    } finally {
      fs.chmodSync(fs.realpathSync(c.dataDir), 0o700);
      console.error = original;
    }
    assert.equal(await pool.connect(h2.id), null);
    assert.match(errors.join(' '), /could not remove its directory/);
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

  it('measures a run that ends before the watchdog does, and stops it past the disk limit', async () => {
    const workers = fakeWorkers(async (_req, _w, cmd) => {
      fs.writeFileSync(path.join(cmd.cwd!, 'big'), 'x'.repeat(5000));
      return done({ results: ['ok'] });
    });
    const h = await create(new SandboxPool(config({ maxDiskBytes: 1000, watchMs: 60_000 }), workers.start));
    assert.equal((await h.runCode('fill', opts())).stopped, 'disk');
  });

  it('stops a worker that keeps using CPU between runs — code left running, or a forged end of run', async () => {
    let cpu = 0;
    const workers = fakeWorkers();
    const pool = new SandboxPool(config(), workers.start, async () => ({ cpuSec: cpu, rssBytes: 1 }));
    const h = await create(pool);
    await h.runCode('setInterval(spin)', opts());
    const spin = setInterval(() => { cpu += 0.02; }, 20); // one core's worth
    try {
      await sleep(150);
    } finally {
      clearInterval(spin);
    }
    assert.equal(workers.started[0].worker.alive, false);
    const next = await h.runCode('x', opts());
    assert.equal(next.restarted, true);
    assert.equal(next.previousStop, 'background');
  });

  it('leaves an idle worker alone, and charges nothing for a run’s own CPU', async () => {
    let cpu = 0;
    let release!: () => void;
    const workers = fakeWorkers((req) => (req.code === 'busy' ? new Promise((r) => { release = () => r(done()); }) : Promise.resolve(done())));
    const pool = new SandboxPool(config(), workers.start, async () => ({ cpuSec: cpu, rssBytes: 1 }));
    const h = await create(pool);
    const running = h.runCode('busy', opts());
    const spin = setInterval(() => { cpu += 0.02; }, 20);
    await sleep(100);
    clearInterval(spin);
    release();
    assert.equal((await running).stopped, undefined);
    await sleep(100);
    assert.ok(workers.started[0].worker.alive);
  });

  it('stops a worker over the memory limit, during a run or between runs', async () => {
    let rss = 1;
    const workers = fakeWorkers((req) => (req.code === 'grow' ? new Promise(() => { rss = 10_000; }) : Promise.resolve(done())));
    const pool = new SandboxPool(config({ maxRssBytes: 5000 }), workers.start, async () => ({ cpuSec: 0, rssBytes: rss }));
    const h = await create(pool);
    assert.equal((await h.runCode('grow', opts())).stopped, 'memory');
    rss = 1;
    await h.runCode('x', opts());
    rss = 10_000;
    await sleep(80);
    const next = await h.runCode('x', opts());
    assert.equal(next.previousStop, 'memory');
  });

  it('stops a worker whose session ended while it was starting', async () => {
    let resolveStart!: (w: WorkerLike) => void;
    const worker = new FakeWorker(async () => done());
    const pool = new SandboxPool(config(), () => new Promise((r) => { resolveStart = r; }));
    const h = await create(pool);
    const running = h.runCode('x', opts());
    await sleep(10);
    await pool.kill(h.id);
    resolveStart(worker);
    await assert.rejects(running, { name: 'NotFoundError' });
    assert.equal(worker.alive, false);
  });

  it('says why an evicted worker’s user lost their variables', async () => {
    const pool = new SandboxPool(config({ maxWorkers: 1 }), fakeWorkers().start);
    const a = await create(pool);
    const b = await create(pool);
    await a.runCode('x', opts());
    await b.runCode('x', opts());
    assert.equal((await a.runCode('x', opts())).previousStop, 'evicted');
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

  it('refuses a write past the disk limit, counting an overwrite as replacing the old bytes', async () => {
    const h = await create(new SandboxPool(config({ maxDiskBytes: 10 }), fakeWorkers().start));
    await h.writeFile('a', '12345');
    await assert.rejects(h.writeFile('b', '123456'), /disk limit/);
    await h.writeFile('a', '1234567890'); // replaces 5 bytes: 10 in all
    await assert.rejects(h.writeFile('a', '12345678901'), /disk limit/);
  });

  it('counts the parent directories a write would create against the file limit', async () => {
    const h = await create(new SandboxPool(config({ maxFiles: 3 }), fakeWorkers().start));
    await h.writeFile('one', 'x');
    await assert.rejects(h.writeFile('a/b/c', 'x'), /3 files/, 'a, a/b and a/b/c would make four');
    await h.writeFile('a/c', 'x');
    await h.writeFile('a/c', 'y'); // an overwrite adds nothing
  });

  it('refuses a write that raced the session ending, leaving no directory behind', async () => {
    const c = config();
    const pool = new SandboxPool(c, fakeWorkers().start);
    const h = await create(pool);
    const write = h.writeFile('deep/x.txt', 'x');
    await pool.kill(h.id);
    await assert.rejects(write, { name: 'NotFoundError' });
    assert.equal(fs.existsSync(path.join(fs.realpathSync(c.dataDir), h.id)), false);
  });
});
