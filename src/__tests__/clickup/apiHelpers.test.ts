import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { ClickUpClient, matchesDocQuery, sortDocsNewestFirst } from '../../clickup/apiHelpers.js';

// Mock global fetch
const originalFetch = globalThis.fetch;

function mockFetch(responses: Array<{ status: number; body?: any; text?: string }>) {
  let callIndex = 0;
  const calls: Array<{ url: string; method: string; headers: any; body?: string }> = [];

  const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
    const response = responses[callIndex] || responses[responses.length - 1];
    callIndex++;

    calls.push({
      url: url.toString(),
      method: init?.method || 'GET',
      headers: init?.headers,
      body: init?.body as string,
    });

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => response.text ?? JSON.stringify(response.body ?? {}),
      json: async () => response.body,
    } as any;
  };

  globalThis.fetch = fetchMock as any;
  return { calls };
}

describe('ClickUpClient', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('constructor and auth header', () => {
    it('should send access token in Authorization header', async () => {
      const { calls } = mockFetch([{ status: 200, body: { user: { id: 1 } } }]);
      const client = new ClickUpClient('test-token-123');
      await client.getAuthorizedUser();
      assert.equal(calls.length, 1);
      assert.equal((calls[0].headers as any)['Authorization'], 'Bearer test-token-123');
    });
  });

  describe('getAuthorizedUser', () => {
    it('should call /user endpoint', async () => {
      const { calls } = mockFetch([{ status: 200, body: { user: { id: 1, email: 'test@test.com' } } }]);
      const client = new ClickUpClient('token');
      const result = await client.getAuthorizedUser();
      assert.equal(calls[0].url, 'https://api.clickup.com/api/v2/user');
      assert.equal(result.user.email, 'test@test.com');
    });
  });

  describe('getWorkspaces', () => {
    it('should call /team endpoint', async () => {
      const { calls } = mockFetch([{ status: 200, body: { teams: [{ id: 't1', name: 'My Team' }] } }]);
      const client = new ClickUpClient('token');
      const result = await client.getWorkspaces();
      assert.equal(calls[0].url, 'https://api.clickup.com/api/v2/team');
      assert.equal(result.teams[0].name, 'My Team');
    });
  });

  describe('getSpaces', () => {
    it('should call /team/:id/space', async () => {
      const { calls } = mockFetch([{ status: 200, body: { spaces: [] } }]);
      const client = new ClickUpClient('token');
      await client.getSpaces('team1');
      assert.equal(calls[0].url, 'https://api.clickup.com/api/v2/team/team1/space');
    });

    it('should pass archived param', async () => {
      const { calls } = mockFetch([{ status: 200, body: { spaces: [] } }]);
      const client = new ClickUpClient('token');
      await client.getSpaces('team1', true);
      assert.ok(calls[0].url.includes('?archived=true'));
    });
  });

  describe('createTask', () => {
    it('should POST to /list/:id/task with body', async () => {
      const taskBody = { name: 'New Task', description: 'Test' };
      const { calls } = mockFetch([{ status: 200, body: { id: 'task1', name: 'New Task' } }]);
      const client = new ClickUpClient('token');
      const result = await client.createTask('list1', taskBody);
      assert.equal(calls[0].url, 'https://api.clickup.com/api/v2/list/list1/task');
      assert.equal(calls[0].method, 'POST');
      assert.deepEqual(JSON.parse(calls[0].body!), taskBody);
      assert.equal(result.name, 'New Task');
    });
  });

  describe('updateTask', () => {
    it('should PUT to /task/:id', async () => {
      const { calls } = mockFetch([{ status: 200, body: { id: 'task1', name: 'Updated' } }]);
      const client = new ClickUpClient('token');
      await client.updateTask('task1', { name: 'Updated' });
      assert.equal(calls[0].url, 'https://api.clickup.com/api/v2/task/task1');
      assert.equal(calls[0].method, 'PUT');
    });
  });

  describe('deleteTask', () => {
    it('should DELETE /task/:id', async () => {
      const { calls } = mockFetch([{ status: 200, text: '' }]);
      const client = new ClickUpClient('token');
      await client.deleteTask('task1');
      assert.equal(calls[0].method, 'DELETE');
      assert.equal(calls[0].url, 'https://api.clickup.com/api/v2/task/task1');
    });
  });

  describe('getTasks — array filter serialization', () => {
    // Same ClickUp v2 parser quirk as filterTeamTasks: bare `foo=X` alone
    // 400s (scalar), `foo[]=X` silently drops the filter. Only ≥2 repeated
    // bare occurrences work — verify the workaround propagates here too.
    it('duplicates single-element assignees so the filter is parsed as an array', async () => {
      const { calls } = mockFetch([{ status: 200, body: { tasks: [] } }]);
      const client = new ClickUpClient('token');
      await client.getTasks('list1', { assignees: ['u1'] });
      const url = new URL(calls[0].url);
      assert.deepEqual(url.searchParams.getAll('assignees'), ['u1', 'u1']);
      assert.doesNotMatch(calls[0].url, /%5B%5D/);
    });

    it('duplicates single-element statuses the same way', async () => {
      const { calls } = mockFetch([{ status: 200, body: { tasks: [] } }]);
      const client = new ClickUpClient('token');
      await client.getTasks('list1', { statuses: ['open'] });
      const url = new URL(calls[0].url);
      assert.deepEqual(url.searchParams.getAll('statuses'), ['open', 'open']);
    });

    it('leaves multi-element arrays as repeated bare keys', async () => {
      const { calls } = mockFetch([{ status: 200, body: { tasks: [] } }]);
      const client = new ClickUpClient('token');
      await client.getTasks('list1', { assignees: ['u1', 'u2'], statuses: ['open', 'in progress'] });
      const url = new URL(calls[0].url);
      assert.deepEqual(url.searchParams.getAll('assignees'), ['u1', 'u2']);
      assert.deepEqual(url.searchParams.getAll('statuses'), ['open', 'in progress']);
      assert.doesNotMatch(calls[0].url, /%5B%5D/);
    });
  });

  describe('error handling', () => {
    it('should throw UserError on rate limit (429)', async () => {
      mockFetch([{ status: 429, text: 'rate limited' }]);
      const client = new ClickUpClient('token');
      await assert.rejects(
        () => client.getAuthorizedUser(),
        { message: 'ClickUp rate limit exceeded. Please try again in a moment.' }
      );
    });

    it('should throw UserError on API errors', async () => {
      mockFetch([{ status: 400, text: 'Bad request' }]);
      const client = new ClickUpClient('token');
      await assert.rejects(
        () => client.getAuthorizedUser(),
        { message: 'ClickUp API error (400): Bad request' }
      );
    });
  });

  describe('searchTasks', () => {
    it('should call /team/:id/task and filter results by name client-side', async () => {
      const { calls } = mockFetch([{ status: 200, body: { tasks: [
        { name: 'Bug fix urgent' }, { name: 'Feature request' }, { name: 'bug fix minor' }
      ] } }]);
      const client = new ClickUpClient('token');
      const result = await client.searchTasks('team1', 'bug fix');
      assert.ok(calls[0].url.includes('/team/team1/task'));
      // Name filter is client-side — should only return matching tasks
      assert.equal(result.tasks.length, 2);
    });

    it('should return all tasks when query is empty', async () => {
      mockFetch([{ status: 200, body: { tasks: [{ name: 'A' }, { name: 'B' }] } }]);
      const client = new ClickUpClient('token');
      const result = await client.searchTasks('team1', '');
      assert.equal(result.tasks.length, 2);
    });

    it('should pass include_closed param', async () => {
      const { calls } = mockFetch([{ status: 200, body: { tasks: [] } }]);
      const client = new ClickUpClient('token');
      await client.searchTasks('team1', '', undefined, undefined, true);
      assert.ok(calls[0].url.includes('include_closed=true'));
    });
  });

  describe('getTaskComments', () => {
    it('should GET /task/:id/comment', async () => {
      const { calls } = mockFetch([{ status: 200, body: { comments: [] } }]);
      const client = new ClickUpClient('token');
      await client.getTaskComments('task1');
      assert.equal(calls[0].url, 'https://api.clickup.com/api/v2/task/task1/comment');
    });
  });

  describe('addTaskComment', () => {
    it('should POST comment to task', async () => {
      const { calls } = mockFetch([{ status: 200, body: { id: 'c1' } }]);
      const client = new ClickUpClient('token');
      await client.addTaskComment('task1', { comment_text: 'Hello' });
      assert.equal(calls[0].method, 'POST');
      assert.deepEqual(JSON.parse(calls[0].body!), { comment_text: 'Hello' });
    });
  });

  describe('time tracking', () => {
    it('should start time entry', async () => {
      const { calls } = mockFetch([{ status: 200, body: { data: { id: 'te1' } } }]);
      const client = new ClickUpClient('token');
      await client.startTimeEntry('team1', { tid: 'task1' });
      assert.equal(calls[0].method, 'POST');
      assert.ok(calls[0].url.includes('/time_entries/start'));
    });

    it('should stop time entry', async () => {
      const { calls } = mockFetch([{ status: 200, body: { data: { id: 'te1' } } }]);
      const client = new ClickUpClient('token');
      await client.stopTimeEntry('team1');
      assert.equal(calls[0].method, 'POST');
      assert.ok(calls[0].url.includes('/time_entries/stop'));
    });
  });

  describe('tags', () => {
    it('should list tags in a space', async () => {
      const { calls } = mockFetch([{ status: 200, body: { tags: [{ name: 'bug', tag_fg: '#fff', tag_bg: '#f00' }] } }]);
      const client = new ClickUpClient('token');
      const result = await client.getSpaceTags('space1');
      assert.equal(calls[0].url, 'https://api.clickup.com/api/v2/space/space1/tag');
      assert.equal(calls[0].method, 'GET');
      assert.equal(result.tags[0].name, 'bug');
    });

    it('should add a tag to a task', async () => {
      const { calls } = mockFetch([{ status: 200, text: '' }]);
      const client = new ClickUpClient('token');
      await client.addTagToTask('task1', 'bug');
      assert.equal(calls[0].url, 'https://api.clickup.com/api/v2/task/task1/tag/bug');
      assert.equal(calls[0].method, 'POST');
    });

    it('should url-encode tag names with spaces or special chars', async () => {
      const { calls } = mockFetch([{ status: 200, text: '' }, { status: 200, text: '' }]);
      const client = new ClickUpClient('token');
      await client.addTagToTask('task1', 'high priority');
      await client.removeTagFromTask('task1', 'needs review/qa');
      assert.equal(calls[0].url, 'https://api.clickup.com/api/v2/task/task1/tag/high%20priority');
      assert.equal(calls[1].url, 'https://api.clickup.com/api/v2/task/task1/tag/needs%20review%2Fqa');
    });

    it('should remove a tag from a task', async () => {
      const { calls } = mockFetch([{ status: 200, text: '' }]);
      const client = new ClickUpClient('token');
      await client.removeTagFromTask('task1', 'bug');
      assert.equal(calls[0].url, 'https://api.clickup.com/api/v2/task/task1/tag/bug');
      assert.equal(calls[0].method, 'DELETE');
    });
  });

  describe('lists', () => {
    it('should create a list in folder', async () => {
      const { calls } = mockFetch([{ status: 200, body: { id: 'l1', name: 'New List' } }]);
      const client = new ClickUpClient('token');
      await client.createList('folder1', { name: 'New List' });
      assert.equal(calls[0].url, 'https://api.clickup.com/api/v2/folder/folder1/list');
    });

    it('should create folderless list in space', async () => {
      const { calls } = mockFetch([{ status: 200, body: { id: 'l1', name: 'New List' } }]);
      const client = new ClickUpClient('token');
      await client.createFolderlessList('space1', { name: 'New List' });
      assert.equal(calls[0].url, 'https://api.clickup.com/api/v2/space/space1/list');
    });

    it('should delete a list', async () => {
      const { calls } = mockFetch([{ status: 200, text: '' }]);
      const client = new ClickUpClient('token');
      await client.deleteList('l1');
      assert.equal(calls[0].method, 'DELETE');
    });
  });
});

// === Docs search: matching, pagination, sorting ===
// See ClickUp ticket 86cb5r680. The endpoint has no text-search and no sort
// parameter, and defaults to 50 docs per page, so all three behaviours are
// implemented client-side and all three are asserted here.

describe('matchesDocQuery', () => {
  const TITLE = '[AWESOME] Sync - 08/15/2026';

  it('matches every token regardless of intervening punctuation', () => {
    // The reported bug: "AWESOME Sync" is not a contiguous substring of the
    // title because "] " sits between the words.
    assert.equal(matchesDocQuery(TITLE, 'AWESOME Sync'), true);
  });

  it('is order-independent', () => {
    assert.equal(matchesDocQuery(TITLE, 'Sync AWESOME'), true);
  });

  it('is case-insensitive', () => {
    assert.equal(matchesDocQuery(TITLE, 'awesome sYnC'), true);
  });

  it('still matches a single token, as before', () => {
    assert.equal(matchesDocQuery(TITLE, 'Sync'), true);
    assert.equal(matchesDocQuery(TITLE, 'AWESOME'), true);
  });

  it('still matches a literal substring containing punctuation', () => {
    assert.equal(matchesDocQuery(TITLE, '] Sync'), true);
  });

  it('requires ALL tokens, not any', () => {
    assert.equal(matchesDocQuery(TITLE, 'AWESOME Standup'), false);
  });

  it('treats an empty or blank query as match-everything', () => {
    assert.equal(matchesDocQuery(TITLE, ''), true);
    assert.equal(matchesDocQuery(TITLE, '   '), true);
    assert.equal(matchesDocQuery(TITLE, undefined), true);
  });

  it('tolerates a missing title', () => {
    assert.equal(matchesDocQuery('', 'anything'), false);
    assert.equal(matchesDocQuery('', ''), true);
  });
});

describe('sortDocsNewestFirst', () => {
  it('orders by date_created descending', () => {
    const sorted = sortDocsNewestFirst([
      { id: 'old', date_created: '1000' },
      { id: 'new', date_created: '3000' },
      { id: 'mid', date_created: '2000' },
    ]);
    assert.deepEqual(sorted.map((d) => d.id), ['new', 'mid', 'old']);
  });

  it('puts undated docs last rather than first', () => {
    const sorted = sortDocsNewestFirst([
      { id: 'undated' },
      { id: 'dated', date_created: '1000' },
    ]);
    assert.deepEqual(sorted.map((d) => d.id), ['dated', 'undated']);
  });

  it('does not mutate its input', () => {
    const input = [{ id: 'a', date_created: '1' }, { id: 'b', date_created: '2' }];
    sortDocsNewestFirst(input);
    assert.deepEqual(input.map((d) => d.id), ['a', 'b']);
  });
});

describe('ClickUpClient.searchDocs query params', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('omits parent_type when EVERYTHING is requested', async () => {
    // EVERYTHING is a valid upstream value that matches nothing; omitting the
    // filter is what actually returns the whole workspace.
    const { calls } = mockFetch([{ status: 200, body: { docs: [] } }]);
    await new ClickUpClient('tok').searchDocs('w1', { parentType: 'EVERYTHING' });
    assert.ok(!calls[0].url.includes('parent_type'), calls[0].url);
  });

  it('forwards a real parent_type', async () => {
    const { calls } = mockFetch([{ status: 200, body: { docs: [] } }]);
    await new ClickUpClient('tok').searchDocs('w1', { parentType: 'SPACE', parentId: 's1' });
    assert.ok(calls[0].url.includes('parent_type=SPACE'));
    assert.ok(calls[0].url.includes('parent_id=s1'));
  });

  it('clamps limit into ClickUp’s 10-100 range', async () => {
    const { calls } = mockFetch([{ status: 200, body: { docs: [] } }]);
    const client = new ClickUpClient('tok');
    await client.searchDocs('w1', { limit: 5000 });
    assert.ok(calls[0].url.includes('limit=100'));
    await client.searchDocs('w1', { limit: 1 });
    assert.ok(calls[1].url.includes('limit=10'));
  });

  it('forwards the pagination cursor', async () => {
    const { calls } = mockFetch([{ status: 200, body: { docs: [] } }]);
    await new ClickUpClient('tok').searchDocs('w1', { cursor: 'abc123' });
    assert.ok(calls[0].url.includes('cursor=abc123'));
  });
});

describe('ClickUpClient.searchAllDocs', () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('pages until the cursor runs out and finds a match on a later page', async () => {
    // The core regression: before this, a doc on page 2 reported "No docs found".
    const { calls } = mockFetch([
      { status: 200, body: { docs: [{ id: 'd1', name: 'Onboarding' }], next_cursor: 'c2' } },
      { status: 200, body: { docs: [{ id: 'd2', name: '[AWESOME] Sync - 08/15/2026' }] } },
    ]);
    const scan = await new ClickUpClient('tok').searchAllDocs('w1', { query: 'AWESOME Sync' });

    assert.equal(calls.length, 2);
    assert.ok(calls[1].url.includes('cursor=c2'), calls[1].url);
    assert.deepEqual(scan.docs.map((d: any) => d.id), ['d2']);
    assert.equal(scan.totalScanned, 2);
    assert.equal(scan.pagesScanned, 2);
    assert.equal(scan.hitCap, false);
    assert.equal(scan.rateLimited, false);
  });

  it('stops at the page cap and reports it', async () => {
    // Every page hands back another cursor, so only the cap ends the loop.
    const { calls } = mockFetch([
      { status: 200, body: { docs: [{ id: 'x', name: 'x' }], next_cursor: 'more' } },
    ]);
    const scan = await new ClickUpClient('tok').searchAllDocs('w1', { query: 'nope', maxPages: 3 });
    assert.equal(calls.length, 3);
    assert.equal(scan.pagesScanned, 3);
    assert.equal(scan.hitCap, true);
  });

  it('returns partial results instead of throwing when rate-limited mid-scan', async () => {
    const { calls } = mockFetch([
      { status: 200, body: { docs: [{ id: 'd1', name: 'Sync notes' }], next_cursor: 'c2' } },
      { status: 429 },
    ]);
    const scan = await new ClickUpClient('tok').searchAllDocs('w1', { query: 'Sync' });
    assert.equal(calls.length, 2);
    assert.equal(scan.rateLimited, true);
    assert.deepEqual(scan.docs.map((d: any) => d.id), ['d1']);
  });

  it('propagates a rate limit on the very first page', async () => {
    // Nothing collected yet, so there is no partial result worth preserving.
    mockFetch([{ status: 429 }]);
    await assert.rejects(() => new ClickUpClient('tok').searchAllDocs('w1'), /rate limit/i);
  });

  it('returns every doc newest-first when no query is given', async () => {
    mockFetch([{
      status: 200,
      body: { docs: [
        { id: 'old', name: 'A', date_created: '1000' },
        { id: 'new', name: 'B', date_created: '9000' },
      ] },
    }]);
    const scan = await new ClickUpClient('tok').searchAllDocs('w1');
    assert.deepEqual(scan.docs.map((d: any) => d.id), ['new', 'old']);
  });

  it('reads the data envelope as well as docs', async () => {
    mockFetch([{ status: 200, body: { data: [{ id: 'd1', name: 'Spec' }] } }]);
    const scan = await new ClickUpClient('tok').searchAllDocs('w1', { query: 'Spec' });
    assert.equal(scan.docs.length, 1);
  });
});
