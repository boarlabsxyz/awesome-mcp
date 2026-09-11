// Minimal MCP client over Streamable HTTP, for calling a tool without a browser
// or an LLM in the loop.
//
// Why hand-rolled instead of @modelcontextprotocol/sdk: the client needs exactly
// three calls (initialize, notifications/initialized, tools/call) plus tools/list,
// and the e2e package deliberately carries a small dependency set — the same
// reasoning as src/mailer.ts using plain fetch. If this ever needs sampling,
// roots, or resource subscriptions, swap it for the SDK; until then the protocol
// surface here is smaller than the adapter around it would be.
//
// What this transport is FOR: the needle tier proves the client → connector →
// OAuth → tool → render chain and therefore has to drive a real client. The
// volume and zero tiers ask server-side questions (does this page, does it
// truncate, what does it say with no data) where an LLM in the loop only adds
// nondeterminism and, on Browserbase, billable browser-minutes. 227 tools is
// ~17h of live-client conversations; this path runs them in minutes.

import type { Endpoint } from '../accounts.ts';

const CLIENT_INFO = { name: 'awesome-mcp-e2e', version: '0.0.0' };
const PREFERRED_PROTOCOL = '2025-06-18';

export interface ToolResult {
  /** Every tool in this repo but Slack's downloadFile returns text blocks. */
  text: string;
  /** `isError` from the MCP result — a tool-level failure, not a transport one. */
  isError: boolean;
  raw: unknown;
}

export interface McpClient {
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  listTools(): Promise<string[]>;
  close(): Promise<void>;
  describe(): string;
}

export async function connectMcp(endpoint: Endpoint): Promise<McpClient> {
  let sessionId: string | undefined;
  let protocolVersion = PREFERRED_PROTOCOL;
  let nextId = 1;

  async function rpc(method: string, params?: unknown): Promise<any> {
    const id = nextId++;
    const res = await post({ jsonrpc: '2.0', id, method, params });
    const body = await readBody(res, id);
    if (body?.error) {
      throw new Error(
        `MCP ${method} failed (${body.error.code}): ${body.error.message}` +
          (body.error.data ? ` — ${JSON.stringify(body.error.data)}` : ''),
      );
    }
    return body?.result;
  }

  async function notify(method: string, params?: unknown): Promise<void> {
    await post({ jsonrpc: '2.0', method, params });
  }

  async function post(payload: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // Both types: the server picks, and FastMCP answers tools/call over SSE.
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${endpoint.apiKey}`,
      'mcp-protocol-version': protocolVersion,
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;

    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    // A 401 here is the single most common setup failure: a missing or stale
    // dashboard API key. Say which account so it is actionable.
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `${res.status} from ${endpoint.url} — the '${endpoint.account}' account's ` +
          'API key was rejected. Regenerate it on the dashboard and update ' +
          `E2E_${endpoint.account.toUpperCase()}_API_KEY.`,
      );
    }
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText} from ${endpoint.url}: ${truncate(await res.text())}`);
    }

    const returned = res.headers.get('mcp-session-id');
    if (returned) sessionId = returned;
    return res;
  }

  const init = await rpc('initialize', {
    protocolVersion: PREFERRED_PROTOCOL,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  });
  // Use what the server negotiated, not what we asked for — sending a version
  // header the server did not agree to is rejected by spec-compliant hosts.
  if (typeof init?.protocolVersion === 'string') protocolVersion = init.protocolVersion;
  await notify('notifications/initialized');

  return {
    async callTool(name, args) {
      const result = await rpc('tools/call', { name, arguments: args });
      return {
        text: textOf(result),
        isError: result?.isError === true,
        raw: result,
      };
    },

    async listTools() {
      const names: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await rpc('tools/list', cursor ? { cursor } : {});
        for (const tool of page?.tools ?? []) names.push(tool.name);
        cursor = page?.nextCursor;
      } while (cursor);
      return names;
    },

    async close() {
      if (!sessionId) return;
      // Best-effort: a session the server has already reaped is not an error
      // worth failing a passing check over.
      try {
        await fetch(endpoint.url, {
          method: 'DELETE',
          headers: {
            authorization: `Bearer ${endpoint.apiKey}`,
            'mcp-session-id': sessionId,
            'mcp-protocol-version': protocolVersion,
          },
        });
      } catch {
        /* ignore */
      }
    },

    describe: () => `${endpoint.account}:${endpoint.service} ${endpoint.url}`,
  };
}

/**
 * Pull the response for `id` out of either a JSON body or an SSE stream.
 *
 * FastMCP answers POSTs with `text/event-stream` whose frames carry the JSON-RPC
 * response, so a client that only reads res.json() gets a parse error and blames
 * the tool. Notifications get 202 with no body, hence the undefined return.
 */
async function readBody(res: Response, id: number): Promise<any | undefined> {
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

function textOf(result: any): string {
  const blocks = result?.content;
  if (!Array.isArray(blocks)) return typeof result === 'string' ? result : JSON.stringify(result);
  return blocks
    .map((b: any) => (b?.type === 'text' ? b.text : `[${b?.type ?? 'unknown'} block]`))
    .join('\n');
}

function truncate(s: string, n = 400): string {
  return s.length > n ? `${s.slice(0, n)}...(truncated)` : s;
}
