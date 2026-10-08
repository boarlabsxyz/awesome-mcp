// src/browserbase/mcpProxyClient.ts
// Minimal MCP client over Streamable HTTP, used to proxy this connector's six
// browser-driving tools to Browserbase's hosted MCP server.
//
// Why proxy at all: the hosted server runs Stagehand and pays for the model
// behind act/observe/extract. Re-implementing those against the REST API is not
// possible — REST has no act/observe — and self-hosting the open-source server
// would mean our own model key plus a new deploy target.
//
// Why hand-rolled instead of @modelcontextprotocol/sdk: this needs exactly the
// initialize / notifications-initialized / tools-call trio, and `src/` carries
// no SDK dependency (the same reasoning as src/mailer.ts using plain fetch).
// The protocol surface used here is smaller than the adapter around the SDK
// would be. Ported from e2e/transports/mcpHttp.ts rather than imported: `e2e/`
// is a separate npm package with its own tsconfig and dependency set.
//
// ---------------------------------------------------------------------------
// THE LOAD-BEARING DESIGN DECISION, stated here because everything else follows
// from it: a fresh transport is opened PER TOOL CALL and the Mcp-Session-Id is
// never cached, so the Browserbase `sessionId` must be passed explicitly on
// every call.
//
// The hosted endpoint tracks one active browser session per MCP transport. Its
// own docs name our exact shape — "Some MCP clients open a new transport on
// every tool call instead of reusing one, which means the server has no active
// session to fall back to and calls fail with `No active session`" — and
// prescribe the fix: "pass the `sessionId` returned by `start` on every
// subsequent tool call. An explicit `sessionId` always takes priority over the
// transport's current session."
//
// So this is the documented path, not a workaround. Caching a transport would
// be worse than useless here: this server runs multiple replicas, and a cached
// Mcp-Session-Id that a sibling replica does not hold is precisely the
// `No active session` failure the explicit contract removes. The cost is three
// round-trips on an operation that already takes seconds in a real browser.
// ---------------------------------------------------------------------------

import { UserError } from 'fastmcp';

import { safeErrorText } from './responseSafety.js';

const HOSTED_MCP_URL = 'https://mcp.browserbase.com/mcp';
const CLIENT_INFO = { name: 'awesome-mcp-browserbase-proxy', version: '1.0.0' };
const PREFERRED_PROTOCOL = '2025-06-18';
const REQUEST_TIMEOUT_MS = 120_000;

/** The six tools the hosted server exposes, which this connector mirrors. */
export type BrowserbaseHostedTool = 'start' | 'end' | 'navigate' | 'act' | 'observe' | 'extract';

export interface ProxyToolResult {
  /** Joined text blocks. Every hosted tool answers with text. */
  text: string;
  /** `isError` from the MCP result — a tool-level failure, not a transport one. */
  isError: boolean;
  raw: unknown;
}

export interface ProxyOptions {
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Overridden in tests only; the hosted endpoint is not configurable. */
  url?: string;
}

/**
 * Browserbase's hosted MCP endpoint. Deliberately a constant and not an env
 * var: an operator-set URL here would be a credential-forwarding target, since
 * every request carries the user's Browserbase API key.
 */
export function hostedMcpUrl(): string {
  return HOSTED_MCP_URL;
}

/** The timeout is long on purpose — `act` drives a real browser. */
function timeoutError(name: string): Error {
  return new Error(`Browserbase hosted MCP '${name}' timed out after ${REQUEST_TIMEOUT_MS}ms`);
}

function truncate(s: string, n = 400): string {
  return s.length > n ? `${s.slice(0, n)}...(truncated)` : s;
}

/**
 * Pull the response for `id` out of either a JSON body or an SSE stream.
 *
 * The hosted server answers `tools/call` with `text/event-stream` whose frames
 * carry the JSON-RPC response, so a client that only reads `res.json()` gets a
 * parse error and blames the tool. Notifications get 202 with no body, hence
 * the undefined return.
 */
export async function readRpcBody(res: Response, id: number): Promise<any | undefined> {
  if (res.status === 202) return undefined;
  const contentType = res.headers.get('content-type') ?? '';
  const raw = await res.text();
  if (!raw) return undefined;

  if (!contentType.includes('text/event-stream')) return JSON.parse(raw);

  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const frame = JSON.parse(line.slice(5).trim());
    if (frame?.id === id) return frame;
  }
  throw new Error(`No SSE frame carried a response for request id ${id}. Stream: ${truncate(raw)}`);
}

/** Join the text blocks of an MCP tool result. */
export function textOfResult(result: any): string {
  const blocks = result?.content;
  if (!Array.isArray(blocks)) return typeof result === 'string' ? result : JSON.stringify(result);
  return blocks
    .map((b: any) => (b?.type === 'text' ? b.text : `[${b?.type ?? 'unknown'} block]`))
    .join('\n');
}

/**
 * Rewrite the one upstream failure that is guaranteed to happen and whose raw
 * text does not say what to do.
 *
 * `No active session` means the transport had no session to fall back to — i.e.
 * no `sessionId` was passed. Since this proxy opens a fresh transport per call
 * by design, that is the expected failure for any call made without one, and
 * the fix is a contract the caller has to follow rather than something to
 * retry.
 */
export function explainHostedError(tool: string, rawMessage: string): string {
  // Sanitized before anything else looks at it. A live run hit an upstream
  // extraction failure (AI_NoObjectGeneratedError) whose message echoed ~214 K
  // characters of the model's own degenerate output — on its own more than a
  // 25 K-token client could hold, so the error that most needed reading became
  // the one that could not be read. This also keeps a credential out of an
  // error path, since redaction has to cover every exit, not just the happy one.
  const message = safeErrorText(rawMessage);
  if (/no active session/i.test(message)) {
    return (
      `Browserbase has no active browser session for this call. Each tool call reaches Browserbase independently, ` +
      `so the session is identified by its id and not remembered between calls: run 'start' to get a sessionId, then pass ` +
      `that same sessionId to '${tool}' and to every later call. If you already have one, it may have ended or timed out — ` +
      `getBrowserSession tells you whether it is still running.`
    );
  }
  return message;
}

/**
 * Run one hosted tool call: handshake, call, discard.
 *
 * `initialize` + `notifications/initialized` are re-done every call. That is
 * the price of holding no state, and it is the right trade here — see the
 * header.
 */
export async function callHostedTool(
  apiKey: string,
  name: BrowserbaseHostedTool,
  args: Record<string, unknown>,
  options: ProxyOptions = {},
): Promise<ProxyToolResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = options.url ?? HOSTED_MCP_URL;

  let sessionId: string | undefined;
  let protocolVersion = PREFERRED_PROTOCOL;
  let nextId = 1;

  async function post(payload: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // Both types: the server picks, and it answers tools/call over SSE.
      accept: 'application/json, text/event-stream',
      // Header auth, not the `browserbaseApiKey` query parameter, which
      // Browserbase documents as a deprecated fallback. It also keeps the key
      // out of any URL the user could copy — the connector requirement.
      authorization: `Bearer ${apiKey}`,
      'mcp-protocol-version': protocolVersion,
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
        // Every request carries the user's Browserbase API key in a header.
        // Node's fetch keeps custom headers across a redirect and would replay
        // the Authorization header at whatever host the response names, so a
        // hijacked DNS entry or a misconfigured proxy could collect it. MCP has
        // no legitimate redirect; treat one as an error.
        redirect: 'error',
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') throw timeoutError(name);
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 401 || res.status === 403) {
      const error: any = new UserError(
        'Browserbase rejected the API key. Reconnect from the dashboard with a current key from https://www.browserbase.com/settings.',
      );
      error.status = res.status;
      throw error;
    }
    if (!res.ok) {
      const error: any = new Error(
        `Browserbase hosted MCP returned ${res.status} ${res.statusText}: ${truncate(await res.text().catch(() => ''))}`,
      );
      error.status = res.status;
      throw error;
    }

    // Capture the transport session so the three requests of THIS call share
    // one upstream transport. It is deliberately not persisted past the call.
    const returned = res.headers.get('mcp-session-id');
    if (returned) sessionId = returned;
    return res;
  }

  async function rpc(method: string, params?: unknown): Promise<any> {
    const id = nextId++;
    const res = await post({ jsonrpc: '2.0', id, method, params });
    const body = await readRpcBody(res, id);
    if (body?.error) {
      const detail = body.error.data ? ` — ${JSON.stringify(body.error.data)}` : '';
      throw new Error(`Browserbase hosted MCP ${method} failed (${body.error.code}): ${body.error.message}${detail}`);
    }
    return body?.result;
  }

  const init = await rpc('initialize', {
    protocolVersion: PREFERRED_PROTOCOL,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  });
  // Use what the server negotiated, not what we asked for — sending a version
  // header the server did not agree to is rejected by spec-compliant hosts.
  if (typeof init?.protocolVersion === 'string') protocolVersion = init.protocolVersion;
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const result = await rpc('tools/call', { name, arguments: args });
  return { text: textOfResult(result), isError: result?.isError === true, raw: result };
}

/**
 * Call a hosted tool and return its text, raising a UserError for a tool-level
 * failure so it reads like every other tool in this repo.
 */
export async function proxyHostedTool(
  apiKey: string,
  name: BrowserbaseHostedTool,
  args: Record<string, unknown>,
  options: ProxyOptions = {},
): Promise<string> {
  let result: ProxyToolResult;
  try {
    result = await callHostedTool(apiKey, name, args, options);
  } catch (err: any) {
    if (err instanceof UserError) throw err;
    throw new UserError(explainHostedError(name, err?.message ?? String(err)));
  }
  if (result.isError) throw new UserError(explainHostedError(name, result.text));
  return result.text;
}

/**
 * Pull the Browserbase session id out of `start`'s response text.
 *
 * `start` is documented to return `{ sessionId }`, but the hosted server
 * delivers it as text, and this id is the whole contract every later call
 * depends on — so parse it defensively and report plainly when it cannot be
 * found rather than returning a response that looks successful and leaves the
 * caller with nothing to pass on.
 */
export function parseSessionId(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text);
    const fromJson = parsed?.sessionId ?? parsed?.id;
    if (typeof fromJson === 'string' && fromJson.trim()) return fromJson.trim();
  } catch {
    /* not JSON — fall through to the text scan */
  }
  // Accept `sessionId: <id>`, `"sessionId": "<id>"` and `sessionId=<id>`.
  const labelled = /session[_\s-]?id["']?\s*[:=]\s*["']?([A-Za-z0-9_-]{8,})/i.exec(text);
  if (labelled) return labelled[1];
  // Last resort: a bare UUID anywhere in the text.
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(text);
  return uuid ? uuid[0] : undefined;
}
