// src/__tests__/pinecone/session.test.ts
// Unit tests for createPineconeSession — the per-request session builder for
// Pinecone connections. Covers the required key, the instance id the per-call
// rule lookup depends on, and the cache identity.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createPineconeSession } from '../../userSession.js';

let idCounter = 0;
function fixtures(providerTokens: Record<string, unknown>) {
  idCounter += 1;
  const user = { id: idCounter, apiKey: `key-${idCounter}`, email: `u${idCounter}@e.com` } as any;
  const connection = { instanceId: `inst-${idCounter}`, mcpSlug: 'pinecone', providerTokens } as any;
  return { user, connection };
}

describe('createPineconeSession', () => {
  it('builds a session from a pasted API key', () => {
    const { user, connection } = fixtures({ access_token: 'pcsk_123' });
    const session = createPineconeSession(user, connection);

    assert.equal(session.pineconeAccessToken, 'pcsk_123');
    assert.equal(session.userId, user.id);
    assert.equal(session.email, user.email);
    assert.equal(session.mcpSlug, 'pinecone');
  });

  it('carries the instance id, which the per-call rule lookup depends on', () => {
    // The tools re-read providerTokens.accessRules by instanceId on every
    // call, because SSE sessions are long-lived. Without this field there is
    // nothing to look up — and one of those rules is a WRITE GATE, so a
    // connection set to read-only would silently accept writes.
    const { user, connection } = fixtures({ access_token: 'pcsk_123' });
    assert.equal(createPineconeSession(user, connection).pineconeInstanceId, connection.instanceId);
  });

  it('refuses a connection with no key rather than building a half-session', () => {
    const { user, connection } = fixtures({});
    assert.throws(() => createPineconeSession(user, connection), /API key missing/);
  });

  it('nulls the Google clients, which this MCP never uses', () => {
    const { user, connection } = fixtures({ access_token: 'pcsk_123' });
    const session = createPineconeSession(user, connection);
    assert.equal(session.googleDocs, null);
    assert.equal(session.googleDrive, null);
    assert.equal(session.oauthClient, null);
  });

  it('reuses a cached session for the same user and instance', () => {
    const { user, connection } = fixtures({ access_token: 'pcsk_123' });
    assert.equal(createPineconeSession(user, connection), createPineconeSession(user, connection));
  });

  it('does NOT reuse a cached session after the key changes', () => {
    // A re-entered token must take effect immediately; serving the old key
    // from cache would make the dashboard look like it did nothing.
    const { user, connection } = fixtures({ access_token: 'pcsk_old' });
    const first = createPineconeSession(user, connection);
    const second = createPineconeSession(user, { ...connection, providerTokens: { access_token: 'pcsk_new' } });
    assert.notEqual(first, second);
    assert.equal(second.pineconeAccessToken, 'pcsk_new');
  });
});
