// src/redmine/authMode.ts
// Which credential a Redmine connection holds, and how to read it back.
//
// Its own module rather than living in apiHelpers.ts because userSession.ts
// needs it too, and apiHelpers.ts already imports UserSession from there —
// putting it here keeps that from becoming an import cycle.

/** 'oauth' sends `Authorization: Bearer`; 'apiKey' sends `X-Redmine-API-Key`. */
export type RedmineAuthMode = 'apiKey' | 'oauth';

/**
 * Resolve the stored auth mode, falling back to the legacy heuristic.
 *
 * The mode is stored explicitly because the heuristic ("a refresh token means
 * OAuth") is wrong whenever Redmine returns an access token with no refresh
 * token: the OAuth token would then go out as X-Redmine-API-Key and be
 * rejected, reporting a healthy connection as a bad credential. The heuristic
 * survives only for rows written before the field existed.
 */
export function resolveRedmineAuthMode(
  stored: string | undefined,
  hasRefreshToken: boolean,
): RedmineAuthMode {
  if (stored === 'oauth' || stored === 'apiKey') return stored;
  return hasRefreshToken ? 'oauth' : 'apiKey';
}
