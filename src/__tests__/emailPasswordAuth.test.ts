import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import request from 'supertest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Isolate the file-backed user store from the repo's ./data directory before
// anything imports it — DATA_DIR is read at module load.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-'));

if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: {
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:8080/auth/callback'],
    },
  });
}

const { createWebOnlyApp } = await import('../website/webServer.js');
const { __resetLoginRateLimitForTests, LOGIN_RATE_LIMIT } = await import('../website/loginRateLimit.js');
const { getUserByEmail, getPasswordHashByEmail, createOrUpdateUser } = await import('../userStore.js');
const { isValidEmail, verifyPassword, hashPassword, MAX_PASSWORD_BYTES } = await import('../auth/password.js');
const { createPasswordUser, DuplicateEmailError } = await import('../userStore.js');
const { __memoryKeyCountForTests, consumeLoginAttempt } = await import('../website/loginRateLimit.js');
const { validatePassword } = await import('../auth/password.js');

const app = createWebOnlyApp();

/** Pull the session cookie out of a Set-Cookie header list. */
function sessionCookie(res: request.Response): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return raw?.find(c => c.startsWith('session='))?.split(';')[0];
}

let emailCounter = 0;
function freshEmail(): string {
  emailCounter += 1;
  return `user${emailCounter}-${process.pid}@example.com`;
}

const GOOD_PASSWORD = 'a-long-enough-pw';

describe('Email + password authentication', () => {
  beforeEach(() => {
    // Every request consumes an ip: bucket, and supertest reuses 127.0.0.1 for
    // all of them — without this the later tests trip the limiter set by the
    // earlier ones.
    __resetLoginRateLimitForTests();
  });

  describe('POST /api/auth/register', () => {
    it('creates an account, sets a session cookie, and returns a redirect target', async () => {
      const email = freshEmail();
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email, password: GOOD_PASSWORD });

      assert.equal(res.status, 201);
      assert.equal(res.body.email, email);
      assert.equal(res.body.redirectTo, '/dashboard');
      assert.ok(sessionCookie(res), 'should set a session cookie');
    });

    it('stores a bcrypt hash, never the password itself', async () => {
      const email = freshEmail();
      await request(app).post('/api/auth/register').send({ email, password: GOOD_PASSWORD });

      const hash = await getPasswordHashByEmail(email);
      assert.ok(hash, 'password hash should be stored');
      assert.notEqual(hash, GOOD_PASSWORD);
      assert.match(hash!, /^\$2[aby]\$\d{2}\$/, 'should be a bcrypt hash');
    });

    it('records the account with no Google identity and authMethod=password', async () => {
      const email = freshEmail();
      await request(app).post('/api/auth/register').send({ email, password: GOOD_PASSWORD });

      const user = await getUserByEmail(email);
      assert.ok(user);
      assert.equal(user!.googleId, null);
      assert.equal(user!.authMethod, 'password');
      assert.ok(user!.apiKey, 'should be issued an API key like a Google user');
    });

    it('names the account after its email', async () => {
      const email = freshEmail();
      const res = await request(app).post('/api/auth/register').send({ email, password: GOOD_PASSWORD });
      assert.equal(res.body.name, email);
    });

    it('ignores a name in the request body rather than trusting it', async () => {
      // Sign-up has no name field. A caller can still put one in the JSON, and
      // it must not reach the account: the display name is rendered on the
      // dashboard, so accepting an unvalidated one is a free spoofing surface.
      const email = freshEmail();
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email, password: GOOD_PASSWORD, name: 'Administrator' });

      assert.equal(res.status, 201);
      assert.equal(res.body.name, email, 'supplied name must be ignored');
      const stored = await getUserByEmail(email);
      assert.equal(stored!.name, email);
    });

    it('rejects a malformed email', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'not-an-email', password: GOOD_PASSWORD });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /valid email/i);
    });

    it('rejects a password below the minimum length', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: freshEmail(), password: 'short' });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /at least 10 characters/);
    });

    it('rejects a password past bcrypt\'s 72-byte ceiling rather than truncating it', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: freshEmail(), password: 'x'.repeat(100) });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /72 bytes/);
    });

    it('rejects a duplicate email instead of overwriting the existing account', async () => {
      const email = freshEmail();
      await request(app).post('/api/auth/register').send({ email, password: GOOD_PASSWORD });
      const original = await getUserByEmail(email);
      // Captured BEFORE the second request. Reading it twice afterwards would
      // compare the value with itself and pass even if the hash were
      // overwritten — which is the regression this guards against.
      const originalHash = await getPasswordHashByEmail(email);

      const res = await request(app)
        .post('/api/auth/register')
        .send({ email, password: 'a-different-password' });

      assert.equal(res.status, 409);
      const after = await getUserByEmail(email);
      assert.equal(after!.apiKey, original!.apiKey, 'existing account must be untouched');
      assert.equal(await getPasswordHashByEmail(email), originalHash, 'password must not be replaced');
      // The rejected password must not work.
      const login = await request(app)
        .post('/api/auth/login')
        .send({ email, password: 'a-different-password' });
      assert.equal(login.status, 401);
    });

    it('treats emails case-insensitively', async () => {
      const email = freshEmail();
      await request(app).post('/api/auth/register').send({ email, password: GOOD_PASSWORD });

      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: email.toUpperCase(), password: GOOD_PASSWORD });
      assert.equal(res.status, 409, 'uppercase variant is the same account');
    });
  });

  describe('POST /api/auth/login', () => {
    it('signs in with the right password and sets a session', async () => {
      const email = freshEmail();
      await request(app).post('/api/auth/register').send({ email, password: GOOD_PASSWORD });

      const res = await request(app).post('/api/auth/login').send({ email, password: GOOD_PASSWORD });
      assert.equal(res.status, 200);
      assert.equal(res.body.email, email);
      assert.equal(res.body.redirectTo, '/dashboard');
      assert.ok(sessionCookie(res));
    });

    it('rejects the wrong password', async () => {
      const email = freshEmail();
      await request(app).post('/api/auth/register').send({ email, password: GOOD_PASSWORD });

      const res = await request(app).post('/api/auth/login').send({ email, password: 'wrong-password-x' });
      assert.equal(res.status, 401);
      assert.equal(sessionCookie(res), undefined);
    });

    it('gives an unknown email the same response as a wrong password', async () => {
      const wrongPw = await request(app)
        .post('/api/auth/login')
        .send({ email: freshEmail(), password: 'whatever-long' });
      assert.equal(wrongPw.status, 401);
      assert.match(wrongPw.body.error, /Incorrect email or password/);
    });

    it('accepts an uppercase spelling of a registered email', async () => {
      const email = freshEmail();
      await request(app).post('/api/auth/register').send({ email, password: GOOD_PASSWORD });

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: `  ${email.toUpperCase()} `, password: GOOD_PASSWORD });
      assert.equal(res.status, 200);
    });

    it('requires both fields', async () => {
      const res = await request(app).post('/api/auth/login').send({ email: freshEmail() });
      assert.equal(res.status, 400);
    });

    it('blocks further attempts once the limit is hit, with Retry-After', async () => {
      const email = freshEmail();
      await request(app).post('/api/auth/register').send({ email, password: GOOD_PASSWORD });
      __resetLoginRateLimitForTests();

      let last = await request(app).post('/api/auth/login').send({ email, password: 'bad-password-01' });
      for (let i = 0; i < LOGIN_RATE_LIMIT.MAX_ATTEMPTS + 2; i++) {
        last = await request(app).post('/api/auth/login').send({ email, password: 'bad-password-01' });
      }

      assert.equal(last.status, 429);
      assert.ok(last.headers['retry-after'], 'should tell the client when to retry');

      // The ceiling must hold even for the correct password — otherwise it
      // bounds nothing an attacker cares about.
      const withGoodPassword = await request(app)
        .post('/api/auth/login')
        .send({ email, password: GOOD_PASSWORD });
      assert.equal(withGoodPassword.status, 429);
    });
  });

  describe('session works across the dashboard, not just at login', () => {
    it('GET /api/me returns the email account behind a password session', async () => {
      const email = freshEmail();
      const reg = await request(app)
        .post('/api/auth/register')
        .send({ email, password: GOOD_PASSWORD });
      const cookie = sessionCookie(reg)!;

      const res = await request(app).get('/api/me').set('Cookie', cookie);

      assert.equal(res.status, 200, 'a googleId-keyed session lookup would 401 here');
      assert.equal(res.body.email, email);
      assert.equal(res.body.name, email);
      assert.equal(res.body.authMethod, 'password');
      assert.ok(res.body.apiKey);
      assert.ok(Array.isArray(res.body.connections));
    });

    it('POST /api/regenerate-key rotates the key for a password account', async () => {
      const email = freshEmail();
      const reg = await request(app).post('/api/auth/register').send({ email, password: GOOD_PASSWORD });
      const cookie = sessionCookie(reg)!;

      const before = (await request(app).get('/api/me').set('Cookie', cookie)).body.apiKey;
      const res = await request(app).post('/api/regenerate-key').set('Cookie', cookie);

      assert.equal(res.status, 200, 'the google_id-keyed rotation would find no rows here');
      assert.ok(res.body.apiKey);
      assert.notEqual(res.body.apiKey, before);
    });

    it('GET /api/me/instances is reachable with a password session', async () => {
      const email = freshEmail();
      const reg = await request(app).post('/api/auth/register').send({ email, password: GOOD_PASSWORD });
      const res = await request(app).get('/api/me/instances').set('Cookie', sessionCookie(reg)!);

      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.instances));
    });

    it('POST /api/logout ends the session', async () => {
      const email = freshEmail();
      const reg = await request(app).post('/api/auth/register').send({ email, password: GOOD_PASSWORD });
      const cookie = sessionCookie(reg)!;

      await request(app).post('/api/logout').set('Cookie', cookie);
      const after = await request(app).get('/api/me').set('Cookie', cookie);
      assert.equal(after.status, 401);
    });

    it('rejects dashboard routes with no session at all', async () => {
      const res = await request(app).get('/api/me');
      assert.equal(res.status, 401);
    });
  });

  describe('linking Google to an existing password account', () => {
    it('reuses the account instead of creating a second one for the same email', async () => {
      const email = freshEmail();
      await request(app).post('/api/auth/register').send({ email, password: GOOD_PASSWORD, name: 'Original' });
      const before = await getUserByEmail(email);

      // Simulate what /auth/callback does when this person later signs in
      // with a Google account carrying the same address.
      const linked = await createOrUpdateUser(
        { email, googleId: `google-${email}`, name: 'Original' },
        { access_token: 'a', refresh_token: 'r', scope: 'email', token_type: 'Bearer', expiry_date: Date.now() + 3600_000 },
      );

      assert.equal(linked.id, before!.id, 'must be the same account, not a duplicate');
      assert.equal(linked.apiKey, before!.apiKey, 'API key must survive the link');
      assert.equal(linked.googleId, `google-${email}`, 'Google identity is attached');
    });

    it('keeps the password working — and keeps saying so — after Google is linked', async () => {
      const email = freshEmail();
      await request(app).post('/api/auth/register').send({ email, password: GOOD_PASSWORD });

      await createOrUpdateUser(
        { email, googleId: `google-${email}`, name: 'Linked' },
        { access_token: 'a', refresh_token: 'r', scope: 'email', token_type: 'Bearer', expiry_date: Date.now() + 3600_000 },
      );

      const stillWorks = await request(app).post('/api/auth/login').send({ email, password: GOOD_PASSWORD });
      assert.equal(stillWorks.status, 200, 'linking Google must not revoke the password');

      // The dashboard renders authMethod verbatim, so relabelling this
      // 'google' would tell the user a credential they can still use is gone.
      const user = await getUserByEmail(email);
      assert.equal(user!.authMethod, 'password');
    });
  });

  describe('email validation is linear-time', () => {
    it('accepts and rejects the same addresses the old regex did', () => {
      for (const good of ['a@b.com', 'user.name+tag@sub.example.co.uk', 'A@B.CO']) {
        assert.equal(isValidEmail(good), true, good);
      }
      // A leading dot in the local part is accepted by both — this is a
      // permissive typo check, and matching the old behaviour is the point.
      assert.equal(isValidEmail('.a@b.com'), true);
      for (const bad of ['', 'a@b', '@b.com', 'a@.com', 'a@b.', 'a b@c.com', 'a@b c.com',
                         'a@@b.com', 'a@b@c.com', 'ab.com', 'a\t@b.com',
                         'x'.repeat(300) + '@b.com']) {
        assert.equal(isValidEmail(bad), false, JSON.stringify(bad));
      }
    });

    it('does not backtrack on a hostile input', () => {
      // The pattern this replaced — /^[^\s@]+@[^\s@]+\.[^\s@]+$/ — is
      // quadratic on this shape (4x length => 16x time), and it ran BEFORE the
      // length check, so it saw unbounded unauthenticated input. Timing is a
      // blunt assertion but the failure mode is seconds, not milliseconds.
      const hostile = 'a@' + 'x.'.repeat(200_000) + ' ';
      const started = process.hrtime.bigint();
      assert.equal(isValidEmail(hostile), false);
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(elapsedMs < 50, `took ${elapsedMs.toFixed(1)}ms — backtracking regex is back?`);
    });

    it('rejects an oversized email at the route without hashing it', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'a@' + 'x.'.repeat(50_000) + 'com', password: GOOD_PASSWORD });
      assert.equal(res.status, 400);
    });
  });

  describe('the unknown-account comparison target', () => {
    it('is not a literal in the source', () => {
      // A checked-in bcrypt hash is indistinguishable from a leaked credential
      // to a scanner, and would be identical across every deployment forever.
      const src = fs.readFileSync(path.join(process.cwd(), 'src', 'auth', 'password.ts'), 'utf8');
      assert.doesNotMatch(src, /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/, 'bcrypt hash literal in source');
      assert.match(src, /randomBytes/, 'should derive the dummy hash from a CSPRNG');
    });

    it('keeps unknown-email and wrong-password costs equal', async () => {
      const hash = await hashPassword(GOOD_PASSWORD);
      const time = async (h: string | null) => {
        const started = process.hrtime.bigint();
        for (let i = 0; i < 4; i++) await verifyPassword('a-wrong-password', h);
        return Number(process.hrtime.bigint() - started) / 1e6 / 4;
      };
      const wrongPassword = await time(hash);
      const unknownEmail = await time(null);

      // Equal cost is the whole point: a cheap null-hash path would let
      // response time reveal which emails have accounts.
      const ratio = unknownEmail / wrongPassword;
      assert.ok(ratio > 0.5 && ratio < 2,
        `unknown-email ${unknownEmail.toFixed(0)}ms vs wrong-password ${wrongPassword.toFixed(0)}ms`);
    });

    it('never authenticates against the dummy hash', async () => {
      assert.equal(await verifyPassword('anything at all', null), false);
      assert.equal(await verifyPassword('', undefined), false);
    });
  });

  describe('hardening', () => {
    it('rejects a password that only shares a stored password\'s first 72 bytes', async () => {
      // bcrypt compares at most 72 bytes. Registration caps input there, so a
      // password that IS exactly 72 bytes would otherwise be authenticated by
      // every longer string starting with it.
      const exact72 = 'p'.repeat(MAX_PASSWORD_BYTES);
      const hash = await hashPassword(exact72);
      assert.equal(await verifyPassword(exact72, hash), true, 'the real password still works');
      assert.equal(await verifyPassword(exact72 + 'EXTRA', hash), false, 'a longer prefix-match must not authenticate');
    });

    it('does not create a second account when a duplicate slips past the pre-check', async () => {
      // Goes straight at the store, bypassing the route's pre-check, which is
      // exactly what two concurrent registrations do to each other.
      const email = freshEmail();
      await request(app).post('/api/auth/register').send({ email, password: GOOD_PASSWORD });

      await assert.rejects(
        () => createPasswordUser({ email, name: 'Racer', passwordHash: 'irrelevant' }),
        (err: unknown) => err instanceof DuplicateEmailError,
        'the store itself must reject the duplicate',
      );
    });

    it('answers 409, not 500, when the store rejects a duplicate', async () => {
      const email = freshEmail();
      await request(app).post('/api/auth/register').send({ email, password: GOOD_PASSWORD });
      const res = await request(app).post('/api/auth/register').send({ email, password: GOOD_PASSWORD });
      assert.equal(res.status, 409);
    });

    it('bounds the in-memory limiter instead of growing a key per email', async () => {
      // Each distinct email used to mint an entry that was reclaimed only if
      // that same key came back after expiring, so varying the email grew the
      // map without limit.
      const before = __memoryKeyCountForTests();
      for (let i = 0; i < 40; i++) {
        await request(app)
          .post('/api/auth/login')
          .send({ email: `flood-${i}-${process.pid}@example.com`, password: 'bad-password-x' });
      }
      const after = __memoryKeyCountForTests();
      assert.ok(after <= LOGIN_RATE_LIMIT.MAX_MEMORY_KEYS,
        `map grew to ${after}, past the ${LOGIN_RATE_LIMIT.MAX_MEMORY_KEYS} cap`);
      assert.ok(after >= before, 'sanity: the limiter is actually recording attempts');
    });

    it('does not write an API-key fragment to the logs', () => {
      const src = fs.readFileSync(path.join(process.cwd(), 'src', 'website', 'webServer.ts'), 'utf8');
      const authLogs = src.split('\n').filter(l => /User (registered|signed in) via password/.test(l));
      assert.ok(authLogs.length >= 2, 'expected both auth log lines');
      for (const line of authLogs) {
        assert.doesNotMatch(line, /apiKey/, `API-key fragment in log line: ${line.trim()}`);
      }
    });
  });

  describe('limiter and policy edges', () => {
    it('reports a missing password distinctly from a too-short one', async () => {
      assert.match(validatePassword('') ?? '', /required/);
      assert.match(validatePassword(undefined as unknown as string) ?? '', /required/);
      assert.match(validatePassword('short') ?? '', /at least/);

      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: freshEmail(), password: '' });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /required/i);
    });

    it('evicts once the fallback map hits its cap, instead of growing forever', async () => {
      // Drive the store directly: reaching the cap through HTTP would need
      // 10k requests, and the behaviour under test is the map, not the route.
      const cap = LOGIN_RATE_LIMIT.MAX_MEMORY_KEYS;
      for (let i = 0; i <= cap + 50; i++) {
        await consumeLoginAttempt(`prune-probe:${i}`, LOGIN_RATE_LIMIT.MAX_ATTEMPTS);
      }
      const size = __memoryKeyCountForTests();
      assert.ok(size <= cap, `map holds ${size}, past the ${cap} cap`);
      // Eviction targets 90% of the cap, so a full sweep must have run.
      assert.ok(size < cap, 'expected eviction to have reclaimed space');
    });

    it('still limits when the client forges a different X-Forwarded-For each time', async () => {
      const email = freshEmail();
      await request(app).post('/api/auth/register').send({ email, password: GOOD_PASSWORD });
      __resetLoginRateLimitForTests();

      let last: request.Response | undefined;
      for (let i = 0; i < LOGIN_RATE_LIMIT.MAX_ATTEMPTS + 3; i++) {
        last = await request(app)
          .post('/api/auth/login')
          .set('X-Forwarded-For', `203.0.113.${i}, 198.51.100.7`)
          .send({ email, password: 'bad-password-x' });
      }
      // req.ip would read the leftmost (caller-supplied) hop and mint a fresh
      // bucket per request; the email bucket holds regardless.
      assert.equal(last!.status, 429);
    });
  });

  describe('GET /login', () => {
    it('serves a page instead of bouncing straight to Google', async () => {
      const res = await request(app).get('/login');
      // publicDir resolves to src/public under tsx, so sendFile may 404 in
      // test even though the route ran — same accommodation as the
      // /integrations test in routes.test.ts. What matters here is that the
      // route no longer redirects: a 302 to /auth/google would deny the page
      // to every email+password account.
      assert.ok([200, 404].includes(res.status), `unexpected status ${res.status}`);
      assert.notEqual(res.status, 302);
    });

    it('ships a login page offering both sign-in methods', () => {
      const html = fs.readFileSync(path.join(process.cwd(), 'public', 'login.html'), 'utf8');
      assert.match(html, /\/auth\/google/, 'keeps the Google button');
      // The endpoint is assembled at submit time from the form's mode, so
      // match the prefix and both mode names rather than a whole URL.
      assert.match(html, /'\/api\/auth\/' \+/, 'posts to the password endpoints');
      assert.match(html, /'register'/);
      assert.match(html, /id="authForm"/);
      assert.doesNotMatch(html, /id="name"/, 'sign-up must not collect a display name');
    });
  });
});
