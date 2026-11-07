// The host side of one worker process (worker.ts under Deno): starting it,
// the JSON-lines protocol, and stopping it. A run that outlives its timeout
// kills the process; there is no softer stop, since a JavaScript loop cannot
// be interrupted and a Python one only from inside the same process.
//
// User code shares the worker's stdout, so every line is untrusted: it may
// be malformed, outsized, or a forged message. Nothing here trusts one beyond
// its own run's output, which is capped on this side too. A forged `done` can
// end the run early with code still going; the pool's watchdog (CPU, memory,
// disk, measured from outside the process) is what bounds that.
import * as crypto from 'node:crypto';
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
  /** Characters printed; a lower bound when the run stopped before reporting them. */
  stdoutTotal: number;
  stderrTotal: number;
  /** Capped at maxOutputChars together; resultsTotal is their full length. */
  results: string[];
  resultsTotal: number;
  images: string[];
  imagesDropped: number;
  error?: { name: string; value: string; traceback: string };
  /** Set when the process was stopped during the run: its variables are gone. */
  stopped?: 'timeout' | 'crashed' | 'disk' | 'memory';
  /** The end of the worker's own stderr, when it crashed. */
  crashDetail?: string;
}

/** What the pool needs from a worker; tests substitute a fake. */
export interface WorkerLike {
  readonly alive: boolean;
  /** The OS process, for the pool's CPU and memory watchdog. */
  readonly pid?: number;
  run(req: WorkerRunRequest, timeoutMs: number): Promise<WorkerRunResult>;
  /** Stops the process; a run in progress ends with `stopped` set to the reason. */
  kill(reason?: 'disk' | 'memory'): void;
}

export interface WorkerCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** The session directory, so JavaScript's relative paths land in /home/user. */
  cwd?: string;
}

/** The longest protocol line accepted; a longer one means the worker is misbehaving, and it is killed. */
const MAX_LINE_CHARS = 16 * 1024 * 1024;
/** How much of the worker's own stderr is kept, for a crash report. */
const STDERR_TAIL_CHARS = 2000;

type Stream = 'stdout' | 'stderr';

interface Pending {
  id: string;
  maxChars: number;
  text: Record<Stream, string>;
  total: Record<Stream, number>;
  resolve: (r: WorkerRunResult) => void;
  timer: NodeJS.Timeout;
}

type Message = Record<string, unknown>;

export class WorkerProcess implements WorkerLike {
  private readonly child: ChildProcess;
  private buffer = '';
  private stderrTail = '';
  private pending: Pending | null = null;
  private exited = false;
  private killReason: 'disk' | 'memory' | undefined;
  private readyWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;

  private constructor(cmd: WorkerCommand) {
    this.child = spawn(cmd.command, cmd.args, { env: cmd.env, cwd: cmd.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
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

  get pid(): number | undefined {
    return this.child.pid;
  }

  run(req: WorkerRunRequest, timeoutMs: number): Promise<WorkerRunResult> {
    if (this.exited) return Promise.reject(new Error('The worker has exited.'));
    if (this.pending) return Promise.reject(new Error('The worker is already running code.'));
    // Random, so code from an earlier run cannot predict which id to forge.
    const id = crypto.randomBytes(12).toString('hex');
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish({ stopped: 'timeout' }, true), timeoutMs);
      this.pending = { id, maxChars: req.maxOutputChars, text: { stdout: '', stderr: '' }, total: { stdout: 0, stderr: 0 }, resolve, timer };
      this.child.stdin!.write(JSON.stringify({ id, ...req }) + '\n');
    });
  }

  kill(reason?: 'disk' | 'memory'): void {
    if (this.exited) return;
    this.killReason ??= reason;
    this.child.kill('SIGKILL');
  }

  /** Settles the pending run with what was streamed so far plus `extra`, killing the worker when asked. */
  private finish(extra: Partial<WorkerRunResult>, kill: boolean): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    if (kill) this.kill();
    p.resolve({
      stdout: p.text.stdout,
      stderr: p.text.stderr,
      stdoutTotal: p.total.stdout,
      stderrTotal: p.total.stderr,
      results: [],
      resultsTotal: 0,
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

  /** Appends a run's output, capped here as well: a forged message never passed the worker's cap. */
  private append(p: Pending, stream: Stream, text: string, more: boolean): void {
    p.total[stream] += text.length;
    p.text[stream] += text.slice(0, Math.max(0, p.maxChars - p.text[stream].length));
    // The worker stopped sending at its cap; count at least one more character so the cut shows.
    if (more) p.total[stream] = Math.max(p.total[stream], p.text[stream].length + 1);
  }

  private onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // not ours: user code can write to the process's stdout directly
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const msg = parsed as Message;
    if (msg.type === 'ready') {
      this.readyWaiter?.resolve();
      this.readyWaiter = null;
      return;
    }
    const p = this.pending;
    if (!p || msg.id !== p.id) return;
    if (msg.type === 'out') {
      this.append(p, msg.stream === 'stderr' ? 'stderr' : 'stdout', typeof msg.text === 'string' ? msg.text : '', msg.more === true);
    } else if (msg.type === 'done') {
      const strings = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
      const error = msg.error as WorkerRunResult['error'] | undefined;
      const results = strings(msg.results);
      this.finish({
        stdoutTotal: Math.max(p.total.stdout, Number(msg.stdoutTotal) || 0),
        stderrTotal: Math.max(p.total.stderr, Number(msg.stderrTotal) || 0),
        results,
        resultsTotal: Math.max(results.join('').length, Number(msg.resultsTotal) || 0),
        images: strings(msg.images),
        imagesDropped: Number(msg.imagesDropped) || 0,
        ...(error && typeof error === 'object'
          ? { error: { name: String(error.name), value: String(error.value), traceback: String(error.traceback) } }
          : {}),
      }, false);
    }
  }

  private onExit(reason: string): void {
    if (this.exited) return;
    this.exited = true;
    const detail = this.stderrTail.trim() || reason;
    this.readyWaiter?.reject(new Error(`The Python worker failed to start: ${detail}`));
    this.readyWaiter = null;
    this.finish(this.killReason ? { stopped: this.killReason } : { stopped: 'crashed', crashDetail: detail }, false);
  }
}
