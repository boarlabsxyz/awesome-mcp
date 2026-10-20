// src/github/ownerDiscovery.ts
// Builds the checkbox list in the dashboard's GitHub Access Rules dialog: the
// connected account plus every organization (or other user) it can reach.
//
// Three sources, because no single one is complete:
//   - `GET /user/orgs` — every organization the account belongs to, public or
//     private, but only with the `read:org` scope (403 without it, which is
//     every connection made before the scope was added, and every classic PAT
//     that lacks it). A fine-grained token gets 200 and an EMPTY list.
//   - `GET /users/{login}/orgs` — public memberships only, but needs no scope,
//     so it is the fallback that keeps a `repo`-only connection from showing
//     nothing at all.
//   - owners of `GET /user/repos` — every owner the token can actually READ.
//
// The third is also the diagnostic. An organization the account belongs to
// that contributes NO visible repository is almost always one that restricts
// OAuth Apps and has not approved this one: GitHub then hides its private
// resources from the token entirely, so calls into it fail however the
// connector's own rules are set. Counting visible repositories per owner is
// what lets the dialog and `listOrganizations` say so instead of listing the
// organization as if it were usable.
//
// As with Slack, a missing row is a silent access failure, not a cosmetic
// one: an owner with no checkbox can never be allowed. So every cap is
// reported (`truncated` + `notes`) rather than quietly shortening the list.

import type { GitHubClient } from './apiHelpers.js';

/** 100 repositories a page; 10 pages covers 1,000 before reporting truncation. */
export const REPO_DISCOVERY_MAX_PAGES = 10;

export interface DiscoveredOwner {
  login: string;
  /** 'Organization' or 'User', as GitHub reports it; null for a saved owner not seen in this scan. */
  type: string | null;
  /** In the saved rules. */
  saved: boolean;
  /** Seen in this scan. False for a saved owner that no longer appears. */
  discovered: boolean;
  /** The account is a member (from a membership list, not inferred from repositories). */
  member: boolean;
  /** Repositories of this owner the token can read, from the scan — a floor when `truncated`. */
  repos: number;
}

/**
 * How complete the membership list is: `full` (read:org granted), `public-only`
 * (no read:org — private memberships are missing), or `fine-grained` (a
 * fine-grained token, which belongs to one owner and lists no organizations).
 */
export type MembershipCoverage = 'full' | 'public-only' | 'fine-grained';

export interface OwnerDiscoveryResult {
  self: string;
  /** Every owner other than the connected account, sorted by login. */
  owners: DiscoveredOwner[];
  /** Repositories of the connected account itself, from the scan. */
  selfRepos: number;
  membership: MembershipCoverage;
  truncated: boolean;
  notes: string[];
}

type Found = { login: string; type: string | null; member: boolean; repos: number };

/** Organizations the account belongs to, from the best source the token allows. */
async function listMemberships(client: GitHubClient, self: string): Promise<{ logins: string[]; coverage: MembershipCoverage }> {
  try {
    const res = await client.get<Array<{ login?: string }>>('/user/orgs', { per_page: 100 });
    const logins = res.data.map(o => o.login).filter((l): l is string => typeof l === 'string');
    // Classic/OAuth tokens report their scopes; fine-grained ones send no header.
    if (res.headers.get('x-oauth-scopes') === null && !logins.length) return { logins, coverage: 'fine-grained' };
    return { logins, coverage: 'full' };
  } catch {
    // 403 without read:org. Public memberships need no scope at all.
    try {
      const res = await client.get<Array<{ login?: string }>>(`/users/${encodeURIComponent(self)}/orgs`, { per_page: 100 });
      return { logins: res.data.map(o => o.login).filter((l): l is string => typeof l === 'string'), coverage: 'public-only' };
    } catch {
      return { logins: [], coverage: 'public-only' };
    }
  }
}

export async function discoverGitHubOwners(
  client: GitHubClient,
  opts: { savedOwners?: string[] } = {},
): Promise<OwnerDiscoveryResult> {
  const { data: me } = await client.get<{ login: string }>('/user');
  const self = me.login;
  const selfKey = self.toLowerCase();
  const found = new Map<string, Found>();
  const notes: string[] = [];
  let truncated = false;
  let selfRepos = 0;

  const entry = (login: string, type: string | null): Found | null => {
    const key = login.toLowerCase();
    if (key === selfKey) return null;
    let row = found.get(key);
    if (!row) { row = { login, type, member: false, repos: 0 }; found.set(key, row); }
    if (!row.type && type) row.type = type;
    return row;
  };

  for (let page = 1; ; page += 1) {
    const res = await client.get<Array<{ owner?: { login?: string; type?: string } }>>('/user/repos', {
      affiliation: 'owner,collaborator,organization_member', per_page: 100, page,
    });
    for (const repo of res.data) {
      const login = repo.owner?.login;
      if (typeof login !== 'string' || !login) continue;
      if (login.toLowerCase() === selfKey) { selfRepos += 1; continue; }
      entry(login, typeof repo.owner?.type === 'string' ? repo.owner.type : null)!.repos += 1;
    }
    if (!res.page.next) break;
    if (page >= REPO_DISCOVERY_MAX_PAGES) {
      truncated = true;
      notes.push(`Only the first ${REPO_DISCOVERY_MAX_PAGES * 100} repositories were scanned, so repository counts are a floor and an owner whose repositories all come later is missing; add it by name.`);
      break;
    }
  }

  const { logins, coverage } = await listMemberships(client, self);
  for (const login of logins) {
    const row = entry(login, 'Organization');
    if (row) row.member = true;
  }
  if (coverage === 'public-only') {
    notes.push('Private organization memberships are not listed: this connection was not granted the read:org scope. Reconnect it from the dashboard to list every organization you belong to.');
  } else if (coverage === 'fine-grained') {
    notes.push('This token lists no organizations. A fine-grained token belongs to a single owner, so organizations other than the one it was created for are not reachable through it.');
  }

  const savedKeys = new Set((opts.savedOwners ?? []).map(o => o.toLowerCase()));
  const owners: DiscoveredOwner[] = [...found.values()].map(o => ({
    ...o, saved: savedKeys.has(o.login.toLowerCase()), discovered: true,
  }));
  // A saved owner nobody rediscovered still gets its row: the dialog rebuilds
  // the list from what it renders, so a missing row would mean opening it and
  // pressing Save revoked an organization nobody asked to revoke (Slack's bug).
  for (const key of savedKeys) {
    if (key !== selfKey && !found.has(key)) {
      owners.push({ login: key, type: null, saved: true, discovered: false, member: false, repos: 0 });
    }
  }
  owners.sort((a, b) => a.login.localeCompare(b.login, 'en', { sensitivity: 'base' }));
  return { self, owners, selfRepos, membership: coverage, truncated, notes };
}

/**
 * Where a member asks an organization to approve this OAuth App. GitHub's own
 * page for one authorized application lists every organization with a
 * Grant (owner) or Request (member) button. Null without a client id, which is
 * a pasted-token deployment: there is no app to approve, and a fine-grained
 * token is scoped per organization instead.
 */
export function oauthAppApprovalUrl(clientId: string | undefined = process.env.GITHUB_CLIENT_ID): string | null {
  return clientId ? `https://github.com/settings/connections/applications/${encodeURIComponent(clientId)}` : null;
}
