// The Sandbox MCP's tool bodies, with the vendor, Redis and the REST-token
// store injected so they run against fakes in tests. server.ts only registers
// them.
//
// Each user has one sandbox at a time (state.ts maps user → sandbox id in
// Redis), kept alive between calls and killed by the vendor after
// SANDBOX_IDLE_MINUTES without one. Every run gets a REST bearer of its own,
// minted before the run and revoked after it, so an idle sandbox never holds a
// working credential.
import { UserError } from 'fastmcp';
import { mintRestToken, revokeRestToken } from '../website/restTokenStore.js';
import { HELPER_PATH, HELPER_SOURCE } from './helper.js';
import { e2bProvider, type SandboxHandle, type SandboxLanguage, type SandboxProvider } from './provider.js';
import {
  chargeRun,
  chargeSeconds,
  clearSandboxId,
  getSandboxId,
  readUsage,
  sandboxKv,
  sandboxLimits,
  setSandboxId,
  withSandboxLock,
  type Kv,
} from './state.js';

export interface SandboxOpsDeps {
  provider: () => SandboxProvider | null;
  kv: () => Kv | null;
  mintToken: (userId: number, instanceId?: string) => Promise<{ token: string }>;
  revokeToken: (token: string) => Promise<void>;
  /** The platform's public base URL: the REST plane scripts call. */
  apiBase: () => string;
  now: () => number;
}

export const defaultSandboxOpsDeps: SandboxOpsDeps = {
  provider: e2bProvider,
  kv: sandboxKv,
  mintToken: mintRestToken,
  revokeToken: revokeRestToken,
  apiBase: () => (process.env.BASE_URL || 'http://localhost:8080').replace(/\/+$/, ''),
  now: () => Date.now(),
};

/** Package registries a script may reach besides our own API. */
const REGISTRY_HOSTS = ['pypi.org', 'files.pythonhosted.org', 'registry.npmjs.org'];

/** Output caps: what comes back must fit in the caller's context. */
const OUTPUT_CAP = 20_000;
const TRACEBACK_CAP = 5_000;
const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 1_500_000;
/** Lock TTL for calls that do not run code. */
const SHORT_LOCK_MS = 60_000;

interface Ready {
  uid: number;
  provider: SandboxProvider;
  kv: Kv;
}

/** Everything a call needs, or an error saying which part is missing. Never an empty answer. */
function ready(userId: number | undefined, deps: SandboxOpsDeps): Ready {
  if (typeof userId !== 'number') throw new UserError('The sandbox needs a signed-in user; this session has none.');
  const provider = deps.provider();
  if (!provider) throw new UserError('The sandbox is unavailable: this service has no E2B_API_KEY configured.');
  const kv = deps.kv();
  if (!kv) throw new UserError('The sandbox is unavailable: this service has no database/Redis connection (DATABASE_URL and REDIS_URL).');
  return { uid: userId, provider, kv };
}

/**
 * Runs a Redis step that guards spend. A failure there refuses the call
 * rather than running unmetered: an open counter spends our money.
 */
async function failClosed<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw kvRefusal(err);
  }
}

const kvRefusal = (err: unknown) =>
  new UserError(`The sandbox is refusing calls: its usage store (Redis) is unreachable (${(err as Error)?.message ?? err}). Try again shortly.`);

/**
 * fn under the user's sandbox lock. Only taking the lock fails closed; an
 * error from fn itself (a vendor failure, say) passes through as it is.
 */
async function lock<T>(r: Ready, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  let fromFn = false;
  try {
    return await withSandboxLock(r.kv, r.uid, ttlMs, async () => {
      try {
        return await fn();
      } catch (err) {
        fromFn = true;
        throw err;
      }
    });
  } catch (err) {
    if (fromFn || err instanceof UserError) throw err;
    throw kvRefusal(err);
  }
}

function allowOut(apiBase: string): string[] {
  try {
    return [new URL(apiBase).hostname, ...REGISTRY_HOSTS];
  } catch {
    return [...REGISTRY_HOSTS];
  }
}

const idleMs = () => sandboxLimits().idleMinutes * 60_000;

type SandboxState = 'new' | 'reused' | 'replaced';

const STATE_NOTE: Record<SandboxState, string | undefined> = {
  new: 'Started a new sandbox: no files or variables from earlier calls.',
  reused: undefined,
  replaced: 'Your previous sandbox had expired (idle timeout), so this is a new one: its files and variables are gone.',
};

/** The user's sandbox, created (with the API helper) when there is none or it has expired. */
async function acquire(r: Ready, deps: SandboxOpsDeps): Promise<{ handle: SandboxHandle; state: SandboxState }> {
  const id = await getSandboxId(r.kv, r.uid);
  if (id) {
    const handle = await r.provider.connect(id);
    if (handle) return { handle, state: 'reused' };
  }
  const handle = await r.provider.create({
    timeoutMs: idleMs(),
    allowOut: allowOut(deps.apiBase()),
    metadata: { userId: String(r.uid) },
  });
  try {
    await handle.writeFile(HELPER_PATH, HELPER_SOURCE);
    await setSandboxId(r.kv, r.uid, handle.id);
  } catch (err) {
    await r.provider.kill(handle.id).catch(() => {});
    throw err;
  }
  return { handle, state: id ? 'replaced' : 'new' };
}

/** The user's running sandbox, or a UserError saying there is none (never creates one). */
async function existing(r: Ready): Promise<SandboxHandle> {
  const id = await getSandboxId(r.kv, r.uid);
  const handle = id ? await r.provider.connect(id) : null;
  if (!handle) {
    throw new UserError(`No sandbox is running. One starts with the first runCode or writeFile, and stops after ${sandboxLimits().idleMinutes} idle minutes, taking its files with it.`);
  }
  return handle;
}

/** Text capped at `cap` characters, with the total when it was cut. */
class CappedText {
  private text = '';
  total = 0;
  constructor(private readonly cap: number) {}
  push(chunk: string): void {
    this.total += chunk.length;
    if (this.text.length < this.cap) this.text += chunk.slice(0, this.cap - this.text.length);
  }
  get value(): string {
    return this.text;
  }
  get truncated(): boolean {
    return this.total > this.text.length;
  }
}

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more characters]` : s);

const isNotFound = (err: unknown) => /NotFound/.test((err as { name?: string })?.name ?? '');

export interface ImageOut {
  data: string;
  mimeType: string;
}

export interface ToolOutput {
  json: Record<string, unknown>;
  images: ImageOut[];
}

// ---------------------------------------------------------------------------
// runCode
// ---------------------------------------------------------------------------

export async function opRunCode(
  userId: number | undefined,
  instanceId: string | undefined,
  args: { language: SandboxLanguage; code: string; timeoutSec: number },
  deps = defaultSandboxOpsDeps,
): Promise<ToolOutput> {
  const r = ready(userId, deps);
  const limits = sandboxLimits();
  const timeoutMs = Math.min(args.timeoutSec, limits.maxTimeoutSec) * 1000;

  return lock(r, timeoutMs + 60_000, async () => {
    const usage = await failClosed(() => chargeRun(r.kv, r.uid, deps.now()));
    const { handle, state } = await acquire(r, deps);
    // Room for this run on top of the idle timeout, so the vendor cannot kill
    // the sandbox mid-run; set back to the plain idle timeout afterwards.
    await handle.setTimeout(idleMs() + timeoutMs);

    const stdout = new CappedText(OUTPUT_CAP);
    const stderr = new CappedText(OUTPUT_CAP);
    const { token } = await deps.mintToken(r.uid, instanceId);
    const started = deps.now();
    let outcome: Awaited<ReturnType<SandboxHandle['runCode']>> | undefined;
    let timedOut = false;
    try {
      outcome = await handle.runCode(args.code, {
        language: args.language,
        envs: { AWESOME_API_BASE: deps.apiBase(), AWESOME_API_TOKEN: token },
        timeoutMs,
        onStdout: (t) => stdout.push(t),
        onStderr: (t) => stderr.push(t),
      });
    } catch (err) {
      if ((err as { name?: string })?.name !== 'TimeoutError') {
        throw new UserError(`The sandbox could not run the code: ${(err as Error)?.message ?? err}`);
      }
      timedOut = true;
    } finally {
      // Whatever happened, the token dies with the run and the time is charged.
      await deps.revokeToken(token).catch(() => {});
      const seconds = Math.max(1, Math.ceil((deps.now() - started) / 1000));
      await chargeSeconds(r.kv, r.uid, usage.day, seconds).catch(() => {});
      await handle.setTimeout(idleMs()).catch(() => {});
    }

    const durationMs = deps.now() - started;
    const images: ImageOut[] = [];
    const texts: string[] = [];
    let imagesDropped = 0;
    for (const result of outcome?.results ?? []) {
      const b64 = result.png ?? result.jpeg;
      if (b64) {
        if (images.length < MAX_IMAGES && b64.length * 0.75 <= MAX_IMAGE_BYTES) {
          images.push({ data: b64, mimeType: result.png ? 'image/png' : 'image/jpeg' });
        } else {
          imagesDropped++;
        }
      } else if (result.text) {
        texts.push(cap(result.text, OUTPUT_CAP));
      }
    }
    const truncated: Record<string, number> = {};
    if (stdout.truncated) truncated.stdoutTotalChars = stdout.total;
    if (stderr.truncated) truncated.stderrTotalChars = stderr.total;
    const used = await readUsage(r.kv, r.uid, deps.now()).catch(() => null);

    return {
      json: {
        sandbox: state,
        ...(STATE_NOTE[state] ? { note: STATE_NOTE[state] } : {}),
        durationMs,
        ...(timedOut ? { timedOut: `Stopped after ${timeoutMs / 1000} s. Output up to that point is below; raise timeoutSec (max ${limits.maxTimeoutSec}) or split the work.` } : {}),
        stdout: stdout.value,
        stderr: stderr.value,
        ...(Object.keys(truncated).length ? { truncated: { ...truncated, note: `Output is capped at ${OUTPUT_CAP} characters per stream: print a summary, or write the full output to a file and read the part you need.` } } : {}),
        ...(outcome?.error ? { error: { ...outcome.error, traceback: cap(outcome.error.traceback, TRACEBACK_CAP) } } : {}),
        ...(texts.length ? { results: texts } : {}),
        ...(images.length ? { images: images.length } : {}),
        ...(imagesDropped ? { imagesDropped: `${imagesDropped} image(s) not returned (more than ${MAX_IMAGES}, or over ${MAX_IMAGE_BYTES} bytes); save them to files instead.` } : {}),
        quota: used
          ? { runsToday: used.runs, runsPerDay: limits.maxRunsPerDay, secondsToday: used.seconds, secondsPerDay: limits.maxSecondsPerDay }
          : 'unknown (usage store unreachable)',
      },
      images,
    };
  });
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export async function opListFiles(userId: number | undefined, args: { path: string }, deps = defaultSandboxOpsDeps): Promise<ToolOutput> {
  const r = ready(userId, deps);
  return lock(r, SHORT_LOCK_MS, async () => {
    const handle = await existing(r);
    await handle.setTimeout(idleMs()).catch(() => {});
    try {
      const entries = await handle.listFiles(args.path);
      return { json: { path: args.path, count: entries.length, entries }, images: [] };
    } catch (err) {
      if (isNotFound(err)) throw new UserError(`No directory at ${args.path}.`);
      throw err;
    }
  });
}

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export async function opReadFile(
  userId: number | undefined,
  args: { path: string; maxChars: number },
  deps = defaultSandboxOpsDeps,
): Promise<ToolOutput> {
  const r = ready(userId, deps);
  return lock(r, SHORT_LOCK_MS, async () => {
    const handle = await existing(r);
    await handle.setTimeout(idleMs()).catch(() => {});
    let bytes: Uint8Array;
    try {
      bytes = await handle.readFile(args.path);
    } catch (err) {
      if (isNotFound(err)) throw new UserError(`No file at ${args.path}.`);
      throw err;
    }
    const mimeType = IMAGE_TYPES[args.path.split('.').pop()?.toLowerCase() ?? ''];
    if (mimeType && bytes.length <= MAX_IMAGE_BYTES) {
      return { json: { path: args.path, bytes: bytes.length, mimeType }, images: [{ data: Buffer.from(bytes).toString('base64'), mimeType }] };
    }
    let text: string | null = null;
    if (!mimeType && !bytes.subarray(0, 8192).includes(0)) {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        text = null;
      }
    }
    if (text === null) {
      return {
        json: {
          path: args.path,
          bytes: bytes.length,
          binary: true,
          note: 'Not returned: binary, or an image over the size limit. Process it in runCode, or upload it somewhere with a script (e.g. to Drive over the REST API).',
        },
        images: [],
      };
    }
    const shown = text.slice(0, args.maxChars);
    return {
      json: {
        path: args.path,
        bytes: bytes.length,
        chars: text.length,
        ...(shown.length < text.length ? { truncated: `Showing the first ${shown.length} of ${text.length} characters; raise maxChars (max 100000) or read a slice with runCode.` } : {}),
        content: shown,
      },
      images: [],
    };
  });
}

export async function opWriteFile(
  userId: number | undefined,
  args: { path: string; content: string },
  deps = defaultSandboxOpsDeps,
): Promise<ToolOutput> {
  const r = ready(userId, deps);
  return lock(r, SHORT_LOCK_MS, async () => {
    const { handle, state } = await acquire(r, deps);
    await handle.writeFile(args.path, args.content);
    await handle.setTimeout(idleMs()).catch(() => {});
    return {
      json: {
        written: args.path,
        bytes: Buffer.byteLength(args.content, 'utf8'),
        sandbox: state,
        ...(STATE_NOTE[state] ? { note: STATE_NOTE[state] } : {}),
      },
      images: [],
    };
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function opSandboxStatus(userId: number | undefined, deps = defaultSandboxOpsDeps): Promise<ToolOutput> {
  const r = ready(userId, deps);
  const limits = sandboxLimits();
  const id = await failClosed(() => getSandboxId(r.kv, r.uid));
  const endsAt = id ? await r.provider.endsAt(id) : null;
  const usage = await failClosed(() => readUsage(r.kv, r.uid, deps.now()));
  return {
    json: {
      running: endsAt !== null,
      ...(endsAt ? { stopsIfIdleAt: endsAt.toISOString(), minutesLeft: Math.max(0, Math.round((endsAt.getTime() - deps.now()) / 60_000)) } : {}),
      idleMinutes: limits.idleMinutes,
      quota: {
        day: usage.day,
        runsToday: usage.runs,
        runsPerDay: limits.maxRunsPerDay,
        secondsToday: usage.seconds,
        secondsPerDay: limits.maxSecondsPerDay,
        maxTimeoutSec: limits.maxTimeoutSec,
      },
    },
    images: [],
  };
}

export async function opResetSandbox(userId: number | undefined, deps = defaultSandboxOpsDeps): Promise<ToolOutput> {
  const r = ready(userId, deps);
  return lock(r, SHORT_LOCK_MS, async () => {
    const id = await getSandboxId(r.kv, r.uid);
    let killed = false;
    if (id) {
      killed = (await r.provider.endsAt(id)) !== null;
      if (killed) await r.provider.kill(id);
      await clearSandboxId(r.kv, r.uid);
    }
    return {
      json: killed
        ? { reset: true, note: 'The sandbox was stopped; its files and variables are gone. The next runCode starts a new one.' }
        : { reset: false, note: 'No sandbox was running; the next runCode starts a new one.' },
      images: [],
    };
  });
}
