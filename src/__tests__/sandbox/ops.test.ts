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
import type { CreateOptions, RunOptions, RunOutcome, SandboxHandle, SandboxProvider } from '../../sandbox/provider.js';
import { HELPER_PATH } from '../../sandbox/helper.js';
import type { Kv } from '../../sandbox/state.js';

/** An in-memory Redis slice. `down` makes every call fail, like an unreachable server. */
function fakeKv() {
  const data = new Map<string, string>();
  const kv = {
    data,
    down: false,
    check() {
      if (kv.down) throw new Error('connect ECONNREFUSED');
    },
    async get(key: string) { kv.check(); return data.get(key) ?? null; },
    async set(key: string, value: string, _px: 'PX', _ms: number, nx?: 'NX') {
      kv.check();
      if (nx && data.has(key)) return null;
      data.set(key, value);
      return 'OK' as const;
    },
    async del(key: string) { kv.check(); return data.delete(key) ? 1 : 0; },
    async incrby(key: string, by: number) { kv.check(); const n = Number(data.get(key) ?? 0) + by; data.set(key, String(n)); return n; },
    async expire() { kv.check(); return 1; },
  };
  return kv;
}

interface FakeSandbox {
  id: string;
  alive: boolean;
  files: Map<string, Uint8Array>;
  timeouts: number[];
  runs: Array<{ code: string; opts: RunOptions }>;
}

/** A fake vendor. `run` decides what each runCode does. */
function fakeProvider(run: (code: string, opts: RunOptions) => Promise<RunOutcome> = async () => ({ results: [] })) {
  const sandboxes = new Map<string, FakeSandbox>();
  const created: CreateOptions[] = [];
  const killed: string[] = [];
  let n = 0;
  const handle = (s: FakeSandbox): SandboxHandle => ({
    id: s.id,
    async runCode(code, opts) { s.runs.push({ code, opts }); return run(code, opts); },
    async readFile(path) {
      const f = s.files.get(path);
      if (!f) throw Object.assign(new Error('not found'), { name: 'FileNotFoundError' });
      return f;
    },
    async writeFile(path, content) { s.files.set(path, new TextEncoder().encode(content)); },
    async listFiles(path) {
      return [...s.files.keys()].filter((p) => p.startsWith(path)).map((p) => ({ name: p.split('/').pop()!, path: p, type: 'file', size: s.files.get(p)!.length }));
    },
    async setTimeout(ms) { s.timeouts.push(ms); },
  });
  const provider: SandboxProvider = {
    async create(opts) {
      created.push(opts);
      const s: FakeSandbox = { id: `sbx${++n}`, alive: true, files: new Map(), timeouts: [], runs: [] };
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

/** Deps over fakes. `provider` is a vendor (null: no E2B key), not the deps function. */
function makeDeps(over: { kv?: ReturnType<typeof fakeKv>; provider?: SandboxProvider | null } = {}) {
  const kv = over.kv ?? fakeKv();
  const vendor = fakeProvider();
  const provider = over.provider === undefined ? vendor.provider : over.provider;
  const tokens = { minted: [] as string[], revoked: [] as string[] };
  let t = Date.parse('2026-11-05T12:00:00Z');
  const deps: SandboxOpsDeps = {
    provider: () => provider,
    kv: () => kv as unknown as Kv,
    mintToken: async () => { const token = `tok${tokens.minted.length + 1}`; tokens.minted.push(token); return { token }; },
    revokeToken: async (token) => { tokens.revoked.push(token); },
    apiBase: () => 'https://awesome-mcp.xyz',
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
    await rejects(opRunCode(1, undefined, run, makeDeps({ provider: null }).deps), /E2B_API_KEY/);
    await rejects(opRunCode(1, undefined, run, { ...makeDeps().deps, kv: () => null }), /database\/Redis/);
  });

  it('creates the user’s sandbox once, with the API helper and the egress allowlist, then reuses it', async () => {
    const vendor = fakeProvider(async (_code, opts) => { opts.onStdout('hi\n'); return { results: [{ text: '2' }] }; });
    const { deps } = makeDeps({ provider: vendor.provider });
    const first = await opRunCode(7, 'inst1', run, deps);
    assert.equal(first.json.sandbox, 'new');
    assert.equal(first.json.stdout, 'hi\n');
    assert.deepEqual(first.json.results, ['2']);
    assert.deepEqual(vendor.created[0].allowOut, ['awesome-mcp.xyz', 'pypi.org', 'files.pythonhosted.org', 'registry.npmjs.org']);
    assert.equal(vendor.created[0].metadata.userId, '7');
    assert.ok(vendor.sandboxes.get('sbx1')!.files.has(HELPER_PATH), 'helper written at creation');

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
    assert.match(String(again.json.note), /expired.*files and variables are gone/);
  });

  it('mints a bearer for the run, passes it in env, and revokes it after success and after failure', async () => {
    const vendor = fakeProvider(async (code) => {
      if (code === 'boom') throw new Error('kernel died');
      return { results: [] };
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
    const vendor = fakeProvider(async (_c, opts) => {
      opts.onStdout('step 1\n');
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    });
    const { deps, tokens } = makeDeps({ provider: vendor.provider });
    const out = await opRunCode(7, undefined, run, deps);
    assert.match(String(out.json.timedOut), /Stopped after 120 s/);
    assert.equal(out.json.stdout, 'step 1\n');
    assert.deepEqual(tokens.revoked, ['tok1']);
  });

  it('caps output and says how much there was', async () => {
    const vendor = fakeProvider(async (_c, opts) => { opts.onStdout('x'.repeat(50_000)); return { results: [] }; });
    const out = await opRunCode(7, undefined, run, makeDeps({ provider: vendor.provider }).deps);
    assert.equal(String(out.json.stdout).length, 20_000);
    assert.equal((out.json.truncated as any).stdoutTotalChars, 50_000);
  });

  it('returns plot images (up to the cap) and the error with a capped traceback', async () => {
    const png = Buffer.from('fake-png').toString('base64');
    const vendor = fakeProvider(async () => ({
      results: [{ png }, { png }, { png }, { png }],
      error: { name: 'ValueError', value: 'bad', traceback: 'T'.repeat(9000) },
    }));
    const out = await opRunCode(7, undefined, run, makeDeps({ provider: vendor.provider }).deps);
    assert.equal(out.images.length, 3);
    assert.equal(out.images[0].mimeType, 'image/png');
    assert.match(String(out.json.imagesDropped), /^1 image/);
    assert.equal((out.json.error as any).name, 'ValueError');
    assert.ok((out.json.error as any).traceback.length < 6000);
  });

  it('refuses a second call while one holds the user’s lock, and lets other users through', async () => {
    let release: (() => void) | undefined;
    let started!: () => void;
    const running = new Promise<void>((r) => { started = r; });
    // Only the first run blocks until released; later ones finish at once.
    const vendor = fakeProvider(() => (release
      ? Promise.resolve({ results: [] })
      : new Promise((resolve) => { release = () => resolve({ results: [] }); started(); })));
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

  it('fails closed when Redis is unreachable: no run, no sandbox, no token', async () => {
    const { deps, kv, vendor, tokens } = makeDeps();
    kv.down = true;
    await rejects(opRunCode(7, undefined, run, deps), /refusing calls: its usage store \(Redis\) is unreachable/);
    assert.equal(vendor.created.length, 0);
    assert.equal(tokens.minted.length, 0);
  });

  it('passes a vendor failure through as itself, not as a Redis outage', async () => {
    const provider = { ...fakeProvider().provider, create: async () => { throw new Error('E2B 500'); } };
    await assert.rejects(opRunCode(7, undefined, run, makeDeps({ provider }).deps), /E2B 500/);
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
