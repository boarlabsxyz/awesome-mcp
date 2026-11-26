import assert from 'node:assert/strict';
import { describe, it, beforeEach, mock } from 'node:test';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  isOAuthAccessToken,
  issueTokenPair,
  lookupAccessToken,
  rotateRefreshToken,
  revokeClient,
  revokeAllForUser,
  listClients,
  __resetOAuthTokensForTests,
} from '../website/oauthTokenStore.js';

// No DATABASE_URL in tests, so this exercises the memory backend; the
// Postgres backend runs the same logic through SQL with the same semantics.

const issue = (userId = 1, clientId = 'claude', clientName: string | null = 'Claude') =>
  issueTokenPair({ userId, clientId, clientName, scope: 'mcp' });

describe('oauthTokenStore', () => {
  beforeEach(() => {
    __resetOAuthTokensForTests();
    mock.timers.reset();
  });

  it('issues prefixed, dot-free tokens with the advertised lifetime', async () => {
    const t = await issue();
    assert.match(t.accessToken, /^amcp_at_[A-Za-z0-9_-]{43}$/);
    assert.match(t.refreshToken, /^amcp_rt_[A-Za-z0-9_-]{43}$/);
    assert.equal(t.expiresIn, ACCESS_TOKEN_TTL_SECONDS);
    assert.equal(isOAuthAccessToken(t.accessToken), true);
    assert.equal(isOAuthAccessToken(t.refreshToken), false);
    assert.equal(isOAuthAccessToken('0123abcd'), false);
  });

  it('resolves a live access token to its user and client', async () => {
    const t = await issue(5, 'chatgpt');
    assert.deepEqual(await lookupAccessToken(t.accessToken), { userId: 5, clientId: 'chatgpt', scope: 'mcp' });
  });

  it('does not accept a refresh token as an access token, or anything unknown', async () => {
    const t = await issue();
    assert.equal(await lookupAccessToken(t.refreshToken), null);
    assert.equal(await lookupAccessToken('amcp_at_unknown'), null);
    assert.equal(await lookupAccessToken(''), null);
  });

  it('expires access tokens after an hour and refresh tokens after 30 days', async () => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const t = await issue();
    mock.timers.tick(ACCESS_TOKEN_TTL_SECONDS * 1000 + 1);
    assert.equal(await lookupAccessToken(t.accessToken), null);
    const refreshed = await rotateRefreshToken(t.refreshToken);
    assert.equal(refreshed.ok, true, 'refresh still works after the access token expired');

    if (!refreshed.ok) return;
    mock.timers.tick(REFRESH_TOKEN_TTL_SECONDS * 1000 + 1);
    assert.deepEqual(await rotateRefreshToken(refreshed.tokens.refreshToken), { ok: false, reason: 'invalid' });
  });

  it('rotates: a refresh issues a new pair for the same user, client and scope', async () => {
    const t = await issue(3, 'claude');
    const r = await rotateRefreshToken(t.refreshToken, 'claude');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.userId, 3);
    assert.equal(r.clientId, 'claude');
    assert.notEqual(r.tokens.refreshToken, t.refreshToken);
    assert.deepEqual(await lookupAccessToken(r.tokens.accessToken), { userId: 3, clientId: 'claude', scope: 'mcp' });
    // The access token issued with the spent refresh token keeps working until it expires.
    assert.ok(await lookupAccessToken(t.accessToken));
  });

  it('treats reuse of a spent refresh token as theft and revokes the family', async () => {
    const t = await issue();
    const r = await rotateRefreshToken(t.refreshToken);
    assert.ok(r.ok);
    if (!r.ok) return;

    assert.deepEqual(await rotateRefreshToken(t.refreshToken), { ok: false, reason: 'reused' });
    assert.equal(await lookupAccessToken(r.tokens.accessToken), null);
    assert.equal(await lookupAccessToken(t.accessToken), null);
    assert.deepEqual(await rotateRefreshToken(r.tokens.refreshToken), { ok: false, reason: 'reused' });
  });

  it('leaves no live tokens when the same refresh token is used twice at once', async () => {
    const t = await issue();
    const results = await Promise.all([rotateRefreshToken(t.refreshToken), rotateRefreshToken(t.refreshToken)]);
    assert.equal(results.filter(r => !r.ok && r.reason === 'reused').length, 1, 'the loser sees reuse');
    // The winner's pair was issued before the loser revoked the family, so it
    // is revoked too: neither party keeps a working token.
    for (const r of results) {
      if (r.ok) {
        assert.equal(await lookupAccessToken(r.tokens.accessToken), null);
        assert.equal((await rotateRefreshToken(r.tokens.refreshToken)).ok, false);
      }
    }
  });

  it('confines reuse revocation to one family', async () => {
    const a = await issue(1, 'claude');
    const b = await issue(1, 'claude');
    await rotateRefreshToken(a.refreshToken);
    await rotateRefreshToken(a.refreshToken); // reuse in family A
    assert.ok(await lookupAccessToken(b.accessToken), 'a second authorization of the same client survives');
  });

  it('refuses another client\'s refresh token without spending it', async () => {
    const t = await issue(1, 'claude');
    assert.deepEqual(await rotateRefreshToken(t.refreshToken, 'chatgpt'), { ok: false, reason: 'client_mismatch' });
    assert.equal((await rotateRefreshToken(t.refreshToken, 'claude')).ok, true);
  });

  it('rejects malformed refresh tokens', async () => {
    for (const bad of ['', 'amcp_at_x', 'not-ours', undefined as any]) {
      assert.deepEqual(await rotateRefreshToken(bad), { ok: false, reason: 'invalid' });
    }
  });

  it('revokes one client without touching another client or another user', async () => {
    const claude = await issue(1, 'claude');
    const chatgpt = await issue(1, 'chatgpt');
    const otherUser = await issue(2, 'claude');

    assert.equal(await revokeClient(1, 'claude'), 2, 'its access and refresh token');
    assert.equal(await lookupAccessToken(claude.accessToken), null);
    assert.equal((await rotateRefreshToken(claude.refreshToken)).ok, false);
    assert.ok(await lookupAccessToken(chatgpt.accessToken));
    assert.ok(await lookupAccessToken(otherUser.accessToken));
    assert.equal(await revokeClient(1, 'claude'), 0, 'nothing left to revoke');
  });

  it('revokes everything for a user', async () => {
    const a = await issue(1, 'claude');
    const b = await issue(1, 'chatgpt');
    const other = await issue(2, 'claude');
    await revokeAllForUser(1);
    assert.equal(await lookupAccessToken(a.accessToken), null);
    assert.equal(await lookupAccessToken(b.accessToken), null);
    assert.ok(await lookupAccessToken(other.accessToken));
  });

  it('lists clients with live tokens, most recently active first', async () => {
    mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
    await issue(1, 'claude', 'Claude');
    mock.timers.tick(1000);
    await issue(1, 'chatgpt', 'ChatGPT');
    await issue(2, 'other', 'Other user');
    mock.timers.tick(1000);
    await issue(1, 'revoked', 'Gone');
    await revokeClient(1, 'revoked');

    const clients = await listClients(1);
    assert.deepEqual(clients.map(c => c.clientId), ['chatgpt', 'claude']);
    assert.equal(clients[0].clientName, 'ChatGPT');
    assert.equal(clients[1].connectedAt, new Date(1_700_000_000_000).toISOString());
  });
});
