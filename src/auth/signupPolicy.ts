// Who may create an account.
//
// ALLOWED_SIGNUP_DOMAINS restricts NEW accounts to the listed email domains, so
// a company running this platform does not hand an account (and an API key) to
// anyone with a Google login. It never touches existing accounts: every sign-in
// path finds the existing user before it would create one, and nothing re-checks
// an account per request, so cutting off an existing one is an admin action,
// not this list. Unset or empty means everyone, as before.
//
// Read per call rather than at module load, like ADMIN_EMAILS (src/auth/admin.ts),
// so a restarted service and one still running cannot disagree.

import { isAdminEmail } from './admin.js';
import type { UserRecord } from '../userStore.js';

/** The configured sign-up domains, lowercased, without a leading `@`. Empty = no restriction. */
export function allowedSignupDomains(): string[] {
  return (process.env.ALLOWED_SIGNUP_DOMAINS || '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

/**
 * True when a new account may be created for `email`. Always true with no list
 * configured. Anything that is not an address with a domain is refused once a
 * list is set.
 *
 * `exemptAdmins` lets an ADMIN_EMAILS address through even outside the list,
 * so a list that forgets the admins' own domain cannot lock them out. Pass it
 * ONLY where the address is already proven (a verified Google or Auth0 email).
 * On an unproven path such as password register, a different answer for admin
 * addresses would tell anyone probing which outside addresses are admins.
 */
export function isSignupAllowed(email: unknown, opts: { exemptAdmins?: boolean } = {}): boolean {
  const domains = allowedSignupDomains();
  if (domains.length === 0) return true;
  if (typeof email !== 'string') return false;
  const normalized = email.trim().toLowerCase();
  if (opts.exemptAdmins && isAdminEmail(normalized)) return true;
  const at = normalized.lastIndexOf('@');
  if (at <= 0 || at === normalized.length - 1) return false;
  return domains.includes(normalized.slice(at + 1));
}

/** Shown to a person whose sign-up the domain list refused. */
export const SIGNUP_NOT_ALLOWED_MESSAGE =
  'New accounts on this server are limited to approved email domains, and this address is not in one. Ask the administrator for access.';

/**
 * A new account was refused because its email domain is not in
 * ALLOWED_SIGNUP_DOMAINS. Mapped to 403 `signup_domain_not_allowed`; never
 * retryable, so never the generic 503.
 */
export class SignupNotAllowedError extends Error {
  constructor() {
    super(SIGNUP_NOT_ALLOWED_MESSAGE);
    this.name = 'SignupNotAllowedError';
  }
}

export type GoogleSignInDecision =
  | { allowed: true }
  | { allowed: false; reason: 'email_not_verified' | 'signup_domain_not_allowed'; message: string };

/**
 * Whether a Google sign-in may go on to `createOrUpdateUser`, which links by
 * googleId, then by email, then creates, and writes the email it is given
 * into the account.
 *
 * - Already linked by googleId, same email: allowed. Nothing changes hands.
 * - Already linked by googleId, DIFFERENT email: allowed only when Google
 *   verified the new address, because the account's email is rewritten to it
 *   and an unproven address must never become an account's email (an admin's,
 *   say: ADMIN_EMAILS is matched by email).
 * - Matches an existing account only by email: allowed only when Google says
 *   the address is verified. Otherwise anyone who can attach an address to a
 *   Google account without proving it would sign in as its owner (an admin
 *   included, since ADMIN_EMAILS is matched by email). The same rule
 *   mapJwtToUser applies to Auth0.
 * - New account: the address must be verified, so an unproven address is never
 *   stored as an account's email, and must pass isSignupAllowed.
 */
export function decideGoogleSignIn(input: {
  email: string;
  emailVerified: boolean | null | undefined;
  byGoogleId: UserRecord | undefined;
  byEmail: UserRecord | undefined;
}): GoogleSignInDecision {
  if (input.byGoogleId && (input.byGoogleId.email === input.email || input.emailVerified === true)) {
    return { allowed: true };
  }
  if (input.emailVerified !== true) {
    return {
      allowed: false,
      reason: 'email_not_verified',
      message: `Google has not verified the address ${input.email}, so it cannot be used to sign in or create an account here. Verify it with Google, or sign in another way.`,
    };
  }
  if (input.byEmail) return { allowed: true };
  if (input.byGoogleId) return { allowed: true }; // verified, changed email on a linked account
  if (!isSignupAllowed(input.email, { exemptAdmins: true })) {
    return { allowed: false, reason: 'signup_domain_not_allowed', message: SIGNUP_NOT_ALLOWED_MESSAGE };
  }
  return { allowed: true };
}
