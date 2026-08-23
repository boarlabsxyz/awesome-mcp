// src/__tests__/outline/createOutlineSession.test.ts
// Unit tests for createOutlineSession — the per-request session builder for
// Outline connections. Covers both the OAuth (refresh-capable) and paste-token
// shapes, the baseUrl fallback, the missing-token guard, and the cache.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createOutlineSession, clearSessionCache } from '../../userSession.js';

const ENV_KEYS = ['OUTLINE_CLIENT_ID', 'OUTLINE_CLIENT_SECRET', 'OUTLINE_BASE_URL'] as const;

let idCounter = 0;
function fixtures(providerTokens: Record<string, unknown>) {
  idCounter += 1;
  const user = { id: idCounter, apiKey: `key-${idCounter}`, email: `u${idCounter}@e.com` } as any;
  const connection = {
    instanceId: `inst-${idCounter}`,
    mcpSlug: 'outline',
    providerTokens,
  } as any;
  return { user, connection };
}

describe('createOutlineSession', () => {
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

  test('OAuth connection populates all refresh plumbing from tokens + env', () => {
    process.env.OUTLINE_CLIENT_ID = 'cid';
    process.env.OUTLINE_CLIENT_SECRET = 'sec';
    const { user, connection } = fixtures({
      access_token: 'at',
      refresh_token: 'rt',
      expiry_date: 4242,
      baseUrl: 'https://wiki.example.com',
    });
    const s = createOutlineSession(user, connection);
    assert.equal(s.outlineAccessToken, 'at');
    assert.equal(s.outlineBaseUrl, 'https://wiki.example.com');
    assert.equal(s.outlineRefreshToken, 'rt');
    assert.equal(s.outlineTokenExpiry, 4242);
    assert.equal(s.outlineOauthClientId, 'cid');
    assert.equal(s.outlineOauthClientSecret, 'sec');
    assert.equal(s.outlineInstanceId, connection.instanceId);
    assert.equal(s.mcpSlug, 'outline');
    clearSessionCache(user.apiKey);
  });

  test('paste-token connection leaves refresh fields and creds undefined', () => {
    const { user, connection } = fixtures({ access_token: 'paste-key', baseUrl: 'https://wiki.example.com' });
    const s = createOutlineSession(user, connection);
    assert.equal(s.outlineAccessToken, 'paste-key');
    assert.equal(s.outlineRefreshToken, undefined);
    assert.equal(s.outlineTokenExpiry, undefined);
    assert.equal(s.outlineOauthClientId, undefined);
    assert.equal(s.outlineOauthClientSecret, undefined);
    clearSessionCache(user.apiKey);
  });

  test('baseUrl falls back to OUTLINE_BASE_URL when the token omits it', () => {
    process.env.OUTLINE_BASE_URL = 'https://env.example.com';
    const { user, connection } = fixtures({ access_token: 'at' });
    const s = createOutlineSession(user, connection);
    assert.equal(s.outlineBaseUrl, 'https://env.example.com');
    clearSessionCache(user.apiKey);
  });

  test('throws a reconnect error when the access token is missing', () => {
    const { user, connection } = fixtures({ baseUrl: 'https://wiki.example.com' });
    assert.throws(() => createOutlineSession(user, connection), /access token missing/i);
  });

  test('throws when providerTokens is absent entirely', () => {
    idCounter += 1;
    const user = { id: idCounter, apiKey: `key-${idCounter}`, email: 'x@e.com' } as any;
    const connection = { instanceId: `inst-${idCounter}`, mcpSlug: 'outline' } as any;
    assert.throws(() => createOutlineSession(user, connection), /access token missing/i);
  });

  test('returns the cached session on the second call for the same connection', () => {
    const { user, connection } = fixtures({ access_token: 'at', baseUrl: 'https://wiki.example.com' });
    const first = createOutlineSession(user, connection);
    const second = createOutlineSession(user, connection);
    assert.equal(first, second);
    clearSessionCache(user.apiKey);
  });
});
