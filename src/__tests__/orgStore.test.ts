import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Set DATA_DIR to a temp directory before importing the module — orgStore reads
// it at load time, exactly like mcpConnectionStore.
const tmpDir = path.join(__dirname, '..', '..', '.test-data-orgs-' + Date.now());
process.env.DATA_DIR = tmpDir;

const store = await import('../orgStore.js');

describe('orgStore (file-based)', () => {
  before(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('helpers', () => {
    it('normalizeDomain lowercases and strips a leading @', () => {
      assert.equal(store.normalizeDomain('  @Acme.COM '), 'acme.com');
    });

    it('emailDomain takes the last @ segment', () => {
      assert.equal(store.emailDomain('a.b+tag@Sub.Acme.com'), 'sub.acme.com');
      assert.equal(store.emailDomain('not-an-email'), '');
      assert.equal(store.emailDomain('trailing@'), '');
    });

    it('isPublicEmailDomain covers the big providers', () => {
      assert.equal(store.isPublicEmailDomain('gmail.com'), true);
      assert.equal(store.isPublicEmailDomain('GMAIL.COM'), true);
      assert.equal(store.isPublicEmailDomain('acme.com'), false);
    });

    it('slugifyOrgName produces a URL-safe slug and never returns empty', () => {
      assert.equal(store.slugifyOrgName('Acme, Inc.'), 'acme-inc');
      assert.match(store.slugifyOrgName('!!!'), /^org-[0-9a-f]{8}$/);
    });

    it('hashInviteToken is a stable sha256 hex and is not the token', () => {
      const token = store.generateInviteToken();
      const hash = store.hashInviteToken(token);
      assert.match(hash, /^[0-9a-f]{64}$/);
      assert.notEqual(hash, token);
      assert.equal(hash, store.hashInviteToken(token));
    });
  });

  describe('orgs and membership', () => {
    it('createOrg derives a slug and rejects a duplicate', async () => {
      const org = await store.createOrg({ name: 'Acme Inc', createdBy: 1 });
      assert.equal(org.slug, 'acme-inc');
      assert.equal(org.createdBy, 1);
      assert.equal((await store.getOrgBySlug('acme-inc'))?.id, org.id);
      await assert.rejects(
        () => store.createOrg({ name: 'Acme Inc' }),
        (err: Error) => err.name === 'OrgSlugTakenError',
      );
    });

    it('a user with no org has no membership', async () => {
      assert.equal(await store.getMembershipForUser(999), undefined);
    });

    it('addOrgMember attaches a role and source, and getMembershipForUser joins the org', async () => {
      const org = await store.createOrg({ name: 'Members Co' });
      await store.addOrgMember(org.id, 11, 'admin', 'manual');
      const membership = await store.getMembershipForUser(11);
      assert.equal(membership?.org.id, org.id);
      assert.equal(membership?.role, 'admin');
      assert.equal(membership?.source, 'manual');
    });

    it('addOrgMember is idempotent for the same org', async () => {
      const org = await store.createOrg({ name: 'Idem Co' });
      const first = await store.addOrgMember(org.id, 12, 'member', 'invite');
      const second = await store.addOrgMember(org.id, 12, 'member', 'invite');
      assert.equal(first.id, second.id);
      assert.equal((await store.listOrgMembers(org.id)).length, 1);
    });

    it('addOrgMember refuses a SECOND org for the same user', async () => {
      const a = await store.createOrg({ name: 'First Org' });
      const b = await store.createOrg({ name: 'Second Org' });
      await store.addOrgMember(a.id, 13, 'member', 'invite');
      await assert.rejects(
        () => store.addOrgMember(b.id, 13, 'member', 'invite'),
        (err: any) => err.name === 'AlreadyInOrgError' && err.existingOrgId === a.id,
      );
      // The original membership is untouched.
      assert.equal((await store.getMembershipForUser(13))?.org.id, a.id);
    });

    it('setMemberRole and countOrgAdmins track the admin count', async () => {
      const org = await store.createOrg({ name: 'Roles Co' });
      await store.addOrgMember(org.id, 14, 'admin', 'manual');
      await store.addOrgMember(org.id, 15, 'member', 'invite');
      assert.equal(await store.countOrgAdmins(org.id), 1);
      await store.setMemberRole(org.id, 15, 'admin');
      assert.equal(await store.countOrgAdmins(org.id), 2);
      assert.equal(await store.setMemberRole(org.id, 999, 'admin'), undefined);
    });

    it('removeOrgMember reports whether it removed anything', async () => {
      const org = await store.createOrg({ name: 'Remove Co' });
      await store.addOrgMember(org.id, 16, 'member', 'invite');
      assert.equal(await store.removeOrgMember(org.id, 16), true);
      assert.equal(await store.removeOrgMember(org.id, 16), false);
      assert.equal(await store.getMembershipForUser(16), undefined);
    });
  });

  describe('domains', () => {
    it('claimDomain normalises, and refuses a public provider', async () => {
      const org = await store.createOrg({ name: 'Domain Co' });
      const claimed = await store.claimDomain(org.id, '@Domain-Co.COM');
      assert.equal(claimed.domain, 'domain-co.com');
      assert.equal(claimed.verifiedAt, null, 'a fresh claim must start unverified');
      await assert.rejects(
        () => store.claimDomain(org.id, 'gmail.com'),
        (err: Error) => err.name === 'PublicDomainError',
      );
      await assert.rejects(() => store.claimDomain(org.id, 'nodots'), /Invalid domain/);
    });

    it('a domain can only be claimed once, across orgs', async () => {
      const a = await store.createOrg({ name: 'Claim A' });
      const b = await store.createOrg({ name: 'Claim B' });
      await store.claimDomain(a.id, 'contested.com');
      await assert.rejects(
        () => store.claimDomain(b.id, 'contested.com'),
        (err: Error) => err.name === 'DomainClaimedError',
      );
    });

    it('an UNVERIFIED domain never resolves an org', async () => {
      const org = await store.createOrg({ name: 'Unverified Co' });
      await store.claimDomain(org.id, 'unverified-co.com');
      assert.equal(await store.findOrgByVerifiedDomain('someone@unverified-co.com'), undefined);
      const verified = await store.verifyDomain(org.id, 'unverified-co.com');
      assert.ok(verified?.verifiedAt);
      assert.equal((await store.findOrgByVerifiedDomain('someone@unverified-co.com'))?.id, org.id);
    });

    it('findOrgByVerifiedDomain ignores public domains even if somehow stored', async () => {
      assert.equal(await store.findOrgByVerifiedDomain('someone@gmail.com'), undefined);
      assert.equal(await store.findOrgByVerifiedDomain('malformed'), undefined);
    });

    it('removeOrgDomain reports whether it removed anything', async () => {
      const org = await store.createOrg({ name: 'Drop Domain Co' });
      await store.claimDomain(org.id, 'drop-me.com');
      assert.equal(await store.removeOrgDomain(org.id, 'DROP-ME.com'), true);
      assert.equal(await store.removeOrgDomain(org.id, 'drop-me.com'), false);
    });
  });

  describe('attributeUserToOrgByDomain', () => {
    it('joins on a verified domain and records source=domain', async () => {
      const org = await store.createOrg({ name: 'Attr Co' });
      await store.claimDomain(org.id, 'attr-co.com');
      await store.verifyDomain(org.id, 'attr-co.com');
      const membership = await store.attributeUserToOrgByDomain(21, 'new.hire@attr-co.com');
      assert.equal(membership?.org.id, org.id);
      assert.equal(membership?.source, 'domain');
      assert.equal(membership?.role, 'member');
    });

    it('leaves an existing membership alone rather than moving the user', async () => {
      const invitedTo = await store.createOrg({ name: 'Invited Org' });
      const domainOrg = await store.createOrg({ name: 'Domain Org' });
      await store.claimDomain(domainOrg.id, 'domain-org.com');
      await store.verifyDomain(domainOrg.id, 'domain-org.com');
      await store.addOrgMember(invitedTo.id, 22, 'member', 'invite');

      const result = await store.attributeUserToOrgByDomain(22, 'person@domain-org.com');
      assert.equal(result?.org.id, invitedTo.id, 'an explicit invite outranks a domain match');
      assert.equal((await store.getMembershipForUser(22))?.org.id, invitedTo.id);
    });

    it('is a quiet no-op when no org claims the domain', async () => {
      assert.equal(await store.attributeUserToOrgByDomain(23, 'nobody@unclaimed-xyz.com'), undefined);
      assert.equal(await store.getMembershipForUser(23), undefined);
    });
  });

  describe('invites', () => {
    it('createInvite returns the token once and stores only its hash', async () => {
      const org = await store.createOrg({ name: 'Invite Co' });
      const { invite, token } = await store.createInvite({
        orgId: org.id, email: 'Invitee@Example.org', role: 'admin', invitedBy: 31,
      });
      assert.equal(invite.email, 'invitee@example.org', 'email is normalised');
      assert.equal(invite.role, 'admin');
      assert.equal(invite.acceptedAt, null);
      assert.ok(token.length > 20);
      // The returned record must not carry the hash, let alone the token.
      assert.equal((invite as any).tokenHash, undefined);
      const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'orgs.json'), 'utf-8'));
      const stored = raw.invites.find((i: any) => i.id === invite.id);
      assert.equal(stored.tokenHash, store.hashInviteToken(token));
      assert.ok(!JSON.stringify(raw).includes(token), 'the plaintext token must never be persisted');
    });

    it('peekInvite reads without consuming — the SafeLinks guard', async () => {
      const org = await store.createOrg({ name: 'Peek Co' });
      const { token } = await store.createInvite({ orgId: org.id, email: 'peek@x.com' });
      assert.equal((await store.peekInvite(token))?.acceptedAt, null);
      assert.equal((await store.peekInvite(token))?.acceptedAt, null);
      // Still redeemable after two peeks.
      assert.equal((await store.redeemInvite(token, 32)).ok, true);
    });

    it('redeemInvite adds the member and is single-use', async () => {
      const org = await store.createOrg({ name: 'Redeem Co' });
      const { token } = await store.createInvite({ orgId: org.id, email: 'r@x.com', role: 'admin' });
      const first = await store.redeemInvite(token, 33);
      assert.equal(first.ok, true);
      assert.equal(first.membership?.org.id, org.id);
      assert.equal(first.membership?.role, 'admin');
      assert.equal(first.membership?.source, 'invite');

      const second = await store.redeemInvite(token, 34);
      assert.equal(second.ok, false);
      assert.equal(second.failure, 'already-accepted');
      assert.equal(await store.getMembershipForUser(34), undefined);
    });

    it('an unknown token is invalid, an expired one is expired', async () => {
      const org = await store.createOrg({ name: 'Expiry Co' });
      assert.deepEqual(await store.redeemInvite('nope', 35), { ok: false, failure: 'invalid' });
      const { token } = await store.createInvite({ orgId: org.id, email: 'e@x.com', ttlMs: -1000 });
      assert.deepEqual(await store.redeemInvite(token, 35), { ok: false, failure: 'expired' });
    });

    it('a user already in another org cannot redeem, and the link stays spent', async () => {
      const home = await store.createOrg({ name: 'Home Org' });
      const other = await store.createOrg({ name: 'Other Org' });
      await store.addOrgMember(home.id, 36, 'member', 'invite');
      const { token } = await store.createInvite({ orgId: other.id, email: 'x@x.com' });

      const result = await store.redeemInvite(token, 36);
      assert.equal(result.ok, false);
      assert.equal(result.failure, 'already-in-org');
      assert.equal(result.existingOrgId, home.id);
      assert.equal((await store.peekInvite(token))?.acceptedAt !== null, true);
    });

    it('listPendingInvites hides accepted and expired ones; revokeInvite removes', async () => {
      const org = await store.createOrg({ name: 'Pending Co' });
      const live = await store.createInvite({ orgId: org.id, email: 'live@x.com' });
      const dead = await store.createInvite({ orgId: org.id, email: 'dead@x.com', ttlMs: -1 });
      const used = await store.createInvite({ orgId: org.id, email: 'used@x.com' });
      await store.redeemInvite(used.token, 37);

      const pending = await store.listPendingInvites(org.id);
      assert.deepEqual(pending.map(i => i.email), ['live@x.com']);
      assert.equal(dead.invite.orgId, org.id);

      assert.equal(await store.revokeInvite(org.id, live.invite.id), true);
      assert.equal(await store.revokeInvite(org.id, live.invite.id), false);
      assert.equal((await store.listPendingInvites(org.id)).length, 0);
      // An accepted invite cannot be revoked — the membership it created stands.
      assert.equal(await store.revokeInvite(org.id, used.invite.id), false);
    });
  });
});
