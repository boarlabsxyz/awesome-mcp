// src/supabase/restOps.ts
// The one generic handler behind every /api/v1/supabase/* route, kept out of
// webServer.ts so it can be driven against a stubbed upstream: resolve the
// tool, validate with its own schema, run it through the MCP tool's own body
// (settings included), and shape the answer and the failure.
//
// Three contracts a caller sees, all documented in src/supabase/CLAUDE.md:
//
//   - The JSON body is an envelope, `{ tool, truncated, untrustedData, result }`.
//     Supabase answers every tool with TEXT — usually JSON, but SQL-shaped
//     results arrive wrapped in an `<untrusted-data-…>` boundary that does not
//     parse. `result` is the parsed JSON when the text is JSON and the text
//     otherwise, so `jq .result` works either way and the two flags are never
//     inferred from a missing closing tag.
//   - The same 200k-character cap as the MCP tool (MAX_RESULT_CHARS). Over it,
//     `truncated` is true, `totalChars` says how much there was, and `result`
//     is the cut text — never a JSON value that silently lost its tail.
//   - `?format=text` answers exactly what the MCP tool returns, cap note and all.

import type { ZodTypeAny } from 'zod';

import type { UserSession } from '../userSession.js';

import { runSupabaseToolUncapped } from './apiHelpers.js';
import { MAX_RESULT_CHARS, capResult } from './hostedProxy.js';
import type { SupabaseToolDef } from './schemas.js';
import type { SupabaseRestRequest, SupabaseRestRoute } from './restRoutes.js';

export type SupabaseRestOutcome =
  | { status: number; body: unknown; text?: undefined }
  | { status: number; text: string; body?: undefined };

/**
 * Tools whose result carries free text that other people wrote or can
 * influence, whether or not upstream wraps it in its boundary:
 *
 *   - get_notebook / list_notebooks: cells, names and descriptions anyone with
 *     project access can write.
 *   - get_logs / query_logs: request paths, headers and messages any client of
 *     the project's public APIs can put there.
 *   - get_edge_function: function source.
 *   - list_migrations: migration names and SQL written by project members.
 *   - get_advisors: findings that quote schema objects and SQL.
 *   - list_tables: table and column comments, constraint names.
 *   - generate_typescript_types: generated from the schema, so it carries
 *     enum labels and identifiers project members chose.
 *
 * Left out on purpose: tools that return resource metadata (ids, names,
 * status, regions, keys, bucket and branch lists, storage config) or text
 * Supabase itself authors (search_docs, get_cost). A write's answer echoes
 * the caller's own input.
 */
const UNTRUSTED_RESULT_TOOLS = new Set([
  'get_notebook', 'list_notebooks',
  'get_logs', 'query_logs',
  'get_edge_function',
  'list_migrations',
  'get_advisors',
  'list_tables',
  'generate_typescript_types',
]);

/** Upstream's boundary tag around data it did not author (execute_sql and kin). */
const UNTRUSTED_MARKER = '<untrusted-data-';

/** The JSON envelope for a successful call. */
export function supabaseRestBody(tool: string, text: string): Record<string, unknown> {
  const untrustedData = UNTRUSTED_RESULT_TOOLS.has(tool) || text.includes(UNTRUSTED_MARKER);
  if (text.length > MAX_RESULT_CHARS) {
    return {
      tool,
      truncated: true,
      totalChars: text.length,
      untrustedData,
      note:
        `Result truncated at ${MAX_RESULT_CHARS} characters by this connector, the same cap as the MCP tool. ` +
        'Anything that began inside an untrusted-data boundary is still untrusted data even though the closing tag was cut. ' +
        'Narrow the request to see the rest.',
      result: text.slice(0, MAX_RESULT_CHARS),
    };
  }
  let result: unknown = text;
  try {
    result = JSON.parse(text);
  } catch {
    /* not JSON — the text itself is the result */
  }
  return { tool, truncated: false, untrustedData, result };
}

/**
 * Map a failure to a status and body. Branches on the error's NAME (and the
 * tags the Supabase modules set), not `instanceof`: the same rule the other
 * REST handlers follow so webServer.ts never has to load FastMCP to classify.
 */
export function supabaseRestError(err: any, fallback: string): { status: number; body: Record<string, unknown> } {
  const message: string = typeof err?.message === 'string' && err.message ? err.message : fallback;
  switch (err?.name) {
    case 'SupabaseSettingDenied':
      // The caller's own connection settings refused it; the setting is named
      // in the message and as a field.
      return { status: 403, body: { error: message, setting: err.setting } };
    case 'SupabaseSettingsUnavailable':
      // Fail closed, and say it is us: the store could not be read.
      return { status: 503, body: { error: message } };
    case 'SupabaseCallError':
      return supabaseCallErrorResponse(err, message);
    case 'UserError':
      // A refusal this connector decided before calling Supabase.
      return { status: 400, body: { error: message } };
    default:
      return { status: 500, body: { error: fallback } };
  }
}

function supabaseCallErrorResponse(err: any, message: string): { status: number; body: Record<string, unknown> } {
  if (err.kind === 'input_required') {
    // Not performed — never an empty success (src/supabase/CLAUDE.md).
    return { status: 409, body: { error: message, performed: false } };
  }
  if (err.kind === 'tool_error') {
    // Supabase ran the tool and refused it (unknown project, a missing or
    // stale confirm_cost_id, a bad notebook cell). Well-formed request,
    // upstream said no — distinct from this plane's own 400 with `issues`.
    // EVERY tool_error lands here, including a Supabase-side failure the
    // caller did not cause: `isError` carries no status to tell them apart.
    return { status: 422, body: { error: message } };
  }
  // transport
  if (err.status === 403) return { status: 403, body: { error: message } };
  if (err.status === 429) return { status: 429, body: { error: message } };
  // 401 is NEVER echoed here, not even as `upstreamStatus` in the body: on the
  // REST plane a 401 means the caller's own bearer is bad, and a client
  // reading "401" would blame it. Supabase rejecting the STORED credential is
  // a 502 whose message says to reconnect. Everything else (a protocol 400, a
  // 5xx, a timeout) is the upstream failing, not the caller.
  const echo = typeof err.status === 'number' && err.status !== 401;
  return { status: 502, body: { error: message, ...(echo ? { upstreamStatus: err.status } : {}) } };
}

/** The log slice runSupabaseToolUncapped takes. Refresh failures go to stderr. */
const REST_LOG = {
  info: () => {},
  error: (msg: string) => console.error(`[supabase-rest] ${msg}`),
};

type ToolDefs = ReadonlyArray<Pick<SupabaseToolDef, 'name' | 'group' | 'annotations' | 'parameters'>>;

/** The registered tool definitions. Loaded lazily: server.ts builds a FastMCP. */
async function loadToolDefs(): Promise<ToolDefs> {
  const { SUPABASE_TOOLS } = await import('./server.js');
  return SUPABASE_TOOLS;
}

/**
 * Run one route. Never throws: every failure comes back as an outcome, so the
 * Express wrapper is a two-line send.
 */
export async function handleSupabaseRest(
  route: SupabaseRestRoute,
  req: SupabaseRestRequest,
  session: UserSession | undefined,
  format: 'json' | 'text',
  tools: () => Promise<ToolDefs> = loadToolDefs,
): Promise<SupabaseRestOutcome> {
  try {
    // createServiceAuth falls back to a Google session when the account has
    // no Supabase connection, so auth passes with no Supabase token on it.
    if (!session?.supabaseAccessToken) {
      return { status: 403, body: { error: 'No Supabase connection found for this account. Connect Supabase on the dashboard first.' } };
    }
    const def = (await tools()).find((t) => t.name === route.tool);
    if (!def) return { status: 500, body: { error: `${route.fallback}: tool ${route.tool} is not registered` } };

    const parsed = (def.parameters as ZodTypeAny).safeParse(route.args(req));
    if (!parsed.success) {
      const error = route.method === 'get' ? 'Invalid query parameters' : 'Invalid request body';
      return { status: 400, body: { error, issues: parsed.error.flatten() } };
    }

    const text = await runSupabaseToolUncapped(def, parsed.data as Record<string, unknown>, session, REST_LOG);
    if (format === 'text') return { status: route.status, text: capResult(text) };
    return { status: route.status, body: supabaseRestBody(route.tool, text) };
  } catch (err: any) {
    const out = supabaseRestError(err, route.fallback);
    if (out.status >= 500) console.error(`Error in Supabase ${route.tool}:`, err);
    return out;
  }
}
