// src/auth/scopeMap.ts
// Route-to-scope mapping for MCP proxy endpoints.

const ROUTE_SCOPE_MAP: Record<string, string> = {
  mcp: 'mcp:docs',
  calendar: 'mcp:calendar',
  sheets: 'mcp:sheets',
  gmail: 'mcp:gmail',
  slides: 'mcp:slides',
  drive: 'mcp:drive',
  clickup: 'mcp:clickup',
  slack: 'mcp:slack',
};

/** All supported MCP scopes (single source of truth). */
export const ALL_SCOPES = Object.values(ROUTE_SCOPE_MAP);

/** Map MCP_SLUG values to their required scope. */
const SLUG_SCOPE_MAP: Record<string, string> = {
  'google-docs': 'mcp:docs',
  'google-calendar': 'mcp:calendar',
  'google-sheets': 'mcp:sheets',
  'google-gmail': 'mcp:gmail',
  'google-slides': 'mcp:slides',
  'google-drive': 'mcp:drive',
  'clickup': 'mcp:clickup',
  'slack': 'mcp:slack',
};

/** Return the scope for a given MCP_SLUG, or all scopes if unknown. */
export function getScopesForSlug(slug: string): string[] {
  const scope = SLUG_SCOPE_MAP[slug];
  return scope ? [scope] : ALL_SCOPES;
}

/**
 * Return the OAuth scope required for a given request path,
 * or null if the path is not a recognized MCP proxy route.
 *
 * Handles `/mcp`, `/sse`, `/calendar`, `/calendar-sse`, etc.
 */
export function getRequiredScope(path: string): string | null {
  // Strip leading slash
  let segment = path.replace(/^\//, '');
  // Take only the first path segment (e.g. "calendar" from "calendar/foo")
  segment = segment.split('/')[0];
  // Strip -sse suffix (e.g. "calendar-sse" → "calendar")
  segment = segment.replace(/-sse$/, '');
  // /sse is the default docs SSE endpoint
  if (segment === 'sse') return ROUTE_SCOPE_MAP.mcp;
  return ROUTE_SCOPE_MAP[segment] ?? null;
}
