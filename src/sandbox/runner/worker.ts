// One user's Python (and JavaScript), run by Deno — never Node: Node 20 has no
// network permission, so Python's `js` bridge could reach any host from it.
// The pool (pool.ts) starts this with an empty environment, read access to
// Pyodide, its bundled packages and the user's directory only, write access to
// that directory, the network allowlist, and a cap on WebAssembly memory.
// Everything here runs inside those permissions, the user's code included:
// Python reaches JavaScript through pyodide's `js` module, so nothing in this
// file is hidden from it, and it relies on nothing being hidden.
//
// Protocol, one JSON object per line on stdin/stdout. In:
// {id, language, code, envs, maxOutputChars}. Out: {type:'ready'} once, then
// for each request any number of {id, type:'out', stream, text} (up to
// maxOutputChars per stream; the rest is only counted) and one
// {id, type:'done', ...WorkerResult}. Requests run one at a time.
//
// It has no imports, so Deno runs it from src (.ts) or dist (.js) alike.

declare const Deno: {
  args: string[];
  stdin: { read(buffer: Uint8Array): Promise<number | null> };
  stdout: { writeSync(data: Uint8Array): number };
  inspect(value: unknown, options?: { depth?: number }): string;
  exit(code?: number): never;
};

interface PyodideApi {
  FS: { mkdirTree(path: string): void };
  mountNodeFS(emscriptenPath: string, hostPath: string): void;
  runPython(code: string): unknown;
  runPythonAsync(code: string): Promise<unknown>;
  globals: { get(name: string): (...args: unknown[]) => Promise<string> };
  setStdout(options: { write: (buffer: Uint8Array) => number }): void;
  setStderr(options: { write: (buffer: Uint8Array) => number }): void;
  loadPackage(names: string[], options?: { messageCallback?: (m: string) => void; errorCallback?: (m: string) => void }): Promise<unknown>;
  loadPackagesFromImports(code: string, options?: { messageCallback?: (m: string) => void; errorCallback?: (m: string) => void }): Promise<unknown>;
}

interface WorkerConfig {
  /** 'prefetch' downloads `packages` into packageDir and exits (image build time). */
  mode: 'serve' | 'prefetch';
  pyodideDir: string;
  packageDir: string;
  /** The user's directory on the host, mounted as /home/user. */
  homeDir?: string;
  packages: string[];
  maxImages: number;
  maxImageBytes: number;
}

type Stream = 'stdout' | 'stderr';

const config = JSON.parse(Deno.args[0]) as WorkerConfig;
// Taken before any user code runs, so code that replaces the globals later
// does not see or rewrite this worker's own messages. Hardening only: the
// pool's watchdog, outside this process, is what bounds a misbehaving run.
const encoder = new TextEncoder();
const encode = encoder.encode.bind(encoder);
const stringify = JSON.stringify;
const parse = JSON.parse;
const writeSync = Deno.stdout.writeSync.bind(Deno.stdout);

function send(message: unknown): void {
  const bytes = encode(stringify(message) + '\n');
  // A pipe may take less than all of it at once.
  for (let off = 0; off < bytes.length;) off += writeSync(bytes.subarray(off));
}

const { loadPyodide } = (await import(`file://${encodeURI(config.pyodideDir)}/pyodide.mjs`)) as {
  loadPyodide(options: object): Promise<PyodideApi>;
};
const py = await loadPyodide({
  indexURL: `${config.pyodideDir}/`,
  packageCacheDir: config.packageDir,
  // matplotlib's config goes to the in-memory /tmp, not the user's files.
  env: { HOME: '/home/user', MPLBACKEND: 'Agg', MPLCONFIGDIR: '/tmp/matplotlib' },
});

if (config.mode === 'prefetch') {
  const failed: string[] = [];
  await py.loadPackage(config.packages, { messageCallback: (m) => console.log(m), errorCallback: (m) => failed.push(m) });
  if (failed.length) {
    console.error(failed.join('\n'));
    Deno.exit(1);
  }
  Deno.exit(0);
}

// The run in progress: where output goes, and how much of it has been sent.
let current: { id: string; maxChars: number; sent: Record<Stream, number>; total: Record<Stream, number> } | null = null;

function emit(stream: Stream, text: string): void {
  if (!current || !text) return;
  const before = current.total[stream];
  current.total[stream] += text.length;
  const room = current.maxChars - current.sent[stream];
  if (room > 0) {
    const part = text.slice(0, room);
    current.sent[stream] += part.length;
    send({ id: current.id, type: 'out', stream, text: part });
  }
  // Once, as the cap is passed: a run killed before `done` still shows its output was cut.
  if (current.total[stream] > current.maxChars && before <= current.maxChars) {
    send({ id: current.id, type: 'out', stream, text: '', more: true });
  }
}

/** The results within one budget of max characters, and their full length. */
function capResults(results: string[], max: number): { results: string[]; resultsTotal: number } {
  const kept: string[] = [];
  let used = 0;
  let total = 0;
  for (const r of results) {
    total += r.length;
    const part = r.slice(0, Math.max(0, max - used));
    if (part) kept.push(part);
    used += part.length;
  }
  return { results: kept, resultsTotal: total };
}

const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
py.setStdout({ write: (b) => (emit('stdout', decoders.stdout.decode(b, { stream: true })), b.length) });
py.setStderr({ write: (b) => (emit('stderr', decoders.stderr.decode(b, { stream: true })), b.length) });
const show = (args: unknown[]) => args.map((a) => (typeof a === 'string' ? a : Deno.inspect(a, { depth: 4 }))).join(' ') + '\n';
console.log = console.info = console.debug = (...args: unknown[]) => emit('stdout', show(args));
console.error = console.warn = (...args: unknown[]) => emit('stderr', show(args));

py.FS.mkdirTree('/home/user');
if (config.homeDir) py.mountNodeFS('/home/user', config.homeDir);

// `awesome` is what scripts import to call the REST plane; _awesome_run runs
// one request against the user's own globals, so they persist between runs.
py.runPython(String.raw`
import base64, io, json, os, sys, traceback, types, warnings
from pyodide.code import eval_code_async

warnings.filterwarnings('ignore', message='.*non-interactive.*')

_AWESOME = '''
"""Call this platform's REST API (/api/v1/...) as you, from code run by runCode.

AWESOME_API_BASE and AWESOME_API_TOKEN are set for each run; the token is
revoked when that run ends.
"""
import json as _json
import os as _os


async def api_async(method, path, body=None):
    """api() for code that is already async: await api_async('GET', path)."""
    from pyodide.http import pyfetch
    base = _os.environ.get('AWESOME_API_BASE')
    token = _os.environ.get('AWESOME_API_TOKEN')
    if not base or not token:
        raise RuntimeError('AWESOME_API_BASE / AWESOME_API_TOKEN are not set: call api() from code run by runCode.')
    url = base.rstrip('/') + (path if path.startswith('/') else '/' + path)
    response = await pyfetch(url, method=method.upper(), body=None if body is None else _json.dumps(body),
                             headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    text = await response.string()
    if not response.ok:
        raise RuntimeError(f'{method.upper()} {path} -> {response.status}: {text[:2000]}')
    try:
        return _json.loads(text)
    except ValueError:
        return text


def api(method, path, body=None):
    """Send one request and return the parsed JSON (or the text).

    api('GET', '/api/v1/storage/collections')
    api('POST', '/api/v1/storage/collections/people/find', {'limit': 100})
    Raises RuntimeError with the status and the error body on a non-2xx answer.
    """
    from pyodide.ffi import run_sync
    return run_sync(api_async(method, path, body))
'''

_awesome = types.ModuleType('awesome')
exec(_AWESOME, _awesome.__dict__)
sys.modules['awesome'] = _awesome
_user = {'__name__': '__main__'}
os.chdir('/home/user')


def _figures(max_images, max_bytes):
    images, dropped = [], 0
    plt = sys.modules.get('matplotlib.pyplot')
    if plt is None:
        return images, dropped
    for num in plt.get_fignums():
        buf = io.BytesIO()
        try:
            with warnings.catch_warnings():
                warnings.simplefilter('ignore')
                plt.figure(num).savefig(buf, format='png', bbox_inches='tight')
        except Exception:
            dropped += 1
            continue
        data = buf.getvalue()
        if len(images) >= max_images or len(data) > max_bytes:
            dropped += 1
        else:
            images.append(base64.b64encode(data).decode('ascii'))
    plt.close('all')
    return images, dropped


async def _awesome_run(code, envs, max_images, max_image_bytes):
    envs = envs.to_py() if hasattr(envs, 'to_py') else dict(envs)
    os.environ.update(envs)
    out = {'results': []}
    try:
        value = await eval_code_async(code, globals=_user, filename='<code>')
        if value is not None:
            out['results'].append(repr(value))
    except BaseException as e:
        tb = e.__traceback__
        while tb is not None and tb.tb_frame.f_code.co_filename != '<code>':
            tb = tb.tb_next
        out['error'] = {'name': type(e).__name__, 'value': str(e),
                        'traceback': ''.join(traceback.format_exception(type(e), e, tb))}
    finally:
        for key in envs:
            os.environ.pop(key, None)
        sys.stdout.flush()
        sys.stderr.flush()
    out['images'], out['imagesDropped'] = _figures(max_images, max_image_bytes)
    return json.dumps(out)
`);
const pythonRun = py.globals.get('_awesome_run');

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

/** JavaScript runs as the body of an async function: `return` gives the result, globalThis keeps state. */
async function runJs(code: string, envs: Record<string, string>) {
  const api = async (method: string, path: string, body?: unknown) => {
    const base = envs.AWESOME_API_BASE;
    const token = envs.AWESOME_API_TOKEN;
    if (!base || !token) throw new Error('AWESOME_API_BASE / AWESOME_API_TOKEN are not set: call api() from code run by runCode.');
    const response = await fetch(base.replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`), {
      method: method.toUpperCase(),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method.toUpperCase()} ${path} -> ${response.status}: ${text.slice(0, 2000)}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  try {
    const value = await new AsyncFunction('api', 'env', code)(api, { ...envs });
    return { results: value === undefined ? [] : [typeof value === 'string' ? value : Deno.inspect(value, { depth: 4 })] };
  } catch (e) {
    const err = e as { name?: string; message?: string; stack?: string };
    return { results: [], error: { name: err?.name ?? 'Error', value: err?.message ?? String(e), traceback: err?.stack ?? String(e) } };
  }
}

interface Request {
  id: string;
  language: 'python' | 'javascript';
  code: string;
  envs: Record<string, string>;
  maxOutputChars: number;
}

async function handle(req: Request): Promise<void> {
  current = { id: req.id, maxChars: req.maxOutputChars, sent: { stdout: 0, stderr: 0 }, total: { stdout: 0, stderr: 0 } };
  let result: { results: string[]; error?: unknown; images?: string[]; imagesDropped?: number };
  if (req.language === 'javascript') {
    result = await runJs(req.code, req.envs);
  } else {
    try {
      await py.loadPackagesFromImports(req.code, { messageCallback: () => {}, errorCallback: (m) => emit('stderr', `${m}\n`) });
    } catch (e) {
      emit('stderr', `A package this code imports could not be loaded (${(e as Error)?.message ?? e}). ` +
        `Bundled: ${config.packages.join(', ')}. Pure-Python packages install from PyPI: import micropip; await micropip.install('name')\n`);
    }
    result = parse(await pythonRun(req.code, req.envs, config.maxImages, config.maxImageBytes));
  }
  const { total } = current;
  current = null;
  send({ id: req.id, type: 'done', ...result, ...capResults(result.results, req.maxOutputChars), stdoutTotal: total.stdout, stderrTotal: total.stderr });
}

send({ type: 'ready' });

const lineDecoder = new TextDecoder();
const chunk = new Uint8Array(1 << 16);
let pending = '';
for (;;) {
  const n = await Deno.stdin.read(chunk);
  if (n === null) break;
  pending += lineDecoder.decode(chunk.subarray(0, n), { stream: true });
  let nl;
  while ((nl = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, nl);
    pending = pending.slice(nl + 1);
    let req: Request;
    try {
      req = parse(line);
    } catch {
      continue;
    }
    await handle(req);
  }
}
Deno.exit(0);
