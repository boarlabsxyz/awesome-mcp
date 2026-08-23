// Translate the UserError messages thrown by SlackClient into the right HTTP
// status code so REST consumers can branch on the response code instead of
// parsing the error string.
//
// SlackClient (src/slack/apiHelpers.ts) embeds either the Slack-level error
// code (e.g. "invalid_auth") or the upstream HTTP status (e.g.
// "HTTP error (401)") in err.message — there is no err.status field, which is
// why a naive `err.status === 401 ? 401 : 500` was always returning 500.

export function mapSlackErrorToHttpStatus(err: unknown): number {
  const msg = String((err as { message?: unknown })?.message ?? '').toLowerCase();
  const httpMatch = msg.match(/http error \((\d{3})\)/);
  if (httpMatch) {
    const code = Number.parseInt(httpMatch[1], 10);
    if (code === 401 || code === 403 || code === 404 || code === 429) return code;
  }
  if (msg.includes('rate limit') || msg.includes('ratelimited')) return 429;
  if (
    msg.includes('invalid_auth') ||
    msg.includes('not_authed') ||
    msg.includes('token_revoked') ||
    msg.includes('token_expired')
  ) {
    return 401;
  }
  if (
    msg.includes('missing_scope') ||
    msg.includes('account_inactive') ||
    msg.includes('no_permission')
  ) {
    return 403;
  }
  if (
    msg.includes('channel_not_found') ||
    msg.includes('user_not_found') ||
    msg.includes('thread_not_found') ||
    msg.includes('not_in_channel')
  ) {
    return 404;
  }
  return 500;
}
