// The host side of one worker process (worker.ts under Deno): starting it,
// the JSON-lines protocol, and stopping it. A run that outlives its timeout
// kills the process; there is no softer stop, since a JavaScript loop cannot
// be interrupted and a Python one only from inside the same process.
import { spawn, type ChildProcess } from 'node:child_process';

export interface WorkerRunRequest {
  language: 'python' | 'javascript';
  code: string;
  envs: Record<string, string>;
  maxOutputChars: number;
}

export interface WorkerRunResult {
  stdout: string;
  stderr: string;
  stdoutTotal: number;
  stderrTotal: number;
  results: string[];
  images: string[];
  imagesDropped: number;
  error?: { name: string; value: string; traceback: string };
  /** Set when the process was stopped during the run: its variables are gone. */
  stopped?: 'timeout' | 'crashed';
  /** The end of the worker's own stderr, when it crashed. */
  crashDetail?: string;
}

/** What the pool needs from a worker; tests substitute a fake. */
export interface WorkerLike {
  readonly alive: boolean;
  run(req: WorkerRunRequest, timeoutMs: number): Promise<WorkerRunResult>;
  kill(): void;
}

export interface WorkerCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The longest protocol line accepted; a longer one means the worker is misbehaving, and it is killed. */
const MAX_LINE_CHARS = 16 * 1024 * 1024;
/** How much of the worker's own stderr is kept, for a crash report. */
const STDERR_TAIL_CHARS = 2000;

interface Pending {
  id: number;
  stdout: string;
  stderr: string;
  resolve: (r: WorkerRunResult) => void;
  timer: NodeJS.Timeout;
}

export class WorkerProcess implements WorkerLike {
  private readonly child: ChildProcess;
  private buffer = '';
  private stderrTail = '';
  private nextId = 1;
  private pending: Pending | null = null;
  private exited = false;
  private readyWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;

  private constructor(cmd: WorkerCommand) {
    this.child = spawn(cmd.command, cmd.args, { env: cmd.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (chunk: string) => this.onData(chunk));
    this.child.stderr!.setEncoding('utf8');
    this.child.stderr!.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    this.child.stdin!.on('error', () => {});
    this.child.on('error', (err) => this.onExit(err.message));
    this.child.on('exit', (code, signal) => this.onExit(`exited (${signal ?? `code ${code}`})`));
  }

  /** A started worker, once it reports ready; rejects when it exits first or takes longer than startTimeoutMs. */
  static async start(cmd: WorkerCommand, startTimeoutMs: number): Promise<WorkerProcess> {
    const worker = new WorkerProcess(cmd);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.kill();
        reject(new Error(`The Python worker did not start within ${startTimeoutMs} ms.`));
      }, startTimeoutMs);
      worker.readyWaiter = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
    });
    return worker;
  }

  get alive(): boolean {
    return !this.exited;
  }

  run(req: WorkerRunRequest, timeoutMs: number): Promise<WorkerRunResult> {
    if (this.exited) return Promise.reject(new Error('The worker has exited.'));
    if (this.pending) return Promise.reject(new Error('The worker is already running code.'));
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish({ stopped: 'timeout' }, true), timeoutMs);
      this.pending = { id, stdout: '', stderr: '', resolve, timer };
      this.child.stdin!.write(JSON.stringify({ id, ...req }) + '\n');
    });
  }

  kill(): void {
    if (!this.exited) this.child.kill('SIGKILL');
  }

  /** Settles the pending run with what was streamed so far plus `extra`, killing the worker when asked. */
  private finish(extra: Partial<WorkerRunResult>, kill: boolean): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    if (kill) this.kill();
    p.resolve({
      stdout: p.stdout,
      stderr: p.stderr,
      stdoutTotal: p.stdout.length,
      stderrTotal: p.stderr.length,
      results: [],
      images: [],
      imagesDropped: 0,
      ...extra,
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      this.onLine(line);
    }
    if (this.buffer.length > MAX_LINE_CHARS) {
      this.buffer = '';
      this.finish({ stopped: 'crashed', crashDetail: 'The worker wrote an oversized protocol line.' }, true);
    }
  }

  private onLine(line: string): void {
    let msg: { type?: string; id?: number; stream?: string; text?: string } & Partial<WorkerRunResult>;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not ours: user code can write to the process's stdout directly
    }
    if (msg.type === 'ready') {
      this.readyWaiter?.resolve();
      this.readyWaiter = null;
      return;
    }
    const p = this.pending;
    if (!p || msg.id !== p.id) return;
    if (msg.type === 'out' && typeof msg.text === 'string') {
      if (msg.stream === 'stderr') p.stderr += msg.text;
      else p.stdout += msg.text;
    } else if (msg.type === 'done') {
      this.finish({
        stdoutTotal: Math.max(p.stdout.length, Number(msg.stdoutTotal) || 0),
        stderrTotal: Math.max(p.stderr.length, Number(msg.stderrTotal) || 0),
        results: Array.isArray(msg.results) ? msg.results.map(String) : [],
        images: Array.isArray(msg.images) ? msg.images.map(String) : [],
        imagesDropped: Number(msg.imagesDropped) || 0,
        ...(msg.error ? { error: msg.error } : {}),
      }, false);
    }
  }

  private onExit(reason: string): void {
    if (this.exited) return;
    this.exited = true;
    const detail = this.stderrTail.trim() || reason;
    this.readyWaiter?.reject(new Error(`The Python worker failed to start: ${detail}`));
    this.readyWaiter = null;
    this.finish({ stopped: 'crashed', crashDetail: detail }, false);
  }
}
