// src/redmine/server.ts
// Redmine MCP server. Covers the REST API surface Redmine documents as Stable
// (issues, projects, users, time entries) plus the Alpha resources that matter
// in day-to-day use (wiki, versions, categories, memberships, relations,
// enumerations, search).
//
// Conventions worth knowing before adding a tool here:
//
//   - Project references take an ID *or* an identifier ("42" or "my-project"),
//     because Redmine accepts both everywhere and the identifier is what
//     appears in URLs, so it is what a user will paste.
//   - Lists are paginated with offset/limit, limit caps at 100, and the
//     formatter always prints the returned window. Do not add a tool that
//     silently returns a first page.
//   - Only filters Redmine actually honors are exposed. An unknown filter is
//     ignored upstream, which turns a typo into a plausible-looking wrong
//     answer rather than an error.
//
// Tool naming and parameter coverage follow two MIT-licensed references:
//   https://github.com/yonaka15/mcp-server-redmine @ 0fae1304 (primary)
//   https://github.com/onozaty/redmine-mcp-server (broader surface)
// Both are single-tenant (global env config); every body here is rewritten
// against UserSession, so these are adaptations rather than ports.

import { FastMCP } from 'fastmcp';

import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import { withRedmineClient } from './apiHelpers.js';
import {
  listIssuesSchema,
  getIssueSchema,
  deleteIssueSchema,
  addIssueWatcherSchema,
  removeIssueWatcherSchema,
  listIssueRelationsSchema,
  createIssueRelationSchema,
  deleteIssueRelationSchema,
  listProjectsSchema,
  getProjectSchema,
  createProjectSchema,
  updateProjectSchema,
  archiveProjectSchema,
  unarchiveProjectSchema,
  deleteProjectSchema,
  listUsersSchema,
  getUserSchema,
  getCurrentUserSchema,
  listTimeEntriesSchema,
  getTimeEntrySchema,
  updateTimeEntrySchema,
  deleteTimeEntrySchema,
  listWikiPagesSchema,
  getWikiPageSchema,
  updateWikiPageSchema,
  deleteWikiPageSchema,
  listVersionsSchema,
  getVersionSchema,
  createVersionSchema,
  updateVersionSchema,
  deleteVersionSchema,
  listIssueCategoriesSchema,
  createIssueCategorySchema,
  deleteIssueCategorySchema,
  listMembershipsSchema,
  createMembershipSchema,
  deleteMembershipSchema,
  listTrackersSchema,
  listIssueStatusesSchema,
  listIssuePrioritiesSchema,
  listTimeEntryActivitiesSchema,
  listCustomFieldsSchema,
  searchRedmineSchema,
  createIssueSchema,
  updateIssueSchema,
  createTimeEntrySchema,
} from './schemas.js';
import {
  opListIssues,
  opGetIssue,
  opCreateIssue,
  opUpdateIssue,
  opDeleteIssue,
  opAddIssueWatcher,
  opRemoveIssueWatcher,
  opListIssueRelations,
  opCreateIssueRelation,
  opDeleteIssueRelation,
  opListProjects,
  opGetProject,
  opCreateProject,
  opUpdateProject,
  opArchiveProject,
  opUnarchiveProject,
  opDeleteProject,
  opListUsers,
  opGetUser,
  opGetCurrentUser,
  opListTimeEntries,
  opGetTimeEntry,
  opCreateTimeEntry,
  opUpdateTimeEntry,
  opDeleteTimeEntry,
  opListWikiPages,
  opGetWikiPage,
  opUpdateWikiPage,
  opDeleteWikiPage,
  opListVersions,
  opGetVersion,
  opCreateVersion,
  opUpdateVersion,
  opDeleteVersion,
  opListIssueCategories,
  opCreateIssueCategory,
  opDeleteIssueCategory,
  opListMemberships,
  opCreateMembership,
  opDeleteMembership,
  opListTrackers,
  opListIssueStatuses,
  opListIssuePriorities,
  opListTimeEntryActivities,
  opListCustomFields,
  opSearchRedmine,
} from './ops.js';

// Re-exported so the schemas stay importable from the server module, which is
// where a REST sibling and the existing tests look for them.
export { createIssueSchema, updateIssueSchema, createTimeEntrySchema };

export const redmineServer = new FastMCP<UserSession>({
  name: 'Redmine MCP',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'redmine'),
});

// ==================== Issues ====================

redmineServer.addTool({
  name: 'listIssues',
  annotations: { readOnlyHint: true },
  description: 'Search and filter Redmine issues. Returns one page and always reports the total, so check whether more pages remain before summarizing.',
  parameters: listIssuesSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to list issues', session, log, client => opListIssues(client, args, log), { permission: 'view_issues' }),
});

redmineServer.addTool({
  name: 'getIssue',
  annotations: { readOnlyHint: true },
  description: 'Retrieve one Redmine issue in full. Use `include` to pull in the comment history, subtasks, watchers, or the statuses it may move to.',
  parameters: getIssueSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to fetch issue', session, log, client => opGetIssue(client, args, log), { permission: 'view_issues' }),
});

redmineServer.addTool({
  name: 'createIssue',
  annotations: { readOnlyHint: false },
  description: 'Create a Redmine issue in a project. Only projectId and subject are required; every other field falls back to the project/tracker default.',
  parameters: createIssueSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to create issue', session, log, client => opCreateIssue(client, args, log)),
});

redmineServer.addTool({
  name: 'updateIssue',
  annotations: { readOnlyHint: false },
  description: 'Update a Redmine issue and/or add a comment. Pass `notes` to append a comment; `description` REPLACES the body instead. Fields you omit are left untouched.',
  parameters: updateIssueSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to update issue', session, log, client => opUpdateIssue(client, args, log)),
});

redmineServer.addTool({
  name: 'deleteIssue',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Permanently delete a Redmine issue, along with its comments, time entries and subtasks. Redmine has no recycle bin — this cannot be undone.',
  parameters: deleteIssueSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to delete issue', session, log, client => opDeleteIssue(client, args, log)),
});

redmineServer.addTool({
  name: 'addIssueWatcher',
  annotations: { readOnlyHint: false },
  description: 'Add a user as a watcher on a Redmine issue so they receive its notifications.',
  parameters: addIssueWatcherSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to add watcher', session, log, client => opAddIssueWatcher(client, args, log)),
});

redmineServer.addTool({
  name: 'removeIssueWatcher',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Remove a watcher from a Redmine issue.',
  parameters: removeIssueWatcherSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to remove watcher', session, log, client => opRemoveIssueWatcher(client, args, log)),
});

// ==================== Issue relations ====================

redmineServer.addTool({
  name: 'listIssueRelations',
  annotations: { readOnlyHint: true },
  description: 'List the relations (blocks, precedes, duplicates, …) attached to a Redmine issue.',
  parameters: listIssueRelationsSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to list issue relations', session, log, client => opListIssueRelations(client, args, log), { permission: 'view_issues' }),
});

redmineServer.addTool({
  name: 'createIssueRelation',
  annotations: { readOnlyHint: false },
  description: 'Link two Redmine issues with a relation such as blocks, precedes or duplicates.',
  parameters: createIssueRelationSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to create issue relation', session, log, client => opCreateIssueRelation(client, args, log)),
});

redmineServer.addTool({
  name: 'deleteIssueRelation',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Delete a Redmine issue relation by its relation ID (from listIssueRelations — NOT an issue ID).',
  parameters: deleteIssueRelationSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to delete issue relation', session, log, client => opDeleteIssueRelation(client, args, log)),
});

// ==================== Projects ====================

redmineServer.addTool({
  name: 'listProjects',
  annotations: { readOnlyHint: true },
  description: 'List the Redmine projects visible to the connected account, newest page first. Returns one page and reports the total.',
  parameters: listProjectsSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to list projects', session, log, client => opListProjects(client, args, log)),
});

redmineServer.addTool({
  name: 'getProject',
  annotations: { readOnlyHint: true },
  description: 'Retrieve one Redmine project, optionally with its trackers, categories and enabled modules.',
  parameters: getProjectSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to fetch project', session, log, client => opGetProject(client, args, log)),
});

redmineServer.addTool({
  name: 'createProject',
  annotations: { readOnlyHint: false },
  description: 'Create a Redmine project. Requires administrator rights on most instances.',
  parameters: createProjectSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to create project', session, log, client => opCreateProject(client, args, log)),
});

redmineServer.addTool({
  name: 'updateProject',
  annotations: { readOnlyHint: false },
  description: 'Update a Redmine project. Fields you omit are left untouched.',
  parameters: updateProjectSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to update project', session, log, client => opUpdateProject(client, args, log)),
});

redmineServer.addTool({
  name: 'archiveProject',
  annotations: { readOnlyHint: false },
  description: 'Archive a Redmine project. It becomes read-only and hidden from project lists, but nothing is deleted — unarchiveProject reverses it.',
  parameters: archiveProjectSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to archive project', session, log, client => opArchiveProject(client, args, log)),
});

redmineServer.addTool({
  name: 'unarchiveProject',
  annotations: { readOnlyHint: false },
  description: 'Restore a previously archived Redmine project to active status.',
  parameters: unarchiveProjectSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to unarchive project', session, log, client => opUnarchiveProject(client, args, log)),
});

redmineServer.addTool({
  name: 'deleteProject',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Permanently delete a Redmine project AND every issue, wiki page, version and time entry inside it, including subprojects. There is no recycle bin. Prefer archiveProject unless the data is genuinely meant to be destroyed.',
  parameters: deleteProjectSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to delete project', session, log, client => opDeleteProject(client, args, log)),
});

// ==================== Users ====================

redmineServer.addTool({
  name: 'listUsers',
  annotations: { readOnlyHint: true },
  description: 'List Redmine users. Requires administrator rights — a non-admin account gets a permission error, which is a Redmine restriction, not a connection problem.',
  parameters: listUsersSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to list users', session, log, client => opListUsers(client, args, log), { adminOnly: true }),
});

redmineServer.addTool({
  name: 'getUser',
  annotations: { readOnlyHint: true },
  description: 'Retrieve one Redmine user by ID, optionally with their group and project memberships.',
  parameters: getUserSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to fetch user', session, log, client => opGetUser(client, args, log)),
});

redmineServer.addTool({
  name: 'getCurrentUser',
  annotations: { readOnlyHint: true },
  description: 'Retrieve the Redmine account this connection authenticates as. Use it to resolve "me" to a user ID, or to verify the connection works.',
  parameters: getCurrentUserSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to fetch current user', session, log, client => opGetCurrentUser(client, args, log)),
});

// ==================== Time entries ====================

redmineServer.addTool({
  name: 'listTimeEntries',
  annotations: { readOnlyHint: true },
  description: 'List Redmine time entries, filterable by project, issue, user and date range. The hours total shown covers the returned page only — check the reported total before treating it as a full sum.',
  parameters: listTimeEntriesSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to list time entries', session, log, client => opListTimeEntries(client, args, log), { permission: 'view_time_entries' }),
});

redmineServer.addTool({
  name: 'getTimeEntry',
  annotations: { readOnlyHint: true },
  description: 'Retrieve one Redmine time entry by ID.',
  parameters: getTimeEntrySchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to fetch time entry', session, log, client => opGetTimeEntry(client, args, log), { permission: 'view_time_entries' }),
});

redmineServer.addTool({
  name: 'createTimeEntry',
  annotations: { readOnlyHint: false },
  description: 'Log time against a Redmine issue or project. Pass exactly one of issueId or projectId. Most instances require activityId — call listTimeEntryActivities if you do not have it.',
  parameters: createTimeEntrySchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to create time entry', session, log, client => opCreateTimeEntry(client, args, log), { permission: 'log_time' }),
});

redmineServer.addTool({
  name: 'updateTimeEntry',
  annotations: { readOnlyHint: false },
  description: 'Update an existing Redmine time entry. Fields you omit are left untouched.',
  parameters: updateTimeEntrySchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to update time entry', session, log, client => opUpdateTimeEntry(client, args, log)),
});

redmineServer.addTool({
  name: 'deleteTimeEntry',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Permanently delete a Redmine time entry. This cannot be undone.',
  parameters: deleteTimeEntrySchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to delete time entry', session, log, client => opDeleteTimeEntry(client, args, log)),
});

// ==================== Wiki ====================

redmineServer.addTool({
  name: 'listWikiPages',
  annotations: { readOnlyHint: true },
  description: "List the titles in a Redmine project's wiki. Page bodies are not included — call getWikiPage for one.",
  parameters: listWikiPagesSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to list wiki pages', session, log, client => opListWikiPages(client, args, log), { permission: 'view_wiki_pages' }),
});

redmineServer.addTool({
  name: 'getWikiPage',
  annotations: { readOnlyHint: true },
  description: 'Retrieve one Redmine wiki page with its full text. Pass `version` to read a historical revision.',
  parameters: getWikiPageSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to fetch wiki page', session, log, client => opGetWikiPage(client, args, log), { permission: 'view_wiki_pages' }),
});

redmineServer.addTool({
  name: 'updateWikiPage',
  annotations: { readOnlyHint: false },
  description: 'Create or replace a Redmine wiki page. Redmine uses one endpoint for both — a title that does not exist yet is created. `text` REPLACES the whole page body, so read it first if you mean to edit rather than overwrite.',
  parameters: updateWikiPageSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to update wiki page', session, log, client => opUpdateWikiPage(client, args, log)),
});

redmineServer.addTool({
  name: 'deleteWikiPage',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Permanently delete a Redmine wiki page and every revision of it. Child pages are attached to its parent rather than deleted.',
  parameters: deleteWikiPageSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to delete wiki page', session, log, client => opDeleteWikiPage(client, args, log)),
});

// ==================== Versions ====================

redmineServer.addTool({
  name: 'listVersions',
  annotations: { readOnlyHint: true },
  description: 'List the versions (milestones / target releases) of a Redmine project, including versions shared from other projects.',
  parameters: listVersionsSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to list versions', session, log, client => opListVersions(client, args, log)),
});

redmineServer.addTool({
  name: 'getVersion',
  annotations: { readOnlyHint: true },
  description: 'Retrieve one Redmine version by ID.',
  parameters: getVersionSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to fetch version', session, log, client => opGetVersion(client, args, log)),
});

redmineServer.addTool({
  name: 'createVersion',
  annotations: { readOnlyHint: false },
  description: 'Create a version (milestone / target release) in a Redmine project.',
  parameters: createVersionSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to create version', session, log, client => opCreateVersion(client, args, log)),
});

redmineServer.addTool({
  name: 'updateVersion',
  annotations: { readOnlyHint: false },
  description: 'Update a Redmine version. Fields you omit are left untouched.',
  parameters: updateVersionSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to update version', session, log, client => opUpdateVersion(client, args, log)),
});

redmineServer.addTool({
  name: 'deleteVersion',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Permanently delete a Redmine version. Issues targeting it are not deleted — their target version is cleared.',
  parameters: deleteVersionSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to delete version', session, log, client => opDeleteVersion(client, args, log)),
});

// ==================== Issue categories ====================

redmineServer.addTool({
  name: 'listIssueCategories',
  annotations: { readOnlyHint: true },
  description: 'List the issue categories defined on a Redmine project. Their IDs are what createIssue/updateIssue take as categoryId.',
  parameters: listIssueCategoriesSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to list issue categories', session, log, client => opListIssueCategories(client, args, log)),
});

redmineServer.addTool({
  name: 'createIssueCategory',
  annotations: { readOnlyHint: false },
  description: 'Create an issue category in a Redmine project.',
  parameters: createIssueCategorySchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to create issue category', session, log, client => opCreateIssueCategory(client, args, log)),
});

redmineServer.addTool({
  name: 'deleteIssueCategory',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Delete a Redmine issue category. Issues in it are not deleted — pass reassignToId to move them to another category, otherwise their category is cleared.',
  parameters: deleteIssueCategorySchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to delete issue category', session, log, client => opDeleteIssueCategory(client, args, log)),
});

// ==================== Memberships ====================

redmineServer.addTool({
  name: 'listMemberships',
  annotations: { readOnlyHint: true },
  description: 'List the members of a Redmine project with their roles. This is the reliable way to find user IDs for assignment without administrator rights, since listUsers is admin-only.',
  parameters: listMembershipsSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to list project members', session, log, client => opListMemberships(client, args, log)),
});

redmineServer.addTool({
  name: 'createMembership',
  annotations: { readOnlyHint: false },
  description: 'Add a user or group to a Redmine project with one or more roles.',
  parameters: createMembershipSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to add project member', session, log, client => opCreateMembership(client, args, log)),
});

redmineServer.addTool({
  name: 'deleteMembership',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Remove a member from a Redmine project by membership ID (from listMemberships — NOT a user ID).',
  parameters: deleteMembershipSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to remove project member', session, log, client => opDeleteMembership(client, args, log)),
});

// ==================== Lookups ====================

redmineServer.addTool({
  name: 'listTrackers',
  annotations: { readOnlyHint: true },
  description: 'List the Redmine trackers (Bug, Feature, Support, …). Their IDs are what createIssue takes as trackerId.',
  parameters: listTrackersSchema,
  execute: (_args, { log, session }) =>
    withRedmineClient('Failed to list trackers', session, log, client => opListTrackers(client, log)),
});

redmineServer.addTool({
  name: 'listIssueStatuses',
  annotations: { readOnlyHint: true },
  description: 'List every Redmine issue status, flagging which ones count as closed. Their IDs are what updateIssue takes as statusId.',
  parameters: listIssueStatusesSchema,
  execute: (_args, { log, session }) =>
    withRedmineClient('Failed to list issue statuses', session, log, client => opListIssueStatuses(client, log)),
});

redmineServer.addTool({
  name: 'listIssuePriorities',
  annotations: { readOnlyHint: true },
  description: 'List the Redmine issue priorities (Low, Normal, High, …), flagging the default. Their IDs are what createIssue takes as priorityId.',
  parameters: listIssuePrioritiesSchema,
  execute: (_args, { log, session }) =>
    withRedmineClient('Failed to list issue priorities', session, log, client => opListIssuePriorities(client, log)),
});

redmineServer.addTool({
  name: 'listTimeEntryActivities',
  annotations: { readOnlyHint: true },
  description: 'List the Redmine time-tracking activities (Development, Design, …), flagging the default. Their IDs are what createTimeEntry takes as activityId.',
  parameters: listTimeEntryActivitiesSchema,
  execute: (_args, { log, session }) =>
    withRedmineClient('Failed to list time entry activities', session, log, client => opListTimeEntryActivities(client, log)),
});

redmineServer.addTool({
  name: 'listCustomFields',
  annotations: { readOnlyHint: true },
  description: 'List the custom fields defined on this Redmine, with the `cf_<id>` filter key for each one that is filterable. Requires administrator rights. Call this before using the customFields filter on listIssues.',
  parameters: listCustomFieldsSchema,
  execute: (_args, { log, session }) =>
    withRedmineClient('Failed to list custom fields', session, log, client => opListCustomFields(client, log), { adminOnly: true }),
});

// ==================== Search ====================

redmineServer.addTool({
  name: 'searchRedmine',
  annotations: { readOnlyHint: true },
  description: 'Full-text search across Redmine issues, wiki pages, news, documents and messages. Scope it with projectId, or narrow the object types with the boolean flags.',
  parameters: searchRedmineSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to search Redmine', session, log, client => opSearchRedmine(client, args, log)),
});
