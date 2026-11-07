// The sandbox vendor behind one small interface, so ops.ts is testable with a
// fake and the vendor can be swapped. This is the only file that imports the
// E2B SDK.
//
// E2B: Firecracker microVMs billed per second. The code-interpreter template
// keeps a live Jupyter kernel per language, so variables survive between
// runCode calls on the same sandbox — which is what the per-user session in
// session.ts relies on.
import { Sandbox } from '@e2b/code-interpreter';

export type SandboxLanguage = 'python' | 'javascript' | 'bash';

export interface RunOptions {
  language: SandboxLanguage;
  envs: Record<string, string>;
  timeoutMs: number;
  /** Streamed output, so a run that times out still reports what it printed. */
  onStdout: (text: string) => void;
  onStderr: (text: string) => void;
}

export interface RunOutcome {
  /** Rich results (the last expression, display() calls, plots). */
  results: Array<{ text?: string; png?: string; jpeg?: string }>;
  error?: { name: string; value: string; traceback: string };
}

export interface SandboxEntry {
  name: string;
  path: string;
  type: string;
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
  /**
   * Stops whatever the language's kernel is still running by restarting it
   * (variables go, files stay). False when no kernel for the language was
   * found to restart, so the caller cannot claim the run stopped.
   */
  interrupt(language: SandboxLanguage): Promise<boolean>;
  /** At most maxBytes of the file, so a huge file is not downloaded to show a little of it. */
  readFile(path: string, maxBytes: number): Promise<FileRead>;
  writeFile(path: string, content: string): Promise<void>;
  listFiles(path: string): Promise<SandboxEntry[]>;
  /** Sets the time left before the vendor kills the sandbox, counted from now. */
  setTimeout(timeoutMs: number): Promise<void>;
}

export interface CreateOptions {
  timeoutMs: number;
  /** Hostnames the sandbox may reach; everything else is denied. */
  allowOut: string[];
  metadata: Record<string, string>;
}

export interface SandboxProvider {
  create(opts: CreateOptions): Promise<SandboxHandle>;
  /** The running sandbox, or null when it has expired or been killed. */
  connect(id: string): Promise<SandboxHandle | null>;
  /** When the vendor will kill it, or null when it is gone. */
  endsAt(id: string): Promise<Date | null>;
  kill(id: string): Promise<void>;
}

/** Room for the HTTP request around a run, beyond the run's own timeout. */
const REQUEST_MARGIN_MS = 15_000;

/** The SDK's "no such sandbox", which a deprecated parent class still covers. */
const isNotFound = (err: unknown): boolean => /NotFound/.test((err as { name?: string })?.name ?? '');

/** The first maxBytes of a stream; the rest is never downloaded. */
export async function readPrefix(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const out = new Uint8Array(maxBytes);
  let filled = 0;
  try {
    while (filled < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, maxBytes - filled);
      out.set(value.subarray(0, take), filled);
      filled += take;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out.subarray(0, filled);
}

function wrap(sandbox: Sandbox): SandboxHandle {
  return {
    id: sandbox.sandboxId,
    async runCode(code, opts) {
      const execution = await sandbox.runCode(code, {
        language: opts.language,
        envs: opts.envs,
        timeoutMs: opts.timeoutMs,
        // The request must outlive the run, or a long run fails at the
        // SDK's 30 s request default with the code still executing.
        requestTimeoutMs: opts.timeoutMs + REQUEST_MARGIN_MS,
        onStdout: (m) => opts.onStdout(m.line),
        onStderr: (m) => opts.onStderr(m.line),
      });
      return {
        results: execution.results.map((r) => ({ text: r.text, png: r.png, jpeg: r.jpeg })),
        error: execution.error
          ? { name: execution.error.name, value: execution.error.value, traceback: execution.error.traceback }
          : undefined,
      };
    },
    async interrupt(language) {
      // UNVERIFIED live: the context language names are assumed to be the
      // runCode ones (plus 'js'). No match is reported, never guessed.
      const names = language === 'javascript' ? ['javascript', 'js'] : [language];
      const contexts = (await sandbox.listCodeContexts()).filter((c) => names.includes(c.language));
      for (const context of contexts) await sandbox.restartCodeContext(context);
      return contexts.length > 0;
    },
    async readFile(path, maxBytes) {
      const { size } = await sandbox.files.getInfo(path);
      if (size <= maxBytes) return { bytes: await sandbox.files.read(path, { format: 'bytes' }), size };
      return { bytes: await readPrefix(await sandbox.files.read(path, { format: 'stream' }), maxBytes), size };
    },
    async writeFile(path, content) {
      await sandbox.files.write(path, content);
    },
    async listFiles(path) {
      const entries = await sandbox.files.list(path);
      return entries.map((e) => ({ name: e.name, path: e.path, type: String(e.type), size: e.size }));
    },
    setTimeout: (timeoutMs) => sandbox.setTimeout(timeoutMs),
  };
}

/** The E2B provider, or null when E2B_API_KEY is unset. */
export function e2bProvider(): SandboxProvider | null {
  const apiKey = process.env.E2B_API_KEY;
  if (!apiKey) return null;
  return {
    async create(opts) {
      const sandbox = await Sandbox.create({
        apiKey,
        timeoutMs: opts.timeoutMs,
        metadata: opts.metadata,
        network: { allowOut: opts.allowOut, denyOut: ['0.0.0.0/0'] },
      });
      return wrap(sandbox);
    },
    async connect(id) {
      try {
        return wrap(await Sandbox.connect(id, { apiKey }));
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async endsAt(id) {
      try {
        const info = await Sandbox.getInfo(id, { apiKey });
        return info.endAt ?? null;
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async kill(id) {
      await Sandbox.kill(id, { apiKey });
    },
  };
}
