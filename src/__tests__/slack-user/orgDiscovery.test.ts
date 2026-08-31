import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { discoverConnectedOrgs, CHANNEL_INFO_MAX } from '../../slack-user/orgDiscovery.js';

/**
 * Build a stub client. Every sweep defaults to empty, so each test only
 * declares the source it cares about.
 */
function mockClient(overrides: Record<string, any> = {}): any {
  return {
    conversationsListAll: async () => ({ channels: [] }),
    conversationsList: async () => ({ channels: [] }),
    conversationsInfo: async () => ({ channel: { id: 'C' } }),
    usersList: async () => ({ members: [] }),
    usersInfo: async () => ({ user: { id: 'U' } }),
    teamInfo: async () => { throw new Error('team.info not available for external team'); },
    ...overrides,
  };
}

function ids(result: { orgs: Array<{ id: string }> }): string[] {
  return result.orgs.map(o => o.id).sort();
}

describe('discoverConnectedOrgs — shared channels', () => {
  it('inspects far more than the first 10 shared channels', async () => {
    // The original bug: conversations.info ran over sharedChannelIds.slice(0, 10),
    // so an org present only in a later shared channel was never offered.
    const channels = Array.from({ length: 40 }, (_, i) => ({
      id: `C${i}`, is_ext_shared: true,
    }));
    const client = mockClient({
      conversationsListAll: async () => ({ channels }),
      conversationsInfo: async (id: string) => ({
        channel: { id, connected_team_ids: [`T_EXT_${id}`] },
      }),
    });

    const result = await discoverConnectedOrgs(client, { currentOrgId: 'T_HOME' });

    assert.ok(result.orgs.some(o => o.id === 'T_EXT_C39'), 'org from the 40th shared channel must be listed');
    assert.equal(result.orgs.length, 40);
    assert.equal(result.truncated, false);
  });

  it('reports truncation instead of silently dropping shared channels', async () => {
    const channels = Array.from({ length: CHANNEL_INFO_MAX + 5 }, (_, i) => ({
      id: `C${i}`, is_ext_shared: true,
    }));
    const client = mockClient({
      conversationsListAll: async () => ({ channels }),
      conversationsInfo: async (id: string) => ({ channel: { id, connected_team_ids: [`T_${id}`] } }),
    });

    const result = await discoverConnectedOrgs(client, { currentOrgId: 'T_HOME' });

    assert.equal(result.truncated, true);
    assert.ok(result.notes.some(n => n.includes('5 shared channel')), result.notes.join(' | '));
  });

  it('harvests team IDs already on the list payload without an extra lookup', async () => {
    let infoCalls = 0;
    const client = mockClient({
      conversationsListAll: async () => ({
        channels: [{ id: 'C1', is_ext_shared: true, connected_team_ids: ['T_PARTNER'] }],
      }),
      conversationsInfo: async (id: string) => { infoCalls++; return { channel: { id } }; },
    });

    const result = await discoverConnectedOrgs(client, { currentOrgId: 'T_HOME' });

    assert.deepEqual(ids(result), ['T_PARTNER']);
    assert.equal(infoCalls, 0, 'no conversations.info needed when the list payload already names the org');
  });

  it('still enriches a shared channel whose payload carries only context_team_id', async () => {
    // context_team_id is the *viewing* workspace, so this payload names no
    // partner. Counting it as resolved skipped the conversations.info call and
    // lost the external org.
    const client = mockClient({
      conversationsListAll: async () => ({
        channels: [{ id: 'C1', is_ext_shared: true, context_team_id: 'T_HOME' }],
      }),
      conversationsInfo: async (id: string) => ({
        channel: { id, connected_team_ids: ['T_PARTNER'] },
      }),
    });

    const result = await discoverConnectedOrgs(client, { currentOrgId: 'T_HOME' });

    assert.deepEqual(ids(result), ['T_PARTNER']);
  });

  it('reads pending_shared alongside pending_connected_team_ids', async () => {
    const client = mockClient({
      conversationsListAll: async () => ({
        channels: [{ id: 'C1', is_pending_ext_shared: true, pending_shared: ['T_INVITED'] }],
      }),
    });

    const result = await discoverConnectedOrgs(client, { currentOrgId: 'T_HOME' });

    assert.deepEqual(ids(result), ['T_INVITED']);
  });

  it('reads connected_team_ids and pending_connected_team_ids, not just shared_team_ids', async () => {
    const client = mockClient({
      conversationsListAll: async () => ({
        channels: [{
          id: 'C1',
          is_pending_ext_shared: true,
          shared_team_ids: ['T_HOME'],
          connected_team_ids: ['T_PARTNER'],
          pending_connected_team_ids: ['T_INVITED'],
        }],
      }),
    });

    const result = await discoverConnectedOrgs(client, { currentOrgId: 'T_HOME' });

    assert.deepEqual(ids(result), ['T_INVITED', 'T_PARTNER']);
  });
});

describe('discoverConnectedOrgs — DMs and users', () => {
  it('finds an org reachable only through a Slack Connect DM', async () => {
    // conversations.list never returns im/mpim, so the old pass could not see
    // this org at all — while allowedOrgs is still enforced on DMs.
    const client = mockClient({
      conversationsList: async () => ({ channels: [{ id: 'D1', is_im: true, user: 'U_EXT' }] }),
      usersList: async () => ({ members: [{ id: 'U_EXT', team_id: 'T_PARTNER' }] }),
    });

    const result = await discoverConnectedOrgs(client, { currentOrgId: 'T_HOME' });

    assert.deepEqual(ids(result), ['T_PARTNER']);
  });

  it('falls back to users.info for a DM counterpart missing from users.list', async () => {
    const client = mockClient({
      conversationsList: async () => ({ channels: [{ id: 'D1', is_im: true, user: 'U_EXT' }] }),
      usersList: async () => ({ members: [] }),
      usersInfo: async (uid: string) => ({ user: { id: uid, team_id: 'T_PARTNER' } }),
    });

    const result = await discoverConnectedOrgs(client, { currentOrgId: 'T_HOME' });

    assert.deepEqual(ids(result), ['T_PARTNER']);
  });

  it('ignores deleted users', async () => {
    const client = mockClient({
      usersList: async () => ({
        members: [
          { id: 'U1', team_id: 'T_GONE', deleted: true },
          { id: 'U2', team_id: 'T_LIVE' },
        ],
      }),
    });

    const result = await discoverConnectedOrgs(client, { currentOrgId: 'T_HOME' });

    assert.deepEqual(ids(result), ['T_LIVE']);
  });

  it('pages users.list and reports when it stops early', async () => {
    const client = mockClient({
      usersList: async (cursor?: string) => ({
        members: [{ id: `U${cursor || '0'}`, team_id: `T${cursor || '0'}` }],
        response_metadata: { next_cursor: `c${Number(cursor?.slice(1) || 0) + 1}` },
      }),
    });

    const result = await discoverConnectedOrgs(client, { currentOrgId: 'T_HOME' });

    assert.equal(result.truncated, true);
    assert.ok(result.notes.some(n => n.includes('pages of users')), result.notes.join(' | '));
  });
});

describe('discoverConnectedOrgs — result shape', () => {
  it('never lists the current workspace as a connected org', async () => {
    const client = mockClient({
      conversationsListAll: async () => ({ channels: [{ id: 'C1', is_ext_shared: true, shared_team_ids: ['T_HOME'] }] }),
    });

    const result = await discoverConnectedOrgs(client, { currentOrgId: 'T_HOME' });

    assert.deepEqual(result.orgs, []);
  });

  it('keeps a saved org that nothing rediscovered, flagged as saved', async () => {
    // Without this row the dashboard renders no checkbox for the org, and the
    // save path would drop it from the allowlist.
    const result = await discoverConnectedOrgs(mockClient(), {
      currentOrgId: 'T_HOME',
      savedOrgIds: ['T_OLD_PARTNER'],
    });

    assert.deepEqual(ids(result), ['T_OLD_PARTNER']);
    assert.equal(result.orgs[0].saved, true);
  });

  it('does not flag a saved org as saved-only when it was also rediscovered', async () => {
    const client = mockClient({
      conversationsListAll: async () => ({ channels: [{ id: 'C1', is_ext_shared: true, connected_team_ids: ['T_PARTNER'] }] }),
    });

    const result = await discoverConnectedOrgs(client, { currentOrgId: 'T_HOME', savedOrgIds: ['T_PARTNER'] });

    assert.equal(result.orgs[0].saved, false);
  });

  it('marks an org unnamed when team.info fails for a foreign workspace', async () => {
    const client = mockClient({
      conversationsListAll: async () => ({ channels: [{ id: 'C1', is_ext_shared: true, connected_team_ids: ['T_PARTNER'] }] }),
    });

    const result = await discoverConnectedOrgs(client, { currentOrgId: 'T_HOME' });

    assert.equal(result.orgs[0].name, 'T_PARTNER');
    assert.equal(result.orgs[0].nameResolved, false);
  });

  it('resolves names when team.info answers', async () => {
    const client = mockClient({
      conversationsListAll: async () => ({ channels: [{ id: 'C1', is_ext_shared: true, connected_team_ids: ['T_PARTNER'] }] }),
      teamInfo: async (id: string) => ({ team: { id, name: 'Partner Inc' } }),
    });

    const result = await discoverConnectedOrgs(client, { currentOrgId: 'T_HOME' });

    assert.equal(result.orgs[0].name, 'Partner Inc');
    assert.equal(result.orgs[0].nameResolved, true);
  });

  it('degrades to a note when a whole sweep fails, rather than throwing', async () => {
    const client = mockClient({
      conversationsListAll: async () => { throw new Error('missing_scope'); },
      usersList: async () => ({ members: [{ id: 'U1', team_id: 'T_PARTNER' }] }),
    });

    const result = await discoverConnectedOrgs(client, { currentOrgId: 'T_HOME' });

    assert.deepEqual(ids(result), ['T_PARTNER']);
    assert.equal(result.truncated, true);
    assert.ok(result.notes.some(n => n.includes('missing_scope')), result.notes.join(' | '));
  });
});
