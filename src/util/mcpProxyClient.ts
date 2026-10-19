// src/util/mcpProxyClient.ts
// Minimal MCP client over Streamable HTTP, for connectors whose upstream is
// itself an MCP server rather than a REST API.
//
// Hoisted out of src/browserbase/mcpProxyClient.ts when Pinecone needed the
// same transport, for the reason pasteTokenValidation.ts and baseUrlGuard.ts
// were hoisted: a second copy of a 200-line protocol client is indistinguishable
// to a reader from the first, and the two drift silently because nothing fails
// when only one of them is fixed.
//
// Why hand-rolled instead of @modelcontextprotocol/sdk: this needs exactly the
// initialize / notifications-initialized / tools-call trio, and `src/` carries
// no SDK dependency (the same reasoning as src/mailer.ts using plain fetch).
// The protocol surface used here is smaller than the adapter around the SDK
// would be.
//
// ---------------------------------------------------------------------------
// THE LOAD-BEARING DESIGN DECISION, stated here because everything else follows
// from it: a fresh transport is opened PER TOOL CALL and the Mcp-Session-Id is
// never cached beyond the three requests of a single call.
//
// A hosted endpoint that tracks state per transport therefore needs the caller
// to re-identify that state explicitly on every call — Browserbase's hosted
// server documents exactly this shape ("Some MCP clients open a new transport
// on every tool call instead of reusing one, which means the server has no
// active session to fall back to") and prescribes passing its `sessionId`
// every time.
//
// Caching a transport would be worse than useless: this server runs multiple
// replicas, and a cached Mcp-Session-Id that a sibling replica does not hold is
// precisely the failure the explicit contract removes. The cost is three
// round-trips per call; the payoff is that any replica can serve any call.
//
// (Note this rules out caching the TRANSPORT's session, which is replica-affine.
// It says nothing about caching facts that are properties of the upstream data
// and identical on every replica — see src/pinecone/indexCatalog.ts, which
// caches index hosts for exactly that reason.)
// ---------------------------------------------------------------------------

const PREFERRED_PROTOCOL = '2025-06-18';

export interface ProxyToolResult {
  /** Joined text blocks. Every hosted tool this is used against answers with text. */
  text: string;
  /** `isError` from the MCP result — a tool-level failure, not a transport one. */
  isError: boolean;
  raw: unknown;
}

/**
 * Everything provider-specific about one upstream MCP endpoint.
 *
 * Each connector builds one of these as a constant and passes it on every
 * call, so nothing here has to know which provider it is serving.
 */
export interface McpProxyTarget {
  /**
   * The upstream endpoint.
   *
   * Every caller supplies a CONSTANT, never an env var. An operator-settable
   * endpoint is a credential-forwarding target whenever `headers` carries one,
   * and there is no deployment that legitimately needs to retarget it.
   */
  url: string;
  /** Sent as `clientInfo` in the initialize handshake. */
  clientInfo: { name: string; version: string };
  /**
   * Per-request auth headers, built from whatever credential the connector holds.
   *
   * OPTIONAL, and that is load-bearing rather than a convenience: Pinecone's
   * documentation assistant is a public, unauthenticated endpoint, and sending
   * a credential to a host that never asked for one is a leak. A connector that
   * needs no auth omits this entirely instead of passing an empty object it
   * might later be tempted to fill in.
   */
  headers?: () => Record<string, string>;
  /** How long one request may take. Long for a browser, short for a doc lookup. */
  timeoutMs: number;
  /** Service name for transport-level error messages, e.g. "Browserbase hosted MCP". */
  label: string;
  /**
   * Run over any upstream text before it reaches an error message.
   *
   * Browserbase passes its redaction + size cap here. Without a hook the error
   * path is the one exit sanitising does not cover, which is how a 214 KB
   * upstream error once reached a client that could not hold it.
   */
  sanitizeText?: (text: string) => string;
  /**
   * Turn a 401/403 into the connector's own reconnect message.
   *
   * Returns a message, and the caller throws it tagged with the status. Omitted
   * means the generic wording, which is right for an endpoint that takes no
   * credential and so cannot reject one.
   */
  explainUnauthorized?: (status: number) => string;
}

export interface ProxyCallOptions {
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Overridden in tests only; production always uses `target.url`. */
  url?: string;
}

/** An upstream rejection, carrying the status so callers can branch on it. */
export class McpProxyHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'McpProxyHttpError';
    this.status = status;
  }
}

function truncate(s: string, n = 400): string {
  return s.length > n ? `${s.slice(0, n)}...(truncated)` : s;
}

/**
 * Pull the response for `id` out of either a JSON body or an SSE stream.
 *
 * A hosted server may answer `tools/call` with `text/event-stream` whose frames
 * carry the JSON-RPC response, so a client that only reads `res.json()` gets a
 * parse error and blames the tool. Notifications get 202 with no body, hence
 * the undefined return.
 */
export async function readRpcBody(res: Response, id: number): Promise<any> {
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
 * Run one hosted tool call: handshake, call, discard.
 *
 * `initialize` + `notifications/initialized` are re-done every call. That is
 * the price of holding no state, and it is the right trade here — see the
 * header.
 */
export async function callProxyTool(
  target: McpProxyTarget,
  name: string,
  args: Record<string, unknown>,
  options: ProxyCallOptions = {},
): Promise<ProxyToolResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = options.url ?? target.url;

  let sessionId: string | undefined;
  let protocolVersion = PREFERRED_PROTOCOL;
  let nextId = 1;

  /**
   * Run upstream text through the target's sanitiser before it reaches a
   * message. Every error path below goes through this — a hook that is
   * declared and never called is worse than no hook, because the caller
   * (Browserbase passes `safeErrorText`) believes the redaction and the size
   * cap are in force.
   */
  const clean = (text: string): string => (target.sanitizeText ? target.sanitizeText(text) : text);

  /**
   * One request, with the response BODY read inside the same deadline.
   *
   * The reader is a parameter rather than the response being returned,
   * because `fetch` resolves as soon as the response HEADERS arrive: clearing
   * the timer there would leave the body read — which for `tools/call` is an
   * SSE stream the upstream can simply stall — with no limit at all, and
   * `target.timeoutMs` would never be enforced. src/util/jsonApiRequest.ts
   * documents the same rule for the same reason; this module had the bug
   * because it predates that one.
   */
  async function post<T>(payload: unknown, read: (res: Response) => Promise<T>): Promise<T> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // Both types: the server picks, and it may answer tools/call over SSE.
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': protocolVersion,
      ...target.headers?.(),
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), target.timeoutMs);
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
        // A request may carry the user's API key in a header. Node's fetch
        // keeps custom headers across a redirect and would replay them at
        // whatever host the response names, so a hijacked DNS entry or a
        // misconfigured proxy could collect the credential. MCP has no
        // legitimate redirect; treat one as an error. Kept unconditional even
        // for an unauthenticated target, since a redirect there is still an
        // endpoint behaving in a way this client cannot reason about.
        redirect: 'error',
      });

      if (res.status === 401 || res.status === 403) {
        throw new McpProxyHttpError(
          target.explainUnauthorized?.(res.status) ?? `${target.label} rejected the request (${res.status}).`,
          res.status,
        );
      }
      if (!res.ok) {
        throw new McpProxyHttpError(
          `${target.label} returned ${res.status} ${res.statusText}: ${truncate(clean(await res.text().catch(() => '')))}`,
          res.status,
        );
      }

      // Capture the transport session so the three requests of THIS call share
      // one upstream transport. It is deliberately not persisted past the call.
      const returned = res.headers.get('mcp-session-id');
      if (returned) sessionId = returned;
      return await read(res);
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new Error(`${target.label} '${name}' timed out after ${target.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function rpc(method: string, params?: unknown): Promise<any> {
    const id = nextId++;
    const body = await post({ jsonrpc: '2.0', id, method, params }, res => readRpcBody(res, id));
    if (body?.error) {
      // Both halves are sanitised AND capped. `error.data` had no size limit
      // at all, which is the 214 KB failure sanitizeText exists for — and a
      // caller that puts `err.message` straight into a UserError (Pinecone's
      // search-docs) would hand all of it to the model.
      const detail = body.error.data ? ` — ${truncate(clean(JSON.stringify(body.error.data)))}` : '';
      const message = truncate(clean(String(body.error.message ?? '')));
      throw new Error(`${target.label} ${method} failed (${body.error.code}): ${message}${detail}`);
    }
    return body?.result;
  }

  const init = await rpc('initialize', {
    protocolVersion: PREFERRED_PROTOCOL,
    capabilities: {},
    clientInfo: target.clientInfo,
  });
  // Use what the server negotiated, not what we asked for — sending a version
  // header the server did not agree to is rejected by spec-compliant hosts.
  if (typeof init?.protocolVersion === 'string') protocolVersion = init.protocolVersion;
  // A 202 carries no body, but an undrained one holds its socket in the pool.
  // Cancelling is best-effort — a stub response in a test has no body.
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, async res => {
    try { await res.body?.cancel(); } catch { /* nothing to drain */ }
  });

  const result = await rpc('tools/call', { name, arguments: args });
  return { text: textOfResult(result), isError: result?.isError === true, raw: result };
}
