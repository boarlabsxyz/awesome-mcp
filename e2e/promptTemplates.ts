// Names of the MCP connectors as registered in Claude Desktop / ChatGPT.
//
// Each service gets its own connector PAIR: a `-readonly` connector bound to
// the readonly test identity (with WRITE_TOOLS manually unchecked) and a
// `-full` connector bound to the write identity. The names must match exactly
// what the operator typed when registering each connector (documented in
// runbook.md) — prompts include the name verbatim so the client dispatches the
// tool call through the right connector.
//
// Naming scheme: `awesome-mcp-<service>-<mode>`, where <service> is the
// directory name under src/. Phase 2 used the unqualified `awesome-mcp-readonly`
// / `awesome-mcp-full` for Google Docs; with nine services those names are
// ambiguous, so the two existing Docs connectors must be RENAMED in the client
// UI (a rename only — no re-OAuth, no redoing the tool blocking). See
// runbook.md § Two-connector model.

import { SERVICES, type ServiceName } from './tools/index.ts';

export type Mode = 'readonly' | 'full';

export interface ConnectorPair {
  readonly: string;
  full: string;
}

function pair(service: ServiceName): ConnectorPair {
  return {
    readonly: `awesome-mcp-${service}-readonly`,
    full: `awesome-mcp-${service}-full`,
  };
}

export const CONNECTORS = Object.fromEntries(
  SERVICES.map((service) => [service, pair(service)]),
) as Record<ServiceName, ConnectorPair>;

/**
 * Opening sentence of every smoke prompt. Naming the connector is what keeps a
 * readonly test from being answered by the full connector (both are registered
 * in the same client and expose overlapping tool names).
 */
export function preface(service: ServiceName, mode: Mode): string {
  return `Use the ${CONNECTORS[service][mode]} connector. `;
}

/**
 * Verbatim-output contract shared by every smoke prompt. The delimiters are
 * what `AssertionSpec.containsBetween` keys off — they fence the tool's output
 * away from any preamble the client wraps around it, so an assertion can't be
 * satisfied by the model merely echoing the needle back from the prompt.
 */
export function outputContract(what: string): string {
  return [
    'Reply with exactly this format and nothing else:',
    `OUTPUT_BEGIN<${what}>OUTPUT_END`,
    'Do not paraphrase, summarize, or add commentary. Do not use markdown formatting.',
  ].join('\n');
}
