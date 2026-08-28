import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanitizePostLoginRedirect } from '../website/webServer.js';

// Clicking Reconnect with a lapsed session used to silently do nothing.
// /connect/:mcpSlug hand-rebuilt its return URL from mcpSlug + name, dropping
// `?reconnect=<instanceId>` — the one parameter that tells the callback to
// refresh an existing instance rather than treat the consent as a new
// connection. Without it the callback took its "already connected" branch and
// left the stale token in place. (It also pointed at `/?redirect=…`, which `/`
// never reads, so the return-to-intent was dead regardless.) The intent now
// rides in a signed, short-lived cookie that /auth/callback consumes — and
// because that value is reflected into res.redirect(), it is sanitized rather
// than trusted.

describe('sanitizePostLoginRedirect', () => {
  it('keeps a reconnect intent intact, query string and all', () => {
    // The whole point: `reconnect` must survive the login round-trip.
    const url = '/connect/google-gmail?reconnect=inst_abc123';
    assert.equal(sanitizePostLoginRedirect(url), url);
  });

  it('keeps a named new-connection intent', () => {
    const url = '/connect/clickup?name=ClickUp%20(S%26F)';
    assert.equal(sanitizePostLoginRedirect(url), url);
  });

  it('allows the plain dashboard', () => {
    assert.equal(sanitizePostLoginRedirect('/dashboard'), '/dashboard');
  });

  it('rejects a protocol-relative URL that would leave the site', () => {
    // Browsers follow //host as an absolute URL — the classic open redirect.
    assert.equal(sanitizePostLoginRedirect('//evil.test/steal'), null);
  });

  it('rejects backslash variants of the same trick', () => {
    assert.equal(sanitizePostLoginRedirect('/\\\\evil.test'), null);
  });

  it('rejects an absolute off-site URL', () => {
    assert.equal(sanitizePostLoginRedirect('https://evil.test/steal'), null);
  });

  it('rejects a path outside the resumable flows', () => {
    // Only the flows that actually need resuming are resumable.
    assert.equal(sanitizePostLoginRedirect('/api/v1/catalogs'), null);
    assert.equal(sanitizePostLoginRedirect('/admin'), null);
  });

  it('is not fooled by a prefix that merely starts with the allowed word', () => {
    assert.equal(sanitizePostLoginRedirect('/connectevil'), null);
    assert.equal(sanitizePostLoginRedirect('/dashboardevil'), null);
  });

  it('leaves a hostile-looking query alone, because a query cannot move the destination', () => {
    // The allowlist is applied to the PATH. A query string is inert here —
    // res.redirect sends the browser to /connect/x either way — so this is
    // kept rather than rejected, and the check stays focused on the one part
    // that decides where the user lands.
    assert.equal(sanitizePostLoginRedirect('/connect/x?next=//evil.test'), '/connect/x?next=//evil.test');
  });

  it('rejects non-strings, empties and absurd lengths', () => {
    assert.equal(sanitizePostLoginRedirect(undefined), null);
    assert.equal(sanitizePostLoginRedirect(null), null);
    assert.equal(sanitizePostLoginRedirect(42), null);
    assert.equal(sanitizePostLoginRedirect(''), null);
    assert.equal(sanitizePostLoginRedirect('/connect/' + 'a'.repeat(600)), null);
  });

  it('rejects a relative path with no leading slash', () => {
    assert.equal(sanitizePostLoginRedirect('connect/google-gmail'), null);
  });
});
