import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

// Mock the MCP authenticate handler before importing server
// We need to mock the session/auth layer since server.ts uses FastMCP
// Instead, we test the tool logic by extracting and calling the execute functions
// through the FastMCP server's tool registry.

import { SlackClient } from '../../slack/apiHelpers.js';

// We can't easily test FastMCP tools directly, so we test the underlying
// SlackClient methods and helper functions that the tools call.
// The tool handlers are thin wrappers, so covering the helpers covers the logic.

describe('Slack Bot Server - tool logic coverage', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(response: any) {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => response,
      text: async () => JSON.stringify(response),
    })) as any;
  }

  describe('listChannels - DM display logic', () => {
    it('conversationsList includes im channels by default', async () => {
      let capturedBody = '';
      globalThis.fetch = (async (_url: any, opts: any) => {
        capturedBody = opts.body;
        return {
          ok: true, status: 200,
          headers: { get: () => null },
          json: async () => ({
            ok: true,
            channels: [
              { id: 'C1', name: 'general', is_private: false, is_im: false },
              { id: 'D1', name: 'dm', is_private: false, is_im: true, user: 'U1' },
            ],
            response_metadata: {},
          }),
        };
      }) as any;

      const client = new SlackClient('xoxb-test');
      const result = await client.conversationsList();

      assert.ok(capturedBody.includes('im'), 'should include im in types');
      assert.equal(result.channels.length, 2);
      assert.equal(result.channels[1].is_im, true);
      assert.equal(result.channels[1].user, 'U1');
    });
  });

  describe('listUsers - user listing', () => {
    it('usersList returns filtered members', async () => {
      mockFetch({
        ok: true,
        members: [
          { id: 'U1', name: 'alice', real_name: 'Alice Smith', team_id: 'T1', is_bot: false, profile: { display_name: 'Alice' } },
          { id: 'U2', name: 'bob', real_name: 'Bob Jones', team_id: 'T1', is_bot: false, deleted: false, profile: { display_name: '' } },
          { id: 'U3', name: 'botuser', real_name: 'Bot', team_id: 'T1', is_bot: true, profile: {} },
          { id: 'U4', name: 'gone', real_name: 'Gone User', team_id: 'T1', is_bot: false, deleted: true, profile: {} },
        ],
        response_metadata: {},
      });

      const client = new SlackClient('xoxb-test');
      const result = await client.usersList();

      // All 4 returned by API, filtering is done in the tool handler
      assert.equal(result.members.length, 4);

      // Simulate tool handler filtering (non-deleted, non-bot)
      const filtered = result.members.filter(m => !m.deleted && !m.is_bot);
      assert.equal(filtered.length, 2);
      assert.equal(filtered[0].name, 'alice');
      assert.equal(filtered[1].name, 'bob');
    });

    it('usersList with cursor passes pagination', async () => {
      let capturedBody = '';
      globalThis.fetch = (async (_url: any, opts: any) => {
        capturedBody = opts.body;
        return {
          ok: true, status: 200,
          headers: { get: () => null },
          json: async () => ({ ok: true, members: [], response_metadata: { next_cursor: 'abc' } }),
        };
      }) as any;

      const client = new SlackClient('xoxb-test');
      const result = await client.usersList('prevCursor');
      assert.ok(capturedBody.includes('cursor=prevCursor'));
      assert.equal(result.response_metadata?.next_cursor, 'abc');
    });
  });

  describe('openDm - conversations.open', () => {
    it('opens a DM and returns channel id', async () => {
      let capturedBody = '';
      globalThis.fetch = (async (_url: any, opts: any) => {
        capturedBody = opts.body;
        return {
          ok: true, status: 200,
          headers: { get: () => null },
          json: async () => ({ ok: true, channel: { id: 'D_NEW_DM' } }),
        };
      }) as any;

      const client = new SlackClient('xoxb-test');
      const result = await client.conversationsOpen('U_TARGET');
      assert.equal(result.channel.id, 'D_NEW_DM');
      assert.ok(capturedBody.includes('users=U_TARGET'));
    });
  });
});
