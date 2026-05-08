import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveUsers, getWorkspaceUrl, handleReadChannelHistory, handleReadThreadReplies, handlePostMessage, handleReplyInThread } from '../../slack/helpers.js';

function mockSlackClient(overrides: Record<string, any> = {}): any {
  return {
    usersInfo: async (uid: string) => ({
      user: { id: uid, name: uid, real_name: `Real ${uid}`, profile: { display_name: `Display ${uid}` } },
    }),
    authTest: async () => ({ ok: true, url: 'https://test.slack.com' }),
    conversationsHistory: async () => ({
      messages: [
        { type: 'message', user: 'U1', text: 'hello', ts: '1609459200.000000' },
        { type: 'message', user: 'U2', text: 'world', ts: '1609459201.000000' },
      ],
      has_more: false,
      response_metadata: {},
    }),
    conversationsReplies: async () => ({
      messages: [
        { type: 'message', user: 'U1', text: 'parent', ts: '1609459200.000000' },
        { type: 'message', user: 'U2', text: 'reply', ts: '1609459201.000000' },
      ],
      has_more: false,
      response_metadata: {},
    }),
    chatPostMessage: async (channel: string, text: string, threadTs?: string) => ({
      ts: '9999.0000',
      channel,
    }),
    ...overrides,
  };
}

describe('resolveUsers', () => {
  it('should resolve user IDs to display names', async () => {
    const client = mockSlackClient();
    const result = await resolveUsers(client, ['U1', 'U2'], 'test-resolve-token');
    assert.equal(result.get('U1'), 'Display U1');
    assert.equal(result.get('U2'), 'Display U2');
  });

  it('should deduplicate user IDs', async () => {
    let callCount = 0;
    const client = mockSlackClient({
      usersInfo: async (uid: string) => {
        callCount++;
        return { user: { id: uid, name: uid, real_name: uid, profile: {} } };
      },
    });
    await resolveUsers(client, ['U1', 'U1', 'U1'], 'test-dedup-token');
    assert.equal(callCount, 1);
  });

  it('should use cache on second call', async () => {
    let callCount = 0;
    const client = mockSlackClient({
      usersInfo: async (uid: string) => {
        callCount++;
        return { user: { id: uid, name: uid, real_name: `Name ${uid}`, profile: { display_name: `Cached ${uid}` } } };
      },
    });
    const tokenKey = 'test-cache-token-' + Date.now();
    await resolveUsers(client, ['U_CACHE1'], tokenKey);
    assert.equal(callCount, 1);
    const result2 = await resolveUsers(client, ['U_CACHE1'], tokenKey);
    assert.equal(callCount, 1); // should not call again
    assert.equal(result2.get('U_CACHE1'), 'Cached U_CACHE1');
  });

  it('should fall back to user ID on error', async () => {
    const client = mockSlackClient({
      usersInfo: async () => { throw new Error('api error'); },
    });
    const result = await resolveUsers(client, ['U_FAIL'], 'test-fail-token');
    assert.equal(result.get('U_FAIL'), 'U_FAIL');
  });

  it('should fall back to real_name when no display_name', async () => {
    const client = mockSlackClient({
      usersInfo: async (uid: string) => ({
        user: { id: uid, name: uid, real_name: 'RealName', profile: {} },
      }),
    });
    const result = await resolveUsers(client, ['U_NODISP'], 'test-nodisp-token');
    assert.equal(result.get('U_NODISP'), 'RealName');
  });

  it('should skip empty user IDs', async () => {
    const client = mockSlackClient();
    const result = await resolveUsers(client, ['', '', 'U1'], 'test-empty-token');
    assert.equal(result.size, 1);
    assert.ok(result.has('U1'));
  });
});

describe('getWorkspaceUrl', () => {
  it('should return workspace URL', async () => {
    const client = mockSlackClient();
    const url = await getWorkspaceUrl(client, 'test-ws-token-' + Date.now());
    assert.equal(url, 'https://test.slack.com');
  });

  it('should cache workspace URL', async () => {
    let callCount = 0;
    const client = mockSlackClient({
      authTest: async () => { callCount++; return { ok: true, url: 'https://cached.slack.com' }; },
    });
    const token = 'test-ws-cache-token-' + Date.now();
    const url1 = await getWorkspaceUrl(client, token);
    const url2 = await getWorkspaceUrl(client, token);
    assert.equal(url1, 'https://cached.slack.com');
    assert.equal(url2, 'https://cached.slack.com');
    assert.equal(callCount, 1);
  });

  it('should return empty string on error', async () => {
    const client = mockSlackClient({
      authTest: async () => { throw new Error('fail'); },
    });
    const url = await getWorkspaceUrl(client, 'test-ws-fail-token-' + Date.now());
    assert.equal(url, '');
  });
});

describe('handleReadChannelHistory', () => {
  it('should return formatted messages', async () => {
    const client = mockSlackClient();
    const result = await handleReadChannelHistory(client, 'test-hist-token-' + Date.now(), 'C123', { limit: 20 });
    assert.ok(result.includes('hello'));
    assert.ok(result.includes('world'));
    assert.ok(result.includes('Display U1'));
  });

  it('should return no messages message when empty', async () => {
    const client = mockSlackClient({
      conversationsHistory: async () => ({ messages: [], has_more: false, response_metadata: {} }),
    });
    const result = await handleReadChannelHistory(client, 'test-empty-hist-token', 'C123', { limit: 20 });
    assert.ok(result.includes('No messages'));
  });

  it('should include pagination cursor when available', async () => {
    const client = mockSlackClient({
      conversationsHistory: async () => ({
        messages: [{ type: 'message', user: 'U1', text: 'hi', ts: '1.0' }],
        has_more: true,
        response_metadata: { next_cursor: 'abc123' },
      }),
    });
    const result = await handleReadChannelHistory(client, 'test-cursor-token-' + Date.now(), 'C123', { limit: 1 });
    assert.ok(result.includes('abc123'));
  });

  it('should clamp limit to range 1-100', async () => {
    const client = mockSlackClient();
    // Should not throw with extreme limits
    const result = await handleReadChannelHistory(client, 'test-clamp-token-' + Date.now(), 'C123', { limit: 999 });
    assert.ok(result.includes('hello'));
  });
});

describe('handleReadThreadReplies', () => {
  it('should return formatted thread replies', async () => {
    const client = mockSlackClient();
    const result = await handleReadThreadReplies(client, 'test-thread-token-' + Date.now(), 'C123', '1.0', { limit: 50 });
    assert.ok(result.includes('parent'));
    assert.ok(result.includes('reply'));
  });

  it('should return no replies message when empty', async () => {
    const client = mockSlackClient({
      conversationsReplies: async () => ({ messages: [], has_more: false, response_metadata: {} }),
    });
    const result = await handleReadThreadReplies(client, 'test-empty-thread-token', 'C123', '1.0', { limit: 50 });
    assert.ok(result.includes('No replies'));
  });
});

describe('handlePostMessage', () => {
  it('should post message and return confirmation', async () => {
    const origEnv = process.env.SLACK_WRITES_ENABLED;
    process.env.SLACK_WRITES_ENABLED = 'true';
    try {
      const client = mockSlackClient();
      const result = await handlePostMessage(client, 'C123', 'test message');
      assert.ok(result.includes('Message posted'));
      assert.ok(result.includes('C123'));
    } finally {
      if (origEnv === undefined) delete process.env.SLACK_WRITES_ENABLED;
      else process.env.SLACK_WRITES_ENABLED = origEnv;
    }
  });

  it('should throw when writes not enabled', async () => {
    const origEnv = process.env.SLACK_WRITES_ENABLED;
    delete process.env.SLACK_WRITES_ENABLED;
    try {
      const client = mockSlackClient();
      await assert.rejects(() => handlePostMessage(client, 'C123', 'test'), { message: /disabled/ });
    } finally {
      if (origEnv === undefined) delete process.env.SLACK_WRITES_ENABLED;
      else process.env.SLACK_WRITES_ENABLED = origEnv;
    }
  });
});

describe('handleReplyInThread', () => {
  it('should reply in thread and return confirmation', async () => {
    const origEnv = process.env.SLACK_WRITES_ENABLED;
    process.env.SLACK_WRITES_ENABLED = 'true';
    try {
      const client = mockSlackClient();
      const result = await handleReplyInThread(client, 'C123', '1.0', 'reply text');
      assert.ok(result.includes('Reply posted'));
      assert.ok(result.includes('1.0'));
    } finally {
      if (origEnv === undefined) delete process.env.SLACK_WRITES_ENABLED;
      else process.env.SLACK_WRITES_ENABLED = origEnv;
    }
  });
});
