import assert from 'node:assert/strict';
import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import { mapJwtToUser, isUniqueViolation, UnverifiedEmailError, type UserMappingDeps } from '../../auth/userMapping.js';
import { SignupNotAllowedError } from '../../auth/signupPolicy.js';
import type { UserRecord } from '../../userStore.js';
import type { JwtPayload } from '../../auth/jwtValidator.js';

const fakeUser: UserRecord = {
  id: 1, apiKey: 'key1', email: 'user@test.com', googleId: null,
  auth0Sub: 'auth0|123', name: 'Test User', authMethod: 'google',
  createdAt: '', updatedAt: '',
};

const fakeEmailUser: UserRecord = {
  id: 2, apiKey: 'key2', email: 'email@test.com', googleId: 'g1',
  name: 'Email User', authMethod: 'google', createdAt: '', updatedAt: '',
};

const payload: JwtPayload = {
  sub: 'auth0|123', scope: 'mcp:docs', email: 'user@test.com', emailVerified: true, iss: 'iss', aud: 'aud',
};

function makeDeps(overrides: Partial<UserMappingDeps> = {}): UserMappingDeps {
  return {
    getUserByAuth0Sub: mock.fn(async () => undefined),
    setAuth0Sub: mock.fn(async () => {}),
    getUserByEmail: mock.fn(async () => undefined),
    createUser: mock.fn(async (profile: any) => ({
      ...fakeUser, email: profile.email, name: profile.name, auth0Sub: profile.auth0Sub,
    })),
    ...overrides,
  };
}

function makePgError(): Error {
  const err = new Error('duplicate key') as any;
  err.code = '23505';
  return err;
}

describe('isUniqueViolation', () => {
  it('returns true for Postgres 23505 errors', () => {
    assert.ok(isUniqueViolation(makePgError()));
  });

  it('returns false for other errors', () => {
    assert.equal(isUniqueViolation(new Error('db down')), false);
  });

  it('returns false for non-Error values', () => {
    assert.equal(isUniqueViolation('string'), false);
    assert.equal(isUniqueViolation(null), false);
  });
});

describe('mapJwtToUser', () => {
  it('returns user found by auth0_sub (fast path)', async () => {
    const deps = makeDeps({ getUserByAuth0Sub: mock.fn(async () => fakeUser) });

    const result = await mapJwtToUser(payload, deps);
    assert.equal(result, fakeUser);
    assert.equal((deps.getUserByEmail as any).mock.callCount(), 0);
    assert.equal((deps.createUser as any).mock.callCount(), 0);
  });

  it('links existing user by email and sets auth0_sub', async () => {
    const deps = makeDeps({ getUserByEmail: mock.fn(async () => fakeEmailUser) });

    const result = await mapJwtToUser(payload, deps);
    assert.equal(result, fakeEmailUser);
    assert.equal((deps.setAuth0Sub as any).mock.callCount(), 1);
    assert.deepEqual((deps.setAuth0Sub as any).mock.calls[0].arguments, [2, 'auth0|123']);
  });

  it('creates new user when not found by sub or email', async () => {
    const deps = makeDeps();

    const result = await mapJwtToUser(payload, deps);
    assert.equal((deps.createUser as any).mock.callCount(), 1);
    const args = (deps.createUser as any).mock.calls[0].arguments[0];
    assert.equal(args.email, 'user@test.com');
    assert.equal(args.auth0Sub, 'auth0|123');
    assert.equal(args.name, 'user');
  });

  it('creates user with fallback email when email is missing', async () => {
    const deps = makeDeps();
    const noEmailPayload: JwtPayload = { sub: 'auth0|456', scope: 'mcp:docs', iss: 'iss', aud: 'aud' };

    await mapJwtToUser(noEmailPayload, deps);
    const args = (deps.createUser as any).mock.calls[0].arguments[0];
    assert.equal(args.email, 'auth0|456@auth0');
    assert.equal(args.name, 'auth0|456');
  });

  it('handles unique constraint race on setAuth0Sub', async () => {
    let subCallCount = 0;
    const deps = makeDeps({
      getUserByAuth0Sub: mock.fn(async () => {
        subCallCount++;
        return subCallCount > 1 ? fakeUser : undefined;
      }),
      getUserByEmail: mock.fn(async () => fakeEmailUser),
      setAuth0Sub: mock.fn(async () => { throw makePgError(); }),
    });

    const result = await mapJwtToUser(payload, deps);
    assert.equal(result, fakeUser);
  });

  it('rethrows non-unique-constraint errors from setAuth0Sub', async () => {
    const deps = makeDeps({
      getUserByEmail: mock.fn(async () => fakeEmailUser),
      setAuth0Sub: mock.fn(async () => { throw new Error('db down'); }),
    });

    await assert.rejects(() => mapJwtToUser(payload, deps), { message: 'db down' });
  });

  it('handles unique constraint race on createUser (re-fetch by sub)', async () => {
    let subCallCount = 0;
    const deps = makeDeps({
      getUserByAuth0Sub: mock.fn(async () => {
        subCallCount++;
        return subCallCount > 1 ? fakeUser : undefined;
      }),
      createUser: mock.fn(async () => { throw makePgError(); }),
    });

    const result = await mapJwtToUser(payload, deps);
    assert.equal(result, fakeUser);
  });

  it('handles unique constraint race on createUser (re-fetch by email)', async () => {
    let emailCallCount = 0;
    const deps = makeDeps({
      getUserByEmail: mock.fn(async () => {
        emailCallCount++;
        return emailCallCount > 1 ? fakeEmailUser : undefined;
      }),
      createUser: mock.fn(async () => { throw makePgError(); }),
    });

    const result = await mapJwtToUser(payload, deps);
    assert.equal(result, fakeEmailUser);
  });

  it('rethrows non-unique-constraint errors from createUser', async () => {
    const deps = makeDeps({
      createUser: mock.fn(async () => { throw new Error('db down'); }),
    });

    await assert.rejects(() => mapJwtToUser(payload, deps), { message: 'db down' });
  });

  it('rethrows unique constraint error when re-fetch also fails', async () => {
    const deps = makeDeps({
      createUser: mock.fn(async () => { throw makePgError(); }),
      // Both re-fetches return undefined — error propagates
    });

    await assert.rejects(() => mapJwtToUser(payload, deps), (err: any) => err.code === '23505');
  });
});

// An unverified email must never link to, or name, an account: ADMIN_EMAILS is
// matched by email, so either would let anyone who can register an address at
// the identity provider — without proving they own it — act as that person.
describe('mapJwtToUser with an unverified email', () => {
  const unverified: JwtPayload = { ...payload, sub: 'auth0|attacker', email: 'email@test.com', emailVerified: false };

  it('refuses to link to the existing account that uses the address', async () => {
    const deps = makeDeps({ getUserByEmail: mock.fn(async () => fakeEmailUser) });
    await assert.rejects(() => mapJwtToUser(unverified, deps), (err: any) => err instanceof UnverifiedEmailError);
    assert.equal((deps.setAuth0Sub as any).mock.callCount(), 0);
    assert.equal((deps.createUser as any).mock.callCount(), 0);
  });

  it('treats a missing email_verified exactly like false', async () => {
    const noClaim: JwtPayload = { ...unverified };
    delete noClaim.emailVerified;
    const deps = makeDeps({ getUserByEmail: mock.fn(async () => fakeEmailUser) });
    await assert.rejects(() => mapJwtToUser(noClaim, deps), UnverifiedEmailError);
  });

  it('creates a new account WITHOUT the unverified address', async () => {
    const deps = makeDeps();
    await mapJwtToUser(unverified, deps);
    const args = (deps.createUser as any).mock.calls[0].arguments[0];
    assert.equal(args.email, 'auth0|attacker@auth0');
    assert.equal(args.name, 'auth0|attacker');
  });

  it('never re-fetches by the unverified address after a creation race', async () => {
    const deps = makeDeps({
      createUser: mock.fn(async () => { throw makePgError(); }),
      // A lookup by email would find the victim's account here.
      getUserByEmail: mock.fn(async () => fakeEmailUser),
    });
    // The first email lookup (step 2) finds the account and refuses before any race.
    await assert.rejects(() => mapJwtToUser(unverified, deps), UnverifiedEmailError);

    const racing = makeDeps({ createUser: mock.fn(async () => { throw makePgError(); }) });
    await assert.rejects(() => mapJwtToUser(unverified, racing), (err: any) => err.code === '23505');
    assert.equal((racing.getUserByEmail as any).mock.callCount(), 1, 'only the step-2 lookup, never the race re-fetch');
  });

  it('still returns an already-linked account by subject, whatever the email says', async () => {
    const deps = makeDeps({ getUserByAuth0Sub: mock.fn(async () => fakeUser) });
    assert.equal(await mapJwtToUser(unverified, deps), fakeUser);
  });
});

// ALLOWED_SIGNUP_DOMAINS limits only step 3, account creation: an identity
// that already has an account, by subject or by verified email, still signs in.
describe('mapJwtToUser with a sign-up domain list', () => {
  const saved = process.env.ALLOWED_SIGNUP_DOMAINS;
  afterEach(() => {
    if (saved === undefined) delete process.env.ALLOWED_SIGNUP_DOMAINS;
    else process.env.ALLOWED_SIGNUP_DOMAINS = saved;
  });

  it('refuses to create an account outside the list', async () => {
    process.env.ALLOWED_SIGNUP_DOMAINS = 'corp.test';
    const deps = makeDeps();
    await assert.rejects(() => mapJwtToUser(payload, deps), SignupNotAllowedError);
    assert.equal((deps.createUser as any).mock.callCount(), 0);
  });

  it('refuses the no-verified-email fallback account once a list is set', async () => {
    process.env.ALLOWED_SIGNUP_DOMAINS = 'corp.test';
    const deps = makeDeps();
    const noEmail: JwtPayload = { sub: 'auth0|456', scope: 'mcp:docs', iss: 'iss', aud: 'aud' };
    await assert.rejects(() => mapJwtToUser(noEmail, deps), SignupNotAllowedError);
  });

  it('lets a verified ADMIN_EMAILS address through, but not an unverified one', async () => {
    process.env.ALLOWED_SIGNUP_DOMAINS = 'corp.test';
    const savedAdmins = process.env.ADMIN_EMAILS;
    process.env.ADMIN_EMAILS = 'user@test.com';
    try {
      const deps = makeDeps();
      await mapJwtToUser(payload, deps); // payload: user@test.com, verified
      assert.equal((deps.createUser as any).mock.callCount(), 1);
      await assert.rejects(() => mapJwtToUser({ ...payload, sub: 'auth0|u', emailVerified: false }, makeDeps()), SignupNotAllowedError);
    } finally {
      if (savedAdmins === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = savedAdmins;
    }
  });

  it('creates an account inside the list', async () => {
    process.env.ALLOWED_SIGNUP_DOMAINS = 'test.com';
    const deps = makeDeps();
    await mapJwtToUser(payload, deps);
    assert.equal((deps.createUser as any).mock.callCount(), 1);
  });

  it('still signs in existing accounts outside the list, by subject and by verified email', async () => {
    process.env.ALLOWED_SIGNUP_DOMAINS = 'corp.test';
    const bySub = makeDeps({ getUserByAuth0Sub: mock.fn(async () => fakeUser) });
    assert.equal(await mapJwtToUser(payload, bySub), fakeUser);
    const byEmail = makeDeps({ getUserByEmail: mock.fn(async () => fakeEmailUser) });
    assert.equal(await mapJwtToUser(payload, byEmail), fakeEmailUser);
  });
});
