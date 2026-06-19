import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  mintRestToken,
  lookupRestToken,
  revokeRestToken,
  REST_TOKEN_TTL_SECONDS,
} from '../website/restTokenStore.js';

// These tests exercise the in-memory fallback path. The redis-backed path is
// only taken when DATABASE_URL is set, which is not the case in unit tests.

describe('restTokenStore (memory mode)', () => {
  it('mintRestToken returns a non-empty token, expiry, and ttl', async () => {
    const minted = await mintRestToken(1);
    assert.ok(minted.token.length > 0);
    assert.ok(minted.expiresAt > Date.now());
    assert.equal(minted.ttlSeconds, REST_TOKEN_TTL_SECONDS);
  });

  it('lookupRestToken returns the userId for a freshly minted token', async () => {
    const minted = await mintRestToken(42);
    const userId = await lookupRestToken(minted.token);
    assert.equal(userId, 42);
  });

  it('lookupRestToken returns null for an unknown token', async () => {
    assert.equal(await lookupRestToken('bogus-token-value'), null);
  });

  it('lookupRestToken returns null for empty/invalid input', async () => {
    assert.equal(await lookupRestToken(''), null);
    assert.equal(await lookupRestToken(null as any), null);
    assert.equal(await lookupRestToken(undefined as any), null);
  });

  it('revokeRestToken removes the token from the store', async () => {
    const minted = await mintRestToken(7);
    assert.equal(await lookupRestToken(minted.token), 7);
    await revokeRestToken(minted.token);
    assert.equal(await lookupRestToken(minted.token), null);
  });

  it('each mint returns a unique token', async () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const minted = await mintRestToken(1);
      tokens.add(minted.token);
    }
    assert.equal(tokens.size, 20);
  });

  it('sweep runs without throwing after many mints (covers the SWEEP_EVERY_MINTS branch)', async () => {
    // SWEEP_EVERY_MINTS is 64 internally — minting 70 forces at least one sweep.
    for (let i = 0; i < 70; i++) {
      await mintRestToken(i);
    }
    // If we got here without throwing, the sweep ran. Spot-check the last
    // token is still resolvable.
    const last = await mintRestToken(999);
    assert.equal(await lookupRestToken(last.token), 999);
  });
});
