// The sandbox engine behind one small interface, so ops.ts runs against a fake
// in tests. engine.ts picks the implementation: the runner service over HTTP
// (runner/client.ts) or the worker pool in this process (runner/pool.ts).
// No imports, so both sides of the runner can share it.

export type SandboxLanguage = 'python' | 'javascript';

export interface RunOptions {
  language: SandboxLanguage;
  envs: Record<string, string>;
  timeoutMs: number;
  /** stdout and stderr are each cut to this many characters; the totals are still counted. */
  maxOutputChars: number;
}

export interface RunOutcome {
  stdout: string;
  stderr: string;
  /** Characters printed, of which stdout/stderr hold the first maxOutputChars. */
  stdoutTotal: number;
  stderrTotal: number;
  /** repr() of the last expression (Python) or the returned value (JavaScript). */
  results: string[];
  /** Base64 PNGs: matplotlib figures left open at the end of a Python run. */
  images: string[];
  imagesDropped: number;
  error?: { name: string; value: string; traceback: string };
  /** The interpreter was stopped during the run (files are kept, variables are gone). */
  stopped?: 'timeout' | 'crashed' | 'disk';
  /** Why it crashed, when it did. */
  crashDetail?: string;
  /** This run needed a new interpreter after earlier runs: their variables are gone. */
  restarted: boolean;
}

export interface SandboxEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'other';
  size: number;
}

export interface FileRead {
  /** The file's first bytes: all of it when `size` <= maxBytes. */
  bytes: Uint8Array;
  /** The whole file's size. */
  size: number;
}

export interface SandboxHandle {
  readonly id: string;
  runCode(code: string, opts: RunOptions): Promise<RunOutcome>;
  /** At most maxBytes of the file, so a huge file is not copied to show a little of it. */
  readFile(path: string, maxBytes: number): Promise<FileRead>;
  writeFile(path: string, content: string): Promise<void>;
  listFiles(path: string): Promise<SandboxEntry[]>;
  /** Sets the time left before the sandbox is stopped and its files deleted, counted from now. */
  setTimeout(timeoutMs: number): Promise<void>;
}

export interface CreateOptions {
  timeoutMs: number;
  /** host[:port] entries the code may reach; everything else is denied. */
  allowNet: string[];
  userId: number;
}

export interface SandboxProvider {
  create(opts: CreateOptions): Promise<SandboxHandle>;
  /** The sandbox, or null when it has expired or been stopped. */
  connect(id: string): Promise<SandboxHandle | null>;
  /** When it will be stopped if left idle, or null when it is gone. */
  endsAt(id: string): Promise<Date | null>;
  kill(id: string): Promise<void>;
}

/**
 * A refusal meant for the caller as it is (capacity, disk quota, a path
 * outside /home/user). ops.ts turns it into a UserError; the runner service
 * answers it as a 4xx carrying the message, and its client throws it again.
 */
export class SandboxRefusal extends Error {
  override name = 'SandboxRefusal';
}

/** A missing file, directory or sandbox: ops.ts matches the name. */
export class SandboxNotFound extends Error {
  override name = 'NotFoundError';
}
