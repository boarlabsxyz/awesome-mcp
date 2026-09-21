// src/redmine/schemas.ts
// Zod parameter schemas for every Redmine tool, plus the fragments they share.
//
// Separate from server.ts so the tool bodies (ops.ts) can be typed from these
// and unit-tested without constructing a FastMCP server, and so a future REST
// sibling validates with exactly what the MCP tool validates.

import { z } from 'zod';

import { isoDate } from '../util/isoDate.js';
import { REDMINE_MAX_LIMIT } from './apiHelpers.js';

const offsetParam = z
  .number()
  .int()
  .min(0)
  .optional()
  .default(0)
  .describe('How many records to skip. Combine with `limit` to page: the response says which window it returned.');

const limitParam = z
  .number()
  .int()
  .min(1)
  .max(REDMINE_MAX_LIMIT)
  .optional()
  .default(25)
  .describe(`Records per page (max ${REDMINE_MAX_LIMIT} — Redmine caps it server-side and silently returns ${REDMINE_MAX_LIMIT} if you ask for more).`);

const projectIdParam = z
  .string()
  .min(1)
  .describe('Project numeric ID or identifier (the slug in the project URL, e.g. "my-project").');

const issueIdParam = z
  .union([z.string(), z.number()])
  .describe('The issue ID (the number after # in Redmine, e.g. 1234).');

const customFieldsParam = z
  .record(z.string(), z.string())
  .optional()
  .describe('Custom-field filters keyed by `cf_<id>`, e.g. { "cf_3": "Urgent" }. Get the IDs from listCustomFields. Keys that are not `cf_<number>` are ignored rather than sent, since Redmine would silently drop them and widen the results.');

/** Zod schema for creating an issue. Exported so a REST sibling can reuse it verbatim. */
export const createIssueSchema = z.object({
  projectId: projectIdParam,
  subject: z.string().min(1).describe('Issue title.'),
  description: z.string().optional().describe('Issue body (Redmine wiki/textile or markdown, depending on the instance setting).'),
  trackerId: z.number().int().optional().describe('Tracker ID from listTrackers (Bug / Feature / Support / …).'),
  statusId: z.number().int().optional().describe('Status ID from listIssueStatuses. Omit to use the tracker default.'),
  priorityId: z.number().int().optional().describe('Priority ID from listIssuePriorities. Omit to use the default.'),
  categoryId: z.number().int().optional().describe('Issue category ID from listIssueCategories.'),
  fixedVersionId: z.number().int().optional().describe('Target version ID from listVersions.'),
  assignedToId: z.number().int().optional().describe('User ID to assign to. Get it from listUsers or listMemberships.'),
  parentIssueId: z.number().int().optional().describe('Parent issue ID, to create this as a subtask.'),
  watcherUserIds: z.array(z.number().int()).optional().describe('User IDs to add as watchers on creation.'),
  startDate: isoDate.optional().describe('Start date (YYYY-MM-DD).'),
  dueDate: isoDate.optional().describe('Due date (YYYY-MM-DD).'),
  estimatedHours: z.number().optional().describe('Estimated effort in hours.'),
  doneRatio: z.number().int().min(0).max(100).optional().describe('Percent done, 0-100.'),
  isPrivate: z.boolean().optional().describe('Mark the issue private to its project members.'),
  customFields: z
    .array(z.object({ id: z.number().int(), value: z.union([z.string(), z.array(z.string())]) }))
    .optional()
    .describe('Custom field values as [{ id, value }]. IDs come from listCustomFields.'),
});

/** Zod schema for updating an issue. Exported alongside createIssueSchema. */
export const updateIssueSchema = z.object({
  issueId: issueIdParam,
  subject: z.string().optional().describe('New title.'),
  description: z.string().optional().describe('Replacement body. This REPLACES the description; use `notes` to add a comment instead.'),
  notes: z.string().optional().describe('A comment to append to the issue history. This is how you add a note without touching the description.'),
  privateNotes: z.boolean().optional().describe('Mark the appended note private (visible only to users with the permission).'),
  trackerId: z.number().int().optional().describe('New tracker ID from listTrackers.'),
  statusId: z.number().int().optional().describe('New status ID. getIssue with include=["allowed_statuses"] lists the ones this issue can move to.'),
  priorityId: z.number().int().optional().describe('New priority ID from listIssuePriorities.'),
  categoryId: z.number().int().optional().describe('New category ID from listIssueCategories.'),
  fixedVersionId: z.number().int().optional().describe('New target version ID from listVersions.'),
  assignedToId: z.number().int().optional().describe('User ID to reassign to.'),
  parentIssueId: z.number().int().optional().describe('New parent issue ID.'),
  startDate: isoDate.optional().describe('New start date (YYYY-MM-DD).'),
  dueDate: isoDate.optional().describe('New due date (YYYY-MM-DD).'),
  estimatedHours: z.number().optional().describe('New estimate in hours.'),
  doneRatio: z.number().int().min(0).max(100).optional().describe('New percent done, 0-100.'),
  isPrivate: z.boolean().optional().describe('Change the private flag.'),
  customFields: z
    .array(z.object({ id: z.number().int(), value: z.union([z.string(), z.array(z.string())]) }))
    .optional()
    .describe('Custom field values as [{ id, value }].'),
});

/** Zod schema for logging time. Exported for REST reuse. */
export const createTimeEntrySchema = z
  .object({
    issueId: z.union([z.string(), z.number()]).optional().describe('Issue to log against. Provide this OR projectId.'),
    projectId: z.string().optional().describe('Project to log against (ID or identifier). Provide this OR issueId.'),
    hours: z.number().positive().describe('Hours spent. Decimal, e.g. 1.5.'),
    spentOn: isoDate.optional().describe('Date the time was spent (YYYY-MM-DD). Defaults to today on the Redmine side.'),
    activityId: z.number().int().optional().describe('Activity ID from listTimeEntryActivities. Required unless the instance has a default.'),
    comments: z.string().max(1024).optional().describe('Short note describing the work.'),
    userId: z.number().int().optional().describe('Log on behalf of another user. Needs the "log time for other users" permission.'),
  })
  .refine(v => Boolean(v.issueId) || Boolean(v.projectId), {
    message: 'Provide either issueId or projectId.',
    path: ['issueId'],
  });

/** Parameters for the `listIssues` tool. */
export const listIssuesSchema = z.object({
    projectId: z.string().optional().describe('Restrict to one project (numeric ID or identifier). Omit to search across every project you can see.'),
    subprojectId: z.string().optional().describe('Subproject filter. Pass "!*" to EXCLUDE subprojects of the given project.'),
    trackerId: z.number().int().optional().describe('Tracker ID from listTrackers.'),
    statusId: z.string().optional().describe('Status filter: "open" (default on the Redmine side), "closed", "*" for any, or a numeric status ID from listIssueStatuses.'),
    assignedToId: z.string().optional().describe('Assignee user ID, or the literal "me" for the connected user.'),
    authorId: z.string().optional().describe('Author user ID, or "me".'),
    parentId: z.number().int().optional().describe('Return only subtasks of this issue ID.'),
    issueIds: z.array(z.number().int()).optional().describe('Fetch specific issue IDs. Sent as one comma-joined filter, which is the only form Redmine honors.'),
    subject: z.string().optional().describe('Subject filter. Prefix with ~ for "contains", e.g. "~login bug". A bare string matches exactly.'),
    createdOn: z.string().optional().describe('Creation-date filter using Redmine operators, e.g. ">=2026-01-01", "<=2026-03-31", or "><2026-01-01|2026-03-31".'),
    updatedOn: z.string().optional().describe('Last-updated filter, same operator syntax as createdOn.'),
    customFields: customFieldsParam,
    sort: z.string().optional().describe('Sort column, append :desc to reverse — e.g. "updated_on:desc", "priority:desc", "id".'),
    include: z.array(z.enum(['attachments', 'relations'])).optional().describe('Extra associations to embed in each issue.'),
    offset: offsetParam,
    limit: limitParam,
  });

/** Parameters for the `getIssue` tool. */
export const getIssueSchema = z.object({
    issueId: issueIdParam,
    include: z
      .array(z.enum(['children', 'attachments', 'relations', 'changesets', 'journals', 'watchers', 'allowed_statuses']))
      .optional()
      .describe('Associations to embed. "journals" is the comment/change history; "allowed_statuses" is the set of statuses this issue can legally transition to, which is what updateIssue needs.'),
  });

/** Parameters for the `deleteIssue` tool. */
export const deleteIssueSchema = z.object({ issueId: issueIdParam });

/** Parameters for the `addIssueWatcher` tool. */
export const addIssueWatcherSchema = z.object({
    issueId: issueIdParam,
    userId: z.number().int().describe('User ID to add. Get it from listUsers or listMemberships.'),
  });

/** Parameters for the `removeIssueWatcher` tool. */
export const removeIssueWatcherSchema = z.object({
    issueId: issueIdParam,
    userId: z.number().int().describe('User ID to remove from the watcher list.'),
  });

/** Parameters for the `listIssueRelations` tool. */
export const listIssueRelationsSchema = z.object({ issueId: issueIdParam });

/** Parameters for the `createIssueRelation` tool. */
export const createIssueRelationSchema = z.object({
    issueId: issueIdParam,
    issueToId: z.number().int().describe('The other issue ID this relation points at.'),
    relationType: z
      .enum(['relates', 'duplicates', 'duplicated', 'blocks', 'blocked', 'precedes', 'follows', 'copied_to', 'copied_from'])
      .optional()
      .default('relates')
      .describe('Relation type, read as "<issueId> <type> <issueToId>".'),
    delay: z.number().int().optional().describe('Days of delay. Only meaningful for precedes/follows.'),
  });

/** Parameters for the `deleteIssueRelation` tool. */
export const deleteIssueRelationSchema = z.object({
    relationId: z.union([z.string(), z.number()]).describe('The relation ID from listIssueRelations.'),
  });

/** Parameters for the `listProjects` tool. */
export const listProjectsSchema = z.object({
    include: z.array(z.enum(['trackers', 'issue_categories', 'enabled_modules', 'time_entry_activities'])).optional().describe('Extra associations to embed per project.'),
    offset: offsetParam,
    limit: limitParam,
  });

/** Parameters for the `getProject` tool. */
export const getProjectSchema = z.object({
    projectId: projectIdParam,
    include: z.array(z.enum(['trackers', 'issue_categories', 'enabled_modules', 'time_entry_activities'])).optional().describe('Associations to embed.'),
  });

/** Parameters for the `createProject` tool. */
export const createProjectSchema = z.object({
    name: z.string().min(1).describe('Display name.'),
    identifier: z
      .string()
      .regex(/^[a-z0-9-_]+$/, 'Identifier must be lowercase letters, digits, hyphens or underscores.')
      .describe('URL slug, lowercase. Cannot be changed after creation on older Redmine versions.'),
    description: z.string().optional().describe('Project description.'),
    homepage: z.string().optional().describe('Project homepage URL.'),
    isPublic: z.boolean().optional().describe('Whether the project is visible to all users. Redmine defaults this to true.'),
    parentId: z.number().int().optional().describe('Parent project ID, to nest this project.'),
    inheritMembers: z.boolean().optional().describe('Inherit members from the parent project.'),
    trackerIds: z.array(z.number().int()).optional().describe('Tracker IDs to enable, from listTrackers.'),
    enabledModuleNames: z.array(z.string()).optional().describe('Modules to enable, e.g. ["issue_tracking","time_tracking","wiki"].'),
  });

/** Parameters for the `updateProject` tool. */
export const updateProjectSchema = z.object({
    projectId: projectIdParam,
    name: z.string().optional().describe('New display name.'),
    description: z.string().optional().describe('New description.'),
    homepage: z.string().optional().describe('New homepage URL.'),
    isPublic: z.boolean().optional().describe('Change public visibility.'),
    parentId: z.number().int().optional().describe('Move under a different parent project.'),
    inheritMembers: z.boolean().optional().describe('Change member inheritance.'),
    trackerIds: z.array(z.number().int()).optional().describe('Replace the enabled tracker IDs.'),
    enabledModuleNames: z.array(z.string()).optional().describe('Replace the enabled module names.'),
  });

/** Parameters for the `archiveProject` tool. */
export const archiveProjectSchema = z.object({ projectId: projectIdParam });

/** Parameters for the `unarchiveProject` tool. */
export const unarchiveProjectSchema = z.object({ projectId: projectIdParam });

/** Parameters for the `deleteProject` tool. */
export const deleteProjectSchema = z.object({ projectId: projectIdParam });

/** Parameters for the `listUsers` tool. */
export const listUsersSchema = z.object({
    status: z.enum(['1', '2', '3']).optional().describe('Account status: "1" active, "2" registered (awaiting activation), "3" locked. Omit for active only.'),
    name: z.string().optional().describe('Filter on login, first name, last name or email (substring match).'),
    groupId: z.number().int().optional().describe('Only users in this group.'),
    offset: offsetParam,
    limit: limitParam,
  });

/** Parameters for the `getUser` tool. */
export const getUserSchema = z.object({
    userId: z.union([z.string(), z.number()]).describe('The user ID.'),
    include: z.array(z.enum(['memberships', 'groups'])).optional().describe('Associations to embed.'),
  });

/** Parameters for the `getCurrentUser` tool. */
export const getCurrentUserSchema = z.object({
    include: z.array(z.enum(['memberships', 'groups'])).optional().describe('Associations to embed.'),
  });

/** Parameters for the `listTimeEntries` tool. */
export const listTimeEntriesSchema = z.object({
    projectId: z.string().optional().describe('Restrict to one project (ID or identifier).'),
    issueId: z.union([z.string(), z.number()]).optional().describe('Restrict to one issue.'),
    userId: z.string().optional().describe('Restrict to one user ID, or "me" for the connected account.'),
    spentOn: z.string().optional().describe('Exact date (YYYY-MM-DD), or a Redmine operator expression like ">=2026-01-01".'),
    from: isoDate.optional().describe('Start of the date range (YYYY-MM-DD), inclusive.'),
    to: isoDate.optional().describe('End of the date range (YYYY-MM-DD), inclusive.'),
    offset: offsetParam,
    limit: limitParam,
  });

/** Parameters for the `getTimeEntry` tool. */
export const getTimeEntrySchema = z.object({
    timeEntryId: z.union([z.string(), z.number()]).describe('The time-entry ID.'),
  });

/** Parameters for the `updateTimeEntry` tool. */
export const updateTimeEntrySchema = z.object({
    timeEntryId: z.union([z.string(), z.number()]).describe('The time-entry ID to update.'),
    hours: z.number().positive().optional().describe('New hours value.'),
    spentOn: isoDate.optional().describe('New date (YYYY-MM-DD).'),
    activityId: z.number().int().optional().describe('New activity ID from listTimeEntryActivities.'),
    comments: z.string().max(1024).optional().describe('New comment text.'),
    issueId: z.union([z.string(), z.number()]).optional().describe('Move the entry onto a different issue.'),
    projectId: z.string().optional().describe('Move the entry onto a different project.'),
  });

/** Parameters for the `deleteTimeEntry` tool. */
export const deleteTimeEntrySchema = z.object({
    timeEntryId: z.union([z.string(), z.number()]).describe('The time-entry ID to delete.'),
  });

/** Parameters for the `listWikiPages` tool. */
export const listWikiPagesSchema = z.object({ projectId: projectIdParam });

/** Parameters for the `getWikiPage` tool. */
export const getWikiPageSchema = z.object({
    projectId: projectIdParam,
    title: z.string().min(1).describe('Page title exactly as it appears in listWikiPages (Redmine matches on the title, not a slug).'),
    version: z.number().int().min(1).optional().describe('Specific revision number. Omit for the current version.'),
  });

/** Parameters for the `updateWikiPage` tool. */
export const updateWikiPageSchema = z.object({
    projectId: projectIdParam,
    title: z.string().min(1).describe('Page title. A title that does not exist yet creates a new page.'),
    text: z.string().describe('Full page body. This replaces the existing content entirely.'),
    comments: z.string().optional().describe('Revision comment describing the change.'),
    parentTitle: z.string().optional().describe('Title of the parent wiki page, to nest this one under it.'),
    version: z.number().int().optional().describe('Version being edited, for optimistic locking. If it does not match the current version Redmine rejects the write instead of clobbering a concurrent edit.'),
  });

/** Parameters for the `deleteWikiPage` tool. */
export const deleteWikiPageSchema = z.object({
    projectId: projectIdParam,
    title: z.string().min(1).describe('Page title to delete.'),
  });

/** Parameters for the `listVersions` tool. */
export const listVersionsSchema = z.object({ projectId: projectIdParam });

/** Parameters for the `getVersion` tool. */
export const getVersionSchema = z.object({
    versionId: z.union([z.string(), z.number()]).describe('The version ID from listVersions.'),
  });

/** Parameters for the `createVersion` tool. */
export const createVersionSchema = z.object({
    projectId: projectIdParam,
    name: z.string().min(1).describe('Version name, e.g. "2.1.0" or "Sprint 14".'),
    description: z.string().optional().describe('Version description.'),
    status: z.enum(['open', 'locked', 'closed']).optional().describe('Version status. "open" accepts new issues; "locked" and "closed" do not.'),
    dueDate: isoDate.optional().describe('Target date (YYYY-MM-DD).'),
    sharing: z
      .enum(['none', 'descendants', 'hierarchy', 'tree', 'system'])
      .optional()
      .describe('Which other projects may assign issues to this version.'),
    wikiPageTitle: z.string().optional().describe('Wiki page title to associate with this version.'),
  });

/** Parameters for the `updateVersion` tool. */
export const updateVersionSchema = z.object({
    versionId: z.union([z.string(), z.number()]).describe('The version ID to update.'),
    name: z.string().optional().describe('New name.'),
    description: z.string().optional().describe('New description.'),
    status: z.enum(['open', 'locked', 'closed']).optional().describe('New status.'),
    dueDate: isoDate.optional().describe('New target date (YYYY-MM-DD).'),
    sharing: z.enum(['none', 'descendants', 'hierarchy', 'tree', 'system']).optional().describe('New sharing mode.'),
    wikiPageTitle: z.string().optional().describe('New associated wiki page title.'),
  });

/** Parameters for the `deleteVersion` tool. */
export const deleteVersionSchema = z.object({
    versionId: z.union([z.string(), z.number()]).describe('The version ID to delete.'),
  });

/** Parameters for the `listIssueCategories` tool. */
export const listIssueCategoriesSchema = z.object({ projectId: projectIdParam });

/** Parameters for the `createIssueCategory` tool. */
export const createIssueCategorySchema = z.object({
    projectId: projectIdParam,
    name: z.string().min(1).describe('Category name.'),
    assignedToId: z.number().int().optional().describe('User ID that issues in this category are auto-assigned to.'),
  });

/** Parameters for the `deleteIssueCategory` tool. */
export const deleteIssueCategorySchema = z.object({
    categoryId: z.union([z.string(), z.number()]).describe('The category ID to delete, from listIssueCategories.'),
    reassignToId: z.number().int().optional().describe('Category ID to move affected issues into. Omit to leave them with no category.'),
  });

/** Parameters for the `listMemberships` tool. */
export const listMembershipsSchema = z.object({
    projectId: projectIdParam,
    offset: offsetParam,
    limit: limitParam,
  });

/** Parameters for the `createMembership` tool. */
export const createMembershipSchema = z.object({
    projectId: projectIdParam,
    userId: z.number().int().describe('User OR group ID to add. Redmine uses the same field for both.'),
    roleIds: z.array(z.number().int()).min(1).describe('Role IDs to grant. At least one is required.'),
  });

/** Parameters for the `deleteMembership` tool. */
export const deleteMembershipSchema = z.object({
    membershipId: z.union([z.string(), z.number()]).describe('The membership ID from listMemberships.'),
  });

/** Parameters for the `listTrackers` tool. */
export const listTrackersSchema = z.object({});

/** Parameters for the `listIssueStatuses` tool. */
export const listIssueStatusesSchema = z.object({});

/** Parameters for the `listIssuePriorities` tool. */
export const listIssuePrioritiesSchema = z.object({});

/** Parameters for the `listTimeEntryActivities` tool. */
export const listTimeEntryActivitiesSchema = z.object({});

/** Parameters for the `listCustomFields` tool. */
export const listCustomFieldsSchema = z.object({});

/** Parameters for the `searchRedmine` tool. */
export const searchRedmineSchema = z.object({
    query: z.string().min(1).describe('Search terms.'),
    projectId: z.string().optional().describe('Restrict the search to one project (ID or identifier). Omit to search everything visible.'),
    scope: z
      .enum(['all', 'my_projects', 'subprojects'])
      .optional()
      .describe('Breadth of the search. "subprojects" only means anything alongside projectId.'),
    titlesOnly: z.boolean().optional().describe('Match titles only instead of full text.'),
    issues: z.boolean().optional().describe('Include issues in the results.'),
    news: z.boolean().optional().describe('Include news entries.'),
    documents: z.boolean().optional().describe('Include documents.'),
    wikiPages: z.boolean().optional().describe('Include wiki pages.'),
    openIssues: z.boolean().optional().describe('Restrict issue hits to open issues only.'),
    offset: offsetParam,
    limit: limitParam,
  });
