// src/mcpInstancePath.ts
// An MCP instance addressed by path: /mcp/<instanceId>, the form Copy URL gives.
//
// The instance used to live only in the query (/mcp?instanceId=<id>), but the
// connector list Claude Code fetches from Anthropic comes back without a query
// string and Claude Code dedups connectors by URL, so two instances of one tool
// collapsed into one and the second vanished without an error. The path
// survives that list. /mcp?instanceId= keeps working for existing connectors.
//
// FastMCP serves only its exact endpoint, so the proxy turns the path form back
// into the query form; nothing behind the proxy knows the path form exists.

// nanoid's alphabet, which also covers the older `<slug>-legacy` and
// `<slug>-<rowId>` ids. This value ends up in a response header and in JSON.
const INSTANCE_ID = /^[A-Za-z0-9_-]+$/;

const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

/**
 * The id in `<mount>/<id>`, or null for any other path. A trailing slash is not
 * the path form: the metadata's `resource` must match the URL called exactly,
 * and FastMCP refuses /mcp/ the same way.
 */
export function instanceIdFromPath(pathname: string, mount: string): string | null {
  if (!mount || !pathname.startsWith(`${mount}/`)) return null;
  const id = pathname.slice(mount.length + 1);
  return INSTANCE_ID.test(id) ? id : null;
}

/**
 * `<mount>/<id>?x=1` → `/mcp?x=1&instanceId=<id>`; any other URL comes back
 * unchanged. The path wins over a stray `?instanceId=`: it is the URL the
 * connector was added with.
 */
export function instancePathToQuery(url: string, mount = '/mcp'): string {
  const queryStart = url.indexOf('?');
  const pathname = queryStart === -1 ? url : url.slice(0, queryStart);
  const instanceId = instanceIdFromPath(pathname, mount);
  if (!instanceId) return url;
  const params = new URLSearchParams(queryStart === -1 ? '' : url.slice(queryStart + 1));
  params.set('instanceId', instanceId);
  return `/mcp?${params}`;
}

/**
 * The resource_metadata URL for a 401 on `<mount><path>`, as Express reports
 * them inside app.use() (req.baseUrl, req.path). The path form gets its own
 * document, because RFC 9728 §3.3 requires its `resource` to be the URL the
 * client called. Only /mcp has a path form, so an SSE mount gets the root one.
 */
export function resourceMetadataUrl(baseUrl: string, mount: string, path: string): string {
  const root = `${baseUrl}${PROTECTED_RESOURCE_METADATA_PATH}`;
  const instanceId = mount.endsWith('sse') ? null : instanceIdFromPath(`${mount}${path}`, mount);
  return instanceId ? `${root}${mount}/${instanceId}` : root;
}

/** The route serving the document resourceMetadataUrl points at for `mount`. */
export function instanceResourceMetadataRoute(mount: string): string {
  return `${PROTECTED_RESOURCE_METADATA_PATH}${mount}/:instanceId`;
}
