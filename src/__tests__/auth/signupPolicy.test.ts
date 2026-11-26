import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import {
  allowedSignupDomains,
  isSignupAllowed,
  decideGoogleSignIn,
} from '../../auth/signupPolicy.js';
import type { UserRecord } from '../../userStore.js';

const saved = { domains: process.env.ALLOWED_SIGNUP_DOMAINS, admins: process.env.ADMIN_EMAILS };
afterEach(() => {
  if (saved.domains === undefined) delete process.env.ALLOWED_SIGNUP_DOMAINS;
  else process.env.ALLOWED_SIGNUP_DOMAINS = saved.domains;
  if (saved.admins === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = saved.admins;
});

const someone: UserRecord = {
  id: 7, apiKey: 'k', email: 'a@outside.test', googleId: 'g7', name: 'A',
  authMethod: 'google', createdAt: '', updatedAt: '',
};

describe('allowedSignupDomains', () => {
  it('is empty when unset', () => {
    delete process.env.ALLOWED_SIGNUP_DOMAINS;
    assert.deepEqual(allowedSignupDomains(), []);
  });

  it('trims, lower-cases and drops a leading @ and blanks', () => {
    process.env.ALLOWED_SIGNUP_DOMAINS = ' @Corp.Test, ,other.test ';
    assert.deepEqual(allowedSignupDomains(), ['corp.test', 'other.test']);
  });
});

describe('isSignupAllowed', () => {
  it('allows everyone with no list', () => {
    delete process.env.ALLOWED_SIGNUP_DOMAINS;
    assert.equal(isSignupAllowed('x@anything.test'), true);
  });

  it('matches the domain after the last @, case-insensitively', () => {
    process.env.ALLOWED_SIGNUP_DOMAINS = 'corp.test';
    assert.equal(isSignupAllowed('Pat@CORP.test'), true);
    assert.equal(isSignupAllowed('pat@sub.corp.test'), false, 'subdomains are not implied');
    assert.equal(isSignupAllowed('pat@corp.test.evil.test'), false);
    assert.equal(isSignupAllowed('"corp.test@"@evil.test'), false);
  });

  it('refuses anything that is not an address once a list is set', () => {
    process.env.ALLOWED_SIGNUP_DOMAINS = 'corp.test';
    for (const value of [undefined, null, 42, '', 'corp.test', '@corp.test', 'pat@']) {
      assert.equal(isSignupAllowed(value), false, JSON.stringify(value));
    }
  });

  it('always allows an ADMIN_EMAILS address', () => {
    process.env.ALLOWED_SIGNUP_DOMAINS = 'corp.test';
    process.env.ADMIN_EMAILS = 'boss@outside.test';
    assert.equal(isSignupAllowed('Boss@outside.test'), true);
    assert.equal(isSignupAllowed('other@outside.test'), false);
  });
});

describe('decideGoogleSignIn', () => {
  it('allows an account already linked by googleId, verified or not, inside the list or not', () => {
    process.env.ALLOWED_SIGNUP_DOMAINS = 'corp.test';
    const d = decideGoogleSignIn({ email: 'a@outside.test', emailVerified: false, byGoogleId: someone, byEmail: undefined });
    assert.deepEqual(d, { allowed: true });
  });

  it('refuses to link an existing account by an unverified email', () => {
    delete process.env.ALLOWED_SIGNUP_DOMAINS;
    for (const emailVerified of [false, null, undefined]) {
      const d = decideGoogleSignIn({ email: 'a@outside.test', emailVerified, byGoogleId: undefined, byEmail: someone });
      assert.equal(d.allowed, false);
      assert.equal(!d.allowed && d.reason, 'email_not_verified');
    }
  });

  it('links an existing account by a verified email even outside the list', () => {
    process.env.ALLOWED_SIGNUP_DOMAINS = 'corp.test';
    const d = decideGoogleSignIn({ email: 'a@outside.test', emailVerified: true, byGoogleId: undefined, byEmail: someone });
    assert.deepEqual(d, { allowed: true });
  });

  it('refuses a new account for an unverified email', () => {
    delete process.env.ALLOWED_SIGNUP_DOMAINS;
    const d = decideGoogleSignIn({ email: 'new@corp.test', emailVerified: false, byGoogleId: undefined, byEmail: undefined });
    assert.equal(!d.allowed && d.reason, 'email_not_verified');
  });

  it('refuses a new account outside the list', () => {
    process.env.ALLOWED_SIGNUP_DOMAINS = 'corp.test';
    const d = decideGoogleSignIn({ email: 'new@outside.test', emailVerified: true, byGoogleId: undefined, byEmail: undefined });
    assert.equal(!d.allowed && d.reason, 'signup_domain_not_allowed');
  });

  it('allows a new verified account inside the list, and anyone verified with no list', () => {
    process.env.ALLOWED_SIGNUP_DOMAINS = 'corp.test';
    assert.deepEqual(
      decideGoogleSignIn({ email: 'new@corp.test', emailVerified: true, byGoogleId: undefined, byEmail: undefined }),
      { allowed: true },
    );
    delete process.env.ALLOWED_SIGNUP_DOMAINS;
    assert.deepEqual(
      decideGoogleSignIn({ email: 'new@outside.test', emailVerified: true, byGoogleId: undefined, byEmail: undefined }),
      { allowed: true },
    );
  });
});
