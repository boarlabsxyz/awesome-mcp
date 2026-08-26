import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { resolveUsers, getWorkspaceUrl, handleReadChannelHistory, handleReadThreadReplies, handleDownloadFile, handlePostMessage, handleReplyInThread, handleSearchMessages, handleSearchFiles } from '../../slack/helpers.js';
import { __setImageBlobPoolForTests } from '../../images/imageBlobStore.js';

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

describe('handleDownloadFile', () => {
  // A real PNG so sharp (store) and file-type (imageContent) both work.
  const pngPromise = sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 30, b: 30 } },
  }).png().toBuffer();

  function fileClient(file: any, bytes?: Buffer): any {
    return {
      filesInfo: async () => ({ file }),
      downloadFileBytes: async () => ({
        buffer: bytes ?? Buffer.from('hello'),
        contentType: file.mimetype || 'application/octet-stream',
      }),
    };
  }

  const IMAGE = {
    id: 'F1', name: 'shot.png', mimetype: 'image/png', size: 1024,
    channels: ['C1'], permalink: 'https://x.slack.com/files/F1',
    url_private_download: 'https://files.slack.com/files-pri/T1-F1/download/shot.png',
  };

  it('refuses a file that is not shared in the given channel', async () => {
    const client = fileClient(IMAGE);
    await assert.rejects(
      () => handleDownloadFile(client, { fileId: 'F1', channelId: 'C_OTHER', format: 'url' }),
      { message: /not shared in channel C_OTHER/ },
    );
  });

  it('accepts a share recorded under ims', async () => {
    const png = await pngPromise;
    const client = fileClient({ ...IMAGE, channels: undefined, ims: ['D9'] }, png);
    const result = await handleDownloadFile(client, { fileId: 'F1', channelId: 'D9', format: 'inline' });
    assert.equal((result as any).type, 'image');
  });

  it('accepts a share recorded under the newer shares map', async () => {
    const png = await pngPromise;
    const client = fileClient({ ...IMAGE, channels: undefined, shares: { private: { D9: [{}] } } }, png);
    const result = await handleDownloadFile(client, { fileId: 'F1', channelId: 'D9', format: 'inline' });
    assert.equal((result as any).type, 'image');
  });

  it('returns an image content block for format inline', async () => {
    const png = await pngPromise;
    const client = fileClient(IMAGE, png);
    const result: any = await handleDownloadFile(client, { fileId: 'F1', channelId: 'C1', format: 'inline' });
    assert.equal(result.type, 'image');
    assert.equal(result.mimeType, 'image/png');
    assert.ok(result.data.length > 0);
  });

  it('refuses an oversized inline request and points at format url', async () => {
    const client = fileClient({ ...IMAGE, size: 5 * 1024 * 1024 });
    await assert.rejects(
      () => handleDownloadFile(client, { fileId: 'F1', channelId: 'C1', format: 'inline' }),
      { message: /Use format: "url"/ },
    );
  });

  it('hosts the image and returns a public URL for format url', async () => {
    const origBase = process.env.IMAGE_PUBLIC_BASE_URL;
    process.env.IMAGE_PUBLIC_BASE_URL = 'https://img.test';
    __setImageBlobPoolForTests({ query: async () => ({ rows: [], rowCount: 1 }) });
    try {
      const png = await pngPromise;
      const client = fileClient(IMAGE, png);
      const result = await handleDownloadFile(client, { fileId: 'F1', channelId: 'C1', format: 'url' });
      assert.ok(typeof result === 'string');
      assert.ok((result as string).includes('https://img.test/images/'));
      assert.ok((result as string).includes('shot.png'));
    } finally {
      __setImageBlobPoolForTests(null);
      if (origBase === undefined) delete process.env.IMAGE_PUBLIC_BASE_URL;
      else process.env.IMAGE_PUBLIC_BASE_URL = origBase;
    }
  });

  it('suggests format inline when the image host is not configured', async () => {
    const origBase = process.env.IMAGE_PUBLIC_BASE_URL;
    delete process.env.IMAGE_PUBLIC_BASE_URL;
    __setImageBlobPoolForTests({ query: async () => ({ rows: [], rowCount: 1 }) });
    try {
      const png = await pngPromise;
      const client = fileClient(IMAGE, png);
      await assert.rejects(
        () => handleDownloadFile(client, { fileId: 'F1', channelId: 'C1', format: 'url' }),
        { message: /format: "inline"/ },
      );
    } finally {
      __setImageBlobPoolForTests(null);
      if (origBase !== undefined) process.env.IMAGE_PUBLIC_BASE_URL = origBase;
    }
  });

  it('returns text files inline as text', async () => {
    const client = fileClient(
      { ...IMAGE, name: 'log.txt', mimetype: 'text/plain' },
      Buffer.from('line one\nline two'),
    );
    const result = await handleDownloadFile(client, { fileId: 'F1', channelId: 'C1', format: 'url' });
    assert.ok((result as string).includes('line one'));
    assert.ok((result as string).includes('log.txt'));
  });

  it('returns metadata rather than throwing for an unsupported type', async () => {
    const client = fileClient({ ...IMAGE, name: 'report.pdf', mimetype: 'application/pdf' });
    const result = await handleDownloadFile(client, { fileId: 'F1', channelId: 'C1', format: 'url' });
    assert.ok((result as string).includes('not downloadable'));
    assert.ok((result as string).includes('report.pdf'));
    assert.ok((result as string).includes('https://x.slack.com/files/F1'));
  });

  it('explains that external files cannot be downloaded', async () => {
    const client = fileClient({
      ...IMAGE, mode: 'external', is_external: true, url_private: 'https://drive.google.com/x',
    });
    const result = await handleDownloadFile(client, { fileId: 'F1', channelId: 'C1', format: 'url' });
    assert.ok((result as string).includes('hosted outside Slack'));
    assert.ok((result as string).includes('https://drive.google.com/x'));
  });

  it('translates missing_scope into reconnect guidance', async () => {
    const client = {
      filesInfo: async () => { throw new Error('Slack API error (files.info): missing_scope'); },
    } as any;
    await assert.rejects(
      () => handleDownloadFile(client, { fileId: 'F1', channelId: 'C1', format: 'url' }),
      { message: /files:read.*[Rr]econnect/s },
    );
  });
});

describe('handleSearchMessages', () => {
  const MATCHES = [
    { channel: { id: 'C1', name: 'general' }, user: 'U1', ts: '1609459200.000000', text: 'dashboard is live', permalink: 'https://t/p1' },
    { channel: { id: 'C2', name: 'secret' }, user: 'U2', ts: '1609459201.000000', text: 'do not leak me', permalink: 'https://t/p2' },
  ];

  function searchClient(page: any = { total: 2, paging: { count: 20, total: 2, page: 1, pages: 1 }, matches: MATCHES }): any {
    return mockSlackClient({ searchMessages: async () => ({ query: 'q', messages: page }) });
  }

  it('renders channel, author, text and permalink for each match', async () => {
    const result = await handleSearchMessages(searchClient(), 'tok-search-' + Date.now(), { query: 'dashboard', count: 20 });
    assert.ok(result.includes('Found 2 message(s)'));
    assert.ok(result.includes('#general'));
    assert.ok(result.includes('dashboard is live'));
    assert.ok(result.includes('https://t/p1'));
    assert.ok(result.includes('Display U1'));
  });

  it('reports no results without a tail when Slack returns nothing', async () => {
    const client = searchClient({ total: 0, matches: [] });
    const result = await handleSearchMessages(client, 'tok-empty-' + Date.now(), { query: 'nope', count: 20 });
    assert.ok(result.includes('No messages found for "nope"'));
  });

  it('drops matches the access filter denies and says how many were hidden', async () => {
    const allow = async (ch: { id: string }) => ch.id === 'C1';
    const result = await handleSearchMessages(searchClient(), 'tok-filter-' + Date.now(), { query: 'x', count: 20 }, allow);

    assert.ok(result.includes('Found 1 message(s)'));
    assert.ok(result.includes('dashboard is live'));
    // The denied channel must not leak by name, text or permalink.
    assert.ok(!result.includes('do not leak me'));
    assert.ok(!result.includes('#secret'));
    assert.ok(!result.includes('https://t/p2'));
    assert.ok(result.includes('1 result(s) on this page hidden by your access rules'));
  });

  it('fails closed on a match with no channel', async () => {
    const client = searchClient({ total: 1, matches: [{ channel: undefined as any, user: 'U1', ts: '1609459200.000000', text: 'orphan' }] });
    const result = await handleSearchMessages(client, 'tok-orphan-' + Date.now(), { query: 'x', count: 20 }, async () => true);
    assert.ok(!result.includes('orphan'));
    assert.ok(result.includes('No messages you can access'));
  });

  it('keeps every match when no filter is supplied', async () => {
    const result = await handleSearchMessages(searchClient(), 'tok-nofilter-' + Date.now(), { query: 'x', count: 20 });
    assert.ok(result.includes('do not leak me'));
    assert.ok(!result.includes('hidden by your access rules'));
  });

  it('reports Slack page numbers and points at the next page', async () => {
    const client = searchClient({ total: 73, paging: { count: 20, total: 73, page: 2, pages: 4 }, matches: MATCHES });
    const result = await handleSearchMessages(client, 'tok-page-' + Date.now(), { query: 'x', count: 20, page: 2 });
    assert.ok(result.includes('Page 2 of 4'));
    assert.ok(result.includes('2 shown of 73 total match(es)'));
    assert.ok(result.includes('Use page: 3'));
  });

  it('warns that page numbers precede filtering only when results were hidden', async () => {
    const client = searchClient({ total: 73, paging: { count: 20, total: 73, page: 2, pages: 4 }, matches: MATCHES });
    const filtered = await handleSearchMessages(client, 'tok-warn-' + Date.now(), { query: 'x', count: 20 }, async ({ id }) => id === 'C1');
    assert.ok(filtered.includes("Page numbers are Slack's"));

    const unfiltered = await handleSearchMessages(client, 'tok-warn2-' + Date.now(), { query: 'x', count: 20 });
    assert.ok(!unfiltered.includes("Page numbers are Slack's"));
  });

  it('reads the newer pagination block when paging is absent', async () => {
    const client = searchClient({ total: 5, pagination: { total_count: 5, page: 1, per_page: 20, page_count: 1 }, matches: MATCHES });
    const result = await handleSearchMessages(client, 'tok-pagination-' + Date.now(), { query: 'x', count: 20 });
    assert.ok(result.includes('Page 1 of 1'));
  });

  it('translates missing_scope into reconnect guidance', async () => {
    const client = mockSlackClient({
      searchMessages: async () => { throw new Error('Slack API error (search.messages): missing_scope'); },
    });
    await assert.rejects(
      () => handleSearchMessages(client, 'tok-scope-' + Date.now(), { query: 'x', count: 20 }),
      { message: /search:read.*[Rr]econnect/s },
    );
  });

  it('passes through the scope list Slack reported, so "reconnect" is verifiable', async () => {
    // Slack returns `needed`/`provided` on a missing_scope failure. Without
    // them, a reconnect that happened and still did not grant search:read is
    // indistinguishable from one that never happened.
    const client = mockSlackClient({
      searchMessages: async () => {
        throw new Error('Slack API error (search.messages): missing_scope (needed: search:read; token currently has: channels:history,users:read)');
      },
    });
    await assert.rejects(
      () => handleSearchMessages(client, 'tok-scope-detail-' + Date.now(), { query: 'x', count: 20 }),
      { message: /needed: search:read; token currently has: channels:history,users:read/ },
    );
  });

  it('explains that a bot token cannot search', async () => {
    const client = mockSlackClient({
      searchMessages: async () => { throw new Error('Slack API error (search.messages): not_allowed_token_type'); },
    });
    await assert.rejects(
      () => handleSearchMessages(client, 'tok-bot-' + Date.now(), { query: 'x', count: 20 }),
      { message: /user token/ },
    );
  });
});

describe('handleSearchFiles', () => {
  const FILES = [
    { id: 'F1', name: 'chart.png', mimetype: 'image/png', size: 1024, channels: ['C1'], permalink: 'https://t/f1' },
    { id: 'F2', name: 'secret.png', mimetype: 'image/png', size: 2048, channels: ['C2'], permalink: 'https://t/f2' },
  ];

  function filesClient(page: any = { total: 2, paging: { count: 20, total: 2, page: 1, pages: 1 }, matches: FILES }): any {
    return mockSlackClient({ searchFiles: async () => ({ query: 'q', files: page }) });
  }

  it('lists each file with its share targets so downloadFile has a channelId', async () => {
    const result = await handleSearchFiles(filesClient(), { query: 'png', count: 20 });
    assert.ok(result.includes('Found 2 file(s)'));
    assert.ok(result.includes('chart.png'));
    assert.ok(result.includes('file ID: F1'));
    assert.ok(result.includes('Shared in: C1'));
    assert.ok(result.includes('Permalink: https://t/f1'));
  });

  it('hides files shared only into denied channels', async () => {
    const result = await handleSearchFiles(filesClient(), { query: 'png', count: 20 }, async ({ id }) => id === 'C1');
    assert.ok(result.includes('Found 1 file(s)'));
    assert.ok(result.includes('chart.png'));
    assert.ok(!result.includes('secret.png'));
    assert.ok(!result.includes('https://t/f2'));
    assert.ok(result.includes('1 result(s) on this page hidden'));
  });

  it('keeps a file shared into both an allowed and a denied channel', async () => {
    const client = filesClient({
      total: 1, matches: [{ id: 'F3', name: 'both.png', mimetype: 'image/png', channels: ['C2', 'C1'] }],
    });
    const result = await handleSearchFiles(client, { query: 'png', count: 20 }, async ({ id }) => id === 'C1');
    assert.ok(result.includes('both.png'));
  });

  it('fails closed on a file with no share targets', async () => {
    const client = filesClient({ total: 1, matches: [{ id: 'F4', name: 'orphan.png', mimetype: 'image/png' }] });
    const result = await handleSearchFiles(client, { query: 'png', count: 20 }, async () => true);
    assert.ok(!result.includes('orphan.png'));
    assert.ok(result.includes('No files you can access'));
  });

  it('explains an unverifiable file separately from a rules denial', async () => {
    // Otherwise "Slack told us nothing about where this lives" and "you may not
    // read where this lives" produce an identical, inexplicable empty result.
    const client = filesClient({
      total: 2,
      matches: [
        { id: 'F4', name: 'orphan.png', mimetype: 'image/png' },
        { id: 'F2', name: 'secret.png', mimetype: 'image/png', channels: ['C2'] },
      ],
    });
    const result = await handleSearchFiles(client, { query: 'png', count: 20 }, async ({ id }) => id === 'C1');

    assert.ok(result.includes('1 result(s) on this page hidden by your access rules'));
    assert.ok(result.includes('1 result(s) withheld because Slack returned no channel'));
  });

  it('does not mention withheld results when every match had share targets', async () => {
    const result = await handleSearchFiles(filesClient(), { query: 'png', count: 20 }, async () => true);
    assert.ok(!result.includes('withheld because Slack returned no channel'));
  });

  it('unions the shares maps when picking share targets', async () => {
    const client = filesClient({
      total: 1, matches: [{ id: 'F5', name: 'shared.png', mimetype: 'image/png', shares: { private: { C1: {} } } }],
    });
    const result = await handleSearchFiles(client, { query: 'png', count: 20 }, async ({ id }) => id === 'C1');
    assert.ok(result.includes('shared.png'));
  });

  it('reports no results when Slack returns none', async () => {
    const result = await handleSearchFiles(filesClient({ total: 0, matches: [] }), { query: 'nope', count: 20 });
    assert.ok(result.includes('No files found for "nope"'));
  });

  it('translates missing_scope into reconnect guidance', async () => {
    const client = mockSlackClient({
      searchFiles: async () => { throw new Error('Slack API error (search.files): missing_scope'); },
    });
    await assert.rejects(
      () => handleSearchFiles(client, { query: 'x', count: 20 }),
      { message: /search:read.*[Rr]econnect/s },
    );
  });
});
