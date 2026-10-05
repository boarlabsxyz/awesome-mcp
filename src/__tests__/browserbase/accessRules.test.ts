import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BrowserbaseAccessDenied,
  assertDomainAllowed,
  describeRules,
  hasDomainRules,
  hostMatchesPattern,
  validateDomainPattern,
} from '../../browserbase/accessRules.js';

/** assert.throws returns undefined, and these tests assert on the typed fields. */
function denialFrom(fn: () => unknown): BrowserbaseAccessDenied {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof BrowserbaseAccessDenied, `expected a BrowserbaseAccessDenied, got ${err}`);
    return err;
  }
  assert.fail('expected a BrowserbaseAccessDenied, but nothing was thrown');
}

describe('hostMatchesPattern', () => {
  it('matches the apex and its subdomains', () => {
    assert.ok(hostMatchesPattern('example.com', 'example.com'));
    assert.ok(hostMatchesPattern('example.com', 'app.example.com'));
    assert.ok(hostMatchesPattern('example.com', 'a.b.example.com'));
  });

  it('does not match a hostname that merely ENDS with the pattern', () => {
    // The whole reason this is a label-boundary check and not endsWith: an
    // attacker registering notexample.com must not inherit the rule.
    assert.equal(hostMatchesPattern('example.com', 'notexample.com'), false);
    assert.equal(hostMatchesPattern('example.com', 'evil-example.com'), false);
  });

  it('is case-insensitive and tolerates trailing dots', () => {
    assert.ok(hostMatchesPattern('Example.COM', 'APP.example.com.'));
  });

  it('tolerates the forms a user is likely to type', () => {
    assert.ok(hostMatchesPattern('*.example.com', 'app.example.com'));
    // A leading *. still covers the apex here, which is the point of
    // normalising rather than treating it as a glob.
    assert.ok(hostMatchesPattern('*.example.com', 'example.com'));
    assert.ok(hostMatchesPattern('.example.com', 'app.example.com'));
  });

  it('never treats a pattern as a regex', () => {
    // An LLM-supplied `.*` must not match everything. Stripped of its leading
    // `*.`, this is the literal hostname "", so it matches nothing.
    assert.equal(hostMatchesPattern('.*', 'example.com'), false);
    assert.equal(hostMatchesPattern('', 'example.com'), false);
    assert.equal(hostMatchesPattern('   ', 'example.com'), false);
  });
});

describe('assertDomainAllowed', () => {
  const allowed = { allowedDomains: ['example.com'] };

  it('allows anything when no rules are configured', () => {
    // Absent rules mean unrestricted — the opposite of Slack's fail-closed
    // default. A fresh connection has to be able to browse.
    for (const rules of [undefined, {}, { allowedDomains: [], blockedDomains: [] }]) {
      const url = assertDomainAllowed(rules, 'https://anything.test/path');
      assert.equal(url.hostname, 'anything.test');
    }
  });

  it('allows a host on the allowlist, and its subdomains', () => {
    assert.equal(assertDomainAllowed(allowed, 'https://example.com/p').hostname, 'example.com');
    assert.equal(assertDomainAllowed(allowed, 'https://app.example.com').hostname, 'app.example.com');
  });

  it('denies anything off a non-empty allowlist, naming the patterns', () => {
    const err = denialFrom(() => assertDomainAllowed(allowed, 'https://other.test'));
    assert.equal(err.reason, 'allowlist-miss');
    assert.deepEqual(err.patterns, ['example.com']);
    assert.equal(err.hostname, 'other.test');
    // The message has to say what to edit, not just that it was refused.
    assert.match(err.message, /example\.com/);
    assert.match(err.message, /Access Rules|allowed-domains/i);
  });

  it('lets the blocklist outrank the allowlist', () => {
    const rules = { allowedDomains: ['example.com'], blockedDomains: ['secret.example.com'] };
    assert.ok(assertDomainAllowed(rules, 'https://app.example.com'));
    const err = denialFrom(() => assertDomainAllowed(rules, 'https://secret.example.com/x'));
    assert.equal(err.reason, 'blocklist-hit');
  });

  it('refuses a non-http scheme even with no rules at all', () => {
    const err = denialFrom(() => assertDomainAllowed(undefined, 'file:///etc/passwd'));
    assert.equal(err.reason, 'scheme-not-allowed');
  });

  it('reports an unparseable URL as such rather than as a rule denial', () => {
    const err = denialFrom(() => assertDomainAllowed(allowed, 'example.com/pricing'));
    assert.equal(err.reason, 'url-unparseable');
    assert.match(err.message, /scheme/i);
  });
});

describe('validateDomainPattern', () => {
  it('accepts plain hostnames and the tolerated prefixes', () => {
    for (const ok of ['example.com', '*.example.com', '.example.com', 'a-b.co.uk', 'localhost']) {
      assert.equal(validateDomainPattern(ok), null, ok);
    }
  });

  it('rejects a pasted URL, pointing at the hostname form', () => {
    const problem = validateDomainPattern('https://example.com/pricing');
    assert.ok(problem);
    assert.match(problem, /hostname only/i);
  });

  it('rejects an embedded wildcard but explains the bare form already covers subdomains', () => {
    const problem = validateDomainPattern('ex*mple.com');
    assert.ok(problem);
    assert.match(problem, /wildcard/i);
  });

  it('rejects blanks and non-hostnames', () => {
    assert.ok(validateDomainPattern(''));
    assert.ok(validateDomainPattern('   '));
    assert.ok(validateDomainPattern('-bad-.com'));
    assert.ok(validateDomainPattern('a'.repeat(300)));
  });
});

describe('hasDomainRules / describeRules', () => {
  it('treats blank entries as no rules at all', () => {
    assert.equal(hasDomainRules({ allowedDomains: ['', '  '] }), false);
    assert.equal(describeRules({ allowedDomains: ['', '  '] }), undefined);
  });

  it('describes configured rules and states the navigate-only ceiling', () => {
    const note = describeRules({ allowedDomains: ['example.com'], blockedDomains: ['ads.test'] });
    assert.ok(note);
    assert.match(note, /example\.com/);
    assert.match(note, /ads\.test/);
    // The ceiling has to travel with the description, or a model reading only
    // this line concludes `act` is contained too.
    assert.match(note, /navigate only/i);
  });
});
