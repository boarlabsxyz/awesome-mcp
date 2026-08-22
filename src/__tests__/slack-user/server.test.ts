import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { SlackClient } from '../../slack/apiHelpers.js';
import { filterChannelList, assertAccess, assertDmMemberAccess } from '../../slack-user/accessControl.js';
import { handleDownloadFile, handleSearchMessages } from '../../slack/helpers.js';
import type { SlackAccessRules } from '../../mcpConnectionStore.js';

// Test the search/filter logic that the slack-user listChannels tool uses.
// We can't easily test FastMCP tool execute functions directly, so we test
// the underlying logic: filterChannelList + substring matching (search mode).

describe('Slack User Server - search logic', () => {
  const rules: SlackAccessRules = {
    allowedOrgs: [],
    blacklistUsers: [],
    whitelistChannels: ['*'],
    blacklistChannels: [],
    allowPublicOnly: false,
  };

  const sampleChannels = [
    { id: 'C1', name: 'general', is_private: false },
    { id: 'C2', name: 'ops_anthropic_recovery', is_private: false },
    { id: 'C3', name: 'ops_billing', is_private: false },
    { id: 'C4', name: 'engineering', is_private: false },
    { id: 'C5', name: 'random', is_private: false },
    { id: 'C6', name: 'ops_anthropic_alerts', is_private: true },
  ];

  describe('search filter simulation', () => {
    it('should find channel by substring match', () => {
      const filtered = filterChannelList(rules, sampleChannels);
      const searchLower = 'ops_anthropic'.toLowerCase();
      const matches = filtered.filter(ch => ch.name.toLowerCase().includes(searchLower));
      assert.equal(matches.length, 2);
      assert.ok(matches.some(ch => ch.name === 'ops_anthropic_recovery'));
      assert.ok(matches.some(ch => ch.name === 'ops_anthropic_alerts'));
    });

    it('should find channel with partial name', () => {
      const filtered = filterChannelList(rules, sampleChannels);
      const matches = filtered.filter(ch => ch.name.toLowerCase().includes('recovery'));
      assert.equal(matches.length, 1);
      assert.equal(matches[0].id, 'C2');
    });

    it('should return empty for non-matching search', () => {
      const filtered = filterChannelList(rules, sampleChannels);
      const matches = filtered.filter(ch => ch.name.toLowerCase().includes('nonexistent'));
      assert.equal(matches.length, 0);
    });

    it('should be case insensitive', () => {
      const filtered = filterChannelList(rules, sampleChannels);
      const matches = filtered.filter(ch => ch.name.toLowerCase().includes('OPS_ANTHROPIC'.toLowerCase()));
      assert.equal(matches.length, 2);
    });

    it('should respect whitelist during search', () => {
      const restrictedRules = { ...rules, whitelistChannels: ['ops_*'] };
      const filtered = filterChannelList(restrictedRules, sampleChannels);
      // Only ops_* channels pass the whitelist
      assert.equal(filtered.length, 3);
      assert.ok(filtered.every(ch => ch.name.startsWith('ops_')));
    });

    it('should respect blacklist during search', () => {
      const blacklistRules = { ...rules, blacklistChannels: ['*alerts*'] };
      const filtered = filterChannelList(blacklistRules, sampleChannels);
      assert.ok(!filtered.some(ch => ch.name.includes('alerts')));
    });

    it('should respect allowPublicOnly during search', () => {
      const publicRules = { ...rules, allowPublicOnly: true };
      const filtered = filterChannelList(publicRules, sampleChannels);
      // ops_anthropic_alerts is private, should be excluded
      assert.ok(!filtered.some(ch => ch.id === 'C6'));
      assert.equal(filtered.length, 5);
    });
  });

  describe('listUsers tool logic', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('filters out bots and deleted users', async () => {
      globalThis.fetch = (async () => ({
        ok: true, status: 200,
        headers: { get: () => null },
        json: async () => ({
          ok: true,
          members: [
            { id: 'U1', name: 'alice', real_name: 'Alice', team_id: 'T1', is_bot: false, profile: { display_name: 'Alice' } },
            { id: 'U2', name: 'slackbot', real_name: 'Slackbot', team_id: 'T1', is_bot: true, profile: {} },
            { id: 'U3', name: 'departed', real_name: 'Gone', team_id: 'T1', is_bot: false, deleted: true, profile: {} },
            { id: 'U4', name: 'bob', real_name: 'Bob', team_id: 'T1', is_bot: false, profile: { display_name: 'Bobby' } },
          ],
          response_metadata: {},
        }),
      })) as any;

      const client = new SlackClient('xoxp-test');
      const result = await client.usersList();
      const filtered = result.members.filter(m => !m.deleted && !m.is_bot);

      assert.equal(filtered.length, 2);
      assert.equal(filtered[0].name, 'alice');
      assert.equal(filtered[1].name, 'bob');

      // Simulate tool output formatting
      const lines = filtered.map(m => {
        const displayName = m.profile?.display_name || m.real_name || m.name;
        return `${displayName} (@${m.name}) — ID: ${m.id}`;
      });
      assert.ok(lines[0].includes('Alice'));
      assert.ok(lines[0].includes('@alice'));
      assert.ok(lines[1].includes('Bobby'));
      assert.ok(lines[1].includes('@bob'));
    });
  });

  // downloadFile takes a fileId, which on its own says nothing about which
  // channel the bytes came from. Two layers keep it from becoming a hole in the
  // allowlist: the tool runs enforceAccess on the supplied channelId, and the
  // handler then refuses a file that was never shared in that channel.
  describe('downloadFile access layering', () => {
    const meta = {
      id: 'C4', name: 'engineering', is_private: false,
      is_shared: false, is_im: false, is_mpim: false,
    };

    it('layer 1: a channel outside the whitelist is denied before any file lookup', () => {
      assert.throws(
        () => assertAccess({ ...rules, whitelistChannels: ['ops_*'] }, meta),
        /does not match any whitelist/,
      );
    });

    it('layer 2: an allowed channel cannot be used to reach a file shared elsewhere', async () => {
      const client = {
        // File lives in a channel the rules would deny...
        filesInfo: async () => ({
          file: { id: 'F1', name: 'secret.png', mimetype: 'image/png', channels: ['C_DENIED'] },
        }),
        downloadFileBytes: async () => { throw new Error('must not download'); },
      } as any;

      // ...so naming an allowed channel must not launder it through.
      await assert.rejects(
        () => handleDownloadFile(client, { fileId: 'F1', channelId: 'C1', format: 'url' }),
        /not shared in channel C1/,
      );
    });
  });

  // search.* is the one call whose reach exceeds the access rules: it returns
  // hits from every channel the human belongs to, and Slack's query DSL has no
  // channel deny-list to push the filter server-side. enforceAccess can't run
  // (there is no single channelId), so the tool builds a per-channel predicate
  // from the same assertAccess engine and the handler drops denied matches.
  // This mirrors the tool's buildChannelFilter without the DB/session it needs.
  describe('search access filtering', () => {
    const META: Record<string, any> = {
      C1: { id: 'C1', name: 'general', is_private: false, is_shared: false, is_im: false, is_mpim: false },
      C6: { id: 'C6', name: 'ops_anthropic_alerts', is_private: true, is_shared: false, is_im: false, is_mpim: false },
    };

    /**
     * The channel-pattern half of buildChannelFilter: memoised, fails closed.
     *
     * Deliberately NOT a full copy — the real filter also runs
     * assertDmMemberAccess for DMs and group DMs, which needs a live client.
     * That half is covered directly in the assertDmMemberAccess describe below.
     * Do not grow this mirror into a second implementation: it passing proves
     * nothing about the real one, which is how the DM gap went unnoticed.
     */
    function channelFilter(activeRules: SlackAccessRules, lookups?: string[]) {
      const decided = new Map<string, boolean>();
      return async ({ id }: { id: string }) => {
        const cached = decided.get(id);
        if (cached !== undefined) return cached;
        lookups?.push(id);
        let allowed: boolean;
        try {
          assertAccess(activeRules, META[id]);
          allowed = true;
        } catch {
          allowed = false;
        }
        decided.set(id, allowed);
        return allowed;
      };
    }

    const searchClient = (matches: any[]) => ({
      searchMessages: async () => ({ query: 'q', messages: { total: matches.length, matches } }),
      usersInfo: async (uid: string) => ({ user: { id: uid, name: uid, real_name: uid, profile: { display_name: uid } } }),
      authTest: async () => ({ ok: true, url: 'https://test.slack.com' }),
    }) as any;

    const MATCHES = [
      { channel: { id: 'C1', name: 'general' }, user: 'U1', ts: '1609459200.000000', text: 'public info', permalink: 'https://t/p1' },
      { channel: { id: 'C6', name: 'ops_anthropic_alerts' }, user: 'U2', ts: '1609459201.000000', text: 'confidential alert', permalink: 'https://t/p6' },
    ];

    it('never renders a match from a channel outside the whitelist', async () => {
      const restricted: SlackAccessRules = { ...rules, whitelistChannels: ['general'] };
      const result = await handleSearchMessages(
        searchClient(MATCHES), 'tok-leak-' + Date.now(), { query: 'x', count: 20 }, channelFilter(restricted),
      );

      assert.ok(result.includes('public info'));
      assert.ok(!result.includes('confidential alert'));
      assert.ok(!result.includes('ops_anthropic_alerts'));
      assert.ok(!result.includes('https://t/p6'));
      assert.ok(result.includes('1 result(s) on this page hidden by your access rules'));
    });

    it('honours allowPublicOnly, which readChannelHistory would also enforce', async () => {
      const publicOnly: SlackAccessRules = { ...rules, allowPublicOnly: true };
      const result = await handleSearchMessages(
        searchClient(MATCHES), 'tok-public-' + Date.now(), { query: 'x', count: 20 }, channelFilter(publicOnly),
      );
      assert.ok(result.includes('public info'));
      assert.ok(!result.includes('confidential alert'));
    });

    it('hides everything when no whitelist is configured (deny-all)', async () => {
      const noWhitelist: SlackAccessRules = { ...rules, whitelistChannels: [] };
      const result = await handleSearchMessages(
        searchClient(MATCHES), 'tok-deny-' + Date.now(), { query: 'x', count: 20 }, channelFilter(noWhitelist),
      );
      assert.ok(!result.includes('public info'));
      assert.ok(!result.includes('confidential alert'));
      assert.ok(result.includes('No messages you can access'));
    });

    it('decides each distinct channel once, however many matches it has', async () => {
      const lookups: string[] = [];
      const repeated = [...MATCHES, { ...MATCHES[0], ts: '1609459202.000000', text: 'more public info' }];
      await handleSearchMessages(
        searchClient(repeated), 'tok-memo-' + Date.now(), { query: 'x', count: 20 }, channelFilter(rules, lookups),
      );
      // Three matches over two channels cost two conversations.info lookups,
      // not three — the repeat of C1 is served from the per-call memo.
      assert.deepEqual(lookups, ['C1', 'C6']);
    });
  });

  describe('openDm tool logic', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('returns DM channel ID and usage hint', async () => {
      globalThis.fetch = (async () => ({
        ok: true, status: 200,
        headers: { get: () => null },
        json: async () => ({ ok: true, channel: { id: 'D_OPENED' } }),
      })) as any;

      const client = new SlackClient('xoxp-test');
      const result = await client.conversationsOpen('U_TARGET');

      // Simulate tool output
      const output = `DM channel opened: ${result.channel.id}\n\nYou can now use postMessage with channelId "${result.channel.id}" to send a direct message.`;
      assert.ok(output.includes('D_OPENED'));
      assert.ok(output.includes('postMessage'));
    });
  });
});

// assertDmMemberAccess is the half of the rules that needs API lookups, so
// assertAccess cannot make these calls itself. Both a direct read
// (enforceAccess) and a search result (buildChannelFilter) go through it; it
// used to be inline in enforceAccess only, which let search return DMs a direct
// read of the same conversation would have refused.
describe('assertDmMemberAccess', () => {
  const rules: SlackAccessRules = {
    allowedOrgs: [], blacklistUsers: [], whitelistChannels: ['*'],
    blacklistChannels: [], allowPublicOnly: false,
  };

  const client = (opts: { teams?: Record<string, string>; members?: string[] } = {}) => ({
    usersInfo: async (uid: string) => ({ user: { id: uid, team_id: opts.teams?.[uid] } }),
    conversationsMembers: async () => ({ members: opts.members ?? [] }),
  }) as any;

  const DM = { is_im: true, user: 'U_EXTERNAL' };
  const MPIM = { is_mpim: true };

  it('allows a DM whose counterpart is in an allowed org', async () => {
    await assertDmMemberAccess(
      client({ teams: { U_EXTERNAL: 'T_OK' } }),
      { ...rules, allowedOrgs: ['T_OK'] }, DM, 'D1',
    );
  });

  it('denies a DM whose counterpart is in a non-allowed org', async () => {
    // assertAccess alone lets this through — it cannot resolve the user's org.
    await assert.rejects(
      () => assertDmMemberAccess(
        client({ teams: { U_EXTERNAL: 'T_OTHER' } }),
        { ...rules, allowedOrgs: ['T_OK'] }, DM, 'D1',
      ),
      /organisation not in your allowed list/,
    );
  });

  it('skips the DM lookup entirely when no org allowlist is configured', async () => {
    let called = false;
    const spy = { usersInfo: async () => { called = true; return { user: {} }; } } as any;
    await assertDmMemberAccess(spy, rules, DM, 'D1');
    assert.equal(called, false, 'must not spend an API call when the rule is off');
  });

  it('denies a group DM containing a blacklisted member', async () => {
    // meta.user is unset for an mpim, so assertAccess's blacklist check is a
    // no-op there — this is the only thing enforcing it.
    await assert.rejects(
      () => assertDmMemberAccess(
        client({ members: ['U1', 'U_BAD'] }),
        { ...rules, blacklistUsers: ['U_BAD'] }, MPIM, 'G1',
      ),
      /blacklisted user/,
    );
  });

  it('denies a group DM containing a member from a non-allowed org', async () => {
    await assert.rejects(
      () => assertDmMemberAccess(
        client({ members: ['U1', 'U2'], teams: { U1: 'T_OK', U2: 'T_OTHER' } }),
        { ...rules, allowedOrgs: ['T_OK'] }, MPIM, 'G1',
      ),
      /non-allowed organisation/,
    );
  });

  it('allows a group DM where every member checks out', async () => {
    await assertDmMemberAccess(
      client({ members: ['U1', 'U2'], teams: { U1: 'T_OK', U2: 'T_OK' } }),
      { ...rules, allowedOrgs: ['T_OK'], blacklistUsers: ['U_BAD'] }, MPIM, 'G1',
    );
  });

  it('leaves regular channels untouched', async () => {
    let called = false;
    const spy = {
      usersInfo: async () => { called = true; return { user: {} }; },
      conversationsMembers: async () => { called = true; return { members: [] }; },
    } as any;
    await assertDmMemberAccess(spy, { ...rules, allowedOrgs: ['T_OK'], blacklistUsers: ['U_BAD'] },
      { is_im: false, is_mpim: false }, 'C1');
    assert.equal(called, false);
  });

  it('propagates lookup failures so each caller picks its own posture', async () => {
    // buildChannelFilter turns this into a denial; enforceAccess lets it pass.
    const broken = { usersInfo: async () => { throw new Error('slack down'); } } as any;
    await assert.rejects(
      () => assertDmMemberAccess(broken, { ...rules, allowedOrgs: ['T_OK'] }, DM, 'D1'),
      /slack down/,
    );
  });
});
