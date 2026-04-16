import assert from 'node:assert/strict';
import { describe, it, mock, beforeEach } from 'node:test';
import { mapJwtToUser, isUniqueViolation, type UserMappingDeps } from '../../auth/userMapping.js';
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
  sub: 'auth0|123', scope: 'mcp:docs', email: 'user@test.com', iss: 'iss', aud: 'aud',
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
