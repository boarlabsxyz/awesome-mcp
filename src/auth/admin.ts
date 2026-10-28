// The one definition of "is this person an administrator".
//
// ADMIN_EMAILS is the only admin gate in the system: OAuth scopes are not one
// (any user can obtain mcp:admin — see src/admin-mcp/CLAUDE.md), so every admin
// surface — the /admin page routes and the Admin MCP — must ask this function
// and nothing else. Read per call rather than at module load so the web
// service and the Admin MCP service cannot disagree after one of them is
// restarted with a new list.

/** The configured admin addresses, lowercased and trimmed. */
export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** True when `email` is in ADMIN_EMAILS (case-insensitive). Anything not a non-empty string is false. */
export function isAdminEmail(email: unknown): boolean {
  if (typeof email !== 'string' || !email.trim()) return false;
  return adminEmails().includes(email.trim().toLowerCase());
}
