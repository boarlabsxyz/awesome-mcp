import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { SlackClient } from '../../slack/apiHelpers.js';
import { filterChannelList } from '../../slack-user/accessControl.js';
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
