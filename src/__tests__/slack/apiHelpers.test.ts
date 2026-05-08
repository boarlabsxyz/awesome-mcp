import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { SlackClient } from '../../slack/apiHelpers.js';

// We test SlackClient by mocking global fetch

describe('SlackClient', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  function mockFetch(response: any, status = 200, headers?: Record<string, string>) {
    globalThis.fetch = (async () => ({
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (key: string) => headers?.[key] ?? null,
      },
      json: async () => response,
      text: async () => JSON.stringify(response),
    })) as any;
  }

  function mockFetchSequence(responses: Array<{ response: any; status?: number; headers?: Record<string, string> }>) {
    let callIndex = 0;
    globalThis.fetch = (async () => {
      const r = responses[callIndex] || responses[responses.length - 1];
      callIndex++;
      return {
        ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
        status: r.status ?? 200,
        headers: {
          get: (key: string) => r.headers?.[key] ?? null,
        },
        json: async () => r.response,
        text: async () => JSON.stringify(r.response),
      };
    }) as any;
  }

  describe('request basics', () => {
    it('should call Slack API and return data on success', async () => {
      mockFetch({ ok: true, user_id: 'U123', team: 'Test', team_id: 'T123', url: 'https://test.slack.com' });
      const client = new SlackClient('xoxb-test-token');
      const result = await client.authTest();
      assert.equal(result.user_id, 'U123');
      assert.equal(result.team, 'Test');
    });

    it('should throw UserError on Slack API error (ok:false)', async () => {
      mockFetch({ ok: false, error: 'channel_not_found' });
      const client = new SlackClient('xoxb-test-token');
      await assert.rejects(
        () => client.conversationsHistory('C_BAD'),
        { message: /channel_not_found/ }
      );
    });

    it('should throw UserError on HTTP error', async () => {
      mockFetch({ error: 'server_error' }, 500);
      const client = new SlackClient('xoxb-test-token');
      await assert.rejects(
        () => client.authTest(),
        { message: /HTTP error/ }
      );
    });
  });

  describe('rate limit retry', () => {
    it('should retry once after 429 and succeed', async () => {
      mockFetchSequence([
        { response: {}, status: 429, headers: { 'Retry-After': '1' } },
        { response: { ok: true, user_id: 'U1', team: 'T', team_id: 'T1', url: 'https://t.slack.com' } },
      ]);
      const client = new SlackClient('xoxb-test');
      const result = await client.authTest();
      assert.equal(result.user_id, 'U1');
    });

    it('should throw after double 429', async () => {
      mockFetchSequence([
        { response: {}, status: 429, headers: { 'Retry-After': '1' } },
        { response: {}, status: 429, headers: { 'Retry-After': '1' } },
      ]);
      const client = new SlackClient('xoxb-test');
      await assert.rejects(
        () => client.authTest(),
        { message: /rate limit/ }
      );
    });

    it('should handle retry with ok:false response', async () => {
      mockFetchSequence([
        { response: {}, status: 429, headers: { 'Retry-After': '1' } },
        { response: { ok: false, error: 'invalid_auth' } },
      ]);
      const client = new SlackClient('xoxb-test');
      await assert.rejects(
        () => client.authTest(),
        { message: /invalid_auth/ }
      );
    });

    it('should handle retry with HTTP error', async () => {
      mockFetchSequence([
        { response: {}, status: 429, headers: { 'Retry-After': '1' } },
        { response: { error: 'bad' }, status: 503 },
      ]);
      const client = new SlackClient('xoxb-test');
      await assert.rejects(
        () => client.authTest(),
        { message: /HTTP error/ }
      );
    });
  });

  describe('conversationsList', () => {
    it('should call users.conversations with default types including im', async () => {
      let capturedBody = '';
      globalThis.fetch = (async (_url: any, opts: any) => {
        capturedBody = opts.body;
        return {
          ok: true, status: 200,
          headers: { get: () => null },
          json: async () => ({ ok: true, channels: [], response_metadata: {} }),
        };
      }) as any;

      const client = new SlackClient('xoxb-test');
      await client.conversationsList();
      assert.ok(capturedBody.includes('public_channel'));
      assert.ok(capturedBody.includes('im'));
    });

    it('should pass cursor when provided', async () => {
      let capturedBody = '';
      globalThis.fetch = (async (_url: any, opts: any) => {
        capturedBody = opts.body;
        return {
          ok: true, status: 200,
          headers: { get: () => null },
          json: async () => ({ ok: true, channels: [], response_metadata: {} }),
        };
      }) as any;

      const client = new SlackClient('xoxb-test');
      await client.conversationsList('dGVhbTpDMDExRFQ4Sk');
      assert.ok(capturedBody.includes('cursor'));
    });
  });

  describe('conversationsOpen', () => {
    it('should return channel id', async () => {
      mockFetch({ ok: true, channel: { id: 'D999' } });
      const client = new SlackClient('xoxb-test');
      const result = await client.conversationsOpen('U123');
      assert.equal(result.channel.id, 'D999');
    });
  });

  describe('usersList', () => {
    it('should return members list', async () => {
      mockFetch({
        ok: true,
        members: [
          { id: 'U1', name: 'alice', real_name: 'Alice', team_id: 'T1', is_bot: false },
        ],
        response_metadata: {},
      });
      const client = new SlackClient('xoxb-test');
      const result = await client.usersList();
      assert.equal(result.members.length, 1);
      assert.equal(result.members[0].name, 'alice');
    });
  });

  describe('conversationsHistory', () => {
    it('should pass options correctly', async () => {
      let capturedBody = '';
      globalThis.fetch = (async (_url: any, opts: any) => {
        capturedBody = opts.body;
        return {
          ok: true, status: 200,
          headers: { get: () => null },
          json: async () => ({ ok: true, messages: [], has_more: false }),
        };
      }) as any;

      const client = new SlackClient('xoxb-test');
      await client.conversationsHistory('C123', { limit: 10, oldest: '123.0' });
      assert.ok(capturedBody.includes('channel=C123'));
      assert.ok(capturedBody.includes('limit=10'));
      assert.ok(capturedBody.includes('oldest=123.0'));
    });
  });

  describe('conversationsReplies', () => {
    it('should return messages', async () => {
      mockFetch({ ok: true, messages: [{ text: 'reply', ts: '1.0' }], has_more: false });
      const client = new SlackClient('xoxb-test');
      const result = await client.conversationsReplies('C1', '1.0');
      assert.equal(result.messages.length, 1);
    });
  });

  describe('chatPostMessage', () => {
    it('should return ts and channel', async () => {
      mockFetch({ ok: true, ts: '1234.5', channel: 'C1' });
      const client = new SlackClient('xoxb-test');
      const result = await client.chatPostMessage('C1', 'hello');
      assert.equal(result.ts, '1234.5');
    });

    it('should pass thread_ts when provided', async () => {
      let capturedBody = '';
      globalThis.fetch = (async (_url: any, opts: any) => {
        capturedBody = opts.body;
        return {
          ok: true, status: 200,
          headers: { get: () => null },
          json: async () => ({ ok: true, ts: '1.0', channel: 'C1' }),
        };
      }) as any;

      const client = new SlackClient('xoxb-test');
      await client.chatPostMessage('C1', 'hello', '999.0');
      assert.ok(capturedBody.includes('thread_ts=999.0'));
    });
  });

  describe('usersInfo', () => {
    it('should return user info', async () => {
      mockFetch({ ok: true, user: { id: 'U1', name: 'bob', real_name: 'Bob' } });
      const client = new SlackClient('xoxb-test');
      const result = await client.usersInfo('U1');
      assert.equal(result.user.name, 'bob');
    });
  });

  describe('teamInfo', () => {
    it('should return team info without teamId', async () => {
      mockFetch({ ok: true, team: { id: 'T1', name: 'TestTeam', domain: 'test' } });
      const client = new SlackClient('xoxb-test');
      const result = await client.teamInfo();
      assert.equal(result.team.name, 'TestTeam');
    });

    it('should pass teamId when provided', async () => {
      let capturedBody = '';
      globalThis.fetch = (async (_url: any, opts: any) => {
        capturedBody = opts.body;
        return {
          ok: true, status: 200,
          headers: { get: () => null },
          json: async () => ({ ok: true, team: { id: 'T2', name: 'Other', domain: 'other' } }),
        };
      }) as any;

      const client = new SlackClient('xoxb-test');
      await client.teamInfo('T2');
      assert.ok(capturedBody.includes('team=T2'));
    });
  });

  describe('conversationsInfo', () => {
    it('should return channel info', async () => {
      mockFetch({
        ok: true,
        channel: { id: 'C1', name: 'general', is_private: false, is_shared: false, is_ext_shared: false, is_org_shared: false, is_im: false, is_mpim: false },
      });
      const client = new SlackClient('xoxb-test');
      const result = await client.conversationsInfo('C1');
      assert.equal(result.channel.name, 'general');
    });
  });

  describe('conversationsMembers', () => {
    it('should return members', async () => {
      mockFetch({ ok: true, members: ['U1', 'U2'], response_metadata: {} });
      const client = new SlackClient('xoxb-test');
      const result = await client.conversationsMembers('C1');
      assert.deepEqual(result.members, ['U1', 'U2']);
    });
  });

  describe('conversationsListAll', () => {
    it('should use conversations.list endpoint', async () => {
      let capturedUrl = '';
      globalThis.fetch = (async (url: any, _opts: any) => {
        capturedUrl = url;
        return {
          ok: true, status: 200,
          headers: { get: () => null },
          json: async () => ({ ok: true, channels: [], response_metadata: {} }),
        };
      }) as any;

      const client = new SlackClient('xoxb-test');
      await client.conversationsListAll();
      assert.ok(capturedUrl.includes('conversations.list'));
    });
  });
});
