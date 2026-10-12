import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { discoverConnectedOrgs, CHANNEL_INFO_MAX, LIST_MAX_PAGES } from '../../slack-user/orgDiscovery.js';

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
  return result.orgs.map(o => o.id).sort((a, b) => a.localeCompare(b));
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

  it('spends the conversations.info budget on the user\'s own channels first', async () => {
    // The reported bug. The workspace-wide sweep queues its channels before the
    // member-scoped one does, so insertion order spent the whole budget on
    // channels the user is not in and truncated away the private Slack Connect
    // channel they are — leaving its org with no checkbox, hence unreachable.
    const workspaceChannels = Array.from({ length: CHANNEL_INFO_MAX + 50 }, (_, i) => ({
      id: `C_WS_${i}`, is_shared: true,
    }));
    const client = mockClient({
      conversationsListAll: async () => ({ channels: workspaceChannels }),
      conversationsList: async (_cursor: string | undefined, types: string) => (
        types === 'im,mpim'
          ? { channels: [] }
          : { channels: [{ id: 'C_MINE', is_ext_shared: true }] }
      ),
      conversationsInfo: async (id: string) => ({ channel: { id, connected_team_ids: [`T_${id}`] } }),
    });

    const result = await discoverConnectedOrgs(client, { currentOrgId: 'T_HOME' });

    assert.ok(
      result.orgs.some(o => o.id === 'T_C_MINE'),
      'the org of a shared channel the user is a member of must survive the cap',
    );
    assert.equal(result.truncated, true);
  });

  it('says when the skipped channels are ones the user is not a member of', async () => {
    const client = mockClient({
      conversationsListAll: async () => ({
        channels: Array.from({ length: CHANNEL_INFO_MAX + 3 }, (_, i) => ({ id: `C${i}`, is_shared: true })),
      }),
      conversationsInfo: async (id: string) => ({ channel: { id, connected_team_ids: [`T_${id}`] } }),
    });

    const result = await discoverConnectedOrgs(client, { currentOrgId: 'T_HOME' });

    assert.ok(
      result.notes.some(n => n.includes('you are not a member of')),
      result.notes.join(' | '),
    );
  });

  it('reports a shared channel it could not inspect instead of swallowing it', async () => {
    // 100 sequential tier-3 lookups routinely hit a 429. A failure that is not
    // reported is indistinguishable from an org that is not there.
    const client = mockClient({
      conversationsListAll: async () => ({ channels: [{ id: 'C1', is_ext_shared: true }] }),
      conversationsInfo: async () => { throw new Error('ratelimited'); },
    });

    const result = await discoverConnectedOrgs(client, { currentOrgId: 'T_HOME' });

    assert.equal(result.truncated, true);
    assert.ok(
      result.notes.some(n => n.includes('could not be inspected')),
      result.notes.join(' | '),
    );
  });

  it('prefers an externally-shared channel over a merely org-shared one', async () => {
    // is_shared alone is also set for Enterprise Grid internal sharing, which
    // can never name a foreign org.
    const channels = [
      ...Array.from({ length: CHANNEL_INFO_MAX }, (_, i) => ({ id: `C_INT_${i}`, is_shared: true })),
      { id: 'C_EXT', is_ext_shared: true },
    ];
    const client = mockClient({
      conversationsListAll: async () => ({ channels }),
      conversationsInfo: async (id: string) => ({ channel: { id, connected_team_ids: [`T_${id}`] } }),
    });

    const result = await discoverConnectedOrgs(client, { currentOrgId: 'T_HOME' });

    assert.ok(result.orgs.some(o => o.id === 'T_C_EXT'), 'the externally-shared channel must be inspected');
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

describe('discoverConnectedOrgs — big workspaces', () => {
  /**
   * The reported failure: a workspace with more channels than the
   * workspace-wide sweep's page budget. It spends every page on internal
   * channels, reports "Stopped after N pages of channels", and the partner org
   * of a private channel the user is plainly a member of gets no checkbox — so
   * it can never be allowed and its channel stays invisible.
   *
   * conversations.list is ordered by Slack, not by usefulness, so "page past
   * it" is not a fix anyone can rely on. The member-scoped sweep is, because
   * its size tracks the user rather than the workspace.
   */
  function hugeWorkspaceClient(overrides: Record<string, any> = {}): any {
    return mockClient({
      // Always another page, never a shared channel: the budget is exhausted.
      conversationsListAll: async () => ({
        channels: [{ id: 'C_INTERNAL' }],
        response_metadata: { next_cursor: 'more' },
      }),
      ...overrides,
    });
  }

  it('finds the partner org of a private channel the workspace sweep never reaches', async () => {
    const result = await discoverConnectedOrgs(hugeWorkspaceClient({
      conversationsList: async (_cursor?: string, types?: string) =>
        types === 'public_channel,private_channel'
          ? { channels: [{ id: 'C_PRIVATE', is_ext_shared: true, connected_team_ids: ['T_PARTNER'] }] }
          : { channels: [] },
    }), { currentOrgId: 'T_HOME' });

    const partner = result.orgs.find(o => o.id === 'T_PARTNER');
    assert.ok(partner, `T_PARTNER should be tickable; got ${JSON.stringify(result.orgs)}`);
    assert.deepEqual(partner.sources, ['channel']);
  });

  it('still reports the workspace sweep as truncated, because it genuinely is', async () => {
    // The member sweep covers the common case; it does not make the cap
    // disappear. A public shared channel the user has not joined can still sit
    // beyond the budget, so the warning has to stay honest.
    const result = await discoverConnectedOrgs(hugeWorkspaceClient(), { currentOrgId: 'T_HOME' });
    assert.equal(result.truncated, true);
    assert.ok(
      result.notes.some(n => n.includes(`${LIST_MAX_PAGES} pages of channels`)),
      result.notes.join(' | '),
    );
  });

  it('does not count a DM as a channel when the member sweep returns one', async () => {
    // users.conversations is asked for public/private only, but classification
    // is by the row's own flags so an im can never be mislabelled 'channel'.
    const result = await discoverConnectedOrgs(mockClient({
      conversationsList: async () => ({
        channels: [{ id: 'D1', is_im: true, user: 'U_EXT', connected_team_ids: ['T_PARTNER'] }],
      }),
    }), { currentOrgId: 'T_HOME' });

    const partner = result.orgs.find(o => o.id === 'T_PARTNER');
    assert.ok(partner);
    assert.deepEqual(partner.sources, ['dm'], 'a DM must report as dm, not channel');
  });

  it('reports a member-sweep failure separately from a workspace-sweep failure', async () => {
    const result = await discoverConnectedOrgs(mockClient({
      conversationsList: async (_cursor?: string, types?: string) => {
        if (types === 'public_channel,private_channel') throw new Error('missing_scope');
        return { channels: [] };
      },
    }), { currentOrgId: 'T_HOME' });

    assert.equal(result.truncated, true);
    assert.ok(
      result.notes.some(n => n.includes('your channels') && n.includes('missing_scope')),
      result.notes.join(' | '),
    );
  });
});
