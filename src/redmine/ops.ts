// src/redmine/ops.ts
// One exported function per Redmine tool body.
//
// The tool bodies live here rather than inline in server.ts so they can be
// driven directly against a mocked client in tests — the same split HubSpot
// uses (src/hubspot/server.ts `op*` + src/__tests__/hubspot/serverOps.test.ts).
// server.ts keeps the descriptions, annotations and schemas; this file keeps
// the behaviour.

import { UserError } from 'fastmcp';
import { z } from 'zod';

import {
  RedmineClient,
  RedmineToolLog,
  formatCategoryList,
  formatCustomFieldDefList,
  formatIssue,
  formatIssueList,
  formatMembershipList,
  formatProject,
  formatProjectList,
  formatRefList,
  formatRelationList,
  formatSearchResults,
  formatTimeEntry,
  formatTimeEntryList,
  formatUser,
  formatUserList,
  formatVersion,
  formatVersionList,
  formatWikiPage,
  formatWikiPageList,
  mergeCustomFieldFilters,
} from './apiHelpers.js';
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
  searchRedmineSchema,
  createIssueSchema,
  updateIssueSchema,
  createTimeEntrySchema,
} from './schemas.js';

/** Strip undefined values so a PUT body never clears a field the caller left out. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Map the shared issue-write args onto Redmine's snake_case body keys. */
function issueBody(args: Record<string, any>): Record<string, unknown> {
  return compact({
    subject: args.subject,
    description: args.description,
    notes: args.notes,
    private_notes: args.privateNotes,
    tracker_id: args.trackerId,
    status_id: args.statusId,
    priority_id: args.priorityId,
    category_id: args.categoryId,
    fixed_version_id: args.fixedVersionId,
    assigned_to_id: args.assignedToId,
    parent_issue_id: args.parentIssueId,
    watcher_user_ids: args.watcherUserIds,
    start_date: args.startDate,
    due_date: args.dueDate,
    estimated_hours: args.estimatedHours,
    done_ratio: args.doneRatio,
    is_private: args.isPrivate,
    custom_fields: args.customFields,
  });
}

/** Body of the `listIssues` tool. */
export async function opListIssues(client: RedmineClient, args: z.infer<typeof listIssuesSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Listing Redmine issues (project=${args.projectId ?? 'all'}, status=${args.statusId ?? 'open'}, offset=${args.offset})`);
  const query = mergeCustomFieldFilters(
    {
      project_id: args.projectId,
      subproject_id: args.subprojectId,
      tracker_id: args.trackerId,
      status_id: args.statusId,
      assigned_to_id: args.assignedToId,
      author_id: args.authorId,
      parent_id: args.parentId,
      issue_id: args.issueIds,
      subject: args.subject,
      created_on: args.createdOn,
      updated_on: args.updatedOn,
      sort: args.sort,
      include: args.include,
      offset: args.offset,
      limit: args.limit,
    },
    args.customFields,
  );
  const res = await client.listIssues(query);
  return formatIssueList(res.items, res.page);
}

/** Body of the `getIssue` tool. */
export async function opGetIssue(client: RedmineClient, args: z.infer<typeof getIssueSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Fetching Redmine issue ${args.issueId}`);
  const res = await client.getIssue(args.issueId, args.include);
  if (!res?.issue) throw new UserError('Issue not found.');
  return formatIssue(res.issue);
}

/** Body of the `createIssue` tool. */
export async function opCreateIssue(client: RedmineClient, args: z.infer<typeof createIssueSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Creating Redmine issue in project ${args.projectId}`);
  const res = await client.createIssue({ project_id: args.projectId, ...issueBody(args) });
  if (!res?.issue?.id) throw new UserError('Redmine accepted the request but returned no issue.');
  return `Created issue #${res.issue.id}: ${res.issue.subject ?? args.subject}`;
}

/** Body of the `updateIssue` tool. */
export async function opUpdateIssue(client: RedmineClient, args: z.infer<typeof updateIssueSchema>, log: RedmineToolLog): Promise<string> {
  const body = issueBody(args);
  if (Object.keys(body).length === 0) {
    throw new UserError('Nothing to update — pass at least one field to change, or `notes` to add a comment.');
  }
  log.info(`Updating Redmine issue ${args.issueId} (${Object.keys(body).join(', ')})`);
  await client.updateIssue(args.issueId, body);
  // Redmine answers 204 with no body, so re-read to report the record as it now stands.
  const res = await client.getIssue(args.issueId);
  return res?.issue ? formatIssue(res.issue) : `Updated issue #${args.issueId}.`;
}

/** Body of the `deleteIssue` tool. */
export async function opDeleteIssue(client: RedmineClient, args: z.infer<typeof deleteIssueSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Deleting Redmine issue ${args.issueId}`);
  await client.deleteIssue(args.issueId);
  return `Deleted issue #${args.issueId} permanently.`;
}

/** Body of the `addIssueWatcher` tool. */
export async function opAddIssueWatcher(client: RedmineClient, args: z.infer<typeof addIssueWatcherSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Adding watcher ${args.userId} to Redmine issue ${args.issueId}`);
  await client.addIssueWatcher(args.issueId, args.userId);
  return `Added user #${args.userId} as a watcher on issue #${args.issueId}.`;
}

/** Body of the `removeIssueWatcher` tool. */
export async function opRemoveIssueWatcher(client: RedmineClient, args: z.infer<typeof removeIssueWatcherSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Removing watcher ${args.userId} from Redmine issue ${args.issueId}`);
  await client.removeIssueWatcher(args.issueId, args.userId);
  return `Removed user #${args.userId} from the watchers of issue #${args.issueId}.`;
}

/** Body of the `listIssueRelations` tool. */
export async function opListIssueRelations(client: RedmineClient, args: z.infer<typeof listIssueRelationsSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Listing relations for Redmine issue ${args.issueId}`);
  const res = await client.listIssueRelations(args.issueId);
  return formatRelationList(res.items, res.page);
}

/** Body of the `createIssueRelation` tool. */
export async function opCreateIssueRelation(client: RedmineClient, args: z.infer<typeof createIssueRelationSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Relating Redmine issue ${args.issueId} ${args.relationType} ${args.issueToId}`);
  const res = await client.createIssueRelation(args.issueId, compact({
    issue_to_id: args.issueToId,
    relation_type: args.relationType,
    delay: args.delay,
  }));
  return `Created relation #${res?.relation?.id ?? '?'}: issue #${args.issueId} ${args.relationType} issue #${args.issueToId}.`;
}

/** Body of the `deleteIssueRelation` tool. */
export async function opDeleteIssueRelation(client: RedmineClient, args: z.infer<typeof deleteIssueRelationSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Deleting Redmine issue relation ${args.relationId}`);
  await client.deleteIssueRelation(args.relationId);
  return `Deleted relation #${args.relationId}.`;
}

/** Body of the `listProjects` tool. */
export async function opListProjects(client: RedmineClient, args: z.infer<typeof listProjectsSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Listing Redmine projects (offset=${args.offset}, limit=${args.limit})`);
  const res = await client.listProjects({ include: args.include, offset: args.offset, limit: args.limit });
  return formatProjectList(res.items, res.page);
}

/** Body of the `getProject` tool. */
export async function opGetProject(client: RedmineClient, args: z.infer<typeof getProjectSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Fetching Redmine project ${args.projectId}`);
  const res = await client.getProject(args.projectId, args.include);
  if (!res?.project) throw new UserError('Project not found.');
  return formatProject(res.project);
}

/** Body of the `createProject` tool. */
export async function opCreateProject(client: RedmineClient, args: z.infer<typeof createProjectSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Creating Redmine project ${args.identifier}`);
  const res = await client.createProject(compact({
    name: args.name,
    identifier: args.identifier,
    description: args.description,
    homepage: args.homepage,
    is_public: args.isPublic,
    parent_id: args.parentId,
    inherit_members: args.inheritMembers,
    tracker_ids: args.trackerIds,
    enabled_module_names: args.enabledModuleNames,
  }));
  return res?.project ? formatProject(res.project) : `Created project ${args.identifier}.`;
}

/** Body of the `updateProject` tool. */
export async function opUpdateProject(client: RedmineClient, args: z.infer<typeof updateProjectSchema>, log: RedmineToolLog): Promise<string> {
  const body = compact({
    name: args.name,
    description: args.description,
    homepage: args.homepage,
    is_public: args.isPublic,
    parent_id: args.parentId,
    inherit_members: args.inheritMembers,
    tracker_ids: args.trackerIds,
    enabled_module_names: args.enabledModuleNames,
  });
  if (Object.keys(body).length === 0) throw new UserError('Nothing to update — pass at least one field to change.');
  log.info(`Updating Redmine project ${args.projectId} (${Object.keys(body).join(', ')})`);
  await client.updateProject(args.projectId, body);
  const res = await client.getProject(args.projectId);
  return res?.project ? formatProject(res.project) : `Updated project ${args.projectId}.`;
}

/** Body of the `archiveProject` tool. */
export async function opArchiveProject(client: RedmineClient, args: z.infer<typeof archiveProjectSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Archiving Redmine project ${args.projectId}`);
  await client.archiveProject(args.projectId);
  return `Archived project ${args.projectId}. Use unarchiveProject to restore it.`;
}

/** Body of the `unarchiveProject` tool. */
export async function opUnarchiveProject(client: RedmineClient, args: z.infer<typeof unarchiveProjectSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Unarchiving Redmine project ${args.projectId}`);
  await client.unarchiveProject(args.projectId);
  return `Unarchived project ${args.projectId}.`;
}

/** Body of the `deleteProject` tool. */
export async function opDeleteProject(client: RedmineClient, args: z.infer<typeof deleteProjectSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Deleting Redmine project ${args.projectId}`);
  await client.deleteProject(args.projectId);
  return `Deleted project ${args.projectId} and all of its contents permanently.`;
}

/** Body of the `listUsers` tool. */
export async function opListUsers(client: RedmineClient, args: z.infer<typeof listUsersSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Listing Redmine users (name=${args.name ?? 'any'}, offset=${args.offset})`);
  const res = await client.listUsers({
    status: args.status,
    name: args.name,
    group_id: args.groupId,
    offset: args.offset,
    limit: args.limit,
  });
  return formatUserList(res.items, res.page);
}

/** Body of the `getUser` tool. */
export async function opGetUser(client: RedmineClient, args: z.infer<typeof getUserSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Fetching Redmine user ${args.userId}`);
  const res = await client.getUser(args.userId, args.include);
  if (!res?.user) throw new UserError('User not found.');
  return formatUser(res.user);
}

/** Body of the `getCurrentUser` tool. */
export async function opGetCurrentUser(client: RedmineClient, args: z.infer<typeof getCurrentUserSchema>, log: RedmineToolLog): Promise<string> {
  log.info('Fetching current Redmine user');
  const res = await client.getCurrentUser(args.include);
  if (!res?.user) throw new UserError('Could not resolve the current user.');
  return formatUser(res.user);
}

/** Body of the `listTimeEntries` tool. */
export async function opListTimeEntries(client: RedmineClient, args: z.infer<typeof listTimeEntriesSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Listing Redmine time entries (project=${args.projectId ?? 'all'}, user=${args.userId ?? 'all'}, offset=${args.offset})`);
  const res = await client.listTimeEntries({
    project_id: args.projectId,
    issue_id: args.issueId,
    user_id: args.userId,
    spent_on: args.spentOn,
    from: args.from,
    to: args.to,
    offset: args.offset,
    limit: args.limit,
  });
  return formatTimeEntryList(res.items, res.page);
}

/** Body of the `getTimeEntry` tool. */
export async function opGetTimeEntry(client: RedmineClient, args: z.infer<typeof getTimeEntrySchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Fetching Redmine time entry ${args.timeEntryId}`);
  const res = await client.getTimeEntry(args.timeEntryId);
  if (!res?.time_entry) throw new UserError('Time entry not found.');
  return formatTimeEntry(res.time_entry);
}

/** Body of the `createTimeEntry` tool. */
export async function opCreateTimeEntry(client: RedmineClient, args: z.infer<typeof createTimeEntrySchema>, log: RedmineToolLog): Promise<string> {
  const target = args.issueId ? `issue ${args.issueId}` : `project ${args.projectId}`;
  log.info(`Logging ${args.hours}h against Redmine ${target}`);
  const res = await client.createTimeEntry(compact({
    issue_id: args.issueId,
    project_id: args.projectId,
    hours: args.hours,
    spent_on: args.spentOn,
    activity_id: args.activityId,
    comments: args.comments,
    user_id: args.userId,
  }));
  return res?.time_entry
    ? `Logged ${res.time_entry.hours ?? args.hours}h (time entry #${res.time_entry.id ?? '?'}).`
    : `Logged ${args.hours}h.`;
}

/** Body of the `updateTimeEntry` tool. */
export async function opUpdateTimeEntry(client: RedmineClient, args: z.infer<typeof updateTimeEntrySchema>, log: RedmineToolLog): Promise<string> {
  const body = compact({
    hours: args.hours,
    spent_on: args.spentOn,
    activity_id: args.activityId,
    comments: args.comments,
    issue_id: args.issueId,
    project_id: args.projectId,
  });
  if (Object.keys(body).length === 0) throw new UserError('Nothing to update — pass at least one field to change.');
  log.info(`Updating Redmine time entry ${args.timeEntryId} (${Object.keys(body).join(', ')})`);
  await client.updateTimeEntry(args.timeEntryId, body);
  const res = await client.getTimeEntry(args.timeEntryId);
  return res?.time_entry ? formatTimeEntry(res.time_entry) : `Updated time entry #${args.timeEntryId}.`;
}

/** Body of the `deleteTimeEntry` tool. */
export async function opDeleteTimeEntry(client: RedmineClient, args: z.infer<typeof deleteTimeEntrySchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Deleting Redmine time entry ${args.timeEntryId}`);
  await client.deleteTimeEntry(args.timeEntryId);
  return `Deleted time entry #${args.timeEntryId} permanently.`;
}

/** Body of the `listWikiPages` tool. */
export async function opListWikiPages(client: RedmineClient, args: z.infer<typeof listWikiPagesSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Listing Redmine wiki pages for project ${args.projectId}`);
  const res = await client.listWikiPages(args.projectId);
  return formatWikiPageList(res.items, res.page);
}

/** Body of the `getWikiPage` tool. */
export async function opGetWikiPage(client: RedmineClient, args: z.infer<typeof getWikiPageSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Fetching Redmine wiki page "${args.title}" in project ${args.projectId}`);
  const res = await client.getWikiPage(args.projectId, args.title, args.version);
  if (!res?.wiki_page) throw new UserError('Wiki page not found.');
  return formatWikiPage(res.wiki_page);
}

/** Body of the `updateWikiPage` tool. */
export async function opUpdateWikiPage(client: RedmineClient, args: z.infer<typeof updateWikiPageSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Updating Redmine wiki page "${args.title}" in project ${args.projectId}`);
  await client.updateWikiPage(args.projectId, args.title, compact({
    text: args.text,
    comments: args.comments,
    parent_title: args.parentTitle,
    version: args.version,
  }));
  return `Saved wiki page "${args.title}" in project ${args.projectId}.`;
}

/** Body of the `deleteWikiPage` tool. */
export async function opDeleteWikiPage(client: RedmineClient, args: z.infer<typeof deleteWikiPageSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Deleting Redmine wiki page "${args.title}" in project ${args.projectId}`);
  await client.deleteWikiPage(args.projectId, args.title);
  return `Deleted wiki page "${args.title}" and all its revisions.`;
}

/** Body of the `listVersions` tool. */
export async function opListVersions(client: RedmineClient, args: z.infer<typeof listVersionsSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Listing Redmine versions for project ${args.projectId}`);
  const res = await client.listVersions(args.projectId);
  return formatVersionList(res.items, res.page);
}

/** Body of the `getVersion` tool. */
export async function opGetVersion(client: RedmineClient, args: z.infer<typeof getVersionSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Fetching Redmine version ${args.versionId}`);
  const res = await client.getVersion(args.versionId);
  if (!res?.version) throw new UserError('Version not found.');
  return formatVersion(res.version);
}

/** Body of the `createVersion` tool. */
export async function opCreateVersion(client: RedmineClient, args: z.infer<typeof createVersionSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Creating Redmine version "${args.name}" in project ${args.projectId}`);
  const res = await client.createVersion(args.projectId, compact({
    name: args.name,
    description: args.description,
    status: args.status,
    due_date: args.dueDate,
    sharing: args.sharing,
    wiki_page_title: args.wikiPageTitle,
  }));
  return res?.version ? formatVersion(res.version) : `Created version "${args.name}".`;
}

/** Body of the `updateVersion` tool. */
export async function opUpdateVersion(client: RedmineClient, args: z.infer<typeof updateVersionSchema>, log: RedmineToolLog): Promise<string> {
  const body = compact({
    name: args.name,
    description: args.description,
    status: args.status,
    due_date: args.dueDate,
    sharing: args.sharing,
    wiki_page_title: args.wikiPageTitle,
  });
  if (Object.keys(body).length === 0) throw new UserError('Nothing to update — pass at least one field to change.');
  log.info(`Updating Redmine version ${args.versionId} (${Object.keys(body).join(', ')})`);
  await client.updateVersion(args.versionId, body);
  const res = await client.getVersion(args.versionId);
  return res?.version ? formatVersion(res.version) : `Updated version #${args.versionId}.`;
}

/** Body of the `deleteVersion` tool. */
export async function opDeleteVersion(client: RedmineClient, args: z.infer<typeof deleteVersionSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Deleting Redmine version ${args.versionId}`);
  await client.deleteVersion(args.versionId);
  return `Deleted version #${args.versionId}. Issues that targeted it now have no target version.`;
}

/** Body of the `listIssueCategories` tool. */
export async function opListIssueCategories(client: RedmineClient, args: z.infer<typeof listIssueCategoriesSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Listing Redmine issue categories for project ${args.projectId}`);
  const res = await client.listIssueCategories(args.projectId);
  return formatCategoryList(res.items, res.page);
}

/** Body of the `createIssueCategory` tool. */
export async function opCreateIssueCategory(client: RedmineClient, args: z.infer<typeof createIssueCategorySchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Creating Redmine issue category "${args.name}" in project ${args.projectId}`);
  const res = await client.createIssueCategory(args.projectId, compact({
    name: args.name,
    assigned_to_id: args.assignedToId,
  }));
  return `Created issue category "${args.name}" (ID: ${res?.issue_category?.id ?? '?'}).`;
}

/** Body of the `deleteIssueCategory` tool. */
export async function opDeleteIssueCategory(client: RedmineClient, args: z.infer<typeof deleteIssueCategorySchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Deleting Redmine issue category ${args.categoryId}`);
  await client.deleteIssueCategory(args.categoryId, args.reassignToId);
  const fate = args.reassignToId ? `reassigned to category #${args.reassignToId}` : 'left with no category';
  return `Deleted issue category #${args.categoryId}. Affected issues were ${fate}.`;
}

/** Body of the `listMemberships` tool. */
export async function opListMemberships(client: RedmineClient, args: z.infer<typeof listMembershipsSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Listing Redmine memberships for project ${args.projectId} (offset=${args.offset})`);
  const res = await client.listMemberships(args.projectId, { offset: args.offset, limit: args.limit });
  return formatMembershipList(res.items, res.page);
}

/** Body of the `createMembership` tool. */
export async function opCreateMembership(client: RedmineClient, args: z.infer<typeof createMembershipSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Adding member ${args.userId} to Redmine project ${args.projectId}`);
  const res = await client.createMembership(args.projectId, {
    user_id: args.userId,
    role_ids: args.roleIds,
  });
  return `Added user/group #${args.userId} to project ${args.projectId} (membership #${res?.membership?.id ?? '?'}).`;
}

/** Body of the `deleteMembership` tool. */
export async function opDeleteMembership(client: RedmineClient, args: z.infer<typeof deleteMembershipSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Deleting Redmine membership ${args.membershipId}`);
  await client.deleteMembership(args.membershipId);
  return `Removed membership #${args.membershipId}.`;
}

/** Body of the `listTrackers` tool. */
export async function opListTrackers(client: RedmineClient, log: RedmineToolLog): Promise<string> {
  log.info('Listing Redmine trackers');
  const res = await client.listTrackers();
  return formatRefList('Trackers', 'trackers', res.items, res.page);
}

/** Body of the `listIssueStatuses` tool. */
export async function opListIssueStatuses(client: RedmineClient, log: RedmineToolLog): Promise<string> {
  log.info('Listing Redmine issue statuses');
  const res = await client.listIssueStatuses();
  return formatRefList('Issue statuses', 'issue statuses', res.items, res.page);
}

/** Body of the `listIssuePriorities` tool. */
export async function opListIssuePriorities(client: RedmineClient, log: RedmineToolLog): Promise<string> {
  log.info('Listing Redmine issue priorities');
  const res = await client.listIssuePriorities();
  return formatRefList('Issue priorities', 'issue priorities', res.items, res.page);
}

/** Body of the `listTimeEntryActivities` tool. */
export async function opListTimeEntryActivities(client: RedmineClient, log: RedmineToolLog): Promise<string> {
  log.info('Listing Redmine time entry activities');
  const res = await client.listTimeEntryActivities();
  return formatRefList('Time entry activities', 'time entry activities', res.items, res.page);
}

/** Body of the `listCustomFields` tool. */
export async function opListCustomFields(client: RedmineClient, log: RedmineToolLog): Promise<string> {
  log.info('Listing Redmine custom fields');
  const res = await client.listCustomFields();
  return formatCustomFieldDefList(res.items, res.page);
}

/** Body of the `searchRedmine` tool. */
export async function opSearchRedmine(client: RedmineClient, args: z.infer<typeof searchRedmineSchema>, log: RedmineToolLog): Promise<string> {
  log.info(`Searching Redmine for "${args.query}" (project=${args.projectId ?? 'all'})`);
  const res = await client.search({
    q: args.query,
    project_id: args.projectId,
    scope: args.scope,
    // Redmine reads these as presence flags: sending 0 still enables them,
    // so anything falsy has to be omitted entirely.
    titles_only: args.titlesOnly ? 1 : undefined,
    issues: args.issues ? 1 : undefined,
    news: args.news ? 1 : undefined,
    documents: args.documents ? 1 : undefined,
    wiki_pages: args.wikiPages ? 1 : undefined,
    open_issues: args.openIssues ? 1 : undefined,
    offset: args.offset,
    limit: args.limit,
  });
  return formatSearchResults(res.items, res.page);
}
