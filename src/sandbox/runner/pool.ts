// The sandbox engine itself: one session per user sandbox, each with a
// directory on this host (mounted as /home/user) and, while it is running
// code or holding variables, a worker process (worker.ts under Deno).
//
// Files live on the host, not in the interpreter, so they survive the worker
// being killed (a timeout, a crash, eviction) and the file tools never need a
// worker. A session ends after its idle timeout: worker killed, directory
// deleted. Everything is in this process's memory, so the runner service
// runs as ONE replica, and a restart ends every session (the MCP side then
// reports a replaced sandbox).
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SandboxNotFound,
  SandboxRefusal,
  type CreateOptions,
  type FileRead,
  type RunOptions,
  type RunOutcome,
  type SandboxEntry,
  type SandboxHandle,
  type SandboxProvider,
} from '../provider.js';
import { BUNDLED_PACKAGES } from './packages.js';
import { WorkerProcess, type WorkerCommand, type WorkerLike } from './workerProcess.js';

/** Where the user's directory appears inside the sandbox. */
export const SANDBOX_HOME = '/home/user';
/** Images a run returns at most, and the size of each. */
export const MAX_IMAGES = 3;
export const MAX_IMAGE_BYTES = 1_500_000;
/** V8's own heap (JavaScript, not Python), per worker. */
const JS_HEAP_MB = 512;
/** One WebAssembly page is 64 KiB. */
const PAGES_PER_MB = 16;
/** An idle timer that fires mid-run waits this long and checks again. */
const BUSY_RETRY_MS = 30_000;
/** Between runs a worker should be idle; past this share of one core it is running code left behind, and is stopped. */
const IDLE_CPU_SHARE = 0.5;

export interface PoolConfig {
  denoPath: string;
  /** worker.js (built) or worker.ts (source; Deno runs either). */
  workerScript: string;
  /** node_modules/pyodide. */
  pyodideDir: string;
  /** The bundled wheels (prefetch.ts); read-only to workers. Default: pyodideDir. */
  packageDir: string;
  /** Session directories go here. */
  dataDir: string;
  /** WebAssembly memory per worker: Python's heap, which never shrinks, so this caps it. */
  memoryMb: number;
  /** Live workers at once; the least recently used idle one is stopped to make room. */
  maxWorkers: number;
  maxDiskBytes: number;
  maxFiles: number;
  startTimeoutMs: number;
  /**
   * The resident memory a worker may use: WebAssembly (memoryMb, per memory),
   * the JavaScript heap and Pyodide itself. A process-wide bound, since code
   * can allocate several WebAssembly memories or large ArrayBuffers.
   */
  maxRssBytes: number;
  /** How often the watchdog measures each live worker (disk, memory, idle CPU). */
  watchMs: number;
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const n = Number(env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function defaultWorkerScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const built = path.join(here, 'worker.js');
  return fs.existsSync(built) ? built : path.join(here, 'worker.ts');
}

export function defaultPyodideDir(): string {
  return path.dirname(createRequire(import.meta.url).resolve('pyodide'));
}

export function poolConfigFromEnv(env: NodeJS.ProcessEnv): PoolConfig {
  const pyodideDir = env.SANDBOX_PYODIDE_DIR || defaultPyodideDir();
  return {
    denoPath: env.SANDBOX_DENO_PATH || 'deno',
    workerScript: defaultWorkerScript(),
    pyodideDir,
    packageDir: env.SANDBOX_PACKAGE_DIR || pyodideDir,
    dataDir: env.SANDBOX_DATA_DIR || path.join(os.tmpdir(), 'awesome-sandbox'),
    memoryMb: envInt(env, 'SANDBOX_MEMORY_MB', 1024),
    maxWorkers: envInt(env, 'SANDBOX_MAX_WORKERS', 4),
    maxDiskBytes: envInt(env, 'SANDBOX_MAX_DISK_MB', 500) * 1024 * 1024,
    maxFiles: envInt(env, 'SANDBOX_MAX_FILES', 10_000),
    startTimeoutMs: 60_000,
    maxRssBytes: envInt(env, 'SANDBOX_MAX_RSS_MB', envInt(env, 'SANDBOX_MEMORY_MB', 1024) + 1024) * 1024 * 1024,
    watchMs: 1000,
  };
}

/** hostname or IPv4, or a bracketed IPv6 address, each with an optional port. */
const NET_ENTRY = /^([a-z0-9.-]+|\[[0-9a-f:.]+\])(:\d{1,5})?$/i;

/**
 * The Deno command for one session's worker. The permissions are the
 * sandbox: no environment, no subprocesses, no FFI; reads limited to Pyodide,
 * the wheels and the session directory; writes to that directory only; the
 * network to allowNet only. An empty allowNet must omit the flag entirely —
 * a bare `--allow-net` would allow every host.
 */
export function workerCommand(config: PoolConfig, homeDir: string, allowNet: string[]): WorkerCommand {
  for (const p of [config.pyodideDir, config.packageDir, homeDir]) {
    if (p.includes(',')) throw new Error(`Sandbox paths cannot contain commas (Deno's permission lists are comma-separated): ${p}`);
  }
  const bad = allowNet.find((h) => !NET_ENTRY.test(h));
  if (bad !== undefined) throw new SandboxRefusal(`Not a host[:port] for the network allowlist: ${bad}`);
  const workerConfig = {
    mode: 'serve',
    pyodideDir: config.pyodideDir,
    packageDir: config.packageDir,
    homeDir,
    packages: BUNDLED_PACKAGES,
    maxImages: MAX_IMAGES,
    maxImageBytes: MAX_IMAGE_BYTES,
  };
  return {
    command: config.denoPath,
    args: [
      'run', '--quiet', '--no-prompt', '--no-config', '--no-lock', '--no-remote', '--no-npm',
      `--allow-read=${[...new Set([config.pyodideDir, config.packageDir, homeDir])].join(',')}`,
      `--allow-write=${homeDir}`,
      ...(allowNet.length ? [`--allow-net=${allowNet.join(',')}`] : []),
      `--v8-flags=--max-old-space-size=${JS_HEAP_MB},--wasm-max-mem-pages=${config.memoryMb * PAGES_PER_MB}`,
      config.workerScript,
      JSON.stringify(workerConfig),
    ],
    // Deno's own cache only; the code inside cannot read it (no permission).
    env: { DENO_DIR: path.join(config.dataDir, '.deno'), DENO_NO_UPDATE_CHECK: '1', NO_COLOR: '1' },
    cwd: homeDir,
  };
}

/** The host path for a sandbox path, refusing anything outside /home/user. Relative paths are taken from there. */
export function toHostPath(homeDir: string, sandboxPath: string): string {
  const abs = path.posix.resolve(SANDBOX_HOME, sandboxPath);
  if (abs !== SANDBOX_HOME && !abs.startsWith(`${SANDBOX_HOME}/`)) {
    throw new SandboxRefusal(`Only files under ${SANDBOX_HOME} are reachable from the file tools; ${sandboxPath} is outside it.`);
  }
  return path.join(homeDir, abs.slice(SANDBOX_HOME.length));
}

const isInside = (root: string, p: string) => p === root || p.startsWith(root + path.sep);

/**
 * Refuses a host path that resolves outside root through a link. Workers
 * cannot create symlinks (Deno refuses them under path-scoped permissions),
 * so this is the second line, not the first.
 */
async function assertResolvesInside(root: string, hostPath: string): Promise<void> {
  let probe = hostPath;
  for (;;) {
    try {
      const real = await fsp.realpath(probe);
      if (!isInside(root, real)) throw new SandboxRefusal('That path leads outside the sandbox.');
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || probe === root) throw err;
      probe = path.dirname(probe);
    }
  }
}

export interface DirUsage {
  bytes: number;
  entries: number;
}

/** A directory the user's code made unreadable (chmod 000) is made readable again: it is ours to measure and remove. */
async function openDir(dir: string): Promise<fs.Dir | null> {
  try {
    return await fsp.opendir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM') return null; // removed while counting
    await fsp.chmod(dir, 0o700).catch(() => {});
    return fsp.opendir(dir).catch(() => null);
  }
}

/**
 * Bytes and entries under dir, without following links. Stops as soon as the
 * count passes maxEntries, reading entries one at a time, so a directory of a
 * million files costs no more than the limit.
 */
export async function dirUsage(dir: string, maxEntries: number): Promise<DirUsage> {
  const usage = { bytes: 0, entries: 0 };
  const stack = [dir];
  while (stack.length) {
    const handle = await openDir(stack.pop()!);
    if (!handle) continue;
    try {
      for await (const entry of handle) {
        if (++usage.entries > maxEntries) return usage;
        const full = path.join(handle.path, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else usage.bytes += await fsp.lstat(full).then((st) => st.size, () => 0);
      }
    } catch {
      // removed while counting
    }
  }
  return usage;
}

/** Removes a session directory, restoring permissions the user's code took away if the first try fails. */
async function removeTree(dir: string): Promise<void> {
  try {
    await fsp.rm(dir, { recursive: true, force: true });
    return;
  } catch {
    // fall through: something inside is not writable
  }
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    await fsp.chmod(current, 0o700).catch(() => {});
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const e of entries) if (e.isDirectory()) stack.push(path.join(current, e.name));
  }
  await fsp.rm(dir, { recursive: true, force: true });
}

/** CPU seconds and resident bytes of a process, or null where /proc is missing (macOS: the watchdog then measures disk only). */
export async function procStats(pid: number): Promise<{ cpuSec: number; rssBytes: number } | null> {
  try {
    const [stat, status] = await Promise.all([
      fsp.readFile(`/proc/${pid}/stat`, 'utf8'),
      fsp.readFile(`/proc/${pid}/status`, 'utf8'),
    ]);
    // Fields after the parenthesised command name; utime and stime are the 12th and 13th, in clock ticks (100 Hz on Linux).
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(fields[11]) + Number(fields[12]);
    const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
    return { cpuSec: ticks / 100, rssBytes: rssKb * 1024 };
  } catch {
    return null;
  }
}

export type ProcStats = typeof procStats;

function notFoundOr(err: unknown, sandboxPath: string, what: string): never {
  if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') throw new SandboxNotFound(`No ${what} at ${sandboxPath}.`);
  if ((err as NodeJS.ErrnoException)?.code === 'ENOTDIR') throw new SandboxRefusal(`${sandboxPath} is not a directory.`);
  throw err;
}

interface Session {
  id: string;
  userId: number;
  dir: string;
  allowNet: string[];
  worker: WorkerLike | null;
  /** A worker has run for this session before, so a new one means lost variables. */
  hadWorker: boolean;
  /** Why the watchdog stopped the last worker between runs, for the next run to say. */
  previousStop?: PreviousStop;
  busy: boolean;
  destroyed: boolean;
  lastUsed: number;
  endsAt: number;
  timer?: NodeJS.Timeout;
}

type PreviousStop = NonNullable<RunOutcome['previousStop']>;
interface Baseline {
  cpuSec: number;
  at: number;
}

export type StartWorker = (cmd: WorkerCommand, startTimeoutMs: number) => Promise<WorkerLike>;

const SESSION_ID = /^[0-9a-f]{32}$/;

export class SandboxPool implements SandboxProvider {
  private readonly sessions = new Map<string, Session>();
  private starting = 0;
  private prepared: Promise<string> | null = null;

  constructor(
    private readonly config: PoolConfig,
    private readonly startWorker: StartWorker = (cmd, ms) => WorkerProcess.start(cmd, ms),
    private readonly measure: ProcStats = procStats,
  ) {}

  /**
   * The data directory, resolved (Deno checks permissions against real
   * paths), with session directories left by an earlier process removed —
   * only those: the directory may be shared with other things.
   */
  private dataDir(): Promise<string> {
    this.prepared ??= (async () => {
      await fsp.mkdir(this.config.dataDir, { recursive: true });
      const real = await fsp.realpath(this.config.dataDir);
      for (const name of await fsp.readdir(real)) {
        if (SESSION_ID.test(name) && !this.sessions.has(name)) await removeTree(path.join(real, name));
      }
      return real;
    })();
    return this.prepared;
  }

  async create(opts: CreateOptions): Promise<SandboxHandle> {
    const root = await this.dataDir();
    const id = crypto.randomBytes(16).toString('hex');
    const dir = path.join(root, id);
    const session: Session = {
      id, userId: opts.userId, dir, allowNet: [...opts.allowNet], worker: null, hadWorker: false, busy: false, destroyed: false, lastUsed: Date.now(), endsAt: 0,
    };
    workerCommand(this.config, dir, session.allowNet); // validates now, not at the first run
    await fsp.mkdir(dir);
    this.sessions.set(id, session);
    this.arm(session, opts.timeoutMs);
    return this.handle(session);
  }

  async connect(id: string): Promise<SandboxHandle | null> {
    const session = this.sessions.get(id);
    return session ? this.handle(session) : null;
  }

  async endsAt(id: string): Promise<Date | null> {
    const session = this.sessions.get(id);
    return session ? new Date(session.endsAt) : null;
  }

  async kill(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session) await this.destroy(session);
  }

  /** Live workers, for the runner's health answer. */
  stats() {
    let workers = 0;
    for (const s of this.sessions.values()) if (s.worker?.alive) workers++;
    return { sessions: this.sessions.size, workers, maxWorkers: this.config.maxWorkers };
  }

  private arm(session: Session, ms: number): void {
    clearTimeout(session.timer);
    session.endsAt = Date.now() + ms;
    session.timer = setTimeout(() => {
      if (session.busy) this.arm(session, BUSY_RETRY_MS);
      // A timer callback has no caller: a rejection here would end the process, and every session with it.
      else this.destroy(session).catch((err) => console.error(`Sandbox ${session.id}: could not remove its directory: ${(err as Error)?.message ?? err}`));
    }, ms);
    session.timer.unref();
  }

  private async destroy(session: Session): Promise<void> {
    if (session.destroyed) return;
    session.destroyed = true;
    clearTimeout(session.timer);
    this.sessions.delete(session.id);
    session.worker?.kill();
    session.worker = null;
    await removeTree(session.dir);
  }

  private async overDisk(session: Session): Promise<boolean> {
    const usage = await dirUsage(session.dir, this.config.maxFiles);
    return usage.bytes > this.config.maxDiskBytes || usage.entries > this.config.maxFiles;
  }

  /** Stops this worker if it is still the session's; a run in progress reports the reason itself. */
  private stopWorker(session: Session, worker: WorkerLike, reason: PreviousStop): void {
    if (session.worker !== worker || !worker.alive) return; // already gone: a late measurement
    worker.kill(reason === 'disk' || reason === 'memory' ? reason : undefined);
    session.worker = null;
    if (!session.busy) session.previousStop = reason;
  }

  /**
   * Measures a live worker for as long as it lives, not only during runs: a
   * run can end (or forge its end) with code still going — a timer, an
   * asyncio task — and only measurements from outside the process bound it.
   * Disk and memory are checked always; CPU only between runs, since a run's
   * own time is metered.
   */
  private watch(session: Session, worker: WorkerLike): void {
    let baseline: Baseline | undefined;
    let checking = false;
    const timer = setInterval(() => {
      if (session.worker !== worker || !worker.alive) {
        clearInterval(timer);
        return;
      }
      if (checking) return;
      checking = true;
      this.check(session, worker, baseline)
        .then((next) => { baseline = next; }, () => { baseline = undefined; })
        .finally(() => { checking = false; });
    }, this.config.watchMs);
  }

  /** One watchdog pass; the idle-CPU baseline for the next. */
  private async check(session: Session, worker: WorkerLike, baseline: Baseline | undefined): Promise<Baseline | undefined> {
    if (await this.overDisk(session)) {
      this.stopWorker(session, worker, 'disk');
      return undefined;
    }
    const stats = worker.pid ? await this.measure(worker.pid) : null;
    if (!stats) return undefined;
    if (stats.rssBytes > this.config.maxRssBytes) {
      this.stopWorker(session, worker, 'memory');
      return undefined;
    }
    if (session.busy) return undefined;
    const now = Date.now();
    if (baseline && now - baseline.at >= this.config.watchMs * 0.9
      && stats.cpuSec - baseline.cpuSec > IDLE_CPU_SHARE * ((now - baseline.at) / 1000)) {
      this.stopWorker(session, worker, 'background');
      return undefined;
    }
    return { cpuSec: stats.cpuSec, at: now };
  }

  /** A worker for this session, stopping the least recently used idle one when the pool is full. */
  private async startFor(session: Session): Promise<WorkerLike> {
    const live = [...this.sessions.values()].filter((s) => s.worker?.alive);
    if (live.length + this.starting >= this.config.maxWorkers) {
      const idle = live.filter((s) => !s.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle) {
        throw new SandboxRefusal(`The sandbox runner is at capacity (${this.config.maxWorkers} interpreters, all running code). Try again shortly.`);
      }
      this.stopWorker(idle, idle.worker!, 'evicted');
    }
    this.starting++;
    try {
      return await this.startWorker(workerCommand(this.config, session.dir, session.allowNet), this.config.startTimeoutMs);
    } finally {
      this.starting--;
    }
  }

  private async run(session: Session, code: string, opts: RunOptions): Promise<RunOutcome> {
    if (session.busy) throw new SandboxRefusal('This sandbox is already running code.');
    session.busy = true;
    session.lastUsed = Date.now();
    try {
      let restarted = false;
      let previousStop: PreviousStop | undefined;
      if (!session.worker?.alive) {
        restarted = session.hadWorker;
        previousStop = session.previousStop;
        session.previousStop = undefined;
        const started = await this.startFor(session);
        // The session may have ended while the worker started; nothing else would ever stop it.
        if (session.destroyed) {
          started.kill();
          throw new SandboxNotFound('This sandbox has stopped.');
        }
        session.worker = started;
        session.hadWorker = true;
        this.watch(session, started);
      }
      const worker = session.worker!;
      const result = await worker.run({ language: opts.language, code, envs: opts.envs, maxOutputChars: opts.maxOutputChars }, opts.timeoutMs);
      // A run shorter than one watchdog interval was never measured: measure it before reporting success.
      if (!result.stopped && worker.alive && await this.overDisk(session)) {
        this.stopWorker(session, worker, 'disk');
        result.stopped = 'disk';
      }
      if (result.stopped || !worker.alive) session.worker = null;
      return { ...result, restarted, ...(previousStop ? { previousStop } : {}) };
    } finally {
      session.busy = false;
      session.lastUsed = Date.now();
    }
  }

  private async listFiles(session: Session, sandboxPath: string): Promise<SandboxEntry[]> {
    const host = toHostPath(session.dir, sandboxPath);
    let entries: fs.Dirent[];
    try {
      await assertResolvesInside(session.dir, host);
      entries = await fsp.readdir(host, { withFileTypes: true });
    } catch (err) {
      notFoundOr(err, sandboxPath, 'directory');
    }
    const base = path.posix.resolve(SANDBOX_HOME, sandboxPath);
    return Promise.all(entries.map(async (e) => ({
      name: e.name,
      path: path.posix.join(base, e.name),
      type: e.isDirectory() ? 'dir' as const : e.isFile() ? 'file' as const : 'other' as const,
      size: e.isFile() ? await fsp.lstat(path.join(host, e.name)).then((s) => s.size, () => 0) : 0,
    })));
  }

  private async readFile(session: Session, sandboxPath: string, maxBytes: number): Promise<FileRead> {
    const host = toHostPath(session.dir, sandboxPath);
    let file: fsp.FileHandle;
    try {
      await assertResolvesInside(session.dir, host);
      file = await fsp.open(host, 'r');
    } catch (err) {
      notFoundOr(err, sandboxPath, 'file');
    }
    try {
      const stat = await file.stat();
      if (stat.isDirectory()) throw new SandboxRefusal(`${sandboxPath} is a directory; list it with listFiles.`);
      const want = Math.max(0, Math.min(stat.size, maxBytes));
      const bytes = new Uint8Array(want);
      let filled = 0;
      while (filled < want) {
        const { bytesRead } = await file.read(bytes, filled, want - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return { bytes: bytes.subarray(0, filled), size: stat.size };
    } finally {
      await file.close();
    }
  }

  /** A write the idle timer raced (it may have removed the session, or mkdir recreated its directory) is refused, leaving nothing behind. */
  private async writeFile(session: Session, sandboxPath: string, content: string): Promise<void> {
    try {
      await this.write(session, sandboxPath, content);
    } catch (err) {
      if (!session.destroyed) throw err;
    }
    if (session.destroyed) {
      await removeTree(session.dir).catch(() => {});
      throw new SandboxNotFound('This sandbox stopped during the write.');
    }
  }

  private async write(session: Session, sandboxPath: string, content: string): Promise<void> {
    const host = toHostPath(session.dir, sandboxPath);
    if (host === session.dir) throw new SandboxRefusal(`${sandboxPath} is the home directory, not a file.`);
    await assertResolvesInside(session.dir, host);
    const existing = await fsp.lstat(host).catch(() => null);
    if (existing && !existing.isFile()) throw new SandboxRefusal(`${sandboxPath} exists and is not a regular file.`);
    // Projected usage: an overwrite replaces the old bytes and adds no entry; missing parents are entries too.
    let added = existing ? 0 : 1;
    for (let dir = path.dirname(host); dir !== session.dir && !(await fsp.lstat(dir).catch(() => null)); dir = path.dirname(dir)) added++;
    const usage = await dirUsage(session.dir, this.config.maxFiles);
    const bytes = usage.bytes - (existing?.size ?? 0) + Buffer.byteLength(content, 'utf8');
    if (bytes > this.config.maxDiskBytes || usage.entries + added > this.config.maxFiles) {
      throw new SandboxRefusal(`The sandbox's disk limit (${Math.round(this.config.maxDiskBytes / 1048576)} MB, ${this.config.maxFiles} files) would be exceeded. Delete files with runCode first.`);
    }
    await fsp.mkdir(path.dirname(host), { recursive: true });
    await fsp.writeFile(host, content, 'utf8');
  }

  private handle(session: Session): SandboxHandle {
    const live = () => {
      if (!this.sessions.has(session.id)) throw new SandboxNotFound('This sandbox has stopped.');
      return session;
    };
    return {
      id: session.id,
      runCode: async (code, opts) => this.run(live(), code, opts),
      readFile: async (p, maxBytes) => this.readFile(live(), p, maxBytes),
      writeFile: async (p, content) => this.writeFile(live(), p, content),
      listFiles: async (p) => this.listFiles(live(), p),
      setTimeout: async (ms) => this.arm(live(), ms),
    };
  }
}
