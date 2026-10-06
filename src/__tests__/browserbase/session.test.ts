// src/__tests__/browserbase/session.test.ts
// Unit tests for createBrowserbaseSession — the per-request session builder for
// Browserbase connections. Covers the required key, the optional project id,
// the instance id the per-call rule lookup depends on, and the cache identity.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clearSessionCache, createBrowserbaseSession } from '../../userSession.js';

let idCounter = 0;
function fixtures(providerTokens: Record<string, unknown>) {
  idCounter += 1;
  const user = { id: idCounter, apiKey: `key-${idCounter}`, email: `u${idCounter}@e.com` } as any;
  const connection = { instanceId: `inst-${idCounter}`, mcpSlug: 'browserbase', providerTokens } as any;
  return { user, connection };
}

describe('createBrowserbaseSession', () => {
  it('builds a session from a pasted API key', () => {
    const { user, connection } = fixtures({ access_token: 'bb_live_123' });
    const session = createBrowserbaseSession(user, connection);

    assert.equal(session.browserbaseAccessToken, 'bb_live_123');
    assert.equal(session.userId, user.id);
    assert.equal(session.email, user.email);
    assert.equal(session.mcpSlug, 'browserbase');
  });

  it('carries the instance id, which the per-call rule lookup depends on', () => {
    // getRules re-reads providerTokens.accessRules by instanceId on every call,
    // because SSE sessions are long-lived and a cached copy would keep serving
    // rules the user has already changed. Without this field there is nothing
    // to look up and every connection silently reads as unrestricted.
    const { user, connection } = fixtures({ access_token: 'bb_live_123' });
    assert.equal(createBrowserbaseSession(user, connection).browserbaseInstanceId, connection.instanceId);
  });

  it('keeps the project id when present and leaves it undefined otherwise', () => {
    // Optional upstream — Browserbase infers the project from the key — so its
    // absence must not fail the session.
    const withProject = fixtures({ access_token: 'k', projectId: 'proj-1' });
    assert.equal(createBrowserbaseSession(withProject.user, withProject.connection).browserbaseProjectId, 'proj-1');

    const without = fixtures({ access_token: 'k' });
    assert.equal(createBrowserbaseSession(without.user, without.connection).browserbaseProjectId, undefined);
  });

  it('refuses a connection with no key, naming the instance to reconnect', () => {
    for (const tokens of [{}, { access_token: '' }, { projectId: 'p' }]) {
      const { user, connection } = fixtures(tokens);
      assert.throws(
        () => createBrowserbaseSession(user, connection),
        (err: any) => {
          assert.match(err.message, /Browserbase API key missing for connection inst-\d+/);
          assert.match(err.message, /reconnect/i);
          return true;
        },
      );
    }
  });

  it('tolerates a connection with no providerTokens at all', () => {
    idCounter += 1;
    const user = { id: idCounter, apiKey: `key-${idCounter}`, email: 'u@e.com' } as any;
    const connection = { instanceId: 'inst-none', mcpSlug: 'browserbase' } as any;
    assert.throws(() => createBrowserbaseSession(user, connection), /API key missing/);
  });

  it('nulls the Google client slots rather than leaving them undefined', () => {
    // Every non-Google session does this; code that reaches for session.googleDocs
    // on the wrong connector should get an explicit null, not a missing property.
    const { user, connection } = fixtures({ access_token: 'k' });
    const session = createBrowserbaseSession(user, connection) as any;
    for (const slot of ['googleDocs', 'googleDrive', 'googleSheets', 'googleCalendar', 'googleGmail', 'googleSlides', 'oauthClient']) {
      assert.equal(session[slot], null, slot);
    }
  });

  it('reuses a cached session for the same key, and rebuilds when the token changes', () => {
    const { user, connection } = fixtures({ access_token: 'first' });
    const first = createBrowserbaseSession(user, connection);
    assert.equal(createBrowserbaseSession(user, connection), first, 'same credential should hit the cache');

    // The cache credential is the token, so re-entering a new key on the same
    // instance must not keep serving a session built from the old one.
    const rotated = { ...connection, providerTokens: { access_token: 'second' } } as any;
    const second = createBrowserbaseSession(user, rotated);
    assert.notEqual(second, first);
    assert.equal(second.browserbaseAccessToken, 'second');
  });

  it('is evicted by clearSessionCache', () => {
    const { user, connection } = fixtures({ access_token: 'k' });
    const first = createBrowserbaseSession(user, connection);
    clearSessionCache(user.apiKey);
    assert.notEqual(createBrowserbaseSession(user, connection), first);
  });
});
