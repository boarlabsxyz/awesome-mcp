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

  it('labels DM-filter drops by the rules that caused them, not "blocked user"', () => {
    // filterDmsByOrg drops for a non-allowed org, and filterGroupDmsByRules for
    // either a blocked member or an org — calling all three "blocked user"
    // points at the wrong dashboard control two times out of three.
    const out = renderListSummary([{ ch: { id: 'C1' } }] as any, new Map([['dm-rules', 2]]), []);
    assert.match(out, /DM\/group-DM rules \(blocked user or organisation\): 2/);
    assert.doesNotMatch(out, /^.*blocked user: 2/m);
  });

  it('surfaces an unchecked-group-DM note verbatim', () => {
    const out = renderListSummary(
      [{ ch: { id: 'C1' } }] as any, new Map(),
      ['4 group DM(s) beyond the first 30 were not checked against your member rules — they are listed, but reading one may still be denied.'],
    );
    assert.match(out, /Note: 4 group DM\(s\) beyond the first 30 were not checked/);
  });

  it('appends truncation notes', () => {
    const out = renderListSummary([] as any, new Map(), ['5 shared channel(s) were not checked']);
    assert.match(out, /Note: 5 shared channel\(s\) were not checked/);
  });
});

// === diagnoseChannelAccess helpers ===

import { lookupChannelByName, explainDenial, describeChannel } from '../../slack-user/server.js';
import { assertAccess, SlackAccessDenied } from '../../slack-user/accessControl.js';
import type { ChannelMeta } from '../../slack-user/accessControl.js';

function lookupClient(mine: any[], workspacePages: any[][] = []) {
  let page = 0;
  return {
    conversationsList: async () => ({ channels: mine }),
    conversationsListAll: async () => {
      const channels = workspacePages[page] ?? [];
      const more = page < workspacePages.length - 1;
      page++;
      return { channels, response_metadata: more ? { next_cursor: `c${page}` } : {} };
    },
  } as any;
}

describe('lookupChannelByName', () => {
  it('finds a channel the user is a member of without scanning the workspace', async () => {
    const client = lookupClient([{ id: 'C1', name: 'awesome-mcp-support' }]);
    assert.deepEqual(await lookupChannelByName(client, 'awesome-mcp-support'), {
      kind: 'found', channelId: 'C1',
    });
  });

  it('tolerates a leading # and differing case', async () => {
    const client = lookupClient([{ id: 'C1', name: 'awesome-mcp-support' }]);
    const res = await lookupChannelByName(client, '#AWESOME-MCP-Support');
    assert.equal((res as any).channelId, 'C1');
  });

  it('falls back to the workspace list when not a member', async () => {
    const client = lookupClient([], [[{ id: 'C9', name: 'eng-general' }]]);
    assert.deepEqual(await lookupChannelByName(client, 'eng-general'), {
      kind: 'found', channelId: 'C9',
    });
  });

  it('reports a bounded scan rather than claiming the channel does not exist', async () => {
    // 12 pages of misses, all with a next_cursor: the scan stops at its bound.
    const pages = Array.from({ length: 12 }, (_, i) => [{ id: `C${i}`, name: `other-${i}` }]);
    const client = lookupClient([], pages);
    const res = await lookupChannelByName(client, 'missing');
    assert.equal(res.kind, 'scanBounded');
    assert.equal((res as any).pages, 10);
  });

  it('reports a genuine absence when the scan reached the end', async () => {
    const client = lookupClient([], [[{ id: 'C1', name: 'other' }]]);
    assert.deepEqual(await lookupChannelByName(client, 'missing'), { kind: 'none' });
  });

  it('reports ambiguity instead of picking one', async () => {
    const client = lookupClient([{ id: 'C1', name: 'dup' }, { id: 'C2', name: 'dup' }]);
    const res = await lookupChannelByName(client, 'dup');
    assert.equal(res.kind, 'ambiguous');
    assert.deepEqual((res as any).ids, ['C1', 'C2']);
  });
});

describe('explainDenial', () => {
  function denial(r: SlackAccessRules, meta: ChannelMeta): SlackAccessDenied {
    try { assertAccess(r, meta); } catch (e) { return e as SlackAccessDenied; }
    throw new Error('expected a denial');
  }
  const base: ChannelMeta = {
    id: 'C1', name: 'eng-general', is_private: false,
    is_shared: false, is_im: false, is_mpim: false,
  };

  it('names the org and the dashboard control', () => {
    const d = denial(rules, { ...base, name: 'eng-x', is_shared: true, shared_team_ids: ['T_OTHER'] });
    const out = explainDenial(d, rules, 'eng-x', new Map([['T_OTHER', 'Acme Corp']])).join('\n');
    assert.match(out, /Acme Corp \(T_OTHER\)/);
    assert.match(out, /Access Rules → Organizations/);
    assert.match(out, /Your allowed organisations: T_MINE/);
  });

  it('quotes the user\'s own patterns and the exact channel to add', () => {
    const d = denial(rules, { ...base, name: 'marketing' });
    const out = explainDenial(d, rules, 'marketing').join('\n');
    assert.match(out, /Denied by: whitelist/);
    assert.match(out, /\["eng-\*","general"\]/);
    assert.match(out, /add "marketing"/);
  });

  it('tells the blacklist case to remove rather than add', () => {
    const d = denial(rules, { ...base, name: 'eng-secret-plans' });
    const out = explainDenial(d, rules, 'eng-secret-plans').join('\n');
    assert.match(out, /Denied by: blacklist/);
    assert.match(out, /Fix: remove the pattern/);
  });

  it('handles the empty-whitelist case, whose fix is different', () => {
    const empty = { ...rules, whitelistChannels: [] };
    const out = explainDenial(denial(empty, base), empty, 'eng-general').join('\n');
    assert.match(out, /whitelist is empty/);
    assert.match(out, /use "\*" to allow all/);
  });

  it('handles allowPublicOnly and blocked users', () => {
    const pub = { ...rules, allowPublicOnly: true };
    assert.match(
      explainDenial(denial(pub, { ...base, is_private: true }), pub, 'eng-general').join('\n'),
      /allowPublicOnly is enabled/,
    );
    const blocked = { ...rules, blacklistUsers: ['U_BAD'] };
    assert.match(
      explainDenial(denial(blocked, { ...base, is_im: true, user: 'U_BAD' }), blocked, '').join('\n'),
      /blocked-users list/,
    );
  });

  it('explains an unverifiable org without blaming the user\'s config', () => {
    const d = denial(rules, { ...base, is_shared: true, shared_team_ids: [] });
    const out = explainDenial(d, rules, 'eng-general').join('\n');
    assert.match(out, /no organisation for this shared channel/);
  });

  it('never leaks channel content — only rule names and the user\'s own config', () => {
    const d = denial(rules, { ...base, name: 'marketing' });
    const out = explainDenial(d, rules, 'marketing').join('\n');
    assert.doesNotMatch(out, /Topic|Purpose|message/i);
  });
});

describe('describeChannel', () => {
  const base: ChannelMeta = {
    id: 'C1', name: 'eng', is_private: false, is_shared: false, is_im: false, is_mpim: false,
  };

  it('renders each conversation kind', () => {
    assert.match(describeChannel(base, 'C1'), /^#eng \(C1\) — public$/);
    assert.match(describeChannel({ ...base, is_private: true }, 'C1'), /— private$/);
    assert.match(describeChannel({ ...base, is_im: true, name: 'alice' }, 'D1'), /^alice \(D1\) — DM$/);
    assert.match(describeChannel({ ...base, is_mpim: true, name: 'grp' }, 'G1'), /— group DM$/);
  });

  it('flags a shared channel and falls back to the ID when a DM has no name', () => {
    assert.match(describeChannel({ ...base, is_shared: true }, 'C1'), /shared with another organisation/);
    assert.match(describeChannel({ ...base, is_im: true, name: '' }, 'D9'), /^D9 \(D9\) — DM$/);
  });
});

// === renderChannelLines ===

import { renderChannelLines } from '../../slack-user/server.js';

describe('renderChannelLines', () => {
  const noNames = new Map<string, string>();

  it('renders a readable channel with its topic, purpose and member count', () => {
    const [line] = renderChannelLines([{
      ch: { id: 'C1', name: 'eng-general', is_private: false,
            topic: { value: 'Roadmap' }, purpose: { value: 'Eng chat' }, num_members: 12 } as any,
    }], noNames);
    assert.match(line, /^#eng-general \(C1\)/);
    assert.match(line, /Type: public/);
    assert.match(line, /Topic: Roadmap/);
    assert.match(line, /Purpose: Eng chat/);
    assert.match(line, /Members: 12/);
  });

  it('withholds topic and purpose on a flagged row but keeps structural facts', () => {
    // A flagged row is a channel the rules refuse to read. Its free text must
    // not be handed to the model just because the row is visible.
    const [line] = renderChannelLines([{
      ch: { id: 'C9', name: 'partner-eng', is_private: true,
            topic: { value: 'Secret partner roadmap' },
            purpose: { value: 'Confidential' }, num_members: 14 } as any,
      warning: 'Not readable: shared with Acme Corp (TBM997HJR), which is not ticked under Access Rules → Organizations.',
    }], noNames);
    assert.doesNotMatch(line, /Secret partner roadmap/);
    assert.doesNotMatch(line, /Confidential/);
    assert.doesNotMatch(line, /Topic:|Purpose:/);
    assert.match(line, /Type: private/);
    assert.match(line, /Members: 14/);
    assert.match(line, /⚠ Not readable: shared with Acme Corp \(TBM997HJR\)/);
  });

  it('resolves a DM to the counterpart name and drops the # prefix', () => {
    const [line] = renderChannelLines(
      [{ ch: { id: 'D1', name: 'U_ALICE', is_im: true, user: 'U_ALICE', is_private: true } as any }],
      new Map([['U_ALICE', 'Alice Smith']]),
    );
    assert.match(line, /^Alice Smith \(D1\)/);
    assert.match(line, /Type: im/);
  });

  it('labels group DMs without a prefix', () => {
    const [line] = renderChannelLines(
      [{ ch: { id: 'G1', name: 'mpdm-a--b', is_mpim: true, is_private: true } as any }], noNames,
    );
    assert.match(line, /^mpdm-a--b \(G1\)/);
    assert.match(line, /Type: mpim/);
  });

  it('omits optional fields that Slack did not return', () => {
    const [line] = renderChannelLines([{ ch: { id: 'C2', name: 'bare', is_private: false } as any }], noNames);
    assert.equal(line, '#bare (C2)\n  Type: public');
  });
});
