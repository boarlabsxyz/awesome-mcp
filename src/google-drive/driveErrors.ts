// Turning a Google Drive API error into something a user can act on.
//
// The bug this exists to prevent (ClickUp 86cb89z8q): a Drive 403 was mapped to
// a hardcoded "Permission denied. Make sure you have granted Google Drive
// access to the application." That string is wrong more often than it's right —
// Drive also returns 403 for quota exhaustion, for org policy blocks, and for
// per-file ACL problems — and it sent a user with a perfectly valid grant off to
// re-authorize, twice, while discarding the one piece of evidence (Google's
// `reason`) that would have identified the real cause.
//
// Rule: never invent a diagnosis. Report Google's reason verbatim, add the
// scope actually required for the operation, and say what to do next.

/** Reasons Drive returns with 403 that are NOT authorization problems. */
const RATE_LIMIT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'sharingRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
]);

/** 403 reasons that genuinely mean "this identity may not do that". */
const AUTHZ_REASONS = new Set([
  'insufficientFilePermissions',
  'appNotAuthorizedToFile',
  'domainPolicy',
  'forbidden',
  'cannotModifyInheritedPermission',
]);

export interface DriveErrorInfo {
  status?: number;
  reason?: string;
  googleMessage?: string;
}

/**
 * Dig the useful fields out of a googleapis/gaxios error. The shape varies by
 * transport and by whether the failure came from the client or the server, so
 * every access is defensive — this runs on an error path and must never throw.
 */
export function extractDriveError(err: any): DriveErrorInfo {
  const status: number | undefined =
    typeof err?.code === 'number' ? err.code : err?.response?.status ?? err?.status;

  const apiError = err?.response?.data?.error ?? err?.errors ?? undefined;
  const detail = Array.isArray(apiError)
    ? apiError[0]
    : Array.isArray(apiError?.errors)
      ? apiError.errors[0]
      : undefined;

  const reason: string | undefined = detail?.reason ?? err?.reason;
  const googleMessage: string | undefined =
    detail?.message ?? err?.response?.data?.error?.message ?? err?.message;

  return { status, reason, googleMessage };
}

/**
 * Build the message shown to the user.
 *
 * @param operation human-readable operation, e.g. "list spreadsheets"
 * @param requiredScope the OAuth scope this operation needs, so a real scope
 *        problem names the scope instead of saying "grant Drive access"
 */
export function describeDriveError(
  err: any,
  operation: string,
  requiredScope: string,
): string {
  const { status, reason, googleMessage } = extractDriveError(err);
  const suffix = googleMessage ? ` Google said: ${googleMessage}` : '';
  const because = reason ? ` (reason: ${reason})` : '';

  if (status === 401) {
    return `Google rejected the credentials while trying to ${operation}${because}. ` +
      `The connection needs to be re-authorized.${suffix}`;
  }

  if (status === 403) {
    if (reason && RATE_LIMIT_REASONS.has(reason)) {
      return `Google is rate-limiting this account, so ${operation} failed${because}. ` +
        `This is a quota problem, not a permission problem — retry shortly.${suffix}`;
    }
    if (reason && AUTHZ_REASONS.has(reason)) {
      return `Not authorized to ${operation}${because}. This grant covers the account ` +
        `but not this specific resource or action; re-authorizing will not change it.${suffix}`;
    }
    // Unknown 403 reason — the honest answer is "here's what Google said".
    // Naming the scope lets the user check the grant without guessing.
    return `Google returned 403 while trying to ${operation}${because}. ` +
      `If this is a scope problem the connection needs ${requiredScope}; ` +
      `note that Drive also returns 403 for quota limits and org policy, so ` +
      `re-authorizing may not help.${suffix}`;
  }

  if (status === 404) {
    return `Google could not find the resource needed to ${operation}${because}.${suffix}`;
  }

  return `Failed to ${operation}${because}.${suffix}`;
}
