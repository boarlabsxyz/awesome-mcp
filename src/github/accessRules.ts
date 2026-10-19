// src/github/accessRules.ts
// Per-connection owner allowlist ("Allowed Organisations" in the dashboard),
// stored in providerTokens.accessRules exactly like Slack's and Browserbase's
// rules. It is what lets one GitHub account back several connectors, each
// limited to the organizations its workspace should reach.
//
// A GUARDRAIL, NOT A SECURITY BOUNDARY. An OAuth or classic token reaches every
// organization the account granted; these rules make this connector refuse,
// they do not change what the token can do. A fine-grained PAT scoped to one
// owner is the GitHub-enforced alternative, and the dashboard says so.
//
// Semantics:
//   - No rules stored (`accessRules` absent): UNRESTRICTED. Every connector
//     made before this existed keeps working, and a new one is usable before
//     anyone opens the dialog — the Browserbase default, not Slack's.
//   - Rules stored: only the listed owners (users or organizations) are
//     reachable. The dashboard always includes the connected account itself.
//   - The stored rules could not be READ: fail CLOSED. Browserbase fails open
//     on a lookup error because its stored default is "no restriction"; here a
//     user who saved rules asked for other workspaces to be unreachable, and a
//     database blip is not a reason to hand them out.

import { UserError } from 'fastmcp';

import type { UserSession } from '../userSession.js';

export interface GitHubAccessRules {
  /** GitHub logins (users or organizations), lower-cased. */
  allowedOwners: string[];
}

/** Allowed owners, lower-cased; null means unrestricted. */
export type OwnerPolicy = ReadonlySet<string> | null;

/**
 * GitHub's own login rule: alphanumerics and single hyphens, no leading or
 * trailing hyphen, at most 39 characters. Anything else cannot name an owner,
 * so it is refused rather than saved as a rule that matches nothing.
 */
const LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

/** Normalise a pasted owner (login, `@login`, or a github.com URL) or return null. */
export function normalizeOwner(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let text = value.trim();
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#]+)/i.exec(text);
  if (url) text = url[1];
  text = text.replace(/^@/, '');
  return LOGIN.test(text) ? text.toLowerCase() : null;
}

export function policyFromRules(rules: unknown): OwnerPolicy {
  const owners = (rules as Partial<GitHubAccessRules> | null | undefined)?.allowedOwners;
  if (!Array.isArray(owners)) return null;
  return new Set(owners.map(o => normalizeOwner(o)).filter((o): o is string => !!o));
}

export function ownerAllowed(owner: string | null | undefined, policy: OwnerPolicy): boolean {
  if (!policy) return true;
  return !!owner && policy.has(owner.toLowerCase());
}

/** The owner a REST path addresses (`/repos/<owner>/...`), or null for any other path. */
export function ownerFromPath(path: string): string | null {
  const match = /^\/repos\/([^/?#]+)/.exec(path);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * The owner of a search result. Read from `repository_url`/`full_name` rather
 * than `owner.login` because those are present on every search type: an issue
 * carries only `repository_url`, a code hit only `repository`.
 */
export function searchItemOwner(item: any): string | null {
  const fromUrl = typeof item?.repository_url === 'string' ? /\/repos\/([^/]+)\//.exec(item.repository_url) : null;
  if (fromUrl) return fromUrl[1];
  const fullName = item?.repository?.full_name ?? item?.full_name;
  return typeof fullName === 'string' && fullName.includes('/') ? fullName.split('/')[0] : null;
}

export class GitHubAccessDenied extends UserError {
  /** What the REST plane answers. */
  readonly status = 403;

  constructor(owner: string, policy: ReadonlySet<string>) {
    const allowed = [...policy].sort((a, b) => a.localeCompare(b)).join(', ') || 'none';
    super(
      `This GitHub connector's access rules do not allow "${owner}" (allowed: ${allowed}). `
      + 'Change them from the dashboard: Access Rules on this connector. '
      + 'If another connector covers that organization, use it instead.',
    );
  }
}

/**
 * Validate the dashboard's POST body. `null` removes the restriction; an
 * object must name at least one valid owner. A name that cannot be a GitHub
 * login is refused rather than dropped: a rule the enforcement cannot match
 * would read as saved while restricting nothing the user meant it to.
 */
export function parseGitHubAccessRulesBody(
  accessRules: unknown,
): { ok: true; rules: GitHubAccessRules | null } | { ok: false; error: string } {
  if (accessRules === undefined) {
    return { ok: false, error: 'accessRules is required: an object, or null to remove the restriction' };
  }
  if (accessRules === null) return { ok: true, rules: null };
  const raw = (accessRules as { allowedOwners?: unknown }).allowedOwners;
  const allowedOwners: string[] = [];
  for (const value of Array.isArray(raw) ? raw : []) {
    const owner = normalizeOwner(value);
    if (!owner) return { ok: false, error: `${JSON.stringify(value)} is not a GitHub user or organization name.` };
    if (!allowedOwners.includes(owner)) allowedOwners.push(owner);
  }
  if (!allowedOwners.length) {
    return { ok: false, error: 'Allow at least one owner, or remove the rules to reach every organization.' };
  }
  return { ok: true, rules: { allowedOwners } };
}

export function assertOwnerAllowed(owner: string, policy: OwnerPolicy): void {
  if (policy && !ownerAllowed(owner, policy)) throw new GitHubAccessDenied(owner, policy);
}

/**
 * Read this connection's rules from storage, on every call. FastMCP's stateful
 * transport keeps the UserSession for the life of the MCP session, so a copy
 * taken when the session was built would go on serving rules the user has
 * since changed — in the permissive direction, too, if they just narrowed them.
 */
export async function loadGitHubOwnerPolicy(
  session: UserSession | undefined,
  lookup: (instanceId: string) => Promise<{ providerTokens?: unknown } | null> = defaultLookup,
): Promise<OwnerPolicy> {
  const instanceId = session?.githubInstanceId;
  if (!instanceId) return null;
  try {
    const connection = await lookup(instanceId);
    return policyFromRules((connection?.providerTokens as any)?.accessRules);
  } catch (err: any) {
    const error = new UserError(
      `Could not read this GitHub connector's access rules (${err?.message ?? err}), so the call was refused rather than run unrestricted. Try again in a moment.`,
    );
    (error as any).status = 503; // the REST plane's answer: ours to fix, retryable
    throw error;
  }
}

async function defaultLookup(instanceId: string) {
  const { getMcpConnectionByInstanceId } = await import('../mcpConnectionStore.js');
  return getMcpConnectionByInstanceId(instanceId);
}
