// src/auth/userMapping.ts
// Maps Auth0 JWT subject claims to internal user records.

import { getUserByAuth0Sub, setAuth0Sub, getUserByEmail, createUser, type UserRecord } from '../userStore.js';
import type { JwtPayload } from './jwtValidator.js';

/**
 * Resolve a JWT payload to an internal user record.
 *
 * 1. Look up by auth0_sub (fast path for returning users)
 * 2. Fall back to email match (links existing users on first JWT login)
 * 3. Auto-create a minimal user if completely new
 */
export async function mapJwtToUser(payload: JwtPayload): Promise<UserRecord> {
  // 1. Direct lookup by Auth0 subject
  const bySubject = await getUserByAuth0Sub(payload.sub);
  if (bySubject) return bySubject;

  // 2. Email-based fallback — link existing user to their Auth0 subject
  if (payload.email) {
    const byEmail = await getUserByEmail(payload.email);
    if (byEmail) {
      await setAuth0Sub(byEmail.id!, payload.sub);
      return byEmail;
    }
  }

  // 3. Brand-new user — create with minimal profile (no Google tokens)
  const newUser = await createUser({
    email: payload.email || `${payload.sub}@auth0`,
    name: payload.email?.split('@')[0] || payload.sub,
    auth0Sub: payload.sub,
  });

  return newUser;
}
