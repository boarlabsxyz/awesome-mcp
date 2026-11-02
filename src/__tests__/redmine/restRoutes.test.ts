// src/__tests__/redmine/restRoutes.test.ts
// Drives every descriptor in REDMINE_WRITE_ROUTES against a stubbed client: the
// request that reaches Redmine, the status, and the answer. The handler around
// them is covered in restRoutes.providers.test.ts.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { RedmineClient } from '../../redmine/apiHelpers.js';
import { REDMINE_WRITE_ROUTES, writeArgs } from '../../redmine/restRoutes.js';
import type { RedmineWriteRoute } from '../../redmine/restRoutes.js';
import { REST_CATALOG } from '../../restCatalog.js';

type Call = [string, ...unknown[]];

function stubClient(returns: Record<string, unknown> = {}): { client: RedmineClient; calls: Call[] } {
  const calls: Call[] = [];
  const handler: ProxyHandler<object> = {
    get(_t, prop: string) {
      return (...args: unknown[]) => {
        calls.push([prop, ...args]);
        const value = returns[prop];
        return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
      };
    },
  };
  return { client: new Proxy({}, handler) as RedmineClient, calls };
}

function routeFor(tool: string): RedmineWriteRoute {
  const route = REDMINE_WRITE_ROUTES.find((r) => r.tool === tool);
  assert.ok(route, `no route for ${tool}`);
  return route;
}

/** Validate the way the handler does, then run the descriptor. */
async function drive(tool: string, params: Record<string, string>, body: unknown, returns: Record<string, unknown> = {}) {
  const route = routeFor(tool);
  const { client, calls } = stubClient(returns);
  const parsed = route.schema.parse(writeArgs(route, { params, body }));
  return { ...(await route.run(client, parsed)), calls, parsed };
}

describe('REDMINE_WRITE_ROUTES', () => {
  test('every descriptor has one catalog entry, and the catalog names no other unrouted tool', () => {
    const catalogued = REST_CATALOG.filter((e) => e.service === 'redmine' && e.method === 'POST');
    for (const route of REDMINE_WRITE_ROUTES) {
      const path = route.path.replace(/:([A-Za-z]+)/g, '{$1}');
      assert.equal(catalogued.filter((e) => e.path === path && e.mcpToolName === route.tool).length, 1, route.path);
    }
    const legacy = ['createIssue', 'updateIssue', 'createTimeEntry', 'updateWikiPage'];
    assert.equal(catalogued.length, REDMINE_WRITE_ROUTES.length + legacy.length);
  });

  // Declined at sign-off: one call cascades into subprojects with no recycle bin.
  test('deleteProject has no REST sibling', () => {
    assert.equal(REDMINE_WRITE_ROUTES.some((r) => r.tool === 'deleteProject'), false);
    assert.equal(REST_CATALOG.some((e) => e.mcpToolName === 'deleteProject'), false);
  });

  test('path params win over same-named body keys', () => {
    const route = routeFor('createVersion');
    const args = writeArgs(route, { params: { projectId: 'from-path' }, body: { projectId: 'from-body', name: 'v1' } });
    assert.deepEqual(args, { projectId: 'from-path', name: 'v1' });
  });

  test('a non-object body contributes nothing', () => {
    const route = routeFor('deleteIssueCategory');
    assert.deepEqual(writeArgs(route, { params: { categoryId: '3' }, body: ['x'] }), { categoryId: '3' });
    assert.deepEqual(writeArgs(route, { params: { categoryId: '3' } }), { categoryId: '3' });
  });
});

describe('deletes', () => {
  const cases: Array<[string, Record<string, string>, string, unknown[], Record<string, unknown>]> = [
    ['deleteIssue', { issueId: '1' }, 'deleteIssue', ['1'], { deleted: true, issueId: '1' }],
    ['deleteIssueRelation', { relationId: '2' }, 'deleteIssueRelation', ['2'], { deleted: true, relationId: '2' }],
    ['deleteTimeEntry', { timeEntryId: '3' }, 'deleteTimeEntry', ['3'], { deleted: true, timeEntryId: '3' }],
    ['deleteVersion', { versionId: '4' }, 'deleteVersion', ['4'], { deleted: true, versionId: '4' }],
    ['deleteMembership', { membershipId: '5' }, 'deleteMembership', ['5'], { deleted: true, membershipId: '5' }],
    ['deleteWikiPage', { projectId: 'p', title: 'Home' }, 'deleteWikiPage', ['p', 'Home'], { deleted: true, projectId: 'p', title: 'Home' }],
  ];
  for (const [tool, params, method, expected, answer] of cases) {
    test(`${tool} calls the client and says what went`, async () => {
      const res = await drive(tool, params, undefined);
      assert.deepEqual(res.calls, [[method, ...expected]]);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, answer);
    });
  }

  test('deleteIssueCategory carries reassignToId and reports it', async () => {
    const moved = await drive('deleteIssueCategory', { categoryId: '6' }, { reassignToId: 7 });
    assert.deepEqual(moved.calls, [['deleteIssueCategory', '6', 7]]);
    assert.deepEqual(moved.body, { deleted: true, categoryId: '6', reassignedTo: 7 });
    const left = await drive('deleteIssueCategory', { categoryId: '6' }, undefined);
    assert.deepEqual(left.body, { deleted: true, categoryId: '6', reassignedTo: null });
  });
});

describe('watchers', () => {
  test('adding re-reads the watcher list and confirms', async () => {
    const res = await drive('addIssueWatcher', { issueId: '1' }, { userId: 7 }, { getIssue: { issue: { watchers: [{ id: 7 }] } } });
    assert.deepEqual(res.calls, [['addIssueWatcher', '1', 7], ['getIssue', '1', ['watchers']]]);
    assert.deepEqual(res.body, { issueId: '1', userId: 7, watching: true });
  });

  test('a 204 that changed nothing reads as false, not success', async () => {
    const res = await drive('addIssueWatcher', { issueId: '1' }, { userId: 7 }, { getIssue: { issue: { watchers: [{ id: 8 }] } } });
    assert.equal((res.body as any).watching, false);
  });

  test('removing takes the user from the path and reports the list afterwards', async () => {
    const res = await drive('removeIssueWatcher', { issueId: '1', userId: '7' }, undefined, { getIssue: { issue: { watchers: [] } } });
    assert.deepEqual(res.calls[0], ['removeIssueWatcher', '1', 7]);
    assert.equal((res.body as any).watching, false);
  });

  test('a garbage user id in the path fails the schema rather than reaching Redmine', () => {
    const route = routeFor('removeIssueWatcher');
    assert.equal(route.schema.safeParse(writeArgs(route, { params: { issueId: '1', userId: 'abc' } })).success, false);
  });

  test('an account that cannot read watchers gets null', async () => {
    const res = await drive('addIssueWatcher', { issueId: '1' }, { userId: 7 }, { getIssue: { issue: {} } });
    assert.equal((res.body as any).watching, null);
  });

  test('a failed re-read is unconfirmed, not a failed write', async () => {
    const res = await drive('addIssueWatcher', { issueId: '1' }, { userId: 7 }, { getIssue: new Error('boom') });
    assert.equal(res.status, 200);
    assert.equal((res.body as any).watching, null);
  });
});

describe('creates', () => {
  test('createIssueRelation maps to Redmine names and defaults the type', async () => {
    const res = await drive('createIssueRelation', { issueId: '1' }, { issueToId: 2 }, { createIssueRelation: { relation: { id: 9 } } });
    assert.deepEqual(res.calls, [['createIssueRelation', '1', { issue_to_id: 2, relation_type: 'relates' }]]);
    assert.equal(res.status, 201);
    assert.deepEqual(res.body, { relation: { id: 9 } });
  });

  test('createProject maps every field', async () => {
    const res = await drive('createProject', {}, {
      name: 'P', identifier: 'p-1', isPublic: false, parentId: 3, inheritMembers: true, trackerIds: [1], enabledModuleNames: ['wiki'],
    }, { createProject: { project: { id: 1 } } });
    assert.deepEqual(res.calls, [['createProject', {
      name: 'P', identifier: 'p-1', is_public: false, parent_id: 3, inherit_members: true, tracker_ids: [1], enabled_module_names: ['wiki'],
    }]]);
    assert.equal(res.status, 201);
  });

  test('createVersion, createIssueCategory and createMembership target the path project', async () => {
    const version = await drive('createVersion', { projectId: 'p' }, { name: 'v1', dueDate: '2026-12-01' }, { createVersion: { version: { id: 1 } } });
    assert.deepEqual(version.calls, [['createVersion', 'p', { name: 'v1', due_date: '2026-12-01' }]]);
    const category = await drive('createIssueCategory', { projectId: 'p' }, { name: 'c', assignedToId: 4 }, { createIssueCategory: { issue_category: { id: 2 } } });
    assert.deepEqual(category.calls, [['createIssueCategory', 'p', { name: 'c', assigned_to_id: 4 }]]);
    const member = await drive('createMembership', { projectId: 'p' }, { userId: 4, roleIds: [1] }, { createMembership: { membership: { id: 3 } } });
    assert.deepEqual(member.calls, [['createMembership', 'p', { user_id: 4, role_ids: [1] }]]);
    assert.deepEqual([version.status, category.status, member.status], [201, 201, 201]);
  });

  test('a create Redmine answered with no record is a 502, not a 201', async () => {
    const res = await drive('createVersion', { projectId: 'p' }, { name: 'v1' });
    assert.equal(res.status, 502);
    assert.match((res.body as any).error, /returned no version/);
  });
});

describe('updates', () => {
  test('updateProject sends the change and answers with the re-read', async () => {
    const res = await drive('updateProject', { projectId: 'p' }, { name: 'New' }, { getProject: { project: { id: 1, name: 'New' } } });
    assert.deepEqual(res.calls, [['updateProject', 'p', { name: 'New' }], ['getProject', 'p']]);
    assert.deepEqual(res.body, { project: { id: 1, name: 'New' } });
  });

  test('updateTimeEntry sends the change and answers with the re-read', async () => {
    const res = await drive('updateTimeEntry', { timeEntryId: '5' }, { hours: 2, spentOn: '2026-11-01' }, { getTimeEntry: { time_entry: { id: 5 } } });
    assert.deepEqual(res.calls, [['updateTimeEntry', '5', { hours: 2, spent_on: '2026-11-01' }], ['getTimeEntry', '5']]);
    assert.deepEqual(res.body, { time_entry: { id: 5 } });
  });

  test('updateVersion sends the change and answers with the re-read', async () => {
    const res = await drive('updateVersion', { versionId: '6' }, { status: 'closed' }, { getVersion: { version: { id: 6 } } });
    assert.deepEqual(res.calls, [['updateVersion', '6', { status: 'closed' }], ['getVersion', '6']]);
    assert.deepEqual(res.body, { version: { id: 6 } });
  });

  for (const [tool, params] of [['updateProject', { projectId: 'p' }], ['updateTimeEntry', { timeEntryId: '5' }], ['updateVersion', { versionId: '6' }]] as const) {
    test(`${tool} refuses an empty body instead of a silent 200`, async () => {
      const res = await drive(tool, params, {});
      assert.equal(res.status, 400);
      assert.deepEqual(res.calls, []);
    });
  }
});

describe('archive', () => {
  test('archiveProject and unarchiveProject say which state was asked for', async () => {
    const archived = await drive('archiveProject', { projectId: 'p' }, undefined);
    assert.deepEqual(archived.calls, [['archiveProject', 'p']]);
    assert.deepEqual(archived.body, { archived: true, projectId: 'p' });
    const restored = await drive('unarchiveProject', { projectId: 'p' }, undefined);
    assert.deepEqual(restored.calls, [['unarchiveProject', 'p']]);
    assert.deepEqual(restored.body, { archived: false, projectId: 'p' });
  });

  test('both are marked admin-only so the 403 says so', () => {
    assert.equal(routeFor('archiveProject').adminOnly, true);
    assert.equal(routeFor('unarchiveProject').adminOnly, true);
  });
});
