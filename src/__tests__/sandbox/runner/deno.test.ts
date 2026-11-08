// The real thing: worker.ts under Deno with the pool's permissions. These are
// the sandbox's security checks — every escape that matters must stay
// refused. They need Deno (SANDBOX_DENO_PATH, or `deno` on PATH) and the
// prefetched wheels (`npm run sandbox:prefetch`), and skip without them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { SandboxPool, poolConfigFromEnv } from '../../../sandbox/runner/pool.js';
import type { RunOptions, SandboxHandle } from '../../../sandbox/provider.js';

const config = poolConfigFromEnv(process.env);
const hasDeno = spawnSync(config.denoPath, ['--version']).status === 0;
function wheelsPresent(): boolean {
  try {
    return fs.readdirSync(config.packageDir).some((f) => f.startsWith('numpy-'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
const hasWheels = hasDeno && wheelsPresent();
// The watchdog reads CPU and memory from /proc.
const linuxOnly = process.platform === 'linux' ? false : 'the watchdog measures CPU and memory through /proc (Linux)';
const skip = !hasDeno ? 'Deno is not installed (set SANDBOX_DENO_PATH)' : !hasWheels ? 'no prefetched wheels (npm run sandbox:prefetch)' : false;
// CI's sandbox job sets this, so a broken install fails instead of passing as skipped.
if (skip && process.env.SANDBOX_REQUIRE_DENO) throw new Error(`The Deno sandbox suite cannot run: ${skip}.`);

let api: http.Server;
let other: http.Server;
let apiHost = '';
let otherUrl = '';
let pool: SandboxPool;
let dataDir = '';
const seen: string[] = [];
const created: string[] = [];

async function listen(handler: http.RequestListener): Promise<[http.Server, number]> {
  const server = http.createServer(handler).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return [server, (server.address() as AddressInfo).port];
}

before(async () => {
  if (skip) return;
  let port: number;
  [api, port] = await listen((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  apiHost = `127.0.0.1:${port}`;
  let otherPort: number;
  [other, otherPort] = await listen((_req, res) => res.end('reached'));
  otherUrl = `http://127.0.0.1:${otherPort}/`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deno-sandbox-'));
  process.env.SANDBOX_SENTINEL = 'leak-me';
  // The production defaults: every bundled package must load within them, RSS limit included.
  pool = new SandboxPool({ ...poolConfigFromEnv({ ...process.env, SANDBOX_MEMORY_MB: '', SANDBOX_MAX_RSS_MB: '' }), dataDir, maxWorkers: 3 });
});
after(async () => {
  // Stop every worker, or their processes keep the test run alive until the idle timers fire.
  for (const id of created) await pool.kill(id).catch(() => {});
  delete process.env.SANDBOX_SENTINEL;
  api?.close();
  other?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

async function sandbox(): Promise<SandboxHandle> {
  const h = await pool.create({ timeoutMs: 120_000, allowNet: [apiHost], userId: 1 });
  created.push(h.id);
  return h;
}
const opts = (over: Partial<RunOptions> = {}): RunOptions => ({
  language: 'python',
  envs: { AWESOME_API_BASE: `http://${apiHost}`, AWESOME_API_TOKEN: 'run-token' },
  timeoutMs: 30_000,
  maxOutputChars: 2000,
  ...over,
});
const py = (h: SandboxHandle, code: string, over: Partial<RunOptions> = {}) => h.runCode(code, opts(over));
const js = (h: SandboxHandle, code: string) => h.runCode(code, opts({ language: 'javascript' }));

describe('Deno sandbox: what user code cannot reach', { skip, timeout: 120_000 }, () => {
  let h: SandboxHandle;
  before(async () => { h = await sandbox(); });

  it('sees no host environment', async () => {
    // os.environ is Emscripten's own (HOME, LD_LIBRARY_PATH, ...), never this process's.
    const r = await py(h, 'import os\n[k for k, v in os.environ.items() if k == "SANDBOX_SENTINEL" or "leak-me" in v]');
    assert.deepEqual(r.results, ['[]']);
    assert.match(String((await js(h, 'try { Deno.env.toObject(); return "read" } catch (e) { return e.name }')).results), /NotCapable/);
  });

  it('cannot read host files, list other directories, or mount them', async () => {
    const r = await py(h, 'from pyodide.code import run_js\nrun_js("Deno.readTextFileSync(\'/etc/hosts\')")');
    assert.match(String(r.error?.value), /NotCapable: Requires read access/);
    const node = await js(h, 'const fs = await import("node:fs"); return fs.readFileSync("/etc/hosts", "utf8")');
    assert.match(String(node.error?.value), /NotCapable|read access/);
    const mount = await py(h, 'import pyodide_js\npyodide_js.mountNodeFS("/x", "/")');
    assert.ok(mount.error, 'mounting the host root is refused');
  });

  it('cannot run programs or load native code', async () => {
    // An absolute path: a bare name already fails to resolve, there being no PATH.
    assert.match(String((await js(h, 'new Deno.Command("/bin/sh").outputSync()')).error?.value), /Requires run access/);
    assert.equal((await js(h, '(await import("node:child_process")).execFileSync("/bin/sh")')).error?.name, 'NotCapable');
    assert.equal((await js(h, 'Deno.dlopen("/usr/lib/libc.so.6", {})')).error?.name, 'NotCapable');
  });

  it('cannot ask for more permissions', async () => {
    assert.deepEqual((await js(h, 'return (await Deno.permissions.request({ name: "net" })).state')).results, ['denied']);
  });

  it('reaches the API host but no other', async () => {
    const ok = await js(h, `return (await fetch("http://${apiHost}/ping")).status`);
    assert.deepEqual(ok.results, ['200']);
    const denied = await js(h, `return (await fetch("${otherUrl}")).status`);
    assert.match(String(denied.error?.value), /NotCapable|net access/);
    const raw = await js(h, `await Deno.connect({ hostname: "127.0.0.1", port: ${new URL(otherUrl).port} })`);
    assert.match(String(raw.error?.value), /NotCapable|net access/);
  });

  it('cannot plant a symlink out of its directory: the attempt kills the interpreter, files stay', async () => {
    await py(h, 'open("kept.txt", "w").write("still here")');
    const r = await py(h, 'import os\nos.symlink("/etc/hosts", "/home/user/link")');
    assert.ok(r.stopped === 'crashed' || r.error, 'refused one way or the other');
    assert.equal(fs.existsSync(path.join(fs.realpathSync(dataDir), h.id, 'link')), false);
    const after = await py(h, 'open("kept.txt").read()');
    assert.deepEqual(after.results, ["'still here'"]);
  });
});

describe('Deno sandbox: running code', { skip, timeout: 180_000 }, () => {
  it('keeps Python state, returns the last expression, and writes files the host can list', async () => {
    const h = await sandbox();
    await py(h, 'import pandas as pd\ndf = pd.DataFrame({"a": range(4)})\ndf.to_csv("out.csv", index=False)');
    const r = await py(h, 'print("rows", len(df))\nint(df.a.sum())');
    assert.equal(r.stdout, 'rows 4\n');
    assert.deepEqual(r.results, ['6']);
    assert.deepEqual((await h.listFiles('/home/user')).map((e) => e.name), ['out.csv']);
  });

  it('calls the API with the run’s token from Python and JavaScript, and the token is gone after the run', async () => {
    const h = await sandbox();
    seen.length = 0;
    const r = await py(h, 'from awesome import api\napi("GET", "/api/v1/x")["path"]');
    assert.deepEqual(r.results, ["'/api/v1/x'"]);
    const j = await js(h, 'return (await api("POST", "/api/v1/y", { a: 1 })).path');
    assert.deepEqual(j.results, ['/api/v1/y']);
    assert.deepEqual(seen, ['GET /api/v1/x Bearer run-token', 'POST /api/v1/y Bearer run-token']);
    const gone = await py(h, 'import os\nos.environ.get("AWESOME_API_TOKEN")', { envs: {} });
    assert.deepEqual(gone.results, [], 'None: the previous run’s token was removed');
  });

  it('reports errors with a traceback of the user’s code only, and caps output with the total', async () => {
    const h = await sandbox();
    const r = await py(h, 'def f():\n    1/0\nf()');
    assert.equal(r.error?.name, 'ZeroDivisionError');
    assert.match(String(r.error?.traceback), /File "<code>", line 2, in f/);
    assert.doesNotMatch(String(r.error?.traceback), /_pyodide/);
    const big = await py(h, 'print("y" * 5000)');
    assert.equal(big.stdout.length, 2000);
    assert.equal(big.stdoutTotal, 5001);
  });

  it('reports a thrown value whose fields cannot become text, and keeps the interpreter', async () => {
    const h = await sandbox();
    await js(h, 'globalThis.kept = 1');
    const r = await js(h, 'throw { name: { toString: 0 }, message: "bad", stack: "tb" }');
    assert.equal(r.stopped, undefined);
    assert.match(String(r.error?.name), /cannot be shown as text/);
    assert.deepEqual((await js(h, 'return kept')).results, ['1']);
  });

  it('runs JavaScript as an async function body, with state on globalThis', async () => {
    const h = await sandbox();
    await js(h, 'globalThis.n = 20');
    const r = await js(h, 'console.log("n is", n); return n + 1');
    assert.equal(r.stdout, 'n is 20\n');
    assert.deepEqual(r.results, ['21']);
  });

  it('caps Python memory with a MemoryError, and the interpreter survives it', async () => {
    const h = await sandbox();
    const r = await py(h, 'b = bytearray(1200 * 1024**2)');
    assert.equal(r.error?.name, 'MemoryError');
    assert.deepEqual((await py(h, '1 + 1')).results, ['2']);
  });

  it('kills a run at its timeout and starts a new interpreter next time, keeping files', async () => {
    const h = await sandbox();
    await py(h, 'x = 1\nopen("f.txt", "w").write("ok")');
    const r = await py(h, 'print("looping")\nwhile True: pass', { timeoutMs: 1500 });
    assert.equal(r.stopped, 'timeout');
    const next = await py(h, '"x" in globals(), open("f.txt").read()');
    assert.equal(next.restarted, true);
    assert.deepEqual(next.results, ["(False, 'ok')"]);
  });

  it('loads every bundled package from the baked-in wheels, with no CDN to fall back on', async () => {
    const h = await sandbox();
    const r = await py(h, 'import micropip, numpy, pandas, matplotlib, scipy, sklearn, pyarrow, duckdb, requests, bs4, lxml, yaml, xlrd, regex, PIL\n"loaded"', { timeoutMs: 120_000 });
    assert.equal(r.error, undefined, r.error?.traceback);
    assert.deepEqual(r.results, ["'loaded'"]);
    // Let the watchdog sample the loaded interpreter (Linux): it must stay under the default RSS limit.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const after = await py(h, 'len(sys.modules) > 0 if (sys := __import__("sys")) else False');
    assert.equal(after.restarted, false, `the watchdog stopped it: ${after.previousStop}`);
  });

  it('resolves JavaScript’s relative paths in /home/user, where Python sees the same files', async () => {
    const h = await sandbox();
    const w = await js(h, 'await Deno.writeTextFile("from-js.txt", "hi"); return "ok"');
    assert.equal(w.error, undefined, w.error?.value);
    assert.deepEqual((await py(h, 'open("/home/user/from-js.txt").read()')).results, ["'hi'"]);
  });

  it('returns open matplotlib figures as PNGs', async () => {
    const h = await sandbox();
    const r = await py(h, 'import matplotlib.pyplot as plt\nplt.plot([1, 3, 2])\nplt.title("t")\nNone');
    assert.equal(r.images.length, 1);
    assert.equal(Buffer.from(r.images[0], 'base64').subarray(1, 4).toString(), 'PNG');
    assert.equal(r.stderr, '', 'no warnings leak from rendering');
  });
});

describe('Deno sandbox: the watchdog', { skip: skip || linuxOnly, timeout: 120_000 }, () => {
  it('stops code left running after its run returned', async () => {
    const h = await sandbox();
    await js(h, 'setInterval(() => { const end = Date.now() + 200; while (Date.now() < end); }, 0); return "returned"');
    await new Promise((r) => setTimeout(r, 4000));
    const next = await js(h, 'return 1');
    assert.equal(next.previousStop, 'background');
  });

  it('stops a worker whose WebAssembly memories add up past the limit', async () => {
    const h = await sandbox();
    const r = await js(h, 'const all = []; for (;;) { const m = new WebAssembly.Memory({ initial: 4096 }); new Uint8Array(m.buffer).fill(1); all.push(m); await new Promise((r) => setTimeout(r, 10)); }');
    assert.equal(r.stopped, 'memory');
  });
});
