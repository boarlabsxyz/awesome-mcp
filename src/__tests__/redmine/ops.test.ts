// src/__tests__/redmine/ops.test.ts
// Drives every Redmine tool operation (the exported op* functions in ops.ts)
// against a stubbed client, asserting the request shape and the rendered text.
// Mirrors src/__tests__/hubspot/serverOps.test.ts.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { UserError } from 'fastmcp';

import type { RedmineClient } from '../../redmine/apiHelpers.js';
import * as ops from '../../redmine/ops.js';

const log = { info: () => {}, error: () => {} };

/** Calls recorded by the stub, as [method, ...args]. */
type Call = [string, ...unknown[]];

/**
 * A RedmineClient stand-in. Each entry in `returns` is the value that method
 * resolves to; anything not listed resolves to undefined, which is what the
 * 204-No-Content methods really return.
 */
function stubClient(returns: Record<string, unknown> = {}): { client: RedmineClient; calls: Call[] } {
  const calls: Call[] = [];
  const handler: ProxyHandler<object> = {
    get(_t, prop: string) {
      if (prop === 'baseUrl') return 'https://redmine.example.com';
      return (...args: unknown[]) => {
        calls.push([prop, ...args]);
        return Promise.resolve(returns[prop]);
      };
    },
  };
  return { client: new Proxy({}, handler) as RedmineClient, calls };
}

const page = { total_count: 1, offset: 0, limit: 25 };
const list = (items: unknown[]) => ({ items, page });

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

describe('issue ops', () => {
  test('opListIssues maps every filter onto Redmine query keys', async () => {
    const { client, calls } = stubClient({ listIssues: list([{ id: 1, subject: 'Boom' }]) });
    const out = await ops.opListIssues(client, {
      projectId: 'p', subprojectId: '!*', trackerId: 2, statusId: 'open',
      assignedToId: 'me', authorId: '7', parentId: 3, issueIds: [1, 2],
      subject: '~login', createdOn: '>=2026-01-01', updatedOn: '<=2026-02-01',
      customFields: { cf_3: 'Urgent', bogus: 'x' },
      sort: 'updated_on:desc', include: ['attachments'], offset: 0, limit: 25,
    } as any, log);

    const [, query] = calls[0] as [string, Record<string, unknown>];
    assert.equal(query.project_id, 'p');
    assert.equal(query.subproject_id, '!*');
    assert.equal(query.assigned_to_id, 'me');
    assert.deepEqual(query.issue_id, [1, 2]);
    assert.equal(query.created_on, '>=2026-01-01');
    assert.equal(query.cf_3, 'Urgent');
    // Unknown filter keys are dropped rather than forwarded: Redmine ignores
    // them, which would silently widen the result set.
    assert.equal(query.bogus, undefined);
    assert.match(out, /#1 Boom/);
  });

  test('opGetIssue renders the issue and forwards include', async () => {
    const { client, calls } = stubClient({ getIssue: { issue: { id: 5, subject: 'Crash' } } });
    const out = await ops.opGetIssue(client, { issueId: 5, include: ['journals'] } as any, log);
    assert.deepEqual(calls[0], ['getIssue', 5, ['journals']]);
    assert.match(out, /# Issue #5: Crash/);
  });

  test('opGetIssue raises a UserError when Redmine returns nothing', async () => {
    const { client } = stubClient({ getIssue: {} });
    await assert.rejects(() => ops.opGetIssue(client, { issueId: 9 } as any, log), UserError);
  });

  test('opCreateIssue posts project_id plus the mapped body', async () => {
    const { client, calls } = stubClient({ createIssue: { issue: { id: 42, subject: 'New' } } });
    const out = await ops.opCreateIssue(client, {
      projectId: 'p', subject: 'New', description: 'd', trackerId: 1,
      assignedToId: 4, dueDate: '2026-03-01', doneRatio: 10,
    } as any, log);
    const [, body] = calls[0] as [string, Record<string, unknown>];
    assert.equal(body.project_id, 'p');
    assert.equal(body.subject, 'New');
    assert.equal(body.assigned_to_id, 4);
    assert.equal(body.due_date, '2026-03-01');
    assert.equal(body.done_ratio, 10);
    // Fields the caller omitted must not appear at all — a null would clear them.
    assert.ok(!('status_id' in body));
    assert.match(out, /Created issue #42/);
  });

  test('opUpdateIssue re-reads the record after the 204', async () => {
    const { client, calls } = stubClient({ getIssue: { issue: { id: 5, subject: 'After' } } });
    const out = await ops.opUpdateIssue(client, { issueId: 5, notes: 'a comment' } as any, log);
    assert.equal(calls[0][0], 'updateIssue');
    assert.equal(calls[1][0], 'getIssue');
    assert.match(out, /# Issue #5: After/);
  });

  test('opUpdateIssue refuses an empty change set instead of calling Redmine', async () => {
    const { client, calls } = stubClient();
    await assert.rejects(() => ops.opUpdateIssue(client, { issueId: 5 } as any, log), /Nothing to update/);
    assert.equal(calls.length, 0);
  });

  test('opDeleteIssue says the delete was permanent', async () => {
    const { client, calls } = stubClient();
    const out = await ops.opDeleteIssue(client, { issueId: 5 } as any, log);
    assert.deepEqual(calls[0], ['deleteIssue', 5]);
    assert.match(out, /permanently/);
  });

  test('watcher ops call through with the user id', async () => {
    const add = stubClient();
    assert.match(await ops.opAddIssueWatcher(add.client, { issueId: 1, userId: 2 } as any, log), /watcher/);
    assert.deepEqual(add.calls[0], ['addIssueWatcher', 1, 2]);

    const remove = stubClient();
    assert.match(await ops.opRemoveIssueWatcher(remove.client, { issueId: 1, userId: 2 } as any, log), /Removed user #2/);
    assert.deepEqual(remove.calls[0], ['removeIssueWatcher', 1, 2]);
  });
});

describe('relation ops', () => {
  test('opListIssueRelations renders the relation list', async () => {
    const { client } = stubClient({ listIssueRelations: list([{ id: 3, issue_id: 1, issue_to_id: 2, relation_type: 'blocks' }]) });
    const out = await ops.opListIssueRelations(client, { issueId: 1 } as any, log);
    assert.match(out, /Relation #3/);
    assert.match(out, /From: #1/);
    assert.match(out, /Type: blocks/);
    assert.match(out, /To: #2/);
  });

  test('opCreateIssueRelation posts the relation body', async () => {
    const { client, calls } = stubClient({ createIssueRelation: { relation: { id: 8 } } });
    const out = await ops.opCreateIssueRelation(client, { issueId: 1, issueToId: 2, relationType: 'precedes', delay: 3 } as any, log);
    assert.deepEqual(calls[0], ['createIssueRelation', 1, { issue_to_id: 2, relation_type: 'precedes', delay: 3 }]);
    assert.match(out, /Created relation #8/);
  });

  test('opDeleteIssueRelation takes the relation id', async () => {
    const { client, calls } = stubClient();
    assert.match(await ops.opDeleteIssueRelation(client, { relationId: 8 } as any, log), /Deleted relation #8/);
    assert.deepEqual(calls[0], ['deleteIssueRelation', 8]);
  });
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

describe('project ops', () => {
  test('opListProjects and opGetProject render', async () => {
    const l = stubClient({ listProjects: list([{ id: 1, name: 'Platform', identifier: 'plat' }]) });
    assert.match(await ops.opListProjects(l.client, { offset: 0, limit: 25 } as any, log), /Platform/);

    const g = stubClient({ getProject: { project: { id: 1, name: 'Platform', status: 1, is_public: true } } });
    const out = await ops.opGetProject(g.client, { projectId: 'plat' } as any, log);
    assert.match(out, /# Project: Platform/);
    assert.match(out, /Visibility: public/);
    assert.match(out, /Status: active/);
  });

  test('opGetProject raises a UserError on a missing project', async () => {
    const { client } = stubClient({ getProject: {} });
    await assert.rejects(() => ops.opGetProject(client, { projectId: 'nope' } as any, log), UserError);
  });

  test('opCreateProject maps camelCase onto Redmine keys', async () => {
    const { client, calls } = stubClient({ createProject: { project: { id: 2, name: 'New' } } });
    await ops.opCreateProject(client, {
      name: 'New', identifier: 'new', isPublic: false, parentId: 1,
      trackerIds: [1, 2], enabledModuleNames: ['wiki'],
    } as any, log);
    const [, body] = calls[0] as [string, Record<string, unknown>];
    assert.equal(body.is_public, false);
    assert.deepEqual(body.tracker_ids, [1, 2]);
    assert.deepEqual(body.enabled_module_names, ['wiki']);
  });

  test('opUpdateProject refuses an empty change set', async () => {
    const { client, calls } = stubClient();
    await assert.rejects(() => ops.opUpdateProject(client, { projectId: 'p' } as any, log), /Nothing to update/);
    assert.equal(calls.length, 0);
  });

  test('archive / unarchive / delete each report what happened', async () => {
    const a = stubClient();
    assert.match(await ops.opArchiveProject(a.client, { projectId: 'p' } as any, log), /unarchiveProject to restore/);
    const u = stubClient();
    assert.match(await ops.opUnarchiveProject(u.client, { projectId: 'p' } as any, log), /Unarchived/);
    const d = stubClient();
    // The cascade is the part a caller must not be surprised by.
    assert.match(await ops.opDeleteProject(d.client, { projectId: 'p' } as any, log), /all of its contents permanently/);
  });
});

// ---------------------------------------------------------------------------
// Users, time entries
// ---------------------------------------------------------------------------

describe('user ops', () => {
  test('opListUsers forwards the status/name/group filters', async () => {
    const { client, calls } = stubClient({ listUsers: list([{ id: 1, login: 'jsmith', status: 1 }]) });
    const out = await ops.opListUsers(client, { status: '3', name: 'smith', groupId: 4, offset: 0, limit: 25 } as any, log);
    const [, query] = calls[0] as [string, Record<string, unknown>];
    assert.equal(query.status, '3');
    assert.equal(query.name, 'smith');
    assert.equal(query.group_id, 4);
    assert.match(out, /jsmith/);
  });

  test('opGetUser and opGetCurrentUser render, and 404-shaped payloads raise', async () => {
    const g = stubClient({ getUser: { user: { id: 1, firstname: 'J', lastname: 'Smith', status: 3 } } });
    assert.match(await ops.opGetUser(g.client, { userId: 1 } as any, log), /Status: locked/);

    const c = stubClient({ getCurrentUser: { user: { id: 2, login: 'me', admin: true } } });
    assert.match(await ops.opGetCurrentUser(c.client, {} as any, log), /Admin: yes/);

    const missing = stubClient({ getUser: {} });
    await assert.rejects(() => ops.opGetUser(missing.client, { userId: 9 } as any, log), UserError);
    const noCurrent = stubClient({ getCurrentUser: {} });
    await assert.rejects(() => ops.opGetCurrentUser(noCurrent.client, {} as any, log), UserError);
  });
});

describe('time entry ops', () => {
  test('opListTimeEntries forwards the date range and totals the page', async () => {
    const { client, calls } = stubClient({
      listTimeEntries: { items: [{ id: 1, hours: 1.5 }, { id: 2, hours: 2 }], page: { total_count: 40, offset: 0, limit: 2 } },
    });
    const out = await ops.opListTimeEntries(client, { projectId: 'p', userId: 'me', from: '2026-01-01', to: '2026-01-31', offset: 0, limit: 2 } as any, log);
    const [, query] = calls[0] as [string, Record<string, unknown>];
    assert.equal(query.from, '2026-01-01');
    assert.equal(query.user_id, 'me');
    // Page-scoped, and labelled as such — the page line carries the real total.
    assert.match(out, /Hours on this page: 3.5/);
    assert.match(out, /Showing 1-2 of 40/);
  });

  test('opCreateTimeEntry posts either issue_id or project_id', async () => {
    const { client, calls } = stubClient({ createTimeEntry: { time_entry: { id: 7, hours: 3 } } });
    const out = await ops.opCreateTimeEntry(client, { issueId: 5, hours: 3, activityId: 9, comments: 'work' } as any, log);
    const [, body] = calls[0] as [string, Record<string, unknown>];
    assert.equal(body.issue_id, 5);
    assert.equal(body.activity_id, 9);
    assert.ok(!('project_id' in body));
    assert.match(out, /Logged 3h \(time entry #7\)/);
  });

  test('opGetTimeEntry raises when absent; opUpdateTimeEntry re-reads', async () => {
    const missing = stubClient({ getTimeEntry: {} });
    await assert.rejects(() => ops.opGetTimeEntry(missing.client, { timeEntryId: 1 } as any, log), UserError);

    const upd = stubClient({ getTimeEntry: { time_entry: { id: 1, hours: 4 } } });
    const out = await ops.opUpdateTimeEntry(upd.client, { timeEntryId: 1, hours: 4 } as any, log);
    assert.equal(upd.calls[0][0], 'updateTimeEntry');
    assert.match(out, /# Time entry #1/);

    const empty = stubClient();
    await assert.rejects(() => ops.opUpdateTimeEntry(empty.client, { timeEntryId: 1 } as any, log), /Nothing to update/);
  });

  test('opDeleteTimeEntry reports permanence', async () => {
    const { client, calls } = stubClient();
    assert.match(await ops.opDeleteTimeEntry(client, { timeEntryId: 1 } as any, log), /permanently/);
    assert.deepEqual(calls[0], ['deleteTimeEntry', 1]);
  });
});

// ---------------------------------------------------------------------------
// Wiki, versions, categories, memberships
// ---------------------------------------------------------------------------

describe('wiki ops', () => {
  test('opListWikiPages and opGetWikiPage render', async () => {
    const l = stubClient({ listWikiPages: list([{ title: 'Home', version: 3 }]) });
    assert.match(await ops.opListWikiPages(l.client, { projectId: 'p' } as any, log), /Home/);

    const g = stubClient({ getWikiPage: { wiki_page: { title: 'Home', text: 'body', version: 3 } } });
    const out = await ops.opGetWikiPage(g.client, { projectId: 'p', title: 'Home', version: 3 } as any, log);
    assert.deepEqual(g.calls[0], ['getWikiPage', 'p', 'Home', 3]);
    assert.match(out, /## Content/);
  });

  test('opGetWikiPage raises on a missing page', async () => {
    const { client } = stubClient({ getWikiPage: {} });
    await assert.rejects(() => ops.opGetWikiPage(client, { projectId: 'p', title: 'Nope' } as any, log), UserError);
  });

  test('opUpdateWikiPage forwards the optimistic-locking version', async () => {
    const { client, calls } = stubClient();
    const out = await ops.opUpdateWikiPage(client, { projectId: 'p', title: 'Home', text: 'new', comments: 'c', parentTitle: 'Root', version: 3 } as any, log);
    assert.deepEqual(calls[0], ['updateWikiPage', 'p', 'Home', { text: 'new', comments: 'c', parent_title: 'Root', version: 3 }]);
    assert.match(out, /Saved wiki page "Home"/);
  });

  test('opDeleteWikiPage mentions the revisions it destroys', async () => {
    const { client } = stubClient();
    assert.match(await ops.opDeleteWikiPage(client, { projectId: 'p', title: 'Home' } as any, log), /all its revisions/);
  });
});

describe('version ops', () => {
  test('list / get / create / update / delete', async () => {
    const l = stubClient({ listVersions: list([{ id: 1, name: '2.1' }]) });
    assert.match(await ops.opListVersions(l.client, { projectId: 'p' } as any, log), /2\.1/);

    const g = stubClient({ getVersion: { version: { id: 1, name: '2.1', status: 'open' } } });
    assert.match(await ops.opGetVersion(g.client, { versionId: 1 } as any, log), /# Version: 2\.1/);

    const missing = stubClient({ getVersion: {} });
    await assert.rejects(() => ops.opGetVersion(missing.client, { versionId: 9 } as any, log), UserError);

    const c = stubClient({ createVersion: { version: { id: 2, name: '2.2' } } });
    await ops.opCreateVersion(c.client, { projectId: 'p', name: '2.2', dueDate: '2026-06-01', sharing: 'tree' } as any, log);
    const [, , body] = c.calls[0] as [string, string, Record<string, unknown>];
    assert.equal(body.due_date, '2026-06-01');
    assert.equal(body.sharing, 'tree');

    const u = stubClient({ getVersion: { version: { id: 1, name: '2.1.1' } } });
    assert.match(await ops.opUpdateVersion(u.client, { versionId: 1, name: '2.1.1' } as any, log), /2\.1\.1/);
    const empty = stubClient();
    await assert.rejects(() => ops.opUpdateVersion(empty.client, { versionId: 1 } as any, log), /Nothing to update/);

    const d = stubClient();
    // Issues are not deleted with the version — saying so prevents a wrong assumption.
    assert.match(await ops.opDeleteVersion(d.client, { versionId: 1 } as any, log), /no target version/);
  });
});

describe('category and membership ops', () => {
  test('category list / create / delete', async () => {
    const l = stubClient({ listIssueCategories: list([{ id: 1, name: 'UI' }]) });
    assert.match(await ops.opListIssueCategories(l.client, { projectId: 'p' } as any, log), /UI/);

    const c = stubClient({ createIssueCategory: { issue_category: { id: 3 } } });
    assert.match(await ops.opCreateIssueCategory(c.client, { projectId: 'p', name: 'UI', assignedToId: 2 } as any, log), /ID: 3/);

    const withReassign = stubClient();
    assert.match(
      await ops.opDeleteIssueCategory(withReassign.client, { categoryId: 1, reassignToId: 2 } as any, log),
      /reassigned to category #2/,
    );
    const without = stubClient();
    assert.match(await ops.opDeleteIssueCategory(without.client, { categoryId: 1 } as any, log), /left with no category/);
  });

  test('membership list / create / delete', async () => {
    const l = stubClient({ listMemberships: list([{ id: 1, user: { id: 2, name: 'J' }, roles: [{ id: 3, name: 'Dev' }] }]) });
    assert.match(await ops.opListMemberships(l.client, { projectId: 'p', offset: 0, limit: 25 } as any, log), /Dev/);

    const c = stubClient({ createMembership: { membership: { id: 9 } } });
    const out = await ops.opCreateMembership(c.client, { projectId: 'p', userId: 2, roleIds: [3] } as any, log);
    assert.deepEqual(c.calls[0], ['createMembership', 'p', { user_id: 2, role_ids: [3] }]);
    assert.match(out, /membership #9/);

    const d = stubClient();
    assert.match(await ops.opDeleteMembership(d.client, { membershipId: 9 } as any, log), /Removed membership #9/);
  });
});

// ---------------------------------------------------------------------------
// Lookups and search
// ---------------------------------------------------------------------------

describe('lookup and search ops', () => {
  test('each lookup renders id + name', async () => {
    const t = stubClient({ listTrackers: list([{ id: 1, name: 'Bug' }]) });
    assert.match(await ops.opListTrackers(t.client, log), /Bug — ID: 1/);

    const s = stubClient({ listIssueStatuses: list([{ id: 5, name: 'Closed', is_closed: true }]) });
    assert.match(await ops.opListIssueStatuses(s.client, log), /\[closed status\]/);

    const p = stubClient({ listIssuePriorities: list([{ id: 2, name: 'Normal', is_default: true }]) });
    assert.match(await ops.opListIssuePriorities(p.client, log), /\[default\]/);

    const a = stubClient({ listTimeEntryActivities: list([{ id: 8, name: 'Development' }]) });
    assert.match(await ops.opListTimeEntryActivities(a.client, log), /Development — ID: 8/);
  });

  test('opListCustomFields surfaces the cf_ filter key', async () => {
    const { client } = stubClient({
      listCustomFields: list([
        { id: 3, name: 'Severity', is_filter: true, field_format: 'list', possible_values: [{ value: 'High' }] },
        { id: 4, name: 'Notes', is_filter: false },
      ]),
    });
    const out = await ops.opListCustomFields(client, log);
    assert.match(out, /Filter key: cf_3/);
    assert.match(out, /Possible values: High/);
    assert.match(out, /\(not filterable\)/);
  });

  test('opSearchRedmine sends boolean flags only when true', async () => {
    const { client, calls } = stubClient({ search: list([{ id: 1, title: 'hit', type: 'issue' }]) });
    const out = await ops.opSearchRedmine(client, {
      query: 'login', projectId: 'p', scope: 'subprojects',
      titlesOnly: true, issues: true, news: false, documents: false,
      wikiPages: true, openIssues: false, offset: 0, limit: 25,
    } as any, log);
    const [, query] = calls[0] as [string, Record<string, unknown>];
    assert.equal(query.q, 'login');
    assert.equal(query.titles_only, 1);
    assert.equal(query.issues, 1);
    assert.equal(query.wiki_pages, 1);
    // Redmine reads these as presence flags: sending 0 would still enable them,
    // so a false must be omitted entirely rather than sent as 0.
    assert.equal(query.news, undefined);
    assert.equal(query.documents, undefined);
    assert.equal(query.open_issues, undefined);
    assert.match(out, /hit/);
  });
});
