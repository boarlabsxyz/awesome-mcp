import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchGlob, assertAccess, filterChannelList, filterDmsByOrg, filterGroupDmsByRules } from '../../slack-user/accessControl.js';
import type { SlackAccessRules } from '../../mcpConnectionStore.js';
import type { ChannelMeta } from '../../slack-user/accessControl.js';

// === matchGlob ===

describe('matchGlob', () => {
  it('should match * (everything)', () => {
    assert.equal(matchGlob('*', 'anything'), true);
    assert.equal(matchGlob('*', ''), true);
    assert.equal(matchGlob('*', 'hello-world'), true);
  });

  it('should match prefix patterns', () => {
    assert.equal(matchGlob('awesome-*', 'awesome-mcp'), true);
    assert.equal(matchGlob('awesome-*', 'awesome-'), true);
    assert.equal(matchGlob('awesome-*', 'not-awesome'), false);
  });

  it('should match suffix patterns', () => {
    assert.equal(matchGlob('*-support', 'awesome-mcp-support'), true);
    assert.equal(matchGlob('*-support', 'support'), false);
    assert.equal(matchGlob('*-support', 'not-matching'), false);
  });

  it('should match exact strings', () => {
    assert.equal(matchGlob('general', 'general'), true);
    assert.equal(matchGlob('general', 'general2'), false);
    assert.equal(matchGlob('general', 'not-general'), false);
  });

  it('should match ? (single char)', () => {
    assert.equal(matchGlob('test-?', 'test-1'), true);
    assert.equal(matchGlob('test-?', 'test-ab'), false);
    assert.equal(matchGlob('te?t', 'test'), true);
    assert.equal(matchGlob('te?t', 'text'), true);
  });

  it('should be case insensitive', () => {
    assert.equal(matchGlob('General', 'general'), true);
    assert.equal(matchGlob('AWESOME-*', 'awesome-mcp'), true);
  });

  it('should escape regex special chars', () => {
    assert.equal(matchGlob('test.channel', 'test.channel'), true);
    assert.equal(matchGlob('test.channel', 'testXchannel'), false);
  });
});

// === assertAccess ===

describe('assertAccess', () => {
  const defaultRules: SlackAccessRules = {
    allowedOrgs: ['T_BOARLABS'],
    blacklistUsers: ['U_BLOCKED'],
    whitelistChannels: ['*'],
    blacklistChannels: ['secret-*'],
    allowPublicOnly: false,
  };

  function makeMeta(overrides: Partial<ChannelMeta>): ChannelMeta {
    return {
      id: 'C123',
      name: 'general',
      is_private: false,
      is_shared: false,
      is_im: false,
      is_mpim: false,
      ...overrides,
    };
  }

  it('should allow a public channel matching whitelist', () => {
    assert.doesNotThrow(() => assertAccess(defaultRules, makeMeta({ name: 'general' })));
  });

  it('should block a channel matching blacklist pattern', () => {
    assert.throws(
      () => assertAccess(defaultRules, makeMeta({ name: 'secret-project' })),
      { message: /blacklist pattern/ }
    );
  });

  it('should block when whitelist is empty', () => {
    const rules = { ...defaultRules, whitelistChannels: [] };
    assert.throws(
      () => assertAccess(rules, makeMeta({ name: 'general' })),
      { message: /no channel whitelist/ }
    );
  });

  it('should block when channel name does not match whitelist', () => {
    const rules = { ...defaultRules, whitelistChannels: ['awesome-*'] };
    assert.throws(
      () => assertAccess(rules, makeMeta({ name: 'general' })),
      { message: /does not match any whitelist/ }
    );
  });

  it('should allow channel matching specific whitelist pattern', () => {
    const rules = { ...defaultRules, whitelistChannels: ['awesome-*'] };
    assert.doesNotThrow(() => assertAccess(rules, makeMeta({ name: 'awesome-mcp-support' })));
  });

  it('should block private channel when allowPublicOnly is true', () => {
    const rules = { ...defaultRules, allowPublicOnly: true };
    assert.throws(
      () => assertAccess(rules, makeMeta({ name: 'general', is_private: true })),
      { message: /public channels/ }
    );
  });

  it('should allow private channel when allowPublicOnly is false', () => {
    assert.doesNotThrow(() => assertAccess(defaultRules, makeMeta({ name: 'general', is_private: true })));
  });

  // DM checks
  it('should allow a DM with non-blacklisted user', () => {
    assert.doesNotThrow(() => assertAccess(defaultRules, makeMeta({ is_im: true, user: 'U_OK' })));
  });

  it('should block a DM with blacklisted user', () => {
    assert.throws(
      () => assertAccess(defaultRules, makeMeta({ is_im: true, user: 'U_BLOCKED' })),
      { message: /blacklist/ }
    );
  });

  it('should allow a group DM (mpim) — blacklist checked elsewhere', () => {
    assert.doesNotThrow(() => assertAccess(defaultRules, makeMeta({ is_mpim: true })));
  });

  // Shared channel org check
  it('should block shared channel from non-allowed org', () => {
    assert.throws(
      () => assertAccess(defaultRules, makeMeta({
        name: 'external-channel',
        is_shared: true,
        shared_team_ids: ['T_OTHER'],
      })),
      { message: /not in your allowed list/ }
    );
  });

  it('should allow shared channel from allowed org', () => {
    assert.doesNotThrow(() => assertAccess(defaultRules, makeMeta({
      name: 'shared-channel',
      is_shared: true,
      shared_team_ids: ['T_BOARLABS', 'T_OTHER'],
    })));
  });

  it('should block shared channel when org cannot be verified', () => {
    assert.throws(
      () => assertAccess(defaultRules, makeMeta({
        name: 'shared-channel',
        is_shared: true,
        shared_team_ids: [],
      })),
      { message: /could not be verified/ }
    );
  });
});

// === filterChannelList ===

describe('filterChannelList', () => {
  const rules: SlackAccessRules = {
    allowedOrgs: ['T_BOARLABS'],
    blacklistUsers: ['U_BLOCKED'],
    whitelistChannels: ['awesome-*', 'general'],
    blacklistChannels: ['awesome-secret-*'],
    allowPublicOnly: false,
  };

  const channels = [
    { id: 'C1', name: 'awesome-mcp', is_private: false },
    { id: 'C2', name: 'awesome-secret-project', is_private: false },
    { id: 'C3', name: 'general', is_private: false },
    { id: 'C4', name: 'random', is_private: false },
    { id: 'C5', name: 'awesome-support', is_private: true },
    { id: 'D1', name: 'U_OK', is_private: true, is_im: true, user: 'U_OK' },
    { id: 'D2', name: 'U_BLOCKED', is_private: true, is_im: true, user: 'U_BLOCKED' },
  ];

  it('should filter channels by whitelist/blacklist', () => {
    const result = filterChannelList(rules, channels);
    const ids = result.map(ch => ch.id);
    assert.ok(ids.includes('C1')); // awesome-mcp matches awesome-*
    assert.ok(!ids.includes('C2')); // awesome-secret-project matches blacklist
    assert.ok(ids.includes('C3')); // general matches exactly
    assert.ok(!ids.includes('C4')); // random doesn't match whitelist
  });

  it('should allow DMs that are not blacklisted', () => {
    const result = filterChannelList(rules, channels);
    const ids = result.map(ch => ch.id);
    assert.ok(ids.includes('D1')); // U_OK not blacklisted
    assert.ok(!ids.includes('D2')); // U_BLOCKED is blacklisted
  });

  it('should block private channels when allowPublicOnly', () => {
    const pubRules = { ...rules, allowPublicOnly: true };
    const result = filterChannelList(pubRules, channels);
    const ids = result.map(ch => ch.id);
    assert.ok(!ids.includes('C5')); // private, blocked
    assert.ok(ids.includes('C1')); // public, passes
  });

  it('should return nothing when whitelist is empty', () => {
    const emptyRules = { ...rules, whitelistChannels: [] };
    const result = filterChannelList(emptyRules, channels);
    // Only DMs should pass (they skip whitelist check)
    const channelResults = result.filter(ch => !(ch as any).is_im);
    assert.equal(channelResults.length, 0);
  });

  it('should let shared channels through when shared_team_ids unavailable', () => {
    const sharedChannels = [
      { id: 'CS1', name: 'awesome-shared', is_private: false, is_ext_shared: true },
    ];
    const result = filterChannelList(rules, sharedChannels);
    assert.equal(result.length, 1); // passes through, enforced at read time
  });

  it('should block shared channels when org not in allowedOrgs', () => {
    const sharedChannels = [
      { id: 'CS1', name: 'awesome-shared', is_private: false, is_ext_shared: true, shared_team_ids: ['T_OTHER'] },
    ];
    const result = filterChannelList(rules, sharedChannels);
    assert.equal(result.length, 0);
  });

  it('should allow shared channels when org is in allowedOrgs', () => {
    const sharedChannels = [
      { id: 'CS1', name: 'awesome-shared', is_private: false, is_ext_shared: true, shared_team_ids: ['T_BOARLABS'] },
    ];
    const result = filterChannelList(rules, sharedChannels);
    assert.equal(result.length, 1);
  });
});

// === filterDmsByOrg ===

describe('filterDmsByOrg', () => {
  function mockClient(teamMap: Record<string, string>): any {
    return {
      usersInfo: async (uid: string) => ({
        user: { id: uid, name: uid, real_name: uid, team_id: teamMap[uid] || '' },
      }),
    };
  }

  it('should skip filtering when allowedOrgs is empty', async () => {
    const rules: SlackAccessRules = { allowedOrgs: [], blacklistUsers: [], whitelistChannels: [], blacklistChannels: [], allowPublicOnly: false };
    const channels = [{ id: 'D1', name: 'user', is_im: true, user: 'U1', is_private: true }];
    const result = await filterDmsByOrg(mockClient({}), rules, channels);
    assert.equal(result.length, 1);
  });

  it('should filter out DMs from non-allowed orgs', async () => {
    const rules: SlackAccessRules = { allowedOrgs: ['T_MINE'], blacklistUsers: [], whitelistChannels: [], blacklistChannels: [], allowPublicOnly: false };
    const channels = [
      { id: 'D1', name: 'u1', is_im: true, user: 'U1', is_private: true },
      { id: 'D2', name: 'u2', is_im: true, user: 'U2', is_private: true },
      { id: 'C1', name: 'general', is_private: false }, // non-DM passes through
    ];
    const client = mockClient({ U1: 'T_MINE', U2: 'T_OTHER' });
    const result = await filterDmsByOrg(client, rules, channels);
    const ids = result.map(ch => ch.id);
    assert.ok(ids.includes('D1'));
    assert.ok(!ids.includes('D2'));
    assert.ok(ids.includes('C1'));
  });

  it('should allow DMs when user team_id cannot be resolved', async () => {
    const rules: SlackAccessRules = { allowedOrgs: ['T_MINE'], blacklistUsers: [], whitelistChannels: [], blacklistChannels: [], allowPublicOnly: false };
    const channels = [{ id: 'D1', name: 'u1', is_im: true, user: 'U1', is_private: true }];
    const client = { usersInfo: async () => { throw new Error('fail'); } };
    const result = await filterDmsByOrg(client as any, rules, channels);
    assert.equal(result.length, 1);
  });
});

// === filterGroupDmsByRules ===

describe('filterGroupDmsByRules', () => {
  function mockClient(members: Record<string, string[]>, teamMap?: Record<string, string>): any {
    return {
      conversationsMembers: async (chId: string) => ({ members: members[chId] || [] }),
      usersInfo: async (uid: string) => ({
        user: { id: uid, name: uid, real_name: uid, team_id: teamMap?.[uid] || 'T_DEFAULT' },
      }),
    };
  }

  it('should skip filtering when no blacklist and no org filter', async () => {
    const rules: SlackAccessRules = { allowedOrgs: [], blacklistUsers: [], whitelistChannels: [], blacklistChannels: [], allowPublicOnly: false };
    const channels = [{ id: 'G1', name: 'group', is_mpim: true, is_private: true }];
    const result = await filterGroupDmsByRules(mockClient({}), rules, channels);
    assert.equal(result.length, 1);
  });

  it('should block group DM containing blacklisted user', async () => {
    const rules: SlackAccessRules = { allowedOrgs: [], blacklistUsers: ['U_BAD'], whitelistChannels: [], blacklistChannels: [], allowPublicOnly: false };
    const channels = [
      { id: 'G1', name: 'group1', is_mpim: true, is_private: true },
      { id: 'G2', name: 'group2', is_mpim: true, is_private: true },
    ];
    const client = mockClient({ G1: ['U1', 'U_BAD'], G2: ['U1', 'U2'] });
    const result = await filterGroupDmsByRules(client, rules, channels);
    const ids = result.map(ch => ch.id);
    assert.ok(!ids.includes('G1'));
    assert.ok(ids.includes('G2'));
  });

  it('should block group DM with member from non-allowed org', async () => {
    const rules: SlackAccessRules = { allowedOrgs: ['T_MINE'], blacklistUsers: [], whitelistChannels: [], blacklistChannels: [], allowPublicOnly: false };
    const channels = [{ id: 'G1', name: 'group', is_mpim: true, is_private: true }];
    const client = mockClient({ G1: ['U1', 'U2'] }, { U1: 'T_MINE', U2: 'T_OTHER' });
    const result = await filterGroupDmsByRules(client, rules, channels);
    assert.equal(result.length, 0);
  });

  it('should allow group DM when all members are from allowed orgs', async () => {
    const rules: SlackAccessRules = { allowedOrgs: ['T_MINE'], blacklistUsers: [], whitelistChannels: [], blacklistChannels: [], allowPublicOnly: false };
    const channels = [{ id: 'G1', name: 'group', is_mpim: true, is_private: true }];
    const client = mockClient({ G1: ['U1', 'U2'] }, { U1: 'T_MINE', U2: 'T_MINE' });
    const result = await filterGroupDmsByRules(client, rules, channels);
    assert.equal(result.length, 1);
  });

  it('should not filter non-mpim channels', async () => {
    const rules: SlackAccessRules = { allowedOrgs: [], blacklistUsers: ['U_BAD'], whitelistChannels: [], blacklistChannels: [], allowPublicOnly: false };
    const channels = [{ id: 'C1', name: 'general', is_private: false }];
    const result = await filterGroupDmsByRules(mockClient({}), rules, channels);
    assert.equal(result.length, 1);
  });
});
