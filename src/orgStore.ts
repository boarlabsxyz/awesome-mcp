// src/orgStore.ts
//
// Org tenancy: organisations, the email domains they claim, their members and
// pending invitations. This is the layer the admin-org policy enforcement
// feature keys off — "which org owns this connection" is the question every
// policy lookup starts from.
//
// Dual-backend like userStore.ts: Postgres when available, a single
// `data/orgs.json` otherwise. The file sibling is not optional — a table with
// no fallback silently no-ops in local dev, where isDatabaseAvailable() is
// false whenever DATABASE_URL or REDIS_URL is unset (see db.ts).
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { isDatabaseAvailable, getPool } from './db.js';

const DATA_DIR = process.env.DATA_DIR || './data';
const ORGS_FILE = path.join(DATA_DIR, 'orgs.json');

/** How long an invitation link stays redeemable. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type OrgRole = 'admin' | 'member';
export const ORG_ROLES: readonly OrgRole[] = ['admin', 'member'];

/**
 * How a member came to be in the org. Recorded so a second attribution
 * mechanism (an IdP's group claims, say) needs no migration — the column is
 * the extension point that a users.org_id would not have been.
 */
export type MemberSource = 'domain' | 'invite' | 'manual' | 'idp';

export interface Org {
  id: number;
  name: string;
  slug: string;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrgDomain {
  id: number;
  orgId: number;
  domain: string;
  /** null = claimed but unverified. An unverified domain never auto-joins anyone. */
  verifiedAt: string | null;
  createdAt: string;
}

export interface OrgMember {
  id: number;
  orgId: number;
  userId: number;
  role: OrgRole;
  source: MemberSource;
  createdAt: string;
  updatedAt: string;
}

/** A member row joined to its org — what callers asking "who is this user" want. */
export interface OrgMembership {
  org: Org;
  role: OrgRole;
  source: MemberSource;
}

export interface OrgInvite {
  id: number;
  orgId: number;
  email: string;
  role: OrgRole;
  invitedBy: number | null;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

/**
 * Thrown when a user is already a member of a *different* org.
 *
 * Stage 1 permits at most one org per user. Merging two orgs' conflicting
 * policies is an open product question, and refusing the second membership is
 * the honest answer until it is decided — silently picking one org's policy
 * would enforce rules the other org never agreed to. The schema already allows
 * many memberships, so lifting this is a change here and nowhere else.
 */
export class AlreadyInOrgError extends Error {
  readonly existingOrgId: number;
  constructor(userId: number, existingOrgId: number) {
    super(`User ${userId} already belongs to org ${existingOrgId}. A user may belong to one org.`);
    this.name = 'AlreadyInOrgError';
    this.existingOrgId = existingOrgId;
  }
}

/** Thrown when a domain is already claimed — by this org or another one. */
export class DomainClaimedError extends Error {
  constructor(domain: string) {
    super(`Domain ${domain} is already claimed.`);
    this.name = 'DomainClaimedError';
  }
}

/** Thrown when a domain cannot be claimed by anyone (a public mail provider). */
export class PublicDomainError extends Error {
  constructor(domain: string) {
    super(`Domain ${domain} is a public email provider and cannot be claimed by an org.`);
    this.name = 'PublicDomainError';
  }
}

export class OrgSlugTakenError extends Error {
  constructor(slug: string) {
    super(`Org slug "${slug}" is already taken.`);
    this.name = 'OrgSlugTakenError';
  }
}

/**
 * Mail providers no org may claim.
 *
 * Without this list, claiming `gmail.com` captures every Gmail-registered user
 * on the platform into one org — every connection they own becomes governed by
 * a policy set by a stranger. Verification (org_domains.verified_at) is the
 * main guard; this is the second, because a plausible-looking verification
 * scheme for a provider domain does not exist and should never be attempted.
 */
const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com',
  'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.de', 'gmx.net', 'mail.com',
  'zoho.com', 'yandex.ru', 'yandex.com', 'mail.ru', 'qq.com', '163.com', '126.com',
  'fastmail.com', 'hey.com', 'tutanota.com', 'tuta.io', 'web.de', 'inbox.lv',
  'example.com', 'test.com',
]);

// ---------- Helpers ----------

/** Lowercase and strip a leading '@' so "@Acme.COM" and "acme.com" are one domain. */
export function normalizeDomain(input: string): string {
  return input.trim().toLowerCase().replace(/^@+/, '');
}

/** The domain part of an email address, normalised. Empty string if unparseable. */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return '';
  return normalizeDomain(email.slice(at + 1));
}

export function isPublicEmailDomain(domain: string): boolean {
  return PUBLIC_EMAIL_DOMAINS.has(normalizeDomain(domain));
}

/** URL-safe org slug derived from a display name. */
export function slugifyOrgName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return slug || `org-${crypto.randomBytes(4).toString('hex')}`;
}

/** Mint an invitation token. Returned once, to the caller that mails it. */
export function generateInviteToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Hash an invite token for storage.
 *
 * Plain SHA-256 with no salt or work factor, deliberately: the input is 32
 * CSPRNG bytes, so there is nothing to brute-force, and the only property
 * needed is that a database dump does not yield a redeemable token. Same
 * posture as pendingRegistrationStore.ts.
 */
export function hashInviteToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function assertRole(role: string): OrgRole {
  if (role === 'admin' || role === 'member') return role;
  throw new Error(`Invalid org role: ${role}`);
}

// ---------- File-based storage (fallback) ----------

interface OrgFileData {
  orgs: Org[];
  domains: OrgDomain[];
  members: OrgMember[];
  /** Invites hold only the token hash here too — the file is no safer than the DB. */
  invites: Array<OrgInvite & { tokenHash: string }>;
  nextId: number;
}

let data: OrgFileData = { orgs: [], domains: [], members: [], invites: [], nextId: 1 };
let loaded = false;
let writeLock: Promise<void> = Promise.resolve();

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function fileLoad(): Promise<void> {
  if (loaded) return;
  await ensureDataDir();
  try {
    const content = await fs.readFile(ORGS_FILE, 'utf-8');
    const parsed = JSON.parse(content) as Partial<OrgFileData>;
    data = {
      orgs: parsed.orgs ?? [],
      domains: parsed.domains ?? [],
      members: parsed.members ?? [],
      invites: parsed.invites ?? [],
      nextId: parsed.nextId ?? 1,
    };
    loaded = true;
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      data = { orgs: [], domains: [], members: [], invites: [], nextId: 1 };
      loaded = true;
    } else {
      throw err;
    }
  }
}

async function fileSave(): Promise<void> {
  writeLock = writeLock.then(async () => {
    await ensureDataDir();
    await fs.writeFile(ORGS_FILE, JSON.stringify(data, null, 2));
  });
  await writeLock;
}

/**
 * Project a stored invite to its public shape.
 *
 * An explicit field list rather than `{ tokenHash, ...rest }` on purpose: the
 * one thing this function exists to do is keep the token hash out of a response,
 * and a rest-spread would silently carry through any field added to the stored
 * shape later. Naming the fields makes a future leak a compile error.
 */
function toPublicInvite(stored: OrgInvite & { tokenHash: string }): OrgInvite {
  return {
    id: stored.id,
    orgId: stored.orgId,
    email: stored.email,
    role: stored.role,
    invitedBy: stored.invitedBy,
    expiresAt: stored.expiresAt,
    acceptedAt: stored.acceptedAt,
    createdAt: stored.createdAt,
  };
}

function nextId(): number {
  return data.nextId++;
}

// ---------- Row mapping (Postgres) ----------

function iso(value: any): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function isoOrNull(value: any): string | null {
  if (value === null || value === undefined) return null;
  return iso(value);
}

function rowToOrg(row: any): Org {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdBy: row.created_by ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function rowToDomain(row: any): OrgDomain {
  return {
    id: row.id,
    orgId: row.org_id,
    domain: row.domain,
    verifiedAt: isoOrNull(row.verified_at),
    createdAt: iso(row.created_at),
  };
}

function rowToMember(row: any): OrgMember {
  return {
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    role: assertRole(row.role),
    source: (row.source || 'invite') as MemberSource,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function rowToInvite(row: any): OrgInvite {
  return {
    id: row.id,
    orgId: row.org_id,
    email: row.email,
    role: assertRole(row.role),
    invitedBy: row.invited_by ?? null,
    expiresAt: iso(row.expires_at),
    acceptedAt: isoOrNull(row.accepted_at),
    createdAt: iso(row.created_at),
  };
}

// ---------- Orgs ----------

export async function createOrg(input: {
  name: string;
  slug?: string;
  createdBy?: number | null;
}): Promise<Org> {
  const slug = input.slug ? slugifyOrgName(input.slug) : slugifyOrgName(input.name);
  const createdBy = input.createdBy ?? null;

  if (isDatabaseAvailable()) {
    const pool = getPool();
    try {
      const { rows } = await pool.query(
        `INSERT INTO orgs (name, slug, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         RETURNING id, name, slug, created_by, created_at, updated_at`,
        [input.name, slug, createdBy],
      );
      return rowToOrg(rows[0]);
    } catch (err: any) {
      if (err?.code === '23505') throw new OrgSlugTakenError(slug);
      throw err;
    }
  }

  await fileLoad();
  if (data.orgs.some(o => o.slug === slug)) throw new OrgSlugTakenError(slug);
  const now = new Date().toISOString();
  const org: Org = { id: nextId(), name: input.name, slug, createdBy, createdAt: now, updatedAt: now };
  data.orgs.push(org);
  await fileSave();
  return org;
}

export async function getOrgById(orgId: number): Promise<Org | undefined> {
  if (isDatabaseAvailable()) {
    const { rows } = await getPool().query(
      'SELECT id, name, slug, created_by, created_at, updated_at FROM orgs WHERE id = $1',
      [orgId],
    );
    return rows.length ? rowToOrg(rows[0]) : undefined;
  }
  await fileLoad();
  return data.orgs.find(o => o.id === orgId);
}

export async function getOrgBySlug(slug: string): Promise<Org | undefined> {
  if (isDatabaseAvailable()) {
    const { rows } = await getPool().query(
      'SELECT id, name, slug, created_by, created_at, updated_at FROM orgs WHERE slug = $1',
      [slug],
    );
    return rows.length ? rowToOrg(rows[0]) : undefined;
  }
  await fileLoad();
  return data.orgs.find(o => o.slug === slug);
}

export async function listOrgs(): Promise<Org[]> {
  if (isDatabaseAvailable()) {
    const { rows } = await getPool().query(
      'SELECT id, name, slug, created_by, created_at, updated_at FROM orgs ORDER BY name ASC',
    );
    return rows.map(rowToOrg);
  }
  await fileLoad();
  return [...data.orgs].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- Membership ----------

/**
 * The caller's org and role, or undefined when they belong to no org.
 *
 * `undefined` is the ungoverned case and must stay cheap and unremarkable —
 * most users on the platform have no org, and nothing about their behaviour
 * changes because of this feature.
 */
export async function getMembershipForUser(userId: number): Promise<OrgMembership | undefined> {
  if (isDatabaseAvailable()) {
    const { rows } = await getPool().query(
      `SELECT m.role, m.source,
              o.id, o.name, o.slug, o.created_by, o.created_at, o.updated_at
         FROM org_members m
         JOIN orgs o ON o.id = m.org_id
        WHERE m.user_id = $1
        ORDER BY m.created_at ASC
        LIMIT 1`,
      [userId],
    );
    if (!rows.length) return undefined;
    const row = rows[0];
    return { org: rowToOrg(row), role: assertRole(row.role), source: (row.source || 'invite') as MemberSource };
  }
  await fileLoad();
  const member = data.members.find(m => m.userId === userId);
  if (!member) return undefined;
  const org = data.orgs.find(o => o.id === member.orgId);
  if (!org) return undefined;
  return { org, role: member.role, source: member.source };
}

export async function getOrgForUser(userId: number): Promise<Org | undefined> {
  return (await getMembershipForUser(userId))?.org;
}

export async function listOrgMembers(orgId: number): Promise<OrgMember[]> {
  if (isDatabaseAvailable()) {
    const { rows } = await getPool().query(
      `SELECT id, org_id, user_id, role, source, created_at, updated_at
         FROM org_members WHERE org_id = $1 ORDER BY created_at ASC`,
      [orgId],
    );
    return rows.map(rowToMember);
  }
  await fileLoad();
  return data.members
    .filter(m => m.orgId === orgId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Add a user to an org.
 *
 * Idempotent for a repeat of the *same* org — an invite redeemed twice, or a
 * domain match on a user who already joined, should not fail. A different org
 * throws AlreadyInOrgError; see that class for why one org per user.
 */
export async function addOrgMember(
  orgId: number,
  userId: number,
  role: OrgRole = 'member',
  source: MemberSource = 'invite',
): Promise<OrgMember> {
  const existing = await getMembershipForUser(userId);
  if (existing) {
    if (existing.org.id !== orgId) throw new AlreadyInOrgError(userId, existing.org.id);
    const members = await listOrgMembers(orgId);
    const row = members.find(m => m.userId === userId);
    if (row) return row;
  }

  if (isDatabaseAvailable()) {
    const { rows } = await getPool().query(
      `INSERT INTO org_members (org_id, user_id, role, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (org_id, user_id) DO UPDATE SET updated_at = NOW()
       RETURNING id, org_id, user_id, role, source, created_at, updated_at`,
      [orgId, userId, role, source],
    );
    return rowToMember(rows[0]);
  }

  await fileLoad();
  const now = new Date().toISOString();
  const member: OrgMember = {
    id: nextId(), orgId, userId, role, source, createdAt: now, updatedAt: now,
  };
  data.members.push(member);
  await fileSave();
  return member;
}

export async function setMemberRole(orgId: number, userId: number, role: OrgRole): Promise<OrgMember | undefined> {
  if (isDatabaseAvailable()) {
    const { rows } = await getPool().query(
      `UPDATE org_members SET role = $3, updated_at = NOW()
        WHERE org_id = $1 AND user_id = $2
        RETURNING id, org_id, user_id, role, source, created_at, updated_at`,
      [orgId, userId, role],
    );
    return rows.length ? rowToMember(rows[0]) : undefined;
  }
  await fileLoad();
  const member = data.members.find(m => m.orgId === orgId && m.userId === userId);
  if (!member) return undefined;
  member.role = role;
  member.updatedAt = new Date().toISOString();
  await fileSave();
  return member;
}

export async function removeOrgMember(orgId: number, userId: number): Promise<boolean> {
  if (isDatabaseAvailable()) {
    const { rowCount } = await getPool().query(
      'DELETE FROM org_members WHERE org_id = $1 AND user_id = $2',
      [orgId, userId],
    );
    return (rowCount ?? 0) > 0;
  }
  await fileLoad();
  const before = data.members.length;
  data.members = data.members.filter(m => !(m.orgId === orgId && m.userId === userId));
  if (data.members.length === before) return false;
  await fileSave();
  return true;
}

/** How many admins an org has — the guard against removing the last one. */
export async function countOrgAdmins(orgId: number): Promise<number> {
  const members = await listOrgMembers(orgId);
  return members.filter(m => m.role === 'admin').length;
}

// ---------- Domains ----------

export async function claimDomain(orgId: number, rawDomain: string): Promise<OrgDomain> {
  const domain = normalizeDomain(rawDomain);
  if (!domain || !domain.includes('.')) throw new Error(`Invalid domain: ${rawDomain}`);
  if (isPublicEmailDomain(domain)) throw new PublicDomainError(domain);

  if (isDatabaseAvailable()) {
    try {
      const { rows } = await getPool().query(
        `INSERT INTO org_domains (org_id, domain, created_at)
         VALUES ($1, $2, NOW())
         RETURNING id, org_id, domain, verified_at, created_at`,
        [orgId, domain],
      );
      return rowToDomain(rows[0]);
    } catch (err: any) {
      if (err?.code === '23505') throw new DomainClaimedError(domain);
      throw err;
    }
  }

  await fileLoad();
  if (data.domains.some(d => d.domain === domain)) throw new DomainClaimedError(domain);
  const record: OrgDomain = {
    id: nextId(), orgId, domain, verifiedAt: null, createdAt: new Date().toISOString(),
  };
  data.domains.push(record);
  await fileSave();
  return record;
}

/**
 * Mark a claimed domain verified, which is what makes it auto-join users.
 *
 * Operator-gated in stage 1 (see the /api/admin routes): a self-service DNS or
 * postmaster challenge is stage 4. Until then this is the single switch that
 * turns a string somebody typed into an attribution rule, so it stays out of
 * reach of the org admin who typed it.
 */
export async function verifyDomain(orgId: number, rawDomain: string): Promise<OrgDomain | undefined> {
  const domain = normalizeDomain(rawDomain);
  if (isDatabaseAvailable()) {
    const { rows } = await getPool().query(
      `UPDATE org_domains SET verified_at = NOW()
        WHERE org_id = $1 AND domain = $2
        RETURNING id, org_id, domain, verified_at, created_at`,
      [orgId, domain],
    );
    return rows.length ? rowToDomain(rows[0]) : undefined;
  }
  await fileLoad();
  const record = data.domains.find(d => d.orgId === orgId && d.domain === domain);
  if (!record) return undefined;
  record.verifiedAt = new Date().toISOString();
  await fileSave();
  return record;
}

export async function listOrgDomains(orgId: number): Promise<OrgDomain[]> {
  if (isDatabaseAvailable()) {
    const { rows } = await getPool().query(
      `SELECT id, org_id, domain, verified_at, created_at
         FROM org_domains WHERE org_id = $1 ORDER BY domain ASC`,
      [orgId],
    );
    return rows.map(rowToDomain);
  }
  await fileLoad();
  return data.domains.filter(d => d.orgId === orgId).sort((a, b) => a.domain.localeCompare(b.domain));
}

export async function removeOrgDomain(orgId: number, rawDomain: string): Promise<boolean> {
  const domain = normalizeDomain(rawDomain);
  if (isDatabaseAvailable()) {
    const { rowCount } = await getPool().query(
      'DELETE FROM org_domains WHERE org_id = $1 AND domain = $2',
      [orgId, domain],
    );
    return (rowCount ?? 0) > 0;
  }
  await fileLoad();
  const before = data.domains.length;
  data.domains = data.domains.filter(d => !(d.orgId === orgId && d.domain === domain));
  if (data.domains.length === before) return false;
  await fileSave();
  return true;
}

/**
 * The org that owns this address's domain, if any — and only if verified.
 *
 * An unverified claim returns undefined. That asymmetry is the security model:
 * claiming is cheap and anybody can do it, so claiming alone must grant nothing.
 */
export async function findOrgByVerifiedDomain(email: string): Promise<Org | undefined> {
  const domain = emailDomain(email);
  if (!domain || isPublicEmailDomain(domain)) return undefined;

  if (isDatabaseAvailable()) {
    const { rows } = await getPool().query(
      `SELECT o.id, o.name, o.slug, o.created_by, o.created_at, o.updated_at
         FROM org_domains d
         JOIN orgs o ON o.id = d.org_id
        WHERE d.domain = $1 AND d.verified_at IS NOT NULL
        LIMIT 1`,
      [domain],
    );
    return rows.length ? rowToOrg(rows[0]) : undefined;
  }
  await fileLoad();
  const record = data.domains.find(d => d.domain === domain && d.verifiedAt !== null);
  if (!record) return undefined;
  return data.orgs.find(o => o.id === record.orgId);
}

/**
 * Attribute a freshly created or signing-in user to an org by verified domain.
 *
 * Best-effort and never throws: this runs inside the Google callback, the
 * password-verify redemption and the Auth0 JWT mapping, and failing a sign-in
 * because an org lookup blipped would be a far worse outcome than a user who is
 * attributed a moment later. AlreadyInOrgError is an expected no-op here — a
 * user invited to org A whose email domain belongs to org B keeps org A.
 */
export async function attributeUserToOrgByDomain(
  userId: number,
  email: string,
): Promise<OrgMembership | undefined> {
  try {
    const existing = await getMembershipForUser(userId);
    if (existing) return existing;
    const org = await findOrgByVerifiedDomain(email);
    if (!org) return undefined;
    await addOrgMember(org.id, userId, 'member', 'domain');
    console.error(`[orgs] attributed user ${userId} to org ${org.id} (${org.slug}) by verified domain`);
    return { org, role: 'member', source: 'domain' };
  } catch (err: any) {
    if (!(err instanceof AlreadyInOrgError)) {
      console.error('[orgs] domain attribution failed:', err?.message || err);
    }
    return undefined;
  }
}

// ---------- Invites ----------

/**
 * Create an invitation. The plaintext token is returned exactly once, to the
 * caller that mails it; only its hash is stored.
 */
export async function createInvite(input: {
  orgId: number;
  email: string;
  role?: OrgRole;
  invitedBy?: number | null;
  ttlMs?: number;
}): Promise<{ invite: OrgInvite; token: string }> {
  const email = input.email.trim().toLowerCase();
  const role = input.role ?? 'member';
  const token = generateInviteToken();
  const tokenHash = hashInviteToken(token);
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? INVITE_TTL_MS));

  if (isDatabaseAvailable()) {
    const { rows } = await getPool().query(
      `INSERT INTO org_invites (org_id, email, role, token_hash, invited_by, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING id, org_id, email, role, invited_by, expires_at, accepted_at, created_at`,
      [input.orgId, email, role, tokenHash, input.invitedBy ?? null, expiresAt],
    );
    return { invite: rowToInvite(rows[0]), token };
  }

  await fileLoad();
  const invite: OrgInvite & { tokenHash: string } = {
    id: nextId(),
    orgId: input.orgId,
    email,
    role,
    invitedBy: input.invitedBy ?? null,
    expiresAt: expiresAt.toISOString(),
    acceptedAt: null,
    createdAt: new Date().toISOString(),
    tokenHash,
  };
  data.invites.push(invite);
  await fileSave();
  return { invite: toPublicInvite(invite), token };
}

export async function listPendingInvites(orgId: number): Promise<OrgInvite[]> {
  if (isDatabaseAvailable()) {
    const { rows } = await getPool().query(
      `SELECT id, org_id, email, role, invited_by, expires_at, accepted_at, created_at
         FROM org_invites
        WHERE org_id = $1 AND accepted_at IS NULL AND expires_at > NOW()
        ORDER BY created_at DESC`,
      [orgId],
    );
    return rows.map(rowToInvite);
  }
  await fileLoad();
  const now = Date.now();
  return data.invites
    .filter(i => i.orgId === orgId && i.acceptedAt === null && Date.parse(i.expiresAt) > now)
    .map(toPublicInvite)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function revokeInvite(orgId: number, inviteId: number): Promise<boolean> {
  if (isDatabaseAvailable()) {
    const { rowCount } = await getPool().query(
      'DELETE FROM org_invites WHERE org_id = $1 AND id = $2 AND accepted_at IS NULL',
      [orgId, inviteId],
    );
    return (rowCount ?? 0) > 0;
  }
  await fileLoad();
  const before = data.invites.length;
  data.invites = data.invites.filter(
    i => !(i.orgId === orgId && i.id === inviteId && i.acceptedAt === null),
  );
  if (data.invites.length === before) return false;
  await fileSave();
  return true;
}

/**
 * Read an invitation without consuming it, for the page a GET serves.
 *
 * Keeping this separate from redeemInvite is the whole point of the two-request
 * flow: mail scanners (Outlook SafeLinks and friends) follow links, so a GET
 * that consumed the token completed the join on the recipient's behalf and
 * burned their link. Same split as POST /auth/verify, for the same reason.
 */
export async function peekInvite(token: string): Promise<OrgInvite | undefined> {
  const tokenHash = hashInviteToken(token);
  if (isDatabaseAvailable()) {
    const { rows } = await getPool().query(
      `SELECT id, org_id, email, role, invited_by, expires_at, accepted_at, created_at
         FROM org_invites WHERE token_hash = $1`,
      [tokenHash],
    );
    return rows.length ? rowToInvite(rows[0]) : undefined;
  }
  await fileLoad();
  const invite = data.invites.find(i => i.tokenHash === tokenHash);
  if (!invite) return undefined;
  return toPublicInvite(invite);
}

export type RedeemFailure = 'invalid' | 'expired' | 'already-accepted' | 'already-in-org';

export interface RedeemResult {
  ok: boolean;
  failure?: RedeemFailure;
  membership?: OrgMembership;
  /** Set on 'already-in-org' so the caller can say which org holds them. */
  existingOrgId?: number;
}

/**
 * Redeem an invitation and add the user to the org.
 *
 * Single-use: the row is marked accepted in the same statement that checks it,
 * so two concurrent redemptions cannot both win. If adding the member then
 * fails for a reason that is not "already in an org", the acceptance is rolled
 * back — a database blip must not spend a valid link, the same discipline
 * pendingRegistrationStore.ts applies to its own tokens.
 */
export async function redeemInvite(token: string, userId: number): Promise<RedeemResult> {
  const tokenHash = hashInviteToken(token);

  if (isDatabaseAvailable()) {
    const pool = getPool();
    const { rows } = await pool.query(
      `UPDATE org_invites SET accepted_at = NOW()
        WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > NOW()
        RETURNING id, org_id, email, role, invited_by, expires_at, accepted_at, created_at`,
      [tokenHash],
    );
    if (!rows.length) return { ok: false, failure: await classifyRedeemFailure(tokenHash) };
    const invite = rowToInvite(rows[0]);
    try {
      await addOrgMember(invite.orgId, userId, invite.role, 'invite');
    } catch (err) {
      if (err instanceof AlreadyInOrgError) {
        // Consumed deliberately: the link was valid and was used. Re-offering it
        // would suggest the second org is joinable, which it is not.
        return { ok: false, failure: 'already-in-org', existingOrgId: err.existingOrgId };
      }
      await pool.query('UPDATE org_invites SET accepted_at = NULL WHERE id = $1', [invite.id]);
      throw err;
    }
    const org = await getOrgById(invite.orgId);
    if (!org) return { ok: false, failure: 'invalid' };
    return { ok: true, membership: { org, role: invite.role, source: 'invite' } };
  }

  await fileLoad();
  const stored = data.invites.find(i => i.tokenHash === tokenHash);
  if (!stored) return { ok: false, failure: 'invalid' };
  if (stored.acceptedAt !== null) return { ok: false, failure: 'already-accepted' };
  if (Date.parse(stored.expiresAt) <= Date.now()) return { ok: false, failure: 'expired' };

  stored.acceptedAt = new Date().toISOString();
  await fileSave();
  try {
    await addOrgMember(stored.orgId, userId, stored.role, 'invite');
  } catch (err) {
    if (err instanceof AlreadyInOrgError) {
      return { ok: false, failure: 'already-in-org', existingOrgId: err.existingOrgId };
    }
    stored.acceptedAt = null;
    await fileSave();
    throw err;
  }
  const org = data.orgs.find(o => o.id === stored.orgId);
  if (!org) return { ok: false, failure: 'invalid' };
  return { ok: true, membership: { org, role: stored.role, source: 'invite' } };
}

/** Tell apart the reasons the single-use UPDATE matched no row. */
async function classifyRedeemFailure(tokenHash: string): Promise<RedeemFailure> {
  const { rows } = await getPool().query(
    'SELECT accepted_at, expires_at FROM org_invites WHERE token_hash = $1',
    [tokenHash],
  );
  if (!rows.length) return 'invalid';
  if (rows[0].accepted_at !== null) return 'already-accepted';
  return 'expired';
}
