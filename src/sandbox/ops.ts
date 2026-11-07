// The Sandbox MCP's tool bodies, with the vendor, Redis and the REST-token
// store injected so they run against fakes in tests. server.ts only registers
// them.
//
// Each user has one sandbox at a time (state.ts maps user → sandbox id in
// Redis), kept between calls and stopped by the runner after
// SANDBOX_IDLE_MINUTES without a run. Every run gets a REST bearer of its own,
// minted before the run and revoked after it, so an idle sandbox never holds a
// working credential.
import { UserError } from 'fastmcp';
import { mintRestToken, revokeRestToken } from '../website/restTokenStore.js';
import { sandboxProvider } from './engine.js';
import type { FileRead, RunOutcome, SandboxHandle, SandboxLanguage, SandboxProvider } from './provider.js';
import {
  clearSandboxId,
  getSandboxId,
  readUsage,
  reserveRun,
  sandboxKv,
  sandboxLimits,
  setSandboxId,
  settleSeconds,
  withSandboxLock,
  type Kv,
  type SandboxLease,
} from './state.js';

export interface SandboxOpsDeps {
  provider: () => SandboxProvider | null;
  kv: () => Kv | null;
  mintToken: (userId: number, instanceId: string | undefined, ttlSeconds: number) => Promise<{ token: string; expiresAt?: number }>;
  revokeToken: (token: string) => Promise<void>;
  /** The platform's public base URL: the REST plane scripts call. */
  apiBase: () => string;
  now: () => number;
}

export const defaultSandboxOpsDeps: SandboxOpsDeps = {
  provider: () => sandboxProvider(),
  kv: sandboxKv,
  mintToken: mintRestToken,
  revokeToken: revokeRestToken,
  apiBase: () => (process.env.BASE_URL || 'http://localhost:8080').replace(/\/+$/, ''),
  now: () => Date.now(),
};

/** PyPI, for micropip, is all a script may reach besides our own API. */
const REGISTRY_HOSTS = ['pypi.org', 'files.pythonhosted.org'];

/** Output caps: what comes back must fit in the caller's context. */
const OUTPUT_CAP = 20_000;
const TRACEBACK_CAP = 5_000;
const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 1_500_000;
/** Lock TTL for calls that do not run code. */
const SHORT_LOCK_MS = 60_000;
/** Lock time beyond the run itself: starting the interpreter (up to 60 s), and cleaning up after. */
const LOCK_MARGIN_MS = 90_000;
/** listFiles shows at most this many entries, with the total. */
const MAX_LIST_ENTRIES = 500;
const CRASH_DETAIL_CAP = 500;
/** The run's bearer outlives its timeout by this much, so a call dispatched near the end is not refused. */
const TOKEN_MARGIN_SEC = 30;
/** And by the interpreter's start (the runner's limit for it), since the token is minted before a cold start. */
const WORKER_START_SEC = 60;
const REVOKE_ATTEMPTS = 3;

interface Ready {
  uid: number;
  provider: SandboxProvider;
  kv: Kv;
}

/** Everything a call needs, or an error saying which part is missing. Never an empty answer. */
function ready(userId: number | undefined, deps: SandboxOpsDeps): Ready {
  if (typeof userId !== 'number') throw new UserError('The sandbox needs a signed-in user; this session has none.');
  const provider = deps.provider();
  if (!provider) {
    throw new UserError('The sandbox is unavailable: this service has no sandbox runner configured (SANDBOX_RUNNER_URL with SANDBOX_RUNNER_SECRET, or SANDBOX_RUNNER=local for development).');
  }
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

/** A refusal the engine words for the caller (capacity, disk limit, a path outside /home/user). */
const asUserError = (err: unknown) => ((err as Error)?.name === 'SandboxRefusal' ? new UserError((err as Error).message) : err);

/**
 * fn under the user's sandbox lock. Only taking the lock fails closed; an
 * error from fn itself (the runner failing, say) passes through as it is.
 */
async function lock<T>(r: Ready, ttlMs: number, fn: (lease: SandboxLease) => Promise<T>): Promise<T> {
  let fromFn = false;
  try {
    return await withSandboxLock(r.kv, r.uid, ttlMs, async (lease) => {
      try {
        return await fn(lease);
      } catch (err) {
        fromFn = true;
        throw asUserError(err);
      }
    });
  } catch (err) {
    if (fromFn || err instanceof UserError) throw err;
    throw kvRefusal(err);
  }
}

/** host[:port] entries: the port only when BASE_URL names one, as on localhost. */
function allowNet(apiBase: string): string[] {
  try {
    return [new URL(apiBase).host, ...REGISTRY_HOSTS];
  } catch {
    return [...REGISTRY_HOSTS];
  }
}

const idleMs = () => sandboxLimits().idleMinutes * 60_000;

type SandboxState = 'new' | 'reused' | 'replaced';

const STATE_NOTE: Record<SandboxState, string | undefined> = {
  new: 'Started a new sandbox: no files or variables from earlier calls.',
  reused: undefined,
  replaced: 'Your previous sandbox had stopped (idle timeout, or the runner restarted), so this is a new one: its files and variables are gone.',
};

/** The user's sandbox, created when there is none or it has stopped. */
async function acquire(r: Ready, deps: SandboxOpsDeps): Promise<{ handle: SandboxHandle; state: SandboxState }> {
  const id = await getSandboxId(r.kv, r.uid);
  if (id) {
    const handle = await r.provider.connect(id);
    if (handle) return { handle, state: 'reused' };
  }
  const handle = await r.provider.create({ timeoutMs: idleMs(), allowNet: allowNet(deps.apiBase()), userId: r.uid });
  try {
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

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more characters]` : s);

/** Kills the sandbox and forgets it. False when the kill failed, so the caller does not claim it. */
async function stopSandbox(r: Ready, id: string): Promise<boolean> {
  try {
    await r.provider.kill(id);
  } catch {
    return false;
  }
  await clearSandboxId(r.kv, r.uid).catch(() => {});
  return true;
}

/** Revokes the run's bearer, retrying: true once it is gone. */
async function revoke(token: string, deps: SandboxOpsDeps): Promise<boolean> {
  for (let i = 0; i < REVOKE_ATTEMPTS; i++) {
    try {
      await deps.revokeToken(token);
      return true;
    } catch {
      // try again
    }
  }
  return false;
}

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
  const wantSec = Math.min(args.timeoutSec, limits.maxTimeoutSec);

  return lock(r, wantSec * 1000 + LOCK_MARGIN_MS, async (lease) => {
    const quota = await failClosed(() => reserveRun(r.kv, r.uid, deps.now(), wantSec));
    // The seconds were reserved up front; settle to the time actually used.
    // A failure there leaves the user over-charged, never under.
    const meter = { usedSec: 0, settled: false };
    const settle = async () => {
      meter.settled = true;
      await settleSeconds(r.kv, r.uid, quota.day, quota.grantedSec, meter.usedSec).catch(() => {});
    };
    try {
      const out = await runReserved(r, instanceId, args, quota.grantedSec, lease, meter, deps);
      await settle();
      if (quota.grantedSec < wantSec) {
        out.notes.unshift(`timeoutSec was cut to ${quota.grantedSec} s: that is what was left of today's ${limits.maxSecondsPerDay} s of run time.`);
      }
      const used = await readUsage(r.kv, r.uid, deps.now()).catch(() => null);
      return {
        json: {
          ...out.json,
          ...(out.notes.length ? { notes: out.notes } : {}),
          quota: used
            ? { runsToday: used.runs, runsPerDay: limits.maxRunsPerDay, secondsToday: used.seconds, secondsPerDay: limits.maxSecondsPerDay }
            : 'unknown (usage store unreachable)',
        },
        images: out.images,
      };
    } finally {
      if (!meter.settled) await settle();
    }
  });
}

const PREVIOUS_STOP: Record<NonNullable<RunOutcome['previousStop']>, string> = {
  disk: 'it was stopped because /home/user went over its disk limit',
  memory: 'it was stopped for using more memory than a sandbox may',
  background: 'it was stopped because code left running after a run kept using CPU (finish all work before a run returns)',
  evicted: 'it was stopped to make room for another user',
};

/** What the runner reports about stopping or restarting the interpreter, as notes for the caller. */
function interpreterNotes(outcome: RunOutcome): string[] {
  const notes: string[] = [];
  if (outcome.restarted) {
    const why = outcome.previousStop ? PREVIOUS_STOP[outcome.previousStop] : 'the previous one had been stopped';
    notes.push(`This run started a new Python/JavaScript interpreter (${why}): variables from earlier runs are gone; files are kept.`);
  }
  if (outcome.stopped === 'crashed') {
    notes.push(`The interpreter crashed and was stopped${outcome.crashDetail ? ` (${cap(outcome.crashDetail, CRASH_DETAIL_CAP)})` : ''}: variables are gone; files are kept.`);
  } else if (outcome.stopped === 'disk') {
    notes.push('The run was stopped: /home/user went over its disk limit. Variables are gone; delete files to get back under the limit.');
  } else if (outcome.stopped === 'memory') {
    notes.push('The run was stopped for using more memory than a sandbox may. Variables are gone; files are kept. Process the data in chunks.');
  }
  return notes;
}

/** One run inside its lock and reservation: everything from acquiring the sandbox to shaping the output. */
async function runReserved(
  r: Ready,
  instanceId: string | undefined,
  args: { language: SandboxLanguage; code: string },
  grantedSec: number,
  lease: SandboxLease,
  meter: { usedSec: number },
  deps: SandboxOpsDeps,
): Promise<{ json: Record<string, unknown>; images: ImageOut[]; notes: string[] }> {
  const timeoutMs = grantedSec * 1000;
  const { handle, state } = await acquire(r, deps);
  // Fencing: if creating the sandbox outlasted the lease, another call may hold
  // the lock now, and this one must not run alongside it.
  await failClosed(() => lease.renew(timeoutMs + LOCK_MARGIN_MS));
  // Room for this run on top of the idle timeout, so the runner cannot stop
  // the sandbox mid-run; set back to the plain idle timeout afterwards.
  await handle.setTimeout(idleMs() + timeoutMs);

  const notes: string[] = [];
  const { token, expiresAt } = await deps.mintToken(r.uid, instanceId, grantedSec + WORKER_START_SEC + TOKEN_MARGIN_SEC);
  const started = deps.now();
  let outcome: RunOutcome;
  let gone = false;
  try {
    // A timeout is not an error here: the runner kills the interpreter and
    // answers with what was printed until then.
    outcome = await handle.runCode(args.code, {
      language: args.language,
      envs: { AWESOME_API_BASE: deps.apiBase(), AWESOME_API_TOKEN: token },
      timeoutMs,
      maxOutputChars: OUTPUT_CAP,
    });
  } catch (err) {
    if ((err as Error)?.name === 'SandboxRefusal') throw asUserError(err);
    throw new UserError(`The sandbox could not run the code: ${(err as Error)?.message ?? err}`);
  } finally {
    meter.usedSec = Math.max(1, Math.ceil((deps.now() - started) / 1000));
    // Whatever happened, the token dies with the run. If the token store will
    // not delete it, the sandbox (the only place it was handed) goes instead.
    if (!(await revoke(token, deps))) {
      gone = await stopSandbox(r, handle.id);
      notes.push(gone
        ? 'The run\'s API token could not be revoked, so the sandbox was stopped instead: its files and variables are gone.'
        : `The run's API token could not be revoked, and stopping the sandbox failed too; the token expires on its own${expiresAt ? ` at ${new Date(expiresAt).toISOString()}` : ''}.`);
    }
  }
  notes.push(...interpreterNotes(outcome));
  if (!gone) await handle.setTimeout(idleMs()).catch(() => {});

  const images: ImageOut[] = [];
  let imagesDropped = outcome.imagesDropped;
  for (const png of outcome.images) {
    if (images.length < MAX_IMAGES && png.length * 0.75 <= MAX_IMAGE_BYTES) images.push({ data: png, mimeType: 'image/png' });
    else imagesDropped++;
  }
  // One budget for all text results, like each stream has one.
  const texts: string[] = [];
  let resultChars = 0;
  let resultTotal = 0;
  for (const text of outcome.results) {
    resultTotal += text.length;
    const shown = text.slice(0, OUTPUT_CAP - resultChars);
    if (shown) texts.push(shown);
    resultChars += shown.length;
  }
  const truncated: Record<string, number> = {};
  if (outcome.stdoutTotal > outcome.stdout.length) truncated.stdoutTotalChars = outcome.stdoutTotal;
  if (outcome.stderrTotal > outcome.stderr.length) truncated.stderrTotalChars = outcome.stderrTotal;
  // The runner already cut the results to the same budget; resultsTotal is what there was.
  resultTotal = Math.max(resultTotal, outcome.resultsTotal ?? 0);
  if (resultTotal > resultChars) truncated.resultsTotalChars = resultTotal;
  const timedOut = outcome.stopped === 'timeout';

  return {
    json: {
      sandbox: state,
      ...(STATE_NOTE[state] ? { note: STATE_NOTE[state] } : {}),
      durationMs: deps.now() - started,
      ...(timedOut ? { timedOut: `Stopped after ${grantedSec} s, and the interpreter was restarted: variables are gone, files are kept. Output up to that point is below; raise timeoutSec (max ${sandboxLimits().maxTimeoutSec}) or split the work.` } : {}),
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      ...(Object.keys(truncated).length ? { truncated: { ...truncated, note: `Output is capped at ${OUTPUT_CAP} characters each for stdout, stderr and results: print a summary, or write the full output to a file and read the part you need.` } } : {}),
      ...(outcome.error ? { error: { ...outcome.error, traceback: cap(outcome.error.traceback, TRACEBACK_CAP) } } : {}),
      ...(texts.length ? { results: texts } : {}),
      ...(images.length ? { images: images.length } : {}),
      ...(imagesDropped ? { imagesDropped: `${imagesDropped} image(s) not returned (more than ${MAX_IMAGES}, or over ${MAX_IMAGE_BYTES} bytes); save them to files instead.` } : {}),
    },
    images,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export async function opListFiles(userId: number | undefined, args: { path: string }, deps = defaultSandboxOpsDeps): Promise<ToolOutput> {
  const r = ready(userId, deps);
  return lock(r, SHORT_LOCK_MS, async () => {
    const handle = await existing(r);
    try {
      const entries = await handle.listFiles(args.path);
      return {
        json: {
          path: args.path,
          count: entries.length,
          entries: entries.slice(0, MAX_LIST_ENTRIES),
          ...(entries.length > MAX_LIST_ENTRIES ? { truncated: `Showing ${MAX_LIST_ENTRIES} of ${entries.length} entries; list a subdirectory, or summarize with runCode.` } : {}),
        },
        images: [],
      };
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
    const mimeType = IMAGE_TYPES[args.path.split('.').pop()?.toLowerCase() ?? ''];
    let file: FileRead;
    try {
      // Only what can be shown: a UTF-8 character is at most 4 bytes.
      file = await handle.readFile(args.path, mimeType ? MAX_IMAGE_BYTES : args.maxChars * 4);
    } catch (err) {
      if (isNotFound(err)) throw new UserError(`No file at ${args.path}.`);
      throw err;
    }
    const { bytes, size } = file;
    const partial = bytes.length < size;
    if (mimeType && !partial) {
      return { json: { path: args.path, bytes: size, mimeType }, images: [{ data: Buffer.from(bytes).toString('base64'), mimeType }] };
    }
    let text: string | null = null;
    if (!mimeType && !bytes.subarray(0, 8192).includes(0)) {
      try {
        // stream: a cut-off read may end mid-character; that tail is held back, not an error.
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: partial });
      } catch {
        text = null;
      }
    }
    if (text === null) {
      return {
        json: {
          path: args.path,
          bytes: size,
          binary: true,
          note: 'Not returned: binary, or an image over the size limit. Process it in runCode, or upload it somewhere with a script (e.g. to Drive over the REST API).',
        },
        images: [],
      };
    }
    const shown = text.slice(0, args.maxChars);
    const more = 'raise maxChars (max 100000) or read a slice with runCode.';
    return {
      json: {
        path: args.path,
        bytes: size,
        ...(partial ? {} : { chars: text.length }),
        ...(partial
          ? { truncated: `Showing the first ${shown.length} characters of a ${size}-byte file; ${more}` }
          : shown.length < text.length ? { truncated: `Showing the first ${shown.length} of ${text.length} characters; ${more}` } : {}),
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
    // Not extended here: only runCode, which is metered, keeps a sandbox alive.
    const { handle, state } = await acquire(r, deps);
    await handle.writeFile(args.path, args.content);
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
