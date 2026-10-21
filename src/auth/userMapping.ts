// src/auth/userMapping.ts
// Maps Auth0 JWT subject claims to internal user records.

import { getUserByAuth0Sub, setAuth0Sub, getUserByEmail, createUser, type UserRecord } from '../userStore.js';
import { attributeUserToOrgByDomain } from '../orgStore.js';
import type { JwtPayload } from './jwtValidator.js';

/** Dependencies for user mapping, injectable for testing. */
export interface UserMappingDeps {
  getUserByAuth0Sub: (sub: string) => Promise<UserRecord | undefined>;
  setAuth0Sub: (userId: number, sub: string) => Promise<void>;
  getUserByEmail: (email: string) => Promise<UserRecord | undefined>;
  createUser: (profile: { email: string; name: string; auth0Sub?: string }) => Promise<UserRecord>;
  /**
   * Attribute a user to an org by verified email domain.
   *
   * Optional so existing callers and test doubles need no change. It matters
   * here because this function AUTO-PROVISIONS accounts: without attribution on
   * this path, arriving through an MCP client rather than the dashboard produces
   * a brand-new account that belongs to no org, which is a way around whatever
   * policy the user's org has set.
   */
  attributeUserToOrgByDomain?: (userId: number, email: string) => Promise<unknown>;
}

const defaultDeps: UserMappingDeps = {
  getUserByAuth0Sub,
  setAuth0Sub,
  getUserByEmail,
  createUser,
  attributeUserToOrgByDomain,
};

/** Check if an error is a unique constraint violation (Postgres code 23505). */
export function isUniqueViolation(err: unknown): boolean {
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
export async function mapJwtToUser(payload: JwtPayload, deps: UserMappingDeps = defaultDeps): Promise<UserRecord> {
  // 1. Direct lookup by Auth0 subject
  const bySubject = await deps.getUserByAuth0Sub(payload.sub);
  if (bySubject) {
    console.error(`[user-mapping] Found user by sub: id=${bySubject.id}, email=${bySubject.email}`);
    await attributeIfPossible(bySubject, deps);
    return bySubject;
  }

  // 2. Email-based fallback — link existing user to their Auth0 subject
  if (payload.email) {
    const byEmail = await deps.getUserByEmail(payload.email);
    console.error(`[user-mapping] Email lookup for ${payload.email}: ${byEmail ? `found id=${byEmail.id}` : 'not found'}`);
    if (byEmail) {
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
      await attributeIfPossible(byEmail, deps);
      return byEmail;
    }
  }

  // 3. Brand-new user — create with minimal profile (no Google tokens)
  console.error(`[user-mapping] Creating new user for sub=${payload.sub}, email=${payload.email}`);
  try {
    const newUser = await deps.createUser({
      email: payload.email || `${payload.sub}@auth0`,
      name: payload.email?.split('@')[0] || payload.sub,
      auth0Sub: payload.sub,
    });
    await attributeIfPossible(newUser, deps);
    return newUser;
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Another request created this user concurrently — re-fetch
      const raced = await deps.getUserByAuth0Sub(payload.sub)
        || (payload.email ? await deps.getUserByEmail(payload.email) : undefined);
      if (raced) return raced;
    }
    throw err;
  }
}

/**
 * Best-effort org attribution for a resolved user.
 *
 * Never throws: this runs on the authentication path, and failing a sign-in
 * because an org lookup blipped is far worse than a user who gets attributed on
 * their next request. Runs on the returning-user paths too, not just on create,
 * so a domain verified after someone signed up still picks them up.
 */
async function attributeIfPossible(user: UserRecord, deps: UserMappingDeps): Promise<void> {
  const attribute = deps.attributeUserToOrgByDomain;
  if (!attribute || !user.id || !user.email) return;
  try {
    await attribute(user.id, user.email);
  } catch (err: any) {
    console.error('[user-mapping] org attribution failed:', err?.message || err);
  }
}
