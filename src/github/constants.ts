// src/github/constants.ts
// The GitHub REST API host and the headers every request carries. A leaf
// module on purpose: the client, the paste-token probe and the OAuth exchange
// all need these, and the latter two are imported BY the client, so keeping
// them in apiHelpers.ts would make an import cycle.

/**
 * github.com only. GitHub Enterprise Server lives at `https://<host>/api/v3`
 * with its own OAuth endpoints, and supporting it means a per-connection base
 * URL guarded the way Outline's and Redmine's are — not an env override that
 * would send every user's token to one configurable host.
 */
export const GITHUB_API_BASE_URL = 'https://api.github.com';

/** Pinned so a GitHub-side default change cannot silently reshape responses. */
export const GITHUB_API_VERSION = '2022-11-28';

/**
 * GitHub REJECTS requests without a User-Agent (403, "Request forbidden by
 * administrative rules"), and asks that it name the integration.
 */
export const GITHUB_USER_AGENT = 'mcp-googledocs-server-github-connector';

export function githubHeaders(token: string, accept = 'application/vnd.github+json'): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': GITHUB_USER_AGENT,
  };
}
