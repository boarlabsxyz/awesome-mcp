// src/github/ownerDiscovery.ts
// Builds the checkbox list in the dashboard's GitHub Access Rules dialog: the
// connected account plus every organization (or other user) it can reach.
//
// `GET /user/orgs` is the obvious source and is NOT sufficient on its own: for
// an OAuth or classic token it needs the `read:org` (or `user`) scope and
// answers 403 without it, and this connector requests `repo` only — so on a
// default connection it lists nothing. The owners of the repositories the
// account can reach (`GET /user/repos`) need no extra scope and are the primary
// source; `/user/orgs` is added best-effort for a token that happens to carry
// the scope. An organization in which the account can see no repository is
// therefore missing from the list, which is why the dialog also takes a name
// by hand — the same escape hatch as Slack's workspace-ID box.
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
}

export interface OwnerDiscoveryResult {
  self: string;
  /** Every owner other than the connected account, sorted by login. */
  owners: DiscoveredOwner[];
  truncated: boolean;
  notes: string[];
}

export async function discoverGitHubOwners(
  client: GitHubClient,
  opts: { savedOwners?: string[] } = {},
): Promise<OwnerDiscoveryResult> {
  const { data: me } = await client.get<{ login: string }>('/user');
  const self = me.login;
  const found = new Map<string, { login: string; type: string | null }>();
  const notes: string[] = [];
  let truncated = false;

  const add = (login: unknown, type: unknown) => {
    if (typeof login !== 'string' || !login || login.toLowerCase() === self.toLowerCase()) return;
    const key = login.toLowerCase();
    if (!found.has(key)) found.set(key, { login, type: typeof type === 'string' ? type : null });
  };

  for (let page = 1; ; page += 1) {
    const res = await client.get<Array<{ owner?: { login?: string; type?: string } }>>('/user/repos', {
      affiliation: 'owner,collaborator,organization_member', per_page: 100, page,
    });
    for (const repo of res.data) add(repo.owner?.login, repo.owner?.type);
    if (!res.page.next) break;
    if (page >= REPO_DISCOVERY_MAX_PAGES) {
      truncated = true;
      notes.push(`Only the first ${REPO_DISCOVERY_MAX_PAGES * 100} repositories were scanned. An organization whose repositories all come later is missing; add it by name below.`);
      break;
    }
  }

  try {
    const res = await client.get<Array<{ login?: string }>>('/user/orgs', { per_page: 100 });
    for (const org of res.data) add(org.login, 'Organization');
  } catch {
    // The expected outcome on a `repo`-only token (403), not a fault; the
    // repository owners above are the list.
  }

  const savedKeys = new Set((opts.savedOwners ?? []).map(o => o.toLowerCase()));
  const owners: DiscoveredOwner[] = [...found.values()].map(o => ({
    ...o, saved: savedKeys.has(o.login.toLowerCase()), discovered: true,
  }));
  // A saved owner nobody rediscovered still gets its row: the dialog rebuilds
  // the list from what it renders, so a missing row would mean opening it and
  // pressing Save revoked an organization nobody asked to revoke (Slack's bug).
  for (const key of savedKeys) {
    if (key !== self.toLowerCase() && !found.has(key)) owners.push({ login: key, type: null, saved: true, discovered: false });
  }
  owners.sort((a, b) => a.login.localeCompare(b.login, 'en', { sensitivity: 'base' }));
  return { self, owners, truncated, notes };
}
