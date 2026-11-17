// The Sandbox MCP service's side of the runner: SandboxProvider over the
// runner's HTTP API (server.ts). A 404 comes back as SandboxNotFound and a 409
// as SandboxRefusal, so ops.ts sees the same errors as from the pool itself.
import { SandboxNotFound, SandboxRefusal, type SandboxHandle, type SandboxProvider } from '../provider.js';

/** Every call but a run. */
const CALL_TIMEOUT_MS = 30_000;
/** A run's request outlives the run: starting the worker (up to 60 s) and the answer. */
const RUN_MARGIN_MS = 90_000;

export function runnerClient(baseUrl: string, secret: string): SandboxProvider {
  const base = baseUrl.replace(/\/+$/, '');

  async function call<T>(method: string, path: string, body?: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
    let res: globalThis.Response;
    try {
      res = await fetch(base + path, {
        method,
        headers: { Authorization: `Bearer ${secret}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(`The sandbox runner could not be reached (${(err as Error)?.message ?? err}).`);
    }
    if (res.status === 204) return undefined as T;
    if (res.ok) {
      try {
        return (await res.json()) as T;
      } catch (err) {
        throw new Error(`The sandbox runner sent an unreadable answer (${(err as Error)?.message ?? err}).`);
      }
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    const message = data.error ?? `The sandbox runner answered ${res.status}.`;
    if (res.status === 404) throw new SandboxNotFound(message);
    if (res.status === 409) throw new SandboxRefusal(message);
    throw new Error(`The sandbox runner failed (${res.status}): ${message}`);
  }

  const q = (params: Record<string, string | number>) =>
    new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();

  function handle(id: string): SandboxHandle {
    const at = `/sandboxes/${encodeURIComponent(id)}`;
    return {
      id,
      runCode: (code, opts) => call('POST', `${at}/run`, { code, ...opts }, opts.timeoutMs + RUN_MARGIN_MS),
      async readFile(path, maxBytes) {
        const file = await call<{ size: number; data: string }>('GET', `${at}/file?${q({ path, maxBytes })}`);
        return { size: file.size, bytes: new Uint8Array(Buffer.from(file.data, 'base64')) };
      },
      writeFile: (path, content) => call('PUT', `${at}/file`, { path, content }),
      listFiles: async (path) => (await call<{ entries: Awaited<ReturnType<SandboxHandle['listFiles']>> }>('GET', `${at}/files?${q({ path })}`)).entries,
      setTimeout: (timeoutMs) => call('POST', `${at}/timeout`, { timeoutMs }),
    };
  }

  /** The value, or null when the runner says the sandbox is gone. */
  async function unlessGone<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SandboxNotFound) return null;
      throw err;
    }
  }

  return {
    create: async (opts) => handle((await call<{ id: string }>('POST', '/sandboxes', opts)).id),
    connect: (id) => unlessGone(async () => (await call('GET', `/sandboxes/${encodeURIComponent(id)}`), handle(id))),
    endsAt: (id) => unlessGone(async () => new Date((await call<{ endsAt: string }>('GET', `/sandboxes/${encodeURIComponent(id)}`)).endsAt)),
    kill: (id) => call('DELETE', `/sandboxes/${encodeURIComponent(id)}`),
  };
}
