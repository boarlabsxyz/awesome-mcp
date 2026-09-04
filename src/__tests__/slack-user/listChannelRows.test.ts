import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import type { SlackAccessRules } from '../../mcpConnectionStore.js';
import { clearChannelMetaCache } from '../../slack-user/accessControl.js';
import { clearTeamNameCache } from '../../slack-user/teamNames.js';
import { buildChannelRows, renderListSummary } from '../../slack-user/server.js';

// What listChannels shows, hides, and flags. The bug this covers: a Slack
// Connect channel whose conversations.list payload carries no team IDs used to
// list as plainly available and then fail every read of it with an opaque org
// ID. It must now either resolve as readable, or appear with a warning naming
// the organisation.

const rules: SlackAccessRules = {
  allowedOrgs: ['T_MINE'],
  blacklistUsers: [],
  whitelistChannels: ['eng-*', 'general'],
  blacklistChannels: ['eng-secret-*'],
  allowPublicOnly: false,
};

/** conversations.info + team.info stub. */
function stubClient(info: Record<string, any>, teams: Record<string, string> = {}) {
  const calls = { info: [] as string[], team: [] as string[] };
  const client: any = {
    conversationsInfo: async (id: string) => {
      calls.info.push(id);
      const channel = info[id];
      if (!channel) throw new Error('channel_not_found');
      return { channel: { id, is_private: false, is_im: false, is_mpim: false, ...channel } };
    },
    teamInfo: async (id: string) => {
      calls.team.push(id);
      if (!teams[id]) throw new Error('team_not_found');
      return { team: { name: teams[id] } };
    },
  };
  return { client, calls };
}

const session: any = { slackUserToken: 'xoxp-test-token', slackInstanceId: undefined };

describe('buildChannelRows', () => {
  beforeEach(() => {
    clearChannelMetaCache();
    clearTeamNameCache();
  });

  it('lists a readable channel with no warning', async () => {
    const { client } = stubClient({});
    const { rows, hidden } = await buildChannelRows(client, session, rules, [
      { id: 'C1', name: 'eng-general', is_private: false },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].warning, undefined);
    assert.equal(hidden.size, 0);
  });

  it('flags an org-blocked shared channel instead of hiding it, and names the org', async () => {
    // conversations.list gave no team IDs; conversations.info reveals T_OTHER.
    const { client, calls } = stubClient(
      { C9: { name: 'eng-partners', is_ext_shared: true, connected_team_ids: ['T_OTHER'] } },
      { T_OTHER: 'Acme Corp' },
    );
    const { rows, hidden } = await buildChannelRows(client, session, rules, [
      { id: 'C9', name: 'eng-partners', is_private: false, is_ext_shared: true },
    ]);
    assert.deepEqual(calls.info, ['C9'], 'expected a conversations.info backfill');
    assert.equal(rows.length, 1, 'org-blocked rows stay listed');
    assert.match(rows[0].warning!, /Not readable/);
    assert.match(rows[0].warning!, /Acme Corp \(T_OTHER\)/);
    assert.match(rows[0].warning!, /Organizations/);
    assert.equal(hidden.size, 0, 'a flagged row is not also counted as hidden');
  });

  it('falls back to the bare team ID when Slack will not name the org', async () => {
    // The normal case: team.info on a foreign org fails even with team:read.
    const { client } = stubClient(
      { C9: { name: 'eng-partners', is_ext_shared: true, connected_team_ids: ['T_OTHER'] } },
      {},
    );
    const { rows } = await buildChannelRows(client, session, rules, [
      { id: 'C9', name: 'eng-partners', is_private: false, is_ext_shared: true },
    ]);
    assert.match(rows[0].warning!, /T_OTHER/);
  });

  it('resolves a shared channel to readable when its org is allowed', async () => {
    const { client } = stubClient({
      C8: { name: 'eng-partners', is_ext_shared: true, connected_team_ids: ['T_MINE'] },
    });
    const { rows } = await buildChannelRows(client, session, rules, [
      { id: 'C8', name: 'eng-partners', is_private: false, is_ext_shared: true },
    ]);
    assert.equal(rows[0].warning, undefined);
  });

  it('hides and counts channels blocked by the user\'s own patterns', async () => {
    const { client } = stubClient({});
    const { rows, hidden } = await buildChannelRows(client, session, rules, [
      { id: 'C1', name: 'eng-general', is_private: false },
      { id: 'C2', name: 'marketing', is_private: false },
      { id: 'C3', name: 'eng-secret-plans', is_private: false },
    ]);
    assert.deepEqual(rows.map(r => r.ch.id), ['C1']);
    assert.equal(hidden.get('whitelist-miss'), 1);
    assert.equal(hidden.get('blacklist-channel'), 1);
  });

  it('does NOT surface an org-blocked channel that the whitelist also excludes', async () => {
    // Org is checked before patterns, so without the extra pass this channel
    // would be listed-with-a-warning despite the user excluding it outright.
    const { client } = stubClient(
      { C7: { name: 'marketing', is_ext_shared: true, connected_team_ids: ['T_OTHER'] } },
      { T_OTHER: 'Acme Corp' },
    );
    const { rows, hidden } = await buildChannelRows(client, session, rules, [
      { id: 'C7', name: 'marketing', is_private: false, is_ext_shared: true },
    ]);
    assert.equal(rows.length, 0);
    assert.equal(hidden.get('whitelist-miss'), 1);
  });

  it('fails closed when conversations.info errors', async () => {
    // An API blip must not produce a visible row that then refuses to read.
    const { client } = stubClient({}); // every lookup throws
    const { rows, hidden } = await buildChannelRows(client, session, rules, [
      { id: 'C_GONE', name: 'eng-ghost', is_private: false, is_ext_shared: true },
    ]);
    assert.equal(rows.length, 0);
    assert.equal(hidden.get('unavailable'), 1);
  });

  it('caps the backfill and reports what it did not check', async () => {
    const info: Record<string, any> = {};
    const channels = [];
    for (let i = 0; i < 30; i++) {
      info[`C${i}`] = { name: `eng-${i}`, is_ext_shared: true, connected_team_ids: ['T_MINE'] };
      channels.push({ id: `C${i}`, name: `eng-${i}`, is_private: false, is_ext_shared: true });
    }
    const { client, calls } = stubClient(info);
    const { notes } = await buildChannelRows(client, session, rules, channels);
    assert.equal(calls.info.length, 25, 'backfill should stop at CHANNEL_INFO_BACKFILL_MAX');
    assert.equal(notes.length, 1);
    assert.match(notes[0], /5 shared channel\(s\) beyond the first 25/);
  });
});

describe('renderListSummary', () => {
  it('reports shown, flagged and hidden counts with a reason breakdown', () => {
    const rows = [
      { ch: { id: 'C1', name: 'a' } },
      { ch: { id: 'C2', name: 'b' }, warning: 'Not readable: ...' },
    ] as any;
    const hidden = new Map([['whitelist-miss', 5], ['blacklist-channel', 1]]);
    const out = renderListSummary(rows, hidden, []);
    assert.match(out, /1 channel\(s\) shown/);
    assert.match(out, /1 listed but not readable/);
    assert.match(out, /6 hidden by your access rules/);
    assert.match(out, /whitelist: 5/);
    assert.match(out, /blacklist: 1/);
    assert.match(out, /diagnoseChannelAccess/);
  });

  it('stays quiet when nothing was hidden or flagged', () => {
    const out = renderListSummary([{ ch: { id: 'C1' } }] as any, new Map(), []);
    assert.match(out, /1 channel\(s\) shown/);
    assert.doesNotMatch(out, /hidden/);
    assert.doesNotMatch(out, /diagnoseChannelAccess/);
  });

  it('appends truncation notes', () => {
    const out = renderListSummary([] as any, new Map(), ['5 shared channel(s) were not checked']);
    assert.match(out, /Note: 5 shared channel\(s\) were not checked/);
  });
});
