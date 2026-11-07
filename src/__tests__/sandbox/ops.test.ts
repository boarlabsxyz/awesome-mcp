import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { UserError } from 'fastmcp';
import {
  opListFiles,
  opReadFile,
  opResetSandbox,
  opRunCode,
  opSandboxStatus,
  opWriteFile,
  type SandboxOpsDeps,
} from '../../sandbox/ops.js';
import { SandboxRefusal, type CreateOptions, type RunOptions, type RunOutcome, type SandboxHandle, type SandboxProvider } from '../../sandbox/provider.js';
import type { Kv } from '../../sandbox/state.js';

/**
 * An in-memory Redis slice whose PX keys expire on its own clock (`advance`).
 * `down` makes every call fail, like an unreachable server.
 */
function fakeKv() {
  const data = new Map<string, string>();
  const expiresAt = new Map<string, number>();
  const kv = {
    data,
    clock: 0,
    down: false,
    advance(ms: number) { kv.clock += ms; },
    /** ms until the key expires, or undefined when it has no TTL. */
    ttl(key: string) { const at = expiresAt.get(key); return at === undefined ? undefined : at - kv.clock; },
    check() {
      if (kv.down) throw new Error('connect ECONNREFUSED');
    },
    live(key: string) {
      const at = expiresAt.get(key);
      if (at !== undefined && at <= kv.clock) { data.delete(key); expiresAt.delete(key); }
      return data.get(key) ?? null;
    },
    async get(key: string) { kv.check(); return kv.live(key); },
    async set(key: string, value: string, _px: 'PX', ms: number, nx?: 'NX') {
      kv.check();
      if (nx && kv.live(key) !== null) return null;
      data.set(key, value);
      expiresAt.set(key, kv.clock + ms);
      return 'OK' as const;
    },
    async del(key: string) { kv.check(); expiresAt.delete(key); return data.delete(key) ? 1 : 0; },
    async incrby(key: string, by: number) { kv.check(); const n = Number(data.get(key) ?? 0) + by; data.set(key, String(n)); return n; },
    async expire() { kv.check(); return 1; },
    /** Only the lock-renewal script: PEXPIRE KEYS[1] if it still holds ARGV[1]. */
    async eval(_script: string, _n: number, key: string, token: string, ms: number) {
      kv.check();
      if (kv.live(key) !== token) return 0;
      expiresAt.set(key, kv.clock + Number(ms));
      return 1;
    },
  };
  return kv;
}

interface FakeSandbox {
  id: string;
  alive: boolean;
  files: Map<string, Uint8Array>;
  timeouts: number[];
  runs: Array<{ code: string; opts: RunOptions }>;
  reads: number[];
}

/** A run's outcome: nothing printed, unless `over` says otherwise. */
const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({
  stdout: '',
  stderr: '',
  results: [],
  images: [],
  imagesDropped: 0,
  restarted: false,
  ...over,
  stdoutTotal: over.stdoutTotal ?? over.stdout?.length ?? 0,
  stderrTotal: over.stderrTotal ?? over.stderr?.length ?? 0,
  resultsTotal: over.resultsTotal ?? (over.results ?? []).join('').length,
});

/** A fake engine. `run` decides what each runCode does. */
function fakeProvider(
  run: (code: string, opts: RunOptions) => Promise<RunOutcome> = async () => outcome(),
  { onCreate = () => {} }: { onCreate?: () => void } = {},
) {
  const sandboxes = new Map<string, FakeSandbox>();
  const created: CreateOptions[] = [];
  const killed: string[] = [];
  let n = 0;
  const handle = (s: FakeSandbox): SandboxHandle => ({
    id: s.id,
    async runCode(code, opts) { s.runs.push({ code, opts }); return run(code, opts); },
    async readFile(path, maxBytes) {
      const f = s.files.get(path);
      if (!f) throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
      s.reads.push(maxBytes);
      return { bytes: f.subarray(0, maxBytes), size: f.length };
    },
    async writeFile(path, content) { s.files.set(path, new TextEncoder().encode(content)); },
    async listFiles(path) {
      return [...s.files.keys()].filter((p) => p.startsWith(path)).map((p) => ({ name: p.split('/').pop()!, path: p, type: 'file' as const, size: s.files.get(p)!.length }));
    },
    async setTimeout(ms) { s.timeouts.push(ms); },
  });
  const provider: SandboxProvider = {
    async create(opts) {
      created.push(opts);
      onCreate();
      const s: FakeSandbox = { id: `sbx${++n}`, alive: true, files: new Map(), timeouts: [], runs: [], reads: [] };
      sandboxes.set(s.id, s);
      return handle(s);
    },
    async connect(id) {
      const s = sandboxes.get(id);
      return s?.alive ? handle(s) : null;
    },
    async endsAt(id) { return sandboxes.get(id)?.alive ? new Date(Date.parse('2026-11-05T12:10:00Z')) : null; },
    async kill(id) { killed.push(id); const s = sandboxes.get(id); if (s) s.alive = false; },
  };
  return { provider, sandboxes, created, killed };
}

/** Deps over fakes. `provider` is an engine (null: no runner configured), not the deps function. */
function makeDeps(over: { kv?: ReturnType<typeof fakeKv>; provider?: SandboxProvider | null; apiBase?: string } = {}) {
  const kv = over.kv ?? fakeKv();
  const vendor = fakeProvider();
  const provider = over.provider === undefined ? vendor.provider : over.provider;
  const tokens = { minted: [] as string[], revoked: [] as string[], ttls: [] as number[] };
  let t = Date.parse('2026-11-05T12:00:00Z');
  const deps: SandboxOpsDeps = {
    provider: () => provider,
    kv: () => kv as unknown as Kv,
    mintToken: async (_uid, _inst, ttl) => { const token = `tok${tokens.minted.length + 1}`; tokens.minted.push(token); tokens.ttls.push(ttl); return { token }; },
    revokeToken: async (token) => { tokens.revoked.push(token); },
    apiBase: () => over.apiBase ?? 'https://awesome-mcp.xyz',
    now: () => (t += 1500),
  };
  return { deps, kv, vendor, tokens };
}

const run = { language: 'python' as const, code: 'print(1)', timeoutSec: 120 };

async function rejects(p: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(p, (e: any) => e instanceof UserError && pattern.test(e.message));
}

const savedEnv = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith('SANDBOX_')) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

describe('runCode', () => {
  it('says what is missing instead of failing obscurely', async () => {
    await rejects(opRunCode(undefined, undefined, run, makeDeps().deps), /signed-in user/);
    await rejects(opRunCode(1, undefined, run, makeDeps({ provider: null }).deps), /SANDBOX_RUNNER_URL/);
    await rejects(opRunCode(1, undefined, run, { ...makeDeps().deps, kv: () => null }), /database\/Redis/);
  });

  it('creates the user’s sandbox once, with the network allowlist, then reuses it', async () => {
    const vendor = fakeProvider(async () => outcome({ stdout: 'hi\n', results: ['2'] }));
    const { deps } = makeDeps({ provider: vendor.provider });
    const first = await opRunCode(7, 'inst1', run, deps);
    assert.equal(first.json.sandbox, 'new');
    assert.equal(first.json.stdout, 'hi\n');
    assert.deepEqual(first.json.results, ['2']);
    assert.deepEqual(vendor.created[0].allowNet, ['awesome-mcp.xyz', 'pypi.org', 'files.pythonhosted.org']);
    assert.equal(vendor.created[0].userId, 7);
    assert.equal(vendor.sandboxes.get('sbx1')!.runs[0].opts.maxOutputChars, 20_000);

    const second = await opRunCode(7, 'inst1', run, deps);
    assert.equal(second.json.sandbox, 'reused');
    assert.equal(second.json.note, undefined);
    assert.equal(vendor.created.length, 1);
  });

  it('says so when the previous sandbox expired, and starts a new one', async () => {
    const { deps, vendor } = makeDeps();
    await opRunCode(7, undefined, run, deps);
    vendor.sandboxes.get('sbx1')!.alive = false;
    const again = await opRunCode(7, undefined, run, deps);
    assert.equal(again.json.sandbox, 'replaced');
    assert.match(String(again.json.note), /had stopped.*files and variables are gone/);
  });

  it('allows the API host with its port when BASE_URL names one', async () => {
    const { deps, vendor } = makeDeps({ apiBase: 'http://localhost:8080' });
    await opRunCode(7, undefined, run, deps);
    assert.equal(vendor.created[0].allowNet[0], 'localhost:8080');
  });

  it('mints a bearer for the run, passes it in env, and revokes it after success and after failure', async () => {
    const vendor = fakeProvider(async (code) => {
      if (code === 'boom') throw new Error('kernel died');
      return outcome();
    });
    const { deps, tokens } = makeDeps({ provider: vendor.provider });
    await opRunCode(7, 'inst1', run, deps);
    const env = vendor.sandboxes.get('sbx1')!.runs[0].opts.envs;
    assert.deepEqual(env, { AWESOME_API_BASE: 'https://awesome-mcp.xyz', AWESOME_API_TOKEN: 'tok1' });
    assert.deepEqual(tokens.revoked, ['tok1']);

    await rejects(opRunCode(7, 'inst1', { ...run, code: 'boom' }, deps), /could not run the code: kernel died/);
    assert.deepEqual(tokens.revoked, ['tok1', 'tok2']);
  });

  it('keeps the sandbox alive through the run, then back to the idle timeout', async () => {
    process.env.SANDBOX_IDLE_MINUTES = '10';
    const { deps, vendor } = makeDeps();
    await opRunCode(7, undefined, { ...run, timeoutSec: 60 }, deps);
    assert.deepEqual(vendor.sandboxes.get('sbx1')!.timeouts, [600_000 + 60_000, 600_000]);
  });

  it('caps the run timeout at SANDBOX_MAX_TIMEOUT_SEC', async () => {
    process.env.SANDBOX_MAX_TIMEOUT_SEC = '30';
    const { deps, vendor } = makeDeps();
    await opRunCode(7, undefined, { ...run, timeoutSec: 300 }, deps);
    assert.equal(vendor.sandboxes.get('sbx1')!.runs[0].opts.timeoutMs, 30_000);
  });

  it('reports a timeout with the output printed so far, not as a failure', async () => {
    const vendor = fakeProvider(async () => outcome({ stdout: 'step 1\n', stopped: 'timeout' }));
    const { deps, tokens } = makeDeps({ provider: vendor.provider });
    const out = await opRunCode(7, undefined, run, deps);
    assert.match(String(out.json.timedOut), /Stopped after 120 s.*variables are gone, files are kept/);
    assert.equal(out.json.stdout, 'step 1\n');
    assert.deepEqual(tokens.revoked, ['tok1']);
    assert.deepEqual(vendor.killed, [], 'the runner already stopped the interpreter; the sandbox and its files stay');
  });

  it('says when the interpreter crashed, went over the disk limit, or was restarted', async () => {
    const outcomes = [
      outcome({ stopped: 'crashed', crashDetail: 'NotCapable: Deno.symlinkSync() requires unscoped --allow-read' }),
      outcome({ stopped: 'disk' }),
      outcome({ stopped: 'memory' }),
      outcome({ restarted: true }),
      outcome({ restarted: true, previousStop: 'background' }),
    ];
    const vendor = fakeProvider(async () => outcomes.shift()!);
    const { deps } = makeDeps({ provider: vendor.provider });
    const notes = async () => ((await opRunCode(7, undefined, run, deps)).json.notes as string[]).join(' ');
    assert.match(await notes(), /crashed and was stopped \(NotCapable: Deno\.symlinkSync.*variables are gone; files are kept/);
    assert.match(await notes(), /over its disk limit/);
    assert.match(await notes(), /more memory than a sandbox may/);
    assert.match(await notes(), /new Python\/JavaScript interpreter \(the previous one had been stopped\).*variables from earlier runs are gone/);
    assert.match(await notes(), /code left running after a run kept using CPU/);
  });

  it('passes the engine’s refusals on as they are worded', async () => {
    const busy = { ...fakeProvider().provider, create: async () => { throw new SandboxRefusal('The sandbox runner is at capacity'); } };
    await rejects(opRunCode(7, undefined, run, makeDeps({ provider: busy }).deps), /^The sandbox runner is at capacity$/);
    const full = fakeProvider(async () => { throw new SandboxRefusal('disk limit would be exceeded'); });
    await rejects(opRunCode(7, undefined, run, makeDeps({ provider: full.provider }).deps), /^disk limit would be exceeded$/);
  });

  it('mints the bearer for the run timeout, a cold start and a margin, so a call near the end is not refused', async () => {
    const { deps, tokens } = makeDeps();
    await opRunCode(7, undefined, { ...run, timeoutSec: 300 }, deps);
    assert.deepEqual(tokens.ttls, [390]);
  });

  it('stops the sandbox when the bearer cannot be revoked, after retrying', async () => {
    const { deps, vendor } = makeDeps();
    let attempts = 0;
    const failing = { ...deps, revokeToken: async () => { attempts++; throw new Error('READONLY'); } };
    const out = await opRunCode(7, undefined, run, failing);
    assert.equal(attempts, 3);
    assert.deepEqual(vendor.killed, ['sbx1']);
    assert.match(String((out.json.notes as string[]).at(-1)), /could not be revoked, so the sandbox was stopped/);
  });

  it('caps the text results with one budget, not per result', async () => {
    const vendor = fakeProvider(async () => outcome({ results: Array.from({ length: 5 }, () => 'r'.repeat(10_000)) }));
    const out = await opRunCode(7, undefined, run, makeDeps({ provider: vendor.provider }).deps);
    assert.equal((out.json.results as string[]).join('').length, 20_000);
    assert.equal((out.json.truncated as any).resultsTotalChars, 50_000);
    // The runner already cut them, and says how long they were.
    const cut = fakeProvider(async () => outcome({ results: ['r'.repeat(20_000)], resultsTotal: 900_000 }));
    const again = await opRunCode(7, undefined, run, makeDeps({ provider: cut.provider }).deps);
    assert.equal((again.json.truncated as any).resultsTotalChars, 900_000);
  });

  it('caps output and says how much there was', async () => {
    const vendor = fakeProvider(async () => outcome({ stdout: 'x'.repeat(20_000), stdoutTotal: 50_000 }));
    const out = await opRunCode(7, undefined, run, makeDeps({ provider: vendor.provider }).deps);
    assert.equal(String(out.json.stdout).length, 20_000);
    assert.equal((out.json.truncated as any).stdoutTotalChars, 50_000);
  });

  it('returns plot images (up to the cap) and the error with a capped traceback', async () => {
    const png = Buffer.from('fake-png').toString('base64');
    const vendor = fakeProvider(async () => outcome({
      images: [png, png, png, png],
      imagesDropped: 1, // one the runner already left out
      error: { name: 'ValueError', value: 'bad', traceback: 'T'.repeat(9000) },
    }));
    const out = await opRunCode(7, undefined, run, makeDeps({ provider: vendor.provider }).deps);
    assert.equal(out.images.length, 3);
    assert.equal(out.images[0].mimeType, 'image/png');
    assert.match(String(out.json.imagesDropped), /^2 image/);
    assert.equal((out.json.error as any).name, 'ValueError');
    assert.ok((out.json.error as any).traceback.length < 6000);
  });

  it('refuses a second call while one holds the user’s lock, and lets other users through', async () => {
    let release: (() => void) | undefined;
    let started!: () => void;
    const running = new Promise<void>((r) => { started = r; });
    // Only the first run blocks until released; later ones finish at once.
    const vendor = fakeProvider(() => (release
      ? Promise.resolve(outcome())
      : new Promise((resolve) => { release = () => resolve(outcome()); started(); })));
    const { deps } = makeDeps({ provider: vendor.provider });
    const first = opRunCode(7, undefined, run, deps);
    await running;
    await rejects(opRunCode(7, undefined, run, deps), /busy/);
    await rejects(opWriteFile(7, { path: '/home/user/a.txt', content: 'x' }, deps), /busy/);
    await opSandboxStatus(8, deps); // another user is not blocked
    release!();
    await first;
    assert.equal(vendor.created.length, 1, 'two overlapping calls never create two sandboxes');
    await opRunCode(7, undefined, run, deps); // lock released
  });

  it('holds the lock for the whole run timeout, and refuses to run once the lease was lost while starting', async () => {
    let release!: () => void;
    let started!: () => void;
    const running = new Promise<void>((r) => { started = r; });
    const vendor = fakeProvider(() => new Promise((resolve) => { release = () => resolve(outcome()); started(); }));
    const { deps, kv } = makeDeps({ provider: vendor.provider });
    const first = opRunCode(7, undefined, { ...run, timeoutSec: 300 }, deps);
    await running;
    kv.advance(299_000); // most of a 300 s run later, the lease still holds
    await rejects(opRunCode(7, undefined, run, deps), /busy/);
    release();
    await first;

    // Creating the sandbox outlasts the lease and another call takes the lock: this one must not run.
    const slow = makeDeps();
    const stalled = fakeProvider(undefined, { onCreate: () => { slow.kv.advance(10 * 60_000); void slow.kv.set('sandbox:lock:9', 'someone-else', 'PX', 60_000); } });
    await rejects(opRunCode(9, undefined, run, { ...slow.deps, provider: () => stalled.provider }), /lost the sandbox lock/);
    assert.equal(stalled.sandboxes.get('sbx1')!.runs.length, 0);
    assert.equal(slow.tokens.minted.length, 0);
    assert.equal(slow.kv.data.get('sandbox:lock:9'), 'someone-else', 'the other holder keeps its lock');
  });

  it('enforces the daily run and run-second quotas, charging the seconds actually used', async () => {
    process.env.SANDBOX_MAX_RUNS_PER_DAY = '2';
    const { deps, kv } = makeDeps();
    await opRunCode(7, undefined, run, deps);
    const used = await opRunCode(7, undefined, run, deps);
    assert.equal((used.json.quota as any).runsToday, 2);
    await rejects(opRunCode(7, undefined, run, deps), /2 of 2 runs today/);
    // now() advances 1.5 s per call, so each run is charged its whole seconds.
    assert.ok(Number(kv.data.get('sandbox:quota:7:2026-11-05:secs')) >= 2);

    process.env.SANDBOX_MAX_RUNS_PER_DAY = '100';
    process.env.SANDBOX_MAX_SECONDS_PER_DAY = '1';
    await rejects(opRunCode(7, undefined, run, deps), /seconds of run time today/);
  });

  it('cuts the run timeout to the seconds left today, and says so', async () => {
    process.env.SANDBOX_MAX_SECONDS_PER_DAY = '50';
    const { deps, vendor } = makeDeps();
    await opRunCode(7, undefined, run, deps); // uses 2 s
    const out = await opRunCode(7, undefined, { ...run, timeoutSec: 300 }, deps);
    assert.equal(vendor.sandboxes.get('sbx1')!.runs[1].opts.timeoutMs, 48_000);
    assert.match(String((out.json.notes as string[])[0]), /cut to 48 s/);
  });

  it('reserves the seconds before the run, so a Redis failure afterwards over-charges rather than losing them', async () => {
    const kv = fakeKv();
    const vendor = fakeProvider(async () => { kv.down = true; return outcome(); });
    const { deps } = makeDeps({ kv, provider: vendor.provider });
    const out = await opRunCode(7, undefined, run, deps);
    assert.equal(out.json.quota, 'unknown (usage store unreachable)');
    kv.down = false;
    assert.equal(kv.data.get('sandbox:quota:7:2026-11-05:secs'), '120', 'the whole reservation stays charged');
  });

  it('fails closed when Redis is unreachable: no run, no sandbox, no token', async () => {
    const { deps, kv, vendor, tokens } = makeDeps();
    kv.down = true;
    await rejects(opRunCode(7, undefined, run, deps), /refusing calls: its usage store \(Redis\) is unreachable/);
    assert.equal(vendor.created.length, 0);
    assert.equal(tokens.minted.length, 0);
  });

  it('passes a runner failure through as itself, not as a Redis outage', async () => {
    const provider = { ...fakeProvider().provider, create: async () => { throw new Error('The sandbox runner failed (500)'); } };
    await assert.rejects(opRunCode(7, undefined, run, makeDeps({ provider }).deps), /runner failed \(500\)/);
  });
});

describe('files, status and reset', () => {
  it('list and read need a running sandbox and never create one', async () => {
    const { deps, vendor } = makeDeps();
    await rejects(opListFiles(7, { path: '/home/user' }, deps), /No sandbox is running/);
    await rejects(opReadFile(7, { path: '/home/user/a.txt', maxChars: 100 }, deps), /No sandbox is running/);
    assert.equal(vendor.created.length, 0);
  });

  it('writes, lists and reads text, capping it with the total', async () => {
    const { deps } = makeDeps();
    const written = await opWriteFile(7, { path: '/home/user/a.txt', content: 'hello world' }, deps);
    assert.equal(written.json.sandbox, 'new');
    const listed = await opListFiles(7, { path: '/home/user' }, deps);
    assert.ok((listed.json.entries as any[]).some((e) => e.name === 'a.txt'));
    const read = await opReadFile(7, { path: '/home/user/a.txt', maxChars: 5 }, deps);
    assert.equal(read.json.content, 'hello');
    assert.match(String(read.json.truncated), /first 5 of 11/);
    await rejects(opReadFile(7, { path: '/home/user/missing', maxChars: 5 }, deps), /No file at/);
  });

  it('lists at most 500 entries, with the total', async () => {
    const { deps, vendor } = makeDeps();
    await opWriteFile(7, { path: '/home/user/x', content: '' }, deps);
    const files = vendor.sandboxes.get('sbx1')!.files;
    for (let i = 0; i < 600; i++) files.set(`/home/user/f${i}`, new Uint8Array());
    const listed = await opListFiles(7, { path: '/home/user' }, deps);
    assert.equal((listed.json.entries as unknown[]).length, 500);
    assert.equal(listed.json.count, 601);
    assert.match(String(listed.json.truncated), /500 of 601/);
  });

  it('reads only what maxChars can show of a large file', async () => {
    const { deps, vendor } = makeDeps();
    await opWriteFile(7, { path: '/home/user/big.txt', content: 'é'.repeat(500_000) }, deps);
    const read = await opReadFile(7, { path: '/home/user/big.txt', maxChars: 3 }, deps);
    assert.deepEqual(vendor.sandboxes.get('sbx1')!.reads, [12]);
    assert.equal(read.json.content, 'ééé');
    assert.equal(read.json.bytes, 1_000_000);
    assert.match(String(read.json.truncated), /first 3 characters of a 1000000-byte file/);
  });

  it('file calls never extend the sandbox: only metered runs keep it alive', async () => {
    const { deps, vendor } = makeDeps();
    await opRunCode(7, undefined, run, deps);
    const before = [...vendor.sandboxes.get('sbx1')!.timeouts];
    await opWriteFile(7, { path: '/home/user/a.txt', content: 'x' }, deps);
    await opListFiles(7, { path: '/home/user' }, deps);
    await opReadFile(7, { path: '/home/user/a.txt', maxChars: 10 }, deps);
    assert.deepEqual(vendor.sandboxes.get('sbx1')!.timeouts, before);
  });

  it('returns an image file as an image, and describes other binary files', async () => {
    const { deps, vendor } = makeDeps();
    await opWriteFile(7, { path: '/home/user/x', content: '' }, deps);
    const files = vendor.sandboxes.get('sbx1')!.files;
    files.set('/home/user/plot.png', new Uint8Array([137, 80, 78, 71]));
    files.set('/home/user/data.bin', new Uint8Array([0, 1, 2, 255]));
    const image = await opReadFile(7, { path: '/home/user/plot.png', maxChars: 100 }, deps);
    assert.equal(image.images[0].mimeType, 'image/png');
    const binary = await opReadFile(7, { path: '/home/user/data.bin', maxChars: 100 }, deps);
    assert.equal(binary.json.binary, true);
    assert.equal(binary.images.length, 0);
  });

  it('status reports the sandbox and quotas; reset kills it and says so', async () => {
    const { deps, vendor } = makeDeps();
    assert.equal((await opSandboxStatus(7, deps)).json.running, false);
    await opRunCode(7, undefined, run, deps);
    const status = await opSandboxStatus(7, deps);
    assert.equal(status.json.running, true);
    assert.equal((status.json.quota as any).runsToday, 1);

    const reset = await opResetSandbox(7, deps);
    assert.equal(reset.json.reset, true);
    assert.deepEqual(vendor.killed, ['sbx1']);
    assert.equal((await opResetSandbox(7, deps)).json.reset, false);
    const next = await opRunCode(7, undefined, run, deps);
    assert.equal(next.json.sandbox, 'new');
  });
});
