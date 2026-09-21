// src/__tests__/redmine/session.test.ts
// Unit tests for createRedmineSession — the per-request session builder for
// Redmine connections. Covers both auth shapes, the required base URL, the
// stored auth mode, and the cache identity.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRedmineSession, clearSessionCache } from '../../userSession.js';

const ENV_KEYS = ['REDMINE_CLIENT_ID', 'REDMINE_CLIENT_SECRET', 'REDMINE_BASE_URL'] as const;
const BASE = 'https://redmine.example.com';

let idCounter = 0;
function fixtures(providerTokens: Record<string, unknown>) {
  idCounter += 1;
  const user = { id: idCounter, apiKey: `key-${idCounter}`, email: `u${idCounter}@e.com` } as any;
  const connection = { instanceId: `inst-${idCounter}`, mcpSlug: 'redmine', providerTokens } as any;
  return { user, connection };
}

describe('createRedmineSession', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test('builds a paste-token session', () => {
    const { user, connection } = fixtures({ access_token: 'KEY', baseUrl: BASE, authMode: 'apiKey' });
    const session = createRedmineSession(user, connection);
    assert.equal(session.redmineAccessToken, 'KEY');
    assert.equal(session.redmineBaseUrl, BASE);
    assert.equal(session.redmineAuthMode, 'apiKey');
    assert.equal(session.redmineRefreshToken, undefined);
    // Google clients are absent on a third-party session.
    assert.equal(session.googleDocs, null);
  });

  test('builds an OAuth session and carries the refresh plumbing', () => {
    process.env.REDMINE_CLIENT_ID = 'cid';
    process.env.REDMINE_CLIENT_SECRET = 'secret';
    const expiry = Date.now() + 7_200_000;
    const { user, connection } = fixtures({
      access_token: 'TOK', refresh_token: 'RT', expiry_date: expiry, baseUrl: BASE, authMode: 'oauth',
    });
    const session = createRedmineSession(user, connection);
    assert.equal(session.redmineAuthMode, 'oauth');
    assert.equal(session.redmineRefreshToken, 'RT');
    assert.equal(session.redmineTokenExpiry, expiry);
    assert.equal(session.redmineOauthClientId, 'cid');
    assert.equal(session.redmineOauthClientSecret, 'secret');
    assert.equal(session.redmineInstanceId, connection.instanceId);
  });

  // An OAuth grant that returns no refresh token would otherwise be inferred
  // as a pasted API key and sent in the wrong header.
  test('honours a stored authMode that the refresh-token heuristic would get wrong', () => {
    const { user, connection } = fixtures({ access_token: 'TOK', baseUrl: BASE, authMode: 'oauth' });
    assert.equal(createRedmineSession(user, connection).redmineAuthMode, 'oauth');
  });

  test('falls back to the heuristic for rows written before authMode existed', () => {
    const legacyOauth = fixtures({ access_token: 'TOK', refresh_token: 'RT', baseUrl: BASE });
    assert.equal(createRedmineSession(legacyOauth.user, legacyOauth.connection).redmineAuthMode, 'oauth');

    const legacyPaste = fixtures({ access_token: 'KEY', baseUrl: BASE });
    assert.equal(createRedmineSession(legacyPaste.user, legacyPaste.connection).redmineAuthMode, 'apiKey');
  });

  test('falls back to REDMINE_BASE_URL when the connection carries none', () => {
    process.env.REDMINE_BASE_URL = BASE;
    const { user, connection } = fixtures({ access_token: 'KEY' });
    assert.equal(createRedmineSession(user, connection).redmineBaseUrl, BASE);
  });

  test('throws when the access token is missing', () => {
    const { user, connection } = fixtures({ baseUrl: BASE });
    assert.throws(() => createRedmineSession(user, connection), /access token missing/);
  });

  describe('cache identity', () => {
    test('returns the cached session when nothing changed', () => {
      const { user, connection } = fixtures({ access_token: 'KEY', baseUrl: BASE, authMode: 'apiKey' });
      const first = createRedmineSession(user, connection);
      assert.equal(createRedmineSession(user, connection), first);
      clearSessionCache(user.apiKey);
    });

    // The reconnect path can persist a new baseUrl without the token changing.
    // Keying the cache on the token alone would then keep serving a session
    // still aimed at the old Redmine instance.
    test('rebuilds when only the base URL changed', () => {
      const { user, connection } = fixtures({ access_token: 'KEY', baseUrl: BASE, authMode: 'apiKey' });
      const first = createRedmineSession(user, connection);

      connection.providerTokens = { access_token: 'KEY', baseUrl: 'https://other.example.com', authMode: 'apiKey' };
      const second = createRedmineSession(user, connection);

      assert.notEqual(second, first);
      assert.equal(second.redmineBaseUrl, 'https://other.example.com');
      clearSessionCache(user.apiKey);
    });

    test('rebuilds when only the auth mode changed', () => {
      const { user, connection } = fixtures({ access_token: 'T', baseUrl: BASE, authMode: 'apiKey' });
      const first = createRedmineSession(user, connection);

      connection.providerTokens = { access_token: 'T', baseUrl: BASE, authMode: 'oauth' };
      const second = createRedmineSession(user, connection);

      assert.notEqual(second, first);
      assert.equal(second.redmineAuthMode, 'oauth');
      clearSessionCache(user.apiKey);
    });

    test('rebuilds when the credential itself changed', () => {
      const { user, connection } = fixtures({ access_token: 'OLD', baseUrl: BASE, authMode: 'apiKey' });
      const first = createRedmineSession(user, connection);

      connection.providerTokens = { access_token: 'NEW', baseUrl: BASE, authMode: 'apiKey' };
      const second = createRedmineSession(user, connection);

      assert.notEqual(second, first);
      assert.equal(second.redmineAccessToken, 'NEW');
      clearSessionCache(user.apiKey);
    });
  });
});
