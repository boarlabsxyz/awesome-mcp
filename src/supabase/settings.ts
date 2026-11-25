// src/supabase/settings.ts
// Per-connection options for the hosted Supabase MCP server: a project the
// connection is limited to, read-only mode, and which feature groups it gets.
// Supabase takes all three as query parameters on its hosted URL
// (https://supabase.com/docs/guides/ai-tools/mcp#configuration-options); they
// restrict the connection without touching its credential.
//
// Stored on the connection (providerTokens.supabaseSettings), set from the
// dashboard, and re-read on every call: MCP sessions are cached, so a copy on
// the session would keep serving settings the user already changed.
//
// The same rules are also applied HERE, before forwarding, because this
// server's tool list is fixed at registration: a tool Supabase disabled for the
// connection is still offered to the model, and an upstream "unknown tool"
// would explain nothing. A local refusal names the setting that blocks it.

import { UserError } from 'fastmcp';

import type { SupabaseToolDef } from './schemas.js';

/** Supabase's feature groups (upstream CURRENT_FEATURE_GROUPS, src/types.ts). */
export const SUPABASE_FEATURE_GROUPS = [
  'docs', 'account', 'database', 'debugging', 'development', 'functions', 'branching', 'storage', 'notebooks', 'feedback',
] as const;
export type SupabaseFeatureGroup = (typeof SUPABASE_FEATURE_GROUPS)[number];

export type SupabaseSettings = {
  /** Limit the connection to one project; account tools are then off upstream. */
  projectRef?: string;
  /** Run SQL as a read-only Postgres user and refuse writes. */
  readOnly?: boolean;
  /** Feature groups to enable. Absent = every group this connector mirrors. */
  features?: SupabaseFeatureGroup[];
};

/**
 * Tools that are not read-only but that Supabase ADAPTS in read-only mode
 * instead of refusing: execute_sql runs as the read-only user, run_notebook
 * runs its cells read-only. Refusing them locally would remove reads.
 */
const ADAPTS_TO_READ_ONLY = new Set(['execute_sql', 'run_notebook']);

/**
 * Branch tools that take only a branch_id. Supabase does not tie them to the
 * limited project (they are not project-injected upstream), so under a project
 * limit a branch of ANOTHER project would be acted on. Refused instead.
 */
const BRANCH_ID_ONLY = new Set(['delete_branch', 'merge_branch', 'reset_branch', 'rebase_branch']);

/** Which connection setting refused a call. */
export type SupabaseSettingName = 'features' | 'projectRef' | 'readOnly';

/**
 * A call this connection's settings rule out. Still a UserError, so the MCP
 * tool shows the message unchanged; the name and `setting` let the REST plane
 * answer 403 naming the setting without matching on message text.
 */
export class SupabaseSettingDenied extends UserError {
  readonly setting: SupabaseSettingName;
  constructor(setting: SupabaseSettingName, message: string) {
    super(message);
    this.setting = setting;
  }
}

/** A project ref: Supabase uses 20 lowercase letters; accept a little wider, never a URL or path. */
const PROJECT_REF = /^[a-z0-9]{10,40}$/;

/** Validate what the dashboard posts. Returns the settings to store, or an error message. */
export function normalizeSupabaseSettings(raw: unknown): { settings: SupabaseSettings } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'settings must be an object' };
  const r = raw as Record<string, unknown>;
  const out: SupabaseSettings = {};
  if (r.projectRef !== undefined && r.projectRef !== null && r.projectRef !== '') {
    const ref = String(r.projectRef).trim();
    if (!PROJECT_REF.test(ref)) return { error: 'projectRef must be a Supabase project ref (the ID in the project URL, e.g. abcdefghijklmnopqrst)' };
    out.projectRef = ref;
  }
  if (r.readOnly !== undefined) {
    if (typeof r.readOnly !== 'boolean') return { error: 'readOnly must be true or false' };
    if (r.readOnly) out.readOnly = true;
  }
  if (r.features !== undefined && r.features !== null) {
    if (!Array.isArray(r.features)) return { error: 'features must be a list of feature groups' };
    const unknown = r.features.filter((f) => !(SUPABASE_FEATURE_GROUPS as readonly unknown[]).includes(f));
    if (unknown.length) return { error: `Unknown feature group(s): ${unknown.join(', ')}. Valid: ${SUPABASE_FEATURE_GROUPS.join(', ')}` };
    if (r.features.length === 0) return { error: 'Enable at least one feature group' };
    const features = [...new Set(r.features as SupabaseFeatureGroup[])];
    // Storing "all of them" as absent keeps a later new group enabled by default.
    if (features.length < SUPABASE_FEATURE_GROUPS.length) out.features = features;
  }
  return { settings: out };
}

/**
 * The hosted URL for these settings. The origin is the constant; only the three
 * allowlisted parameters are set, so stored settings can never point the
 * credential at another host.
 *
 * `features` is ALWAYS sent: Supabase leaves storage off unless asked, and this
 * connector registers storage tools, so the default has to name the groups.
 */
export function hostedUrlFor(baseUrl: string, settings: SupabaseSettings = {}): string {
  const url = new URL(baseUrl);
  url.searchParams.set('features', (settings.features ?? SUPABASE_FEATURE_GROUPS).join(','));
  if (settings.readOnly) url.searchParams.set('read_only', 'true');
  if (settings.projectRef) url.searchParams.set('project_ref', settings.projectRef);
  return url.toString();
}

/**
 * Refuse a call the connection's settings rule out, naming the setting, and
 * return the arguments to forward. With a project ref, Supabase injects the
 * project itself, so a `project_id` naming another project is refused and the
 * matching one is dropped.
 */
export function argsForSettings(
  def: Pick<SupabaseToolDef, 'name' | 'group' | 'annotations'>,
  args: Record<string, unknown>,
  settings: SupabaseSettings = {},
): Record<string, unknown> {
  const features = settings.features ?? SUPABASE_FEATURE_GROUPS;
  if (!(features as readonly string[]).includes(def.group)) {
    throw new SupabaseSettingDenied('features', `'${def.name}' is in the ${def.group} feature group, which this Supabase connection has turned off. Turn it on in the connection's Settings on the dashboard.`);
  }
  if (settings.projectRef && def.group === 'account') {
    throw new SupabaseSettingDenied('projectRef', `'${def.name}' is an account tool, and this Supabase connection is limited to project ${settings.projectRef}, which turns account tools off. Remove the project limit in the connection's Settings to use it.`);
  }
  if (settings.projectRef && BRANCH_ID_ONLY.has(def.name)) {
    throw new SupabaseSettingDenied('projectRef', `'${def.name}' acts on a branch by its ID alone, and Supabase does not check which project that branch belongs to, so this connection (limited to project ${settings.projectRef}) does not offer it. Remove the project limit in the connection's Settings to use it.`);
  }
  if (settings.readOnly && !def.annotations.readOnlyHint && !ADAPTS_TO_READ_ONLY.has(def.name)) {
    throw new SupabaseSettingDenied('readOnly', `'${def.name}' writes, and this Supabase connection is read-only. Turn read-only off in the connection's Settings to use it.`);
  }
  if (!settings.projectRef || !('project_id' in args)) return args;
  const { project_id, ...rest } = args;
  if (project_id !== undefined && project_id !== null && project_id !== settings.projectRef) {
    throw new SupabaseSettingDenied('projectRef', `This Supabase connection is limited to project ${settings.projectRef}; '${String(project_id)}' is a different project (a branch is its own project too). Nothing was run.`);
  }
  return rest;
}
