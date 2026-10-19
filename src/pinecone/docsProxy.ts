// src/pinecone/docsProxy.ts
// `search-docs` — the one tool in this connector that is a proxy rather than a
// REST call, and the one that needs no credential at all.
//
// Pinecone hosts its documentation behind a public Pinecone Assistant exposed
// as a remote MCP server. Its tool is `get_context`; the endpoint takes no
// auth, which is why `headers` is omitted from the target below rather than
// set to an empty object. Sending the user's Pinecone API key to a host that
// never asked for one would be a leak, and an empty-object placeholder is the
// kind of thing a later edit fills in without thinking.
//
// This is also why search-docs stays callable when the connection's key is
// missing or rejected: it needs no key, and it is the tool that explains how
// to fix the connection. A connector whose troubleshooting tool is gated on
// the thing being troubleshot is one that can only help people who do not
// need it.

import { UserError } from 'fastmcp';

import { type McpProxyTarget, callProxyTool } from '../util/mcpProxyClient.js';

/**
 * Pinecone's public documentation assistant.
 *
 * A constant and not an env var — the rule the shared module states. It
 * carries no credential, but an operator-settable documentation endpoint is
 * still an operator-settable source of text handed straight to a model.
 */
const DOCS_MCP_URL = 'https://prod-1-data.ke.pinecone.io/mcp/assistants/pinecone-docs';

/** The tool name the assistant exposes. Not `search-docs` — that is ours. */
const DOCS_TOOL = 'get_context';

const CLIENT_INFO = { name: 'awesome-mcp-pinecone-docs', version: '1.0.0' };

/** Short: this is a documentation lookup, not a browser session. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Cap what a documentation answer may contribute to the model's context. */
const MAX_DOCS_CHARS = 60_000;

const DOCS_TARGET: McpProxyTarget = {
  url: DOCS_MCP_URL,
  clientInfo: CLIENT_INFO,
  // No `headers`. See the header — deliberate, not an omission.
  timeoutMs: REQUEST_TIMEOUT_MS,
  label: 'Pinecone documentation MCP',
};

export interface DocsSearchOptions {
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  /** Overridden in tests only. */
  url?: string;
}

function truncate(text: string): string {
  if (text.length <= MAX_DOCS_CHARS) return text;
  return `${text.slice(0, MAX_DOCS_CHARS)}\n\n…(documentation answer truncated at ${MAX_DOCS_CHARS} characters)`;
}

/**
 * Ask Pinecone's documentation assistant.
 *
 * Failures are reported as a transient documentation problem and never as a
 * connector or credential problem: this call does not touch the user's
 * Pinecone project, so blaming their key here would send them to re-issue a
 * credential that was never involved.
 */
export async function searchPineconeDocs(query: string, options: DocsSearchOptions = {}): Promise<string> {
  let result;
  try {
    result = await callProxyTool(DOCS_TARGET, DOCS_TOOL, { query }, options);
  } catch (error: any) {
    throw new UserError(
      `Could not reach Pinecone's documentation service (${error?.message ?? error}). ` +
        `This is usually transient and has nothing to do with your API key — retry once, or read https://docs.pinecone.io directly. ` +
        `Every other tool in this connector is unaffected.`,
    );
  }
  if (result.isError) {
    throw new UserError(`Pinecone's documentation service could not answer that: ${truncate(result.text)}`);
  }
  if (!result.text.trim()) {
    return `Pinecone's documentation service returned nothing for "${query}". That is an empty answer, not an error — try different wording, or read https://docs.pinecone.io directly.`;
  }
  return truncate(result.text);
}
