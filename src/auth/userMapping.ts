// src/auth/userMapping.ts
// Maps Auth0 JWT subject claims to internal user records.

import { getUserByAuth0Sub, setAuth0Sub, getUserByEmail, createUser, type UserRecord } from '../userStore.js';
import type { JwtPayload } from './jwtValidator.js';

/** Check if an error is a unique constraint violation (Postgres code 23505). */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && (err as any).code === '23505';
}

/**
 * Resolve a JWT payload to an internal user record.
 *
 * 1. Look up by auth0_sub (fast path for returning users)
 * 2. Fall back to email match (links existing users on first JWT login)
 * 3. Auto-create a minimal user if completely new
 *
 * All mutation steps handle unique-constraint races by re-fetching on conflict.
 */
export async function mapJwtToUser(payload: JwtPayload): Promise<UserRecord> {
  // 1. Direct lookup by Auth0 subject
  const bySubject = await getUserByAuth0Sub(payload.sub);
  if (bySubject) return bySubject;

  // 2. Email-based fallback — link existing user to their Auth0 subject
  if (payload.email) {
    const byEmail = await getUserByEmail(payload.email);
    if (byEmail) {
      try {
        await setAuth0Sub(byEmail.id!, payload.sub);
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Another request already linked this auth0_sub — re-fetch
          const raced = await getUserByAuth0Sub(payload.sub);
          if (raced) return raced;
        }
        throw err;
      }
      return byEmail;
    }
  }

  // 3. Brand-new user — create with minimal profile (no Google tokens)
  try {
    const newUser = await createUser({
      email: payload.email || `${payload.sub}@auth0`,
      name: payload.email?.split('@')[0] || payload.sub,
      auth0Sub: payload.sub,
    });
    return newUser;
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Another request created this user concurrently — re-fetch
      const raced = await getUserByAuth0Sub(payload.sub)
        || (payload.email ? await getUserByEmail(payload.email) : undefined);
      if (raced) return raced;
    }
    throw err;
  }
}
