// src/__tests__/hubspot/createHubSpotSession.test.ts
// Unit tests for createHubSpotSession — the per-request session builder for
// HubSpot connections. Covers the token/baseUrl mapping, the env fallback,
// the missing-token guard, and the instance cache.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHubSpotSession, clearSessionCache } from '../../userSession.js';

let idCounter = 0;
function fixtures(providerTokens: Record<string, unknown>) {
  idCounter += 1;
  const user = { id: idCounter, apiKey: `key-${idCounter}`, email: `u${idCounter}@e.com` } as any;
  const connection = {
    instanceId: `inst-${idCounter}`,
    mcpSlug: 'hubspot',
    providerTokens,
  } as any;
  return { user, connection };
}

describe('createHubSpotSession', () => {
  let savedBaseUrl: string | undefined;

  beforeEach(() => {
    savedBaseUrl = process.env.HUBSPOT_BASE_URL;
    delete process.env.HUBSPOT_BASE_URL;
  });

  afterEach(() => {
    if (savedBaseUrl === undefined) delete process.env.HUBSPOT_BASE_URL;
    else process.env.HUBSPOT_BASE_URL = savedBaseUrl;
  });

  test('maps access token and per-connection base URL onto the session', () => {
    const { user, connection } = fixtures({ access_token: 'pat-1', baseUrl: 'https://eu.hubapi.com' });
    const s = createHubSpotSession(user, connection);
    assert.equal(s.hubspotAccessToken, 'pat-1');
    assert.equal(s.hubspotBaseUrl, 'https://eu.hubapi.com');
    assert.equal(s.mcpSlug, 'hubspot');
    // Google clients are null placeholders for a third-party session.
    assert.equal(s.googleDocs, null);
  });

  test('falls back to HUBSPOT_BASE_URL env when the connection carries no baseUrl', () => {
    process.env.HUBSPOT_BASE_URL = 'https://env.hubapi.com';
    const { user, connection } = fixtures({ access_token: 'pat-2' });
    const s = createHubSpotSession(user, connection);
    assert.equal(s.hubspotBaseUrl, 'https://env.hubapi.com');
  });

  test('leaves baseUrl undefined when neither connection nor env provides one', () => {
    const { user, connection } = fixtures({ access_token: 'pat-3' });
    const s = createHubSpotSession(user, connection);
    assert.equal(s.hubspotBaseUrl, undefined);
  });

  test('throws a reconnect-friendly error when the access token is missing', () => {
    const { user, connection } = fixtures({});
    assert.throws(() => createHubSpotSession(user, connection), /access token missing/i);
  });

  test('caches by instanceId (second call returns the same object)', () => {
    const { user, connection } = fixtures({ access_token: 'pat-4' });
    const first = createHubSpotSession(user, connection);
    const second = createHubSpotSession(user, connection);
    assert.equal(first, second);
    clearSessionCache(user.apiKey);
  });
});
