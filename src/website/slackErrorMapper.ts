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

/**
 * The status for a failed Slack WRITE on the REST plane.
 *
 * Two differences from the read mapping above:
 *
 * - The shared write ops (`performPostMessage` / `performEditMessage`) replace
 *   Slack's bare codes with instructions, so the code is no longer in the
 *   message. Those refusals carry a numeric `status` instead, and it wins.
 * - An upstream 401 becomes 502. On this plane a 401 means the caller's bearer
 *   was refused; here the bearer was fine and Slack rejected the connection's
 *   own token, which the caller fixes by reconnecting, not by re-minting.
 */
export function slackWriteErrorStatus(err: unknown): number {
  const tagged = (err as { status?: unknown })?.status;
  if (typeof tagged === 'number') return tagged;
  const msg = String((err as { message?: unknown })?.message ?? '').toLowerCase();
  if (msg.includes('is_archived') || msg.includes('restricted_action')) return 403;
  if (msg.includes('no_text') || msg.includes('invalid_arguments') || msg.includes('msg_too_long')) return 400;
  const mapped = mapSlackErrorToHttpStatus(err);
  return mapped === 401 ? 502 : mapped;
}
