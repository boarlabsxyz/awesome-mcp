import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { ClickUpClient } from '../../clickup/apiHelpers.js';

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
