import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { UserError } from 'fastmcp';

// ---------------------------------------------------------------------------
// Capture tools from the FastMCP instance.
//
// server.ts registers tools via clickUpServer.addTool(). The FastMCP class
// stores them in a private #tools field that is inaccessible at runtime. To
// test each tool's execute function we patch FastMCP.prototype.addTool before
// importing the module so that every addTool() call records the tool
// definition in a map we control.
// ---------------------------------------------------------------------------

const toolMap = new Map<string, { execute: (...args: any[]) => any; parameters: any }>();

// Patch addTool BEFORE importing server.ts
const FastMCPModule = await import('fastmcp');
const origAddTool = FastMCPModule.FastMCP.prototype.addTool;
FastMCPModule.FastMCP.prototype.addTool = function (tool: any) {
  toolMap.set(tool.name, tool);
  return origAddTool.call(this, tool);
};

// Now import – all addTool calls will be captured
await import('../../clickup/server.js');

// Restore
FastMCPModule.FastMCP.prototype.addTool = origAddTool;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function sessionWith(token?: string): any {
  return token ? { clickUpAccessToken: token } : {};
}

/** Call a tool's execute function by name with the given args and session. */
async function callTool(name: string, args: any, session?: any) {
  const tool = toolMap.get(name);
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool.execute(args, { session: session ?? sessionWith('tok'), log: { info: () => {}, error: () => {}, warn: () => {} } });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClickUp server tools', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should have registered all 28 tools', () => {
    assert.equal(toolMap.size, 28);
  });

  // === getClickUpClient / auth guard ===

  describe('getClickUpClient guard', () => {
    it('throws UserError when session has no clickUpAccessToken', async () => {
      await assert.rejects(
        () => callTool('getAuthorizedUser', {}, sessionWith()),
        (err: any) => {
          assert.ok(err instanceof UserError);
          assert.ok(err.message.includes('ClickUp not connected'));
          return true;
        },
      );
    });

    it('throws UserError when session is undefined', async () => {
      await assert.rejects(
        () => callTool('getAuthorizedUser', {}, undefined),
        (err: any) => {
          assert.ok(err instanceof UserError);
          return true;
        },
      );
    });
  });

  // === Tier 1: Core Navigation ===

  describe('getAuthorizedUser', () => {
    it('returns formatted user info', async () => {
      mockFetch([{ status: 200, body: { user: { id: 42, username: 'alice', email: 'alice@x.com', color: '#ff0' } } }]);
      const result = await callTool('getAuthorizedUser', {});
      assert.ok(result.includes('alice'));
      assert.ok(result.includes('alice@x.com'));
      assert.ok(result.includes('42'));
    });
  });

  describe('listWorkspaces', () => {
    it('returns workspace list', async () => {
      mockFetch([{ status: 200, body: { teams: [{ id: 'w1', name: 'Acme', members: [1, 2] }] } }]);
      const result = await callTool('listWorkspaces', {});
      assert.ok(result.includes('Acme'));
      assert.ok(result.includes('w1'));
    });

    it('returns message when no workspaces', async () => {
      mockFetch([{ status: 200, body: { teams: [] } }]);
      const result = await callTool('listWorkspaces', {});
      assert.equal(result, 'No workspaces found.');
    });
  });

  describe('listSpaces', () => {
    it('returns space list', async () => {
      mockFetch([{
        status: 200,
        body: {
          spaces: [{
            id: 's1', name: 'Engineering', private: false,
            statuses: [{ status: 'Open' }, { status: 'Closed' }],
          }],
        },
      }]);
      const result = await callTool('listSpaces', { workspaceId: 'w1' });
      assert.ok(result.includes('Engineering'));
      assert.ok(result.includes('Open, Closed'));
    });

    it('returns message when no spaces', async () => {
      mockFetch([{ status: 200, body: { spaces: [] } }]);
      const result = await callTool('listSpaces', { workspaceId: 'w1' });
      assert.equal(result, 'No spaces found.');
    });
  });

  describe('listFolders', () => {
    it('returns folder list', async () => {
      mockFetch([{
        status: 200,
        body: { folders: [{ id: 'f1', name: 'Sprint 1', lists: [1], task_count: 5 }] },
      }]);
      const result = await callTool('listFolders', { spaceId: 's1' });
      assert.ok(result.includes('Sprint 1'));
      assert.ok(result.includes('Task Count: 5'));
    });

    it('returns message when no folders', async () => {
      mockFetch([{ status: 200, body: { folders: [] } }]);
      const result = await callTool('listFolders', { spaceId: 's1' });
      assert.ok(result.includes('No folders'));
    });
  });

  describe('listLists', () => {
    it('returns lists in a folder', async () => {
      mockFetch([{
        status: 200,
        body: { lists: [{ id: 'l1', name: 'Backlog', task_count: 12, status: { status: 'active' } }] },
      }]);
      const result = await callTool('listLists', { folderId: 'f1' });
      assert.ok(result.includes('Backlog'));
      assert.ok(result.includes('Task Count: 12'));
    });

    it('returns folderless lists in a space', async () => {
      mockFetch([{
        status: 200,
        body: { lists: [{ id: 'l2', name: 'Misc', task_count: 3 }] },
      }]);
      const result = await callTool('listLists', { spaceId: 's1' });
      assert.ok(result.includes('Misc'));
    });

    it('throws when neither folderId nor spaceId provided', async () => {
      await assert.rejects(
        () => callTool('listLists', {}),
        (err: any) => {
          assert.ok(err instanceof UserError);
          assert.ok(err.message.includes('folderId or spaceId'));
          return true;
        },
      );
    });

    it('returns message when no lists', async () => {
      mockFetch([{ status: 200, body: { lists: [] } }]);
      const result = await callTool('listLists', { folderId: 'f1' });
      assert.equal(result, 'No lists found.');
    });
  });

  describe('getTask', () => {
    it('returns formatted task', async () => {
      mockFetch([{
        status: 200,
        body: {
          id: 't1', name: 'Fix bug', status: { status: 'open' },
          priority: { priority: 'high' },
          assignees: [{ username: 'bob' }],
          due_date: '1700000000000',
          description: 'A short description',
          url: 'https://app.clickup.com/t/t1',
          list: { name: 'Backlog', id: 'l1' },
          tags: [{ name: 'bug' }],
        },
      }]);
      const result = await callTool('getTask', { taskId: 't1' });
      assert.ok(result.includes('Fix bug'));
      assert.ok(result.includes('high'));
      assert.ok(result.includes('bob'));
      assert.ok(result.includes('bug'));
      assert.ok(result.includes('Backlog'));
    });

    it('includes subtasks when requested', async () => {
      mockFetch([{
        status: 200,
        body: {
          id: 't1', name: 'Parent', status: { status: 'open' },
          subtasks: [
            { id: 'st1', name: 'Sub 1', status: { status: 'done' } },
            { id: 'st2', name: 'Sub 2', status: { status: 'open' } },
          ],
        },
      }]);
      const result = await callTool('getTask', { taskId: 't1', includeSubtasks: true });
      assert.ok(result.includes('Sub 1'));
      assert.ok(result.includes('Sub 2'));
      assert.ok(result.includes('Subtasks'));
    });

    it('omits subtask section when no subtasks', async () => {
      mockFetch([{
        status: 200,
        body: { id: 't1', name: 'Lonely', status: { status: 'open' } },
      }]);
      const result = await callTool('getTask', { taskId: 't1', includeSubtasks: true });
      assert.ok(!result.includes('Subtasks'));
    });
  });

  describe('listTasks', () => {
    it('returns formatted task list', async () => {
      mockFetch([{
        status: 200,
        body: {
          tasks: [
            { id: 't1', name: 'Task A', status: { status: 'open' } },
            { id: 't2', name: 'Task B', status: { status: 'closed' } },
          ],
        },
      }]);
      const result = await callTool('listTasks', { listId: 'l1' });
      assert.ok(result.includes('Task A'));
      assert.ok(result.includes('Task B'));
    });

    it('returns message when no tasks', async () => {
      mockFetch([{ status: 200, body: { tasks: [] } }]);
      const result = await callTool('listTasks', { listId: 'l1' });
      assert.equal(result, 'No tasks found.');
    });
  });

  // === Tier 2: Task CRUD ===

  describe('createTask', () => {
    it('creates a task and returns formatted result', async () => {
      mockFetch([{
        status: 200,
        body: { id: 'new1', name: 'New Task', status: { status: 'open' } },
      }]);
      const result = await callTool('createTask', {
        listId: 'l1',
        name: 'New Task',
        description: 'desc',
        assignees: [1],
        status: 'open',
        priority: 2,
        dueDate: '2025-06-01T00:00:00Z',
        startDate: '2025-05-01T00:00:00Z',
        tags: ['feature'],
        timeEstimate: 3600000,
        parentTaskId: 'parent1',
      });
      assert.ok(result.includes('Task created successfully'));
      assert.ok(result.includes('New Task'));
    });

    it('creates a task with minimal params', async () => {
      mockFetch([{
        status: 200,
        body: { id: 'new2', name: 'Simple', status: { status: 'todo' } },
      }]);
      const result = await callTool('createTask', { listId: 'l1', name: 'Simple' });
      assert.ok(result.includes('Simple'));
    });
  });

  describe('updateTask', () => {
    it('updates all fields and returns formatted result', async () => {
      const { calls } = mockFetch([{
        status: 200,
        body: { id: 't1', name: 'Updated', status: { status: 'in progress' } },
      }]);
      const result = await callTool('updateTask', {
        taskId: 't1',
        name: 'Updated',
        description: 'new desc',
        status: 'in progress',
        priority: 1,
        dueDate: '2025-06-01T00:00:00Z',
        startDate: '2025-05-01T00:00:00Z',
        addAssignees: [1],
        removeAssignees: [2],
        timeEstimate: 7200000,
        archived: false,
      });
      assert.ok(result.includes('Task updated successfully'));
      assert.ok(result.includes('Updated'));

      const body = JSON.parse(calls[0].body!);
      assert.equal(body.name, 'Updated');
      assert.equal(body.priority, 1);
      assert.deepEqual(body.assignees, { add: [1], rem: [2] });
      assert.equal(body.time_estimate, 7200000);
      assert.equal(body.archived, false);
    });

    it('sends only provided fields', async () => {
      const { calls } = mockFetch([{
        status: 200,
        body: { id: 't1', name: 'Same', status: { status: 'open' } },
      }]);
      await callTool('updateTask', { taskId: 't1', name: 'Same' });
      const body = JSON.parse(calls[0].body!);
      assert.equal(body.name, 'Same');
      assert.equal(body.description, undefined);
      assert.equal(body.assignees, undefined);
    });

    it('handles addAssignees without removeAssignees', async () => {
      const { calls } = mockFetch([{
        status: 200,
        body: { id: 't1', name: 'X', status: { status: 'open' } },
      }]);
      await callTool('updateTask', { taskId: 't1', addAssignees: [5] });
      const body = JSON.parse(calls[0].body!);
      assert.deepEqual(body.assignees, { add: [5], rem: [] });
    });
  });

  describe('deleteTask', () => {
    it('deletes task and returns confirmation', async () => {
      mockFetch([{ status: 200, text: '' }]);
      const result = await callTool('deleteTask', { taskId: 't1' });
      assert.ok(result.includes('t1'));
      assert.ok(result.includes('deleted'));
    });
  });

  describe('moveTask', () => {
    it('moves task and returns confirmation', async () => {
      const { calls } = mockFetch([{ status: 200, text: '' }]);
      const result = await callTool('moveTask', { taskId: 't1', listId: 'l2' });
      assert.ok(result.includes('t1'));
      assert.ok(result.includes('l2'));
      assert.equal(calls[0].method, 'POST');
    });
  });

  describe('addTaskComment', () => {
    it('adds comment and returns comment ID', async () => {
      mockFetch([{ status: 200, body: { id: 'c99' } }]);
      const result = await callTool('addTaskComment', {
        taskId: 't1',
        commentText: 'Hello',
        assignee: 1,
        notifyAll: false,
      });
      assert.ok(result.includes('c99'));
      assert.ok(result.includes('t1'));
    });
  });

  describe('getTaskComments', () => {
    it('returns formatted comments', async () => {
      mockFetch([{
        status: 200,
        body: {
          comments: [
            { user: { username: 'alice' }, date: '1700000000000', comment_text: 'Great work!' },
            { user: { username: 'bob' }, date: '1700001000000', comment_text: 'Thanks!' },
          ],
        },
      }]);
      const result = await callTool('getTaskComments', { taskId: 't1' });
      assert.ok(result.includes('alice'));
      assert.ok(result.includes('Great work!'));
      assert.ok(result.includes('bob'));
    });

    it('returns message when no comments', async () => {
      mockFetch([{ status: 200, body: { comments: [] } }]);
      const result = await callTool('getTaskComments', { taskId: 't1' });
      assert.equal(result, 'No comments on this task.');
    });

    it('handles comment with no user or empty text', async () => {
      mockFetch([{
        status: 200,
        body: {
          comments: [
            { date: '1700000000000' },
          ],
        },
      }]);
      const result = await callTool('getTaskComments', { taskId: 't1' });
      assert.ok(result.includes('unknown'));
      assert.ok(result.includes('[empty]'));
    });
  });

  // === Tier 3: Search ===

  describe('searchTasks', () => {
    it('returns search results', async () => {
      mockFetch([{
        status: 200,
        body: {
          tasks: [
            { id: 't1', name: 'Bug fix', status: { status: 'open' } },
          ],
        },
      }]);
      const result = await callTool('searchTasks', { workspaceId: 'w1', query: 'bug' });
      assert.ok(result.includes('Found 1 task'));
      assert.ok(result.includes('Bug fix'));
    });

    it('returns message when no results', async () => {
      mockFetch([{ status: 200, body: { tasks: [] } }]);
      const result = await callTool('searchTasks', { workspaceId: 'w1', query: 'nonexistent' });
      assert.ok(result.includes('No tasks found matching'));
      assert.ok(result.includes('nonexistent'));
    });
  });

  describe('getTaskMembers', () => {
    it('returns member list', async () => {
      mockFetch([{
        status: 200,
        body: { members: [{ id: 1, username: 'alice', email: 'a@x.com' }, { id: 2, email: 'b@x.com' }] },
      }]);
      const result = await callTool('getTaskMembers', { taskId: 't1' });
      assert.ok(result.includes('alice'));
      assert.ok(result.includes('b@x.com'));
    });

    it('returns message when no members', async () => {
      mockFetch([{ status: 200, body: { members: [] } }]);
      const result = await callTool('getTaskMembers', { taskId: 't1' });
      assert.ok(result.includes('No members'));
    });
  });

  // === Tier 4: Space/List Management ===

  describe('createList', () => {
    it('creates list in a folder', async () => {
      mockFetch([{ status: 200, body: { id: 'l1', name: 'New List' } }]);
      const result = await callTool('createList', { folderId: 'f1', name: 'New List', content: 'desc' });
      assert.ok(result.includes('New List'));
      assert.ok(result.includes('l1'));
    });

    it('creates folderless list in a space', async () => {
      mockFetch([{ status: 200, body: { id: 'l2', name: 'Folderless' } }]);
      const result = await callTool('createList', { spaceId: 's1', name: 'Folderless' });
      assert.ok(result.includes('Folderless'));
    });

    it('throws when neither folderId nor spaceId', async () => {
      await assert.rejects(
        () => callTool('createList', { name: 'Orphan' }),
        (err: any) => {
          assert.ok(err instanceof UserError);
          assert.ok(err.message.includes('folderId or spaceId'));
          return true;
        },
      );
    });
  });

  describe('createFolder', () => {
    it('creates folder and returns info', async () => {
      mockFetch([{ status: 200, body: { id: 'f2', name: 'New Folder' } }]);
      const result = await callTool('createFolder', { spaceId: 's1', name: 'New Folder' });
      assert.ok(result.includes('New Folder'));
      assert.ok(result.includes('f2'));
    });
  });

  describe('createSpace', () => {
    it('creates space and returns info', async () => {
      const { calls } = mockFetch([{ status: 200, body: { id: 's2', name: 'New Space' } }]);
      const result = await callTool('createSpace', { workspaceId: 'w1', name: 'New Space', multipleAssignees: true });
      assert.ok(result.includes('New Space'));
      assert.ok(result.includes('s2'));
      const body = JSON.parse(calls[0].body!);
      assert.equal(body.multiple_assignees, true);
    });
  });

  describe('updateList', () => {
    it('updates list with all fields', async () => {
      const { calls } = mockFetch([{ status: 200, body: { id: 'l1', name: 'Renamed' } }]);
      const result = await callTool('updateList', {
        listId: 'l1',
        name: 'Renamed',
        content: 'updated content',
        dueDate: '2025-12-01T00:00:00Z',
        priority: 2,
      });
      assert.ok(result.includes('Renamed'));
      const body = JSON.parse(calls[0].body!);
      assert.equal(body.name, 'Renamed');
      assert.equal(body.content, 'updated content');
      assert.equal(body.priority, 2);
      assert.ok(typeof body.due_date === 'number');
    });

    it('sends only provided fields', async () => {
      const { calls } = mockFetch([{ status: 200, body: { id: 'l1', name: 'Same' } }]);
      await callTool('updateList', { listId: 'l1', name: 'Same' });
      const body = JSON.parse(calls[0].body!);
      assert.equal(body.name, 'Same');
      assert.equal(body.content, undefined);
      assert.equal(body.due_date, undefined);
    });
  });

  describe('deleteList', () => {
    it('deletes list and returns confirmation', async () => {
      mockFetch([{ status: 200, text: '' }]);
      const result = await callTool('deleteList', { listId: 'l1' });
      assert.ok(result.includes('l1'));
      assert.ok(result.includes('deleted'));
    });
  });

  // === Tier 5: Documents & Time ===

  describe('listDocs', () => {
    it('returns doc list', async () => {
      mockFetch([{
        status: 200,
        body: { docs: [{ id: 'd1', name: 'Design Doc', date_created: '1700000000000' }] },
      }]);
      const result = await callTool('listDocs', { workspaceId: 'w1' });
      assert.ok(result.includes('Design Doc'));
      assert.ok(result.includes('d1'));
    });

    it('handles doc with title instead of name', async () => {
      mockFetch([{
        status: 200,
        body: { docs: [{ id: 'd2', title: 'Titled Doc' }] },
      }]);
      const result = await callTool('listDocs', { workspaceId: 'w1' });
      assert.ok(result.includes('Titled Doc'));
    });

    it('returns message when no docs', async () => {
      mockFetch([{ status: 200, body: { docs: [] } }]);
      const result = await callTool('listDocs', { workspaceId: 'w1' });
      assert.ok(result.includes('No docs found'));
    });

    it('handles doc with no name, title, or date_created', async () => {
      mockFetch([{
        status: 200,
        body: { docs: [{ id: 'd3' }] },
      }]);
      const result = await callTool('listDocs', { workspaceId: 'w1' });
      assert.ok(result.includes('Untitled'));
      assert.ok(result.includes('unknown'));
    });
  });

  describe('searchDocs', () => {
    it('returns matching docs', async () => {
      mockFetch([{
        status: 200,
        body: { docs: [{ id: 'd1', name: 'API Spec' }] },
      }]);
      const result = await callTool('searchDocs', { workspaceId: 'w1', query: 'API' });
      assert.ok(result.includes('API Spec'));
    });

    it('returns message when no match', async () => {
      mockFetch([{ status: 200, body: { docs: [] } }]);
      const result = await callTool('searchDocs', { workspaceId: 'w1', query: 'xyz' });
      assert.ok(result.includes('No docs found matching'));
      assert.ok(result.includes('xyz'));
    });
  });

  describe('startTimeEntry', () => {
    it('starts time entry and returns entry ID', async () => {
      mockFetch([{ status: 200, body: { data: { id: 'te1' } } }]);
      const result = await callTool('startTimeEntry', {
        workspaceId: 'w1',
        taskId: 't1',
        description: 'Working on bug',
        billable: true,
      });
      assert.ok(result.includes('te1'));
      assert.ok(result.includes('t1'));
    });

    it('handles response without data.id', async () => {
      mockFetch([{ status: 200, body: { data: {} } }]);
      const result = await callTool('startTimeEntry', { workspaceId: 'w1', taskId: 't1' });
      assert.ok(result.includes('started'));
    });
  });

  describe('stopTimeEntry', () => {
    it('stops time entry and returns entry ID', async () => {
      mockFetch([{ status: 200, body: { data: { id: 'te2' } } }]);
      const result = await callTool('stopTimeEntry', { workspaceId: 'w1' });
      assert.ok(result.includes('te2'));
      assert.ok(result.includes('stopped'));
    });

    it('handles response without data.id', async () => {
      mockFetch([{ status: 200, body: { data: {} } }]);
      const result = await callTool('stopTimeEntry', { workspaceId: 'w1' });
      assert.ok(result.includes('stopped'));
    });
  });

  describe('getTimeEntries', () => {
    it('returns formatted time entries', async () => {
      mockFetch([{
        status: 200,
        body: {
          data: [
            {
              id: 'te1', description: 'Bug fix work', duration: '3600000',
              task: { name: 'Fix bug' }, user: { username: 'alice' },
            },
          ],
        },
      }]);
      const result = await callTool('getTimeEntries', {
        workspaceId: 'w1',
        startDate: '2025-01-01T00:00:00Z',
        endDate: '2025-12-31T00:00:00Z',
        assignee: 'user1',
      });
      assert.ok(result.includes('Bug fix work'));
      assert.ok(result.includes('60 min'));
      assert.ok(result.includes('Fix bug'));
      assert.ok(result.includes('alice'));
    });

    it('shows running for entry without duration', async () => {
      mockFetch([{
        status: 200,
        body: {
          data: [{ id: 'te2', task_id: 't1', user: {} }],
        },
      }]);
      const result = await callTool('getTimeEntries', { workspaceId: 'w1' });
      assert.ok(result.includes('running'));
      assert.ok(result.includes('No description'));
    });

    it('returns message when no entries', async () => {
      mockFetch([{ status: 200, body: { data: [] } }]);
      const result = await callTool('getTimeEntries', { workspaceId: 'w1' });
      assert.equal(result, 'No time entries found.');
    });
  });

  // === formatTask coverage ===

  describe('formatTask (via getTask)', () => {
    it('handles task with minimal fields', async () => {
      mockFetch([{
        status: 200,
        body: { id: 't1', name: 'Minimal', status: { status: 'open' } },
      }]);
      const result = await callTool('getTask', { taskId: 't1' });
      assert.ok(result.includes('Task: Minimal'));
      assert.ok(result.includes('ID: t1'));
      assert.ok(result.includes('Status: open'));
      // Should NOT include optional fields
      assert.ok(!result.includes('Priority'));
      assert.ok(!result.includes('Assignees'));
      assert.ok(!result.includes('Due'));
      assert.ok(!result.includes('Description'));
      assert.ok(!result.includes('URL'));
      assert.ok(!result.includes('List'));
      assert.ok(!result.includes('Tags'));
    });

    it('handles task with unknown status', async () => {
      mockFetch([{
        status: 200,
        body: { id: 't1', name: 'NoStatus' },
      }]);
      const result = await callTool('getTask', { taskId: 't1' });
      assert.ok(result.includes('Status: unknown'));
    });

    it('truncates long descriptions', async () => {
      const longDesc = 'x'.repeat(300);
      mockFetch([{
        status: 200,
        body: { id: 't1', name: 'Verbose', status: { status: 'open' }, description: longDesc },
      }]);
      const result = await callTool('getTask', { taskId: 't1' });
      assert.ok(result.includes('...'));
      // Should only include first 200 chars
      assert.ok(result.includes('x'.repeat(200)));
    });

    it('does not add ellipsis for short descriptions', async () => {
      mockFetch([{
        status: 200,
        body: { id: 't1', name: 'Short', status: { status: 'open' }, description: 'Brief' },
      }]);
      const result = await callTool('getTask', { taskId: 't1' });
      assert.ok(result.includes('Description: Brief'));
      assert.ok(!result.includes('...'));
    });

    it('handles priority as string (non-object)', async () => {
      mockFetch([{
        status: 200,
        body: { id: 't1', name: 'PrioStr', status: { status: 'open' }, priority: 'high' },
      }]);
      const result = await callTool('getTask', { taskId: 't1' });
      assert.ok(result.includes('Priority: high'));
    });

    it('handles assignees with email fallback', async () => {
      mockFetch([{
        status: 200,
        body: {
          id: 't1', name: 'Assigned', status: { status: 'open' },
          assignees: [{ email: 'no-username@x.com' }],
        },
      }]);
      const result = await callTool('getTask', { taskId: 't1' });
      assert.ok(result.includes('no-username@x.com'));
    });
  });
});
