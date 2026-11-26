// Access and refresh tokens issued by our OAuth token endpoint
// (`registerOAuthProxy` → POST /oauth/token in webServer.ts).
//
// These replace the user's permanent dashboard API key as the OAuth
// access_token. Each authorization gets its own short-lived access token and a
// rotating refresh token, per client, so:
// - a leaked access token is good for at most ACCESS_TOKEN_TTL_SECONDS;
// - one client (ChatGPT, say) can be disconnected without touching another;
// - nothing that a client holds is the key that also signs every REST write.
//
// Only sha256(token) is stored. The tokens are 32 CSPRNG bytes, so no work
// factor is needed (same reasoning as pendingRegistrationStore.ts), and a dump
// of the table or the memory map yields nothing usable.
//
// Refresh tokens rotate on every use. A rotated one is kept, revoked, until it
// expires: presenting it again means two parties hold the same token, so the
// whole family (every token descended from that authorization) is revoked and
// the client has to authorize again. That is the OAuth 2.1 / RFC 9700 §4.14
// reuse rule.
//
// Postgres when the database is available; an in-memory map otherwise (tests,
// file-mode dev), with identical behaviour.

import * as crypto from 'node:crypto';
import { getPool, isDatabaseAvailable } from '../db.js';

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Prefixes make our tokens recognisable on sight, so a bearer check can route
 * them without probing every store. Neither the prefix nor base64url contains
 * a `.`, which matters: the MCP auth path splits `apiKey.instanceId` on the
 * last dot.
 */
export const ACCESS_TOKEN_PREFIX = 'amcp_at_';
export const REFRESH_TOKEN_PREFIX = 'amcp_rt_';

type TokenKind = 'access' | 'refresh';

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}

export interface AccessTokenRecord {
  userId: number;
  clientId: string;
  scope: string;
}

export interface ConnectedClient {
  clientId: string;
  clientName: string | null;
  /** When this client was first authorized (oldest live token family). */
  connectedAt: string;
  /** When it last obtained a token: authorization or refresh. */
  lastTokenAt: string;
}

export type RefreshResult =
  | { ok: true; tokens: IssuedTokens; userId: number; clientId: string }
  | { ok: false; reason: 'invalid' | 'reused' | 'client_mismatch' };

interface Row {
  kind: TokenKind;
  userId: number;
  clientId: string;
  clientName: string | null;
  scope: string;
  familyId: string;
  expiresAt: number;
  revokedAt: number | null;
  createdAt: number;
}

export function isOAuthAccessToken(token: unknown): boolean {
  return typeof token === 'string' && token.startsWith(ACCESS_TOKEN_PREFIX);
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function newToken(prefix: string): string {
  return prefix + crypto.randomBytes(32).toString('base64url');
}

// ---------- Backends ----------

interface Backend {
  insert(hash: string, row: Row): Promise<void>;
  findLiveAccess(hash: string, now: number): Promise<AccessTokenRecord | null>;
  /**
   * Atomically revoke a live refresh token and return it. null when it is
   * unknown, expired or already revoked; `find` tells those apart.
   */
  consumeRefresh(hash: string, now: number): Promise<Row | null>;
  find(hash: string): Promise<Row | null>;
  revokeFamily(familyId: string, now: number): Promise<void>;
  revokeClient(userId: number, clientId: string, now: number): Promise<number>;
  revokeUser(userId: number, now: number): Promise<void>;
  listClients(userId: number, now: number): Promise<ConnectedClient[]>;
  sweep(now: number): Promise<void>;
}

const memory = new Map<string, Row>();

const memoryBackend: Backend = {
  async insert(hash, row) { memory.set(hash, row); },
  async findLiveAccess(hash, now) {
    const row = memory.get(hash);
    if (!row || row.kind !== 'access' || row.revokedAt !== null || row.expiresAt <= now) return null;
    return { userId: row.userId, clientId: row.clientId, scope: row.scope };
  },
  async consumeRefresh(hash, now) {
    const row = memory.get(hash);
    if (!row || row.kind !== 'refresh' || row.revokedAt !== null || row.expiresAt <= now) return null;
    row.revokedAt = now;
    return { ...row };
  },
  async find(hash) {
    const row = memory.get(hash);
    return row ? { ...row } : null;
  },
  async revokeFamily(familyId, now) {
    for (const row of memory.values()) {
      if (row.familyId === familyId && row.revokedAt === null) row.revokedAt = now;
    }
  },
  async revokeClient(userId, clientId, now) {
    let n = 0;
    for (const row of memory.values()) {
      if (row.userId === userId && row.clientId === clientId && row.revokedAt === null) {
        row.revokedAt = now;
        n++;
      }
    }
    return n;
  },
  async revokeUser(userId, now) {
    for (const row of memory.values()) {
      if (row.userId === userId && row.revokedAt === null) row.revokedAt = now;
    }
  },
  async listClients(userId, now) {
    const byClient = new Map<string, ConnectedClient & { first: number; last: number }>();
    for (const row of memory.values()) {
      if (row.userId !== userId || row.revokedAt !== null || row.expiresAt <= now) continue;
      const seen = byClient.get(row.clientId);
      if (!seen) {
        byClient.set(row.clientId, {
          clientId: row.clientId, clientName: row.clientName,
          connectedAt: '', lastTokenAt: '', first: row.createdAt, last: row.createdAt,
        });
      } else {
        seen.first = Math.min(seen.first, row.createdAt);
        seen.last = Math.max(seen.last, row.createdAt);
        seen.clientName ??= row.clientName;
      }
    }
    return [...byClient.values()]
      .sort((a, b) => b.last - a.last)
      .map(({ first, last, ...c }) => ({
        ...c,
        connectedAt: new Date(first).toISOString(),
        lastTokenAt: new Date(last).toISOString(),
      }));
  },
  async sweep(now) {
    for (const [hash, row] of memory) {
      if (row.expiresAt <= now) memory.delete(hash);
    }
  },
};

function rowFromDb(r: any): Row {
  return {
    kind: r.kind,
    userId: Number(r.user_id),
    clientId: r.client_id,
    clientName: r.client_name ?? null,
    scope: r.scope,
    familyId: r.family_id,
    expiresAt: new Date(r.expires_at).getTime(),
    revokedAt: r.revoked_at ? new Date(r.revoked_at).getTime() : null,
    createdAt: new Date(r.created_at).getTime(),
  };
}

const ROW_COLUMNS = 'kind, user_id, client_id, client_name, scope, family_id, expires_at, revoked_at, created_at';

const postgresBackend: Backend = {
  async insert(hash, row) {
    await getPool().query(
      `INSERT INTO oauth_tokens (token_hash, kind, user_id, client_id, client_name, scope, family_id, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0), to_timestamp($9 / 1000.0))`,
      [hash, row.kind, row.userId, row.clientId, row.clientName, row.scope, row.familyId, row.expiresAt, row.createdAt],
    );
  },
  async findLiveAccess(hash) {
    const { rows } = await getPool().query(
      `SELECT user_id, client_id, scope FROM oauth_tokens
        WHERE token_hash = $1 AND kind = 'access' AND revoked_at IS NULL AND expires_at > NOW()`,
      [hash],
    );
    if (!rows[0]) return null;
    return { userId: Number(rows[0].user_id), clientId: rows[0].client_id, scope: rows[0].scope };
  },
  async consumeRefresh(hash) {
    // One statement, so two concurrent refreshes with the same token cannot
    // both succeed: the second finds it revoked and is treated as reuse.
    const { rows } = await getPool().query(
      `UPDATE oauth_tokens SET revoked_at = NOW()
        WHERE token_hash = $1 AND kind = 'refresh' AND revoked_at IS NULL AND expires_at > NOW()
        RETURNING ${ROW_COLUMNS}`,
      [hash],
    );
    return rows[0] ? rowFromDb(rows[0]) : null;
  },
  async find(hash) {
    const { rows } = await getPool().query(`SELECT ${ROW_COLUMNS} FROM oauth_tokens WHERE token_hash = $1`, [hash]);
    return rows[0] ? rowFromDb(rows[0]) : null;
  },
  async revokeFamily(familyId) {
    await getPool().query(
      'UPDATE oauth_tokens SET revoked_at = NOW() WHERE family_id = $1 AND revoked_at IS NULL',
      [familyId],
    );
  },
  async revokeClient(userId, clientId) {
    const result = await getPool().query(
      'UPDATE oauth_tokens SET revoked_at = NOW() WHERE user_id = $1 AND client_id = $2 AND revoked_at IS NULL',
      [userId, clientId],
    );
    return result.rowCount ?? 0;
  },
  async revokeUser(userId) {
    await getPool().query('UPDATE oauth_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  },
  async listClients(userId) {
    const { rows } = await getPool().query(
      `SELECT client_id, MAX(client_name) AS client_name, MIN(created_at) AS first, MAX(created_at) AS last
         FROM oauth_tokens
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
        GROUP BY client_id
        ORDER BY last DESC`,
      [userId],
    );
    return rows.map((r: any) => ({
      clientId: r.client_id,
      clientName: r.client_name ?? null,
      connectedAt: new Date(r.first).toISOString(),
      lastTokenAt: new Date(r.last).toISOString(),
    }));
  },
  async sweep() {
    // Expired rows are useless for auth and for reuse detection alike.
    await getPool().query('DELETE FROM oauth_tokens WHERE expires_at < NOW()');
  },
};

function backend(): Backend {
  return isDatabaseAvailable() ? postgresBackend : memoryBackend;
}

// Expired rows are deleted every SWEEP_EVERY_ISSUES issues: deterministic, no
// timer lifecycle (the restTokenStore.ts pattern).
const SWEEP_EVERY_ISSUES = 64;
let issuesSinceSweep = 0;

async function issueInFamily(
  userId: number,
  clientId: string,
  clientName: string | null,
  scope: string,
  familyId: string,
): Promise<IssuedTokens> {
  const store = backend();
  const now = Date.now();
  if (++issuesSinceSweep >= SWEEP_EVERY_ISSUES) {
    issuesSinceSweep = 0;
    await store.sweep(now).catch((err) => console.error('[oauth-tokens] sweep failed:', err?.message || err));
  }
  const accessToken = newToken(ACCESS_TOKEN_PREFIX);
  const refreshToken = newToken(REFRESH_TOKEN_PREFIX);
  const base = { userId, clientId, clientName, scope, familyId, revokedAt: null, createdAt: now };
  await store.insert(hashToken(accessToken), { ...base, kind: 'access', expiresAt: now + ACCESS_TOKEN_TTL_SECONDS * 1000 });
  await store.insert(hashToken(refreshToken), { ...base, kind: 'refresh', expiresAt: now + REFRESH_TOKEN_TTL_SECONDS * 1000 });
  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS, scope };
}

// ---------- Public API ----------

/** A new token family for a fresh authorization (the authorization_code grant). */
export async function issueTokenPair(params: {
  userId: number;
  clientId: string;
  clientName?: string | null;
  scope: string;
}): Promise<IssuedTokens> {
  return issueInFamily(params.userId, params.clientId, params.clientName ?? null, params.scope, crypto.randomUUID());
}

/** The live record behind an access token; null when unknown, expired or revoked. */
export async function lookupAccessToken(token: string): Promise<AccessTokenRecord | null> {
  if (!isOAuthAccessToken(token)) return null;
  return backend().findLiveAccess(hashToken(token), Date.now());
}

/**
 * The refresh_token grant. Spends the refresh token and issues a new pair in
 * the same family. A token presented again after it was spent revokes the
 * family (`reused`). `clientId`, when the client sends one, must match.
 */
export async function rotateRefreshToken(refreshToken: string, clientId?: string): Promise<RefreshResult> {
  if (typeof refreshToken !== 'string' || !refreshToken.startsWith(REFRESH_TOKEN_PREFIX)) {
    return { ok: false, reason: 'invalid' };
  }
  const store = backend();
  const hash = hashToken(refreshToken);
  const now = Date.now();

  const known = await store.find(hash);
  if (!known || known.kind !== 'refresh' || known.expiresAt <= now) return { ok: false, reason: 'invalid' };
  // Checked before spending anything: a wrong client_id must not burn the
  // rightful holder's token.
  if (clientId && known.clientId !== clientId) return { ok: false, reason: 'client_mismatch' };

  // Issue the new pair BEFORE spending the old token. If two requests race
  // with the same token, the loser's family revocation (below) then always
  // happens after the winner's pair exists, so it catches it. Spending first
  // would let the winner insert a live pair after the revocation had run.
  const tokens = known.revokedAt === null
    ? await issueInFamily(known.userId, known.clientId, known.clientName, known.scope, known.familyId)
    : null;

  const spent = tokens ? await store.consumeRefresh(hash, now) : null;
  if (spent && tokens) {
    // The access token issued alongside the spent refresh token stays valid
    // until it expires (at most an hour): revoking it here would break a
    // client that refreshes early while requests are still in flight.
    return { ok: true, tokens, userId: known.userId, clientId: known.clientId };
  }

  // Already spent or revoked: two parties hold this token. Revoke the family,
  // including the pair this request just issued.
  console.error(`[oauth-tokens] refresh token reused for client ${known.clientId}; revoking its family`);
  await store.revokeFamily(known.familyId, now);
  return { ok: false, reason: 'reused' };
}

/** Disconnect one client: every token it holds for this user stops working now. */
export async function revokeClient(userId: number, clientId: string): Promise<number> {
  return backend().revokeClient(userId, clientId, Date.now());
}

/** Disconnect every OAuth client of this user (on API key regeneration). */
export async function revokeAllForUser(userId: number): Promise<void> {
  return backend().revokeUser(userId, Date.now());
}

/** Clients holding at least one live token for this user, most recently active first. */
export async function listClients(userId: number): Promise<ConnectedClient[]> {
  return backend().listClients(userId, Date.now());
}

/** Test-only: forget every memory-backed token. */
export function __resetOAuthTokensForTests(): void {
  memory.clear();
  issuesSinceSweep = 0;
}
