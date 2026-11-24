// src/supabase/restRoutes.ts
// The Supabase REST data plane (/api/v1/supabase/*) as data: one descriptor per
// endpoint, which webServer.ts registers from a loop. Same shape and reasons as
// src/pinecone/restRoutes.ts: the validation, the settings check, the status
// and the error contract live once, in the generic handler.
//
// A descriptor names its MCP TOOL, not a schema. The handler looks the tool's
// definition up in SUPABASE_TOOLS (server.ts) and validates with its own
// `parameters`, then runs it through `runSupabaseToolUncapped` — the body of
// the MCP tool minus the cap — so the connection's settings (project limit,
// read-only, feature groups) are applied by the same `argsForSettings` call
// with the same group and annotations. Nothing here restates either.
//
// Only the mapping from an HTTP request to the tool's arguments lives here:
// path params, query params, and the body. Path params override same-named
// body keys (root CLAUDE.md), so a URL and a body cannot disagree about which
// project a write lands in.
//
// Out of scope on purpose: every destructiveHint tool (execute_sql,
// apply_migration, deploy_edge_function, the branch_id-only branch tools,
// update_storage_config, delete_feedback, run_notebook). See
// src/__tests__/mcpToolsRestCoverage.test.ts for their reasons.

/** The parts of an Express request a descriptor reads. */
export interface SupabaseRestRequest {
  params: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  body?: unknown;
}

export interface SupabaseRestRoute {
  /** Express path. Array order is registration order. */
  path: string;
  method: 'get' | 'post';
  /** The upstream tool name, as registered in SUPABASE_TOOLS. */
  tool: string;
  /** 201 where the call creates a resource; 200 otherwise. */
  status: 200 | 201;
  /** The tool's arguments, before validation with the tool's own schema. */
  args: (req: SupabaseRestRequest) => Record<string, unknown>;
  fallback: string;
}

const param = (req: SupabaseRestRequest, name: string): string => {
  const v = req.params[name];
  return Array.isArray(v) ? v.join('/') : (v ?? '');
};

/** A body object, or {} — spreading a non-object would throw. */
const bodyOf = (req: SupabaseRestRequest): Record<string, unknown> =>
  req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};

/**
 * A query value for the tool's schema to judge. A single string passes as is;
 * a repeated or nested key (an array or object) is passed through too, so the
 * schema REJECTS it rather than this layer silently picking one value.
 */
const q = (req: SupabaseRestRequest, name: string): unknown => {
  const v = req.query[name];
  return v === '' ? undefined : v;
};

/** `true`/`1` and `false`/`0`; anything else goes to the schema to reject. */
const qbool = (req: SupabaseRestRequest, name: string): unknown => {
  const v = q(req, name);
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return v;
};

/** `?schemas=public,auth` or `?schemas=public&schemas=auth`. */
const qlist = (req: SupabaseRestRequest, name: string): unknown => {
  const v = q(req, name);
  if (v === undefined) return undefined;
  const parts = Array.isArray(v) ? v : [v];
  if (!parts.every((p) => typeof p === 'string')) return v;
  return (parts as string[]).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
};

/** Drop undefined keys so the tool's schema applies its own defaults. */
function defined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

const project = (req: SupabaseRestRequest) => ({ project_id: param(req, 'projectId') });

// Array order is registration order. Express matches whole paths, so nothing
// here shadows anything today; keep a static segment (`/cost`, `/logs/query`,
// `/storage/...`) ahead of a parameterised sibling if one is ever added.
export const SUPABASE_REST_ROUTES: ReadonlyArray<SupabaseRestRoute> = [
  // ---- docs ----
  {
    path: '/api/v1/supabase/docs/search', method: 'get', tool: 'search_docs', status: 200,
    args: (req) => defined({ graphql_query: q(req, 'graphql_query') }),
    fallback: 'Failed to search the Supabase documentation',
  },

  // ---- account ----
  {
    path: '/api/v1/supabase/organizations', method: 'get', tool: 'list_organizations', status: 200,
    args: () => ({}),
    fallback: 'Failed to list Supabase organizations',
  },
  {
    path: '/api/v1/supabase/organizations/:organizationId/cost', method: 'get', tool: 'get_cost', status: 200,
    args: (req) => defined({ type: q(req, 'type'), organization_id: param(req, 'organizationId') }),
    fallback: 'Failed to get the Supabase cost',
  },
  {
    path: '/api/v1/supabase/organizations/:organizationId', method: 'get', tool: 'get_organization', status: 200,
    args: (req) => ({ id: param(req, 'organizationId') }),
    fallback: 'Failed to get the Supabase organization',
  },
  {
    // POST: a step in the create flow, not a lookup. It reads nothing upstream
    // stores, but its answer is the caller's assent to a charge, and a GET is
    // fair game for a proxy or crawler to repeat.
    path: '/api/v1/supabase/cost/confirm', method: 'post', tool: 'confirm_cost', status: 200,
    args: (req) => bodyOf(req),
    fallback: 'Failed to confirm the Supabase cost',
  },
  {
    path: '/api/v1/supabase/projects', method: 'get', tool: 'list_projects', status: 200,
    args: () => ({}),
    fallback: 'Failed to list Supabase projects',
  },
  {
    path: '/api/v1/supabase/projects', method: 'post', tool: 'create_project', status: 201,
    args: (req) => bodyOf(req),
    fallback: 'Failed to create the Supabase project',
  },
  {
    path: '/api/v1/supabase/projects/:projectId', method: 'get', tool: 'get_project', status: 200,
    args: (req) => ({ id: param(req, 'projectId') }),
    fallback: 'Failed to get the Supabase project',
  },
  {
    path: '/api/v1/supabase/projects/:projectId/pause', method: 'post', tool: 'pause_project', status: 200,
    args: (req) => ({ ...bodyOf(req), ...project(req) }),
    fallback: 'Failed to pause the Supabase project',
  },
  {
    path: '/api/v1/supabase/projects/:projectId/restore', method: 'post', tool: 'restore_project', status: 200,
    args: (req) => ({ ...bodyOf(req), ...project(req) }),
    fallback: 'Failed to restore the Supabase project',
  },

  // ---- database ----
  {
    path: '/api/v1/supabase/projects/:projectId/tables', method: 'get', tool: 'list_tables', status: 200,
    args: (req) => defined({ ...project(req), schemas: qlist(req, 'schemas'), verbose: qbool(req, 'verbose') }),
    fallback: 'Failed to list Supabase tables',
  },
  {
    path: '/api/v1/supabase/projects/:projectId/extensions', method: 'get', tool: 'list_extensions', status: 200,
    args: (req) => project(req),
    fallback: 'Failed to list Supabase extensions',
  },
  {
    path: '/api/v1/supabase/projects/:projectId/migrations', method: 'get', tool: 'list_migrations', status: 200,
    args: (req) => project(req),
    fallback: 'Failed to list Supabase migrations',
  },

  // ---- debugging ----
  {
    path: '/api/v1/supabase/projects/:projectId/logs/query', method: 'get', tool: 'query_logs', status: 200,
    args: (req) => defined({
      ...project(req),
      sql: q(req, 'sql'),
      iso_timestamp_start: q(req, 'iso_timestamp_start'),
      iso_timestamp_end: q(req, 'iso_timestamp_end'),
    }),
    fallback: 'Failed to query Supabase logs',
  },
  {
    path: '/api/v1/supabase/projects/:projectId/logs', method: 'get', tool: 'get_logs', status: 200,
    args: (req) => defined({
      ...project(req),
      service: q(req, 'service'),
      iso_timestamp_start: q(req, 'iso_timestamp_start'),
      iso_timestamp_end: q(req, 'iso_timestamp_end'),
    }),
    fallback: 'Failed to get Supabase logs',
  },
  {
    path: '/api/v1/supabase/projects/:projectId/advisors', method: 'get', tool: 'get_advisors', status: 200,
    args: (req) => defined({ ...project(req), type: q(req, 'type') }),
    fallback: 'Failed to get Supabase advisors',
  },

  // ---- development ----
  {
    path: '/api/v1/supabase/projects/:projectId/url', method: 'get', tool: 'get_project_url', status: 200,
    args: (req) => project(req),
    fallback: 'Failed to get the Supabase project URL',
  },
  {
    path: '/api/v1/supabase/projects/:projectId/publishable-keys', method: 'get', tool: 'get_publishable_keys', status: 200,
    args: (req) => project(req),
    fallback: 'Failed to get the Supabase publishable keys',
  },
  {
    path: '/api/v1/supabase/projects/:projectId/types', method: 'get', tool: 'generate_typescript_types', status: 200,
    args: (req) => project(req),
    fallback: 'Failed to generate Supabase TypeScript types',
  },

  // ---- functions ----
  {
    path: '/api/v1/supabase/projects/:projectId/functions', method: 'get', tool: 'list_edge_functions', status: 200,
    args: (req) => project(req),
    fallback: 'Failed to list Supabase Edge Functions',
  },
  {
    path: '/api/v1/supabase/projects/:projectId/functions/:functionSlug', method: 'get', tool: 'get_edge_function', status: 200,
    args: (req) => ({ ...project(req), function_slug: param(req, 'functionSlug') }),
    fallback: 'Failed to get the Supabase Edge Function',
  },

  // ---- branching ----
  {
    path: '/api/v1/supabase/projects/:projectId/branches', method: 'get', tool: 'list_branches', status: 200,
    args: (req) => project(req),
    fallback: 'Failed to list Supabase branches',
  },
  {
    path: '/api/v1/supabase/projects/:projectId/branches', method: 'post', tool: 'create_branch', status: 201,
    args: (req) => ({ ...bodyOf(req), ...project(req) }),
    fallback: 'Failed to create the Supabase branch',
  },

  // ---- storage ----
  {
    path: '/api/v1/supabase/projects/:projectId/storage/buckets', method: 'get', tool: 'list_storage_buckets', status: 200,
    args: (req) => project(req),
    fallback: 'Failed to list Supabase storage buckets',
  },
  {
    path: '/api/v1/supabase/projects/:projectId/storage/config', method: 'get', tool: 'get_storage_config', status: 200,
    args: (req) => project(req),
    fallback: 'Failed to get the Supabase storage config',
  },

  // ---- notebooks ----
  {
    path: '/api/v1/supabase/projects/:projectId/notebooks', method: 'get', tool: 'list_notebooks', status: 200,
    args: (req) => project(req),
    fallback: 'Failed to list Supabase notebooks',
  },
  {
    path: '/api/v1/supabase/projects/:projectId/notebooks', method: 'post', tool: 'create_notebook', status: 201,
    args: (req) => ({ ...bodyOf(req), ...project(req) }),
    fallback: 'Failed to create the Supabase notebook',
  },
  {
    path: '/api/v1/supabase/projects/:projectId/notebooks/:notebookId', method: 'get', tool: 'get_notebook', status: 200,
    args: (req) => ({ ...project(req), notebook_id: param(req, 'notebookId') }),
    fallback: 'Failed to get the Supabase notebook',
  },

  // ---- feedback ----
  {
    path: '/api/v1/supabase/feedback', method: 'post', tool: 'submit_feedback', status: 201,
    args: (req) => bodyOf(req),
    fallback: 'Failed to submit Supabase feedback',
  },
];
