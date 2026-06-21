// Names of the two MCP connectors as registered in Claude Desktop / ChatGPT.
// The names must match exactly what the operator typed when registering each
// connector (documented in runbook.md). Prompts include these names so the LLM
// dispatches the tool call through the right connector.

export const CONNECTORS = {
  readonly: 'awesome-mcp-readonly',
  full: 'awesome-mcp-full',
} as const;

export type Mode = keyof typeof CONNECTORS;

export function preface(mode: Mode): string {
  return `Use the ${CONNECTORS[mode]} connector. `;
}
