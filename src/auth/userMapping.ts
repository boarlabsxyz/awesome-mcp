// src/auth/userMapping.ts
// Maps Auth0 JWT subject claims to internal user records.

import { getUserByAuth0Sub, setAuth0Sub, getUserByEmail, createUser, type UserRecord } from '../userStore.js';
import type { JwtPayload } from './jwtValidator.js';

/** Dependencies for user mapping, injectable for testing. */
export interface UserMappingDeps {
  getUserByAuth0Sub: (sub: string) => Promise<UserRecord | undefined>;
  setAuth0Sub: (userId: number, sub: string) => Promise<void>;
  getUserByEmail: (email: string) => Promise<UserRecord | undefined>;
  createUser: (profile: { email: string; name: string; auth0Sub?: string }) => Promise<UserRecord>;
}

const defaultDeps: UserMappingDeps = { getUserByAuth0Sub, setAuth0Sub, getUserByEmail, createUser };

/** Check if an error is a unique constraint violation (Postgres code 23505). */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && (err as any).code === '23505';
}

/**
 * An Auth0 identity whose email is not verified tried to sign in to an account
 * that already uses that address. Linking it would let anyone who can register
 * an address at the identity provider — without proving they own it — take
 * over the account, including an administrator's (ADMIN_EMAILS is matched by
 * email; see src/auth/admin.ts).
 */
export class UnverifiedEmailError extends Error {
  constructor(email: string) {
    super(`The email ${email} is not verified by the identity provider, so it cannot sign in to the existing account that uses it. Verify the address, or sign in with the provider that verified it.`);
    this.name = 'UnverifiedEmailError';
  }
}

/**
 * Resolve a JWT payload to an internal user record.
 *
 * 1. Look up by auth0_sub (fast path for returning users)
 * 2. Fall back to email match — ONLY for a verified email (links existing users on first JWT login)
 * 3. Auto-create a minimal user if completely new
 *
 * An unverified email is never trusted: it does not link (an existing account
 * with that address is refused with UnverifiedEmailError) and it is never
 * stored as a new account's email, which would otherwise pass isAdminEmail
 * if it were an administrator's address with no account yet.
 *
 * All mutation steps handle unique-constraint races by re-fetching on conflict.
 */
export async function mapJwtToUser(payload: JwtPayload, deps: UserMappingDeps = defaultDeps): Promise<UserRecord> {
  // 1. Direct lookup by Auth0 subject
  const bySubject = await deps.getUserByAuth0Sub(payload.sub);
  if (bySubject) {
    console.error(`[user-mapping] Found user by sub: id=${bySubject.id}, email=${bySubject.email}`);
    return bySubject;
  }

  const verifiedEmail = payload.email && payload.emailVerified === true ? payload.email : undefined;

  // 2. Email-based fallback — link existing user to their Auth0 subject
  if (payload.email) {
    const byEmail = await deps.getUserByEmail(payload.email);
    console.error(`[user-mapping] Email lookup for ${payload.email}: ${byEmail ? `found id=${byEmail.id}` : 'not found'}`);
    if (byEmail) {
      if (!verifiedEmail) {
        console.error(`[user-mapping] Refusing to link sub=${payload.sub} to id=${byEmail.id}: email not verified`);
        throw new UnverifiedEmailError(payload.email);
      }
      try {
        await deps.setAuth0Sub(byEmail.id!, payload.sub);
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Another request already linked this auth0_sub — re-fetch
          const raced = await deps.getUserByAuth0Sub(payload.sub);
          if (raced) return raced;
        }
        throw err;
      }
      return byEmail;
    }
  }

  // 3. Brand-new user — create with minimal profile (no Google tokens). An
  //    unverified address is not used as the account email.
  console.error(`[user-mapping] Creating new user for sub=${payload.sub}, email=${verifiedEmail ?? '(none verified)'}`);
  try {
    const newUser = await deps.createUser({
      email: verifiedEmail || `${payload.sub}@auth0`,
      name: verifiedEmail?.split('@')[0] || payload.sub,
      auth0Sub: payload.sub,
    });
    return newUser;
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Another request created this user concurrently — re-fetch. By email
      // only when verified: re-fetching by an unverified address would link
      // it by the back door.
      const raced = await deps.getUserByAuth0Sub(payload.sub)
        || (verifiedEmail ? await deps.getUserByEmail(verifiedEmail) : undefined);
      if (raced) return raced;
    }
    throw err;
  }
}
