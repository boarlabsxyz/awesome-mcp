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

import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';

import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import {
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
  withRedmineClient,
  REDMINE_MAX_LIMIT,
} from './apiHelpers.js';

export const redmineServer = new FastMCP<UserSession>({
  name: 'Redmine MCP',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'redmine'),
});

// ==================== Shared parameter fragments ====================

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

/** ISO date, validated as a real calendar date so 2026-02-31 is rejected up front. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use ISO date format YYYY-MM-DD.')
  .refine(s => {
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }, 'Not a valid calendar date.');

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

// ==================== Helpers ====================

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

// ==================== Issues ====================

redmineServer.addTool({
  name: 'listIssues',
  annotations: { readOnlyHint: true },
  description: 'Search and filter Redmine issues. Returns one page and always reports the total, so check whether more pages remain before summarizing.',
  parameters: z.object({
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
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to list issues', session, log, async client => {
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
    }),
});

redmineServer.addTool({
  name: 'getIssue',
  annotations: { readOnlyHint: true },
  description: 'Retrieve one Redmine issue in full. Use `include` to pull in the comment history, subtasks, watchers, or the statuses it may move to.',
  parameters: z.object({
    issueId: issueIdParam,
    include: z
      .array(z.enum(['children', 'attachments', 'relations', 'changesets', 'journals', 'watchers', 'allowed_statuses']))
      .optional()
      .describe('Associations to embed. "journals" is the comment/change history; "allowed_statuses" is the set of statuses this issue can legally transition to, which is what updateIssue needs.'),
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to fetch issue', session, log, async client => {
      log.info(`Fetching Redmine issue ${args.issueId}`);
      const res = await client.getIssue(args.issueId, args.include);
      if (!res?.issue) throw new UserError('Issue not found.');
      return formatIssue(res.issue);
    }),
});

redmineServer.addTool({
  name: 'createIssue',
  annotations: { readOnlyHint: false },
  description: 'Create a Redmine issue in a project. Only projectId and subject are required; every other field falls back to the project/tracker default.',
  parameters: createIssueSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to create issue', session, log, async client => {
      log.info(`Creating Redmine issue in project ${args.projectId}`);
      const res = await client.createIssue({ project_id: args.projectId, ...issueBody(args) });
      if (!res?.issue?.id) throw new UserError('Redmine accepted the request but returned no issue.');
      return `Created issue #${res.issue.id}: ${res.issue.subject ?? args.subject}`;
    }),
});

redmineServer.addTool({
  name: 'updateIssue',
  annotations: { readOnlyHint: false },
  description: 'Update a Redmine issue and/or add a comment. Pass `notes` to append a comment; `description` REPLACES the body instead. Fields you omit are left untouched.',
  parameters: updateIssueSchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to update issue', session, log, async client => {
      const body = issueBody(args);
      if (Object.keys(body).length === 0) {
        throw new UserError('Nothing to update — pass at least one field to change, or `notes` to add a comment.');
      }
      log.info(`Updating Redmine issue ${args.issueId} (${Object.keys(body).join(', ')})`);
      await client.updateIssue(args.issueId, body);
      // Redmine answers 204 with no body, so re-read to report the record as it now stands.
      const res = await client.getIssue(args.issueId);
      return res?.issue ? formatIssue(res.issue) : `Updated issue #${args.issueId}.`;
    }),
});

redmineServer.addTool({
  name: 'deleteIssue',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Permanently delete a Redmine issue, along with its comments, time entries and subtasks. Redmine has no recycle bin — this cannot be undone.',
  parameters: z.object({ issueId: issueIdParam }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to delete issue', session, log, async client => {
      log.info(`Deleting Redmine issue ${args.issueId}`);
      await client.deleteIssue(args.issueId);
      return `Deleted issue #${args.issueId} permanently.`;
    }),
});

redmineServer.addTool({
  name: 'addIssueWatcher',
  annotations: { readOnlyHint: false },
  description: 'Add a user as a watcher on a Redmine issue so they receive its notifications.',
  parameters: z.object({
    issueId: issueIdParam,
    userId: z.number().int().describe('User ID to add. Get it from listUsers or listMemberships.'),
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to add watcher', session, log, async client => {
      log.info(`Adding watcher ${args.userId} to Redmine issue ${args.issueId}`);
      await client.addIssueWatcher(args.issueId, args.userId);
      return `Added user #${args.userId} as a watcher on issue #${args.issueId}.`;
    }),
});

redmineServer.addTool({
  name: 'removeIssueWatcher',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Remove a watcher from a Redmine issue.',
  parameters: z.object({
    issueId: issueIdParam,
    userId: z.number().int().describe('User ID to remove from the watcher list.'),
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to remove watcher', session, log, async client => {
      log.info(`Removing watcher ${args.userId} from Redmine issue ${args.issueId}`);
      await client.removeIssueWatcher(args.issueId, args.userId);
      return `Removed user #${args.userId} from the watchers of issue #${args.issueId}.`;
    }),
});

// ==================== Issue relations ====================

redmineServer.addTool({
  name: 'listIssueRelations',
  annotations: { readOnlyHint: true },
  description: 'List the relations (blocks, precedes, duplicates, …) attached to a Redmine issue.',
  parameters: z.object({ issueId: issueIdParam }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to list issue relations', session, log, async client => {
      log.info(`Listing relations for Redmine issue ${args.issueId}`);
      const res = await client.listIssueRelations(args.issueId);
      return formatRelationList(res.items, res.page);
    }),
});

redmineServer.addTool({
  name: 'createIssueRelation',
  annotations: { readOnlyHint: false },
  description: 'Link two Redmine issues with a relation such as blocks, precedes or duplicates.',
  parameters: z.object({
    issueId: issueIdParam,
    issueToId: z.number().int().describe('The other issue ID this relation points at.'),
    relationType: z
      .enum(['relates', 'duplicates', 'duplicated', 'blocks', 'blocked', 'precedes', 'follows', 'copied_to', 'copied_from'])
      .optional()
      .default('relates')
      .describe('Relation type, read as "<issueId> <type> <issueToId>".'),
    delay: z.number().int().optional().describe('Days of delay. Only meaningful for precedes/follows.'),
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to create issue relation', session, log, async client => {
      log.info(`Relating Redmine issue ${args.issueId} ${args.relationType} ${args.issueToId}`);
      const res = await client.createIssueRelation(args.issueId, compact({
        issue_to_id: args.issueToId,
        relation_type: args.relationType,
        delay: args.delay,
      }));
      return `Created relation #${res?.relation?.id ?? '?'}: issue #${args.issueId} ${args.relationType} issue #${args.issueToId}.`;
    }),
});

redmineServer.addTool({
  name: 'deleteIssueRelation',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Delete a Redmine issue relation by its relation ID (from listIssueRelations — NOT an issue ID).',
  parameters: z.object({
    relationId: z.union([z.string(), z.number()]).describe('The relation ID from listIssueRelations.'),
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to delete issue relation', session, log, async client => {
      log.info(`Deleting Redmine issue relation ${args.relationId}`);
      await client.deleteIssueRelation(args.relationId);
      return `Deleted relation #${args.relationId}.`;
    }),
});

// ==================== Projects ====================

redmineServer.addTool({
  name: 'listProjects',
  annotations: { readOnlyHint: true },
  description: 'List the Redmine projects visible to the connected account, newest page first. Returns one page and reports the total.',
  parameters: z.object({
    include: z.array(z.enum(['trackers', 'issue_categories', 'enabled_modules', 'time_entry_activities'])).optional().describe('Extra associations to embed per project.'),
    offset: offsetParam,
    limit: limitParam,
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to list projects', session, log, async client => {
      log.info(`Listing Redmine projects (offset=${args.offset}, limit=${args.limit})`);
      const res = await client.listProjects({ include: args.include, offset: args.offset, limit: args.limit });
      return formatProjectList(res.items, res.page);
    }),
});

redmineServer.addTool({
  name: 'getProject',
  annotations: { readOnlyHint: true },
  description: 'Retrieve one Redmine project, optionally with its trackers, categories and enabled modules.',
  parameters: z.object({
    projectId: projectIdParam,
    include: z.array(z.enum(['trackers', 'issue_categories', 'enabled_modules', 'time_entry_activities'])).optional().describe('Associations to embed.'),
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to fetch project', session, log, async client => {
      log.info(`Fetching Redmine project ${args.projectId}`);
      const res = await client.getProject(args.projectId, args.include);
      if (!res?.project) throw new UserError('Project not found.');
      return formatProject(res.project);
    }),
});

redmineServer.addTool({
  name: 'createProject',
  annotations: { readOnlyHint: false },
  description: 'Create a Redmine project. Requires administrator rights on most instances.',
  parameters: z.object({
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
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to create project', session, log, async client => {
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
    }),
});

redmineServer.addTool({
  name: 'updateProject',
  annotations: { readOnlyHint: false },
  description: 'Update a Redmine project. Fields you omit are left untouched.',
  parameters: z.object({
    projectId: projectIdParam,
    name: z.string().optional().describe('New display name.'),
    description: z.string().optional().describe('New description.'),
    homepage: z.string().optional().describe('New homepage URL.'),
    isPublic: z.boolean().optional().describe('Change public visibility.'),
    parentId: z.number().int().optional().describe('Move under a different parent project.'),
    inheritMembers: z.boolean().optional().describe('Change member inheritance.'),
    trackerIds: z.array(z.number().int()).optional().describe('Replace the enabled tracker IDs.'),
    enabledModuleNames: z.array(z.string()).optional().describe('Replace the enabled module names.'),
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to update project', session, log, async client => {
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
    }),
});

redmineServer.addTool({
  name: 'archiveProject',
  annotations: { readOnlyHint: false },
  description: 'Archive a Redmine project. It becomes read-only and hidden from project lists, but nothing is deleted — unarchiveProject reverses it.',
  parameters: z.object({ projectId: projectIdParam }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to archive project', session, log, async client => {
      log.info(`Archiving Redmine project ${args.projectId}`);
      await client.archiveProject(args.projectId);
      return `Archived project ${args.projectId}. Use unarchiveProject to restore it.`;
    }),
});

redmineServer.addTool({
  name: 'unarchiveProject',
  annotations: { readOnlyHint: false },
  description: 'Restore a previously archived Redmine project to active status.',
  parameters: z.object({ projectId: projectIdParam }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to unarchive project', session, log, async client => {
      log.info(`Unarchiving Redmine project ${args.projectId}`);
      await client.unarchiveProject(args.projectId);
      return `Unarchived project ${args.projectId}.`;
    }),
});

redmineServer.addTool({
  name: 'deleteProject',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Permanently delete a Redmine project AND every issue, wiki page, version and time entry inside it, including subprojects. There is no recycle bin. Prefer archiveProject unless the data is genuinely meant to be destroyed.',
  parameters: z.object({ projectId: projectIdParam }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to delete project', session, log, async client => {
      log.info(`Deleting Redmine project ${args.projectId}`);
      await client.deleteProject(args.projectId);
      return `Deleted project ${args.projectId} and all of its contents permanently.`;
    }),
});

// ==================== Users ====================

redmineServer.addTool({
  name: 'listUsers',
  annotations: { readOnlyHint: true },
  description: 'List Redmine users. Requires administrator rights — a non-admin account gets a permission error, which is a Redmine restriction, not a connection problem.',
  parameters: z.object({
    status: z.enum(['1', '2', '3']).optional().describe('Account status: "1" active, "2" registered (awaiting activation), "3" locked. Omit for active only.'),
    name: z.string().optional().describe('Filter on login, first name, last name or email (substring match).'),
    groupId: z.number().int().optional().describe('Only users in this group.'),
    offset: offsetParam,
    limit: limitParam,
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to list users', session, log, async client => {
      log.info(`Listing Redmine users (name=${args.name ?? 'any'}, offset=${args.offset})`);
      const res = await client.listUsers({
        status: args.status,
        name: args.name,
        group_id: args.groupId,
        offset: args.offset,
        limit: args.limit,
      });
      return formatUserList(res.items, res.page);
    }),
});

redmineServer.addTool({
  name: 'getUser',
  annotations: { readOnlyHint: true },
  description: 'Retrieve one Redmine user by ID, optionally with their group and project memberships.',
  parameters: z.object({
    userId: z.union([z.string(), z.number()]).describe('The user ID.'),
    include: z.array(z.enum(['memberships', 'groups'])).optional().describe('Associations to embed.'),
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to fetch user', session, log, async client => {
      log.info(`Fetching Redmine user ${args.userId}`);
      const res = await client.getUser(args.userId, args.include);
      if (!res?.user) throw new UserError('User not found.');
      return formatUser(res.user);
    }),
});

redmineServer.addTool({
  name: 'getCurrentUser',
  annotations: { readOnlyHint: true },
  description: 'Retrieve the Redmine account this connection authenticates as. Use it to resolve "me" to a user ID, or to verify the connection works.',
  parameters: z.object({
    include: z.array(z.enum(['memberships', 'groups'])).optional().describe('Associations to embed.'),
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to fetch current user', session, log, async client => {
      log.info('Fetching current Redmine user');
      const res = await client.getCurrentUser(args.include);
      if (!res?.user) throw new UserError('Could not resolve the current user.');
      return formatUser(res.user);
    }),
});

// ==================== Time entries ====================

redmineServer.addTool({
  name: 'listTimeEntries',
  annotations: { readOnlyHint: true },
  description: 'List Redmine time entries, filterable by project, issue, user and date range. The hours total shown covers the returned page only — check the reported total before treating it as a full sum.',
  parameters: z.object({
    projectId: z.string().optional().describe('Restrict to one project (ID or identifier).'),
    issueId: z.union([z.string(), z.number()]).optional().describe('Restrict to one issue.'),
    userId: z.string().optional().describe('Restrict to one user ID, or "me" for the connected account.'),
    spentOn: z.string().optional().describe('Exact date (YYYY-MM-DD), or a Redmine operator expression like ">=2026-01-01".'),
    from: isoDate.optional().describe('Start of the date range (YYYY-MM-DD), inclusive.'),
    to: isoDate.optional().describe('End of the date range (YYYY-MM-DD), inclusive.'),
    offset: offsetParam,
    limit: limitParam,
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to list time entries', session, log, async client => {
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
    }),
});

redmineServer.addTool({
  name: 'getTimeEntry',
  annotations: { readOnlyHint: true },
  description: 'Retrieve one Redmine time entry by ID.',
  parameters: z.object({
    timeEntryId: z.union([z.string(), z.number()]).describe('The time-entry ID.'),
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to fetch time entry', session, log, async client => {
      log.info(`Fetching Redmine time entry ${args.timeEntryId}`);
      const res = await client.getTimeEntry(args.timeEntryId);
      if (!res?.time_entry) throw new UserError('Time entry not found.');
      return formatTimeEntry(res.time_entry);
    }),
});

redmineServer.addTool({
  name: 'createTimeEntry',
  annotations: { readOnlyHint: false },
  description: 'Log time against a Redmine issue or project. Pass exactly one of issueId or projectId. Most instances require activityId — call listTimeEntryActivities if you do not have it.',
  parameters: createTimeEntrySchema,
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to create time entry', session, log, async client => {
      log.info(`Logging ${args.hours}h against Redmine ${args.issueId ? `issue ${args.issueId}` : `project ${args.projectId}`}`);
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
    }),
});

redmineServer.addTool({
  name: 'updateTimeEntry',
  annotations: { readOnlyHint: false },
  description: 'Update an existing Redmine time entry. Fields you omit are left untouched.',
  parameters: z.object({
    timeEntryId: z.union([z.string(), z.number()]).describe('The time-entry ID to update.'),
    hours: z.number().positive().optional().describe('New hours value.'),
    spentOn: isoDate.optional().describe('New date (YYYY-MM-DD).'),
    activityId: z.number().int().optional().describe('New activity ID from listTimeEntryActivities.'),
    comments: z.string().max(1024).optional().describe('New comment text.'),
    issueId: z.union([z.string(), z.number()]).optional().describe('Move the entry onto a different issue.'),
    projectId: z.string().optional().describe('Move the entry onto a different project.'),
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to update time entry', session, log, async client => {
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
    }),
});

redmineServer.addTool({
  name: 'deleteTimeEntry',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Permanently delete a Redmine time entry. This cannot be undone.',
  parameters: z.object({
    timeEntryId: z.union([z.string(), z.number()]).describe('The time-entry ID to delete.'),
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to delete time entry', session, log, async client => {
      log.info(`Deleting Redmine time entry ${args.timeEntryId}`);
      await client.deleteTimeEntry(args.timeEntryId);
      return `Deleted time entry #${args.timeEntryId} permanently.`;
    }),
});

// ==================== Wiki ====================

redmineServer.addTool({
  name: 'listWikiPages',
  annotations: { readOnlyHint: true },
  description: "List the titles in a Redmine project's wiki. Page bodies are not included — call getWikiPage for one.",
  parameters: z.object({ projectId: projectIdParam }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to list wiki pages', session, log, async client => {
      log.info(`Listing Redmine wiki pages for project ${args.projectId}`);
      const res = await client.listWikiPages(args.projectId);
      return formatWikiPageList(res.items, res.page);
    }),
});

redmineServer.addTool({
  name: 'getWikiPage',
  annotations: { readOnlyHint: true },
  description: 'Retrieve one Redmine wiki page with its full text. Pass `version` to read a historical revision.',
  parameters: z.object({
    projectId: projectIdParam,
    title: z.string().min(1).describe('Page title exactly as it appears in listWikiPages (Redmine matches on the title, not a slug).'),
    version: z.number().int().min(1).optional().describe('Specific revision number. Omit for the current version.'),
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to fetch wiki page', session, log, async client => {
      log.info(`Fetching Redmine wiki page "${args.title}" in project ${args.projectId}`);
      const res = await client.getWikiPage(args.projectId, args.title, args.version);
      if (!res?.wiki_page) throw new UserError('Wiki page not found.');
      return formatWikiPage(res.wiki_page);
    }),
});

redmineServer.addTool({
  name: 'updateWikiPage',
  annotations: { readOnlyHint: false },
  description: 'Create or replace a Redmine wiki page. Redmine uses one endpoint for both — a title that does not exist yet is created. `text` REPLACES the whole page body, so read it first if you mean to edit rather than overwrite.',
  parameters: z.object({
    projectId: projectIdParam,
    title: z.string().min(1).describe('Page title. A title that does not exist yet creates a new page.'),
    text: z.string().describe('Full page body. This replaces the existing content entirely.'),
    comments: z.string().optional().describe('Revision comment describing the change.'),
    parentTitle: z.string().optional().describe('Title of the parent wiki page, to nest this one under it.'),
    version: z.number().int().optional().describe('Version being edited, for optimistic locking. If it does not match the current version Redmine rejects the write instead of clobbering a concurrent edit.'),
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to update wiki page', session, log, async client => {
      log.info(`Updating Redmine wiki page "${args.title}" in project ${args.projectId}`);
      await client.updateWikiPage(args.projectId, args.title, compact({
        text: args.text,
        comments: args.comments,
        parent_title: args.parentTitle,
        version: args.version,
      }));
      return `Saved wiki page "${args.title}" in project ${args.projectId}.`;
    }),
});

redmineServer.addTool({
  name: 'deleteWikiPage',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Permanently delete a Redmine wiki page and every revision of it. Child pages are attached to its parent rather than deleted.',
  parameters: z.object({
    projectId: projectIdParam,
    title: z.string().min(1).describe('Page title to delete.'),
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to delete wiki page', session, log, async client => {
      log.info(`Deleting Redmine wiki page "${args.title}" in project ${args.projectId}`);
      await client.deleteWikiPage(args.projectId, args.title);
      return `Deleted wiki page "${args.title}" and all its revisions.`;
    }),
});

// ==================== Versions ====================

redmineServer.addTool({
  name: 'listVersions',
  annotations: { readOnlyHint: true },
  description: 'List the versions (milestones / target releases) of a Redmine project, including versions shared from other projects.',
  parameters: z.object({ projectId: projectIdParam }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to list versions', session, log, async client => {
      log.info(`Listing Redmine versions for project ${args.projectId}`);
      const res = await client.listVersions(args.projectId);
      return formatVersionList(res.items, res.page);
    }),
});

redmineServer.addTool({
  name: 'getVersion',
  annotations: { readOnlyHint: true },
  description: 'Retrieve one Redmine version by ID.',
  parameters: z.object({
    versionId: z.union([z.string(), z.number()]).describe('The version ID from listVersions.'),
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to fetch version', session, log, async client => {
      log.info(`Fetching Redmine version ${args.versionId}`);
      const res = await client.getVersion(args.versionId);
      if (!res?.version) throw new UserError('Version not found.');
      return formatVersion(res.version);
    }),
});

redmineServer.addTool({
  name: 'createVersion',
  annotations: { readOnlyHint: false },
  description: 'Create a version (milestone / target release) in a Redmine project.',
  parameters: z.object({
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
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to create version', session, log, async client => {
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
    }),
});

redmineServer.addTool({
  name: 'updateVersion',
  annotations: { readOnlyHint: false },
  description: 'Update a Redmine version. Fields you omit are left untouched.',
  parameters: z.object({
    versionId: z.union([z.string(), z.number()]).describe('The version ID to update.'),
    name: z.string().optional().describe('New name.'),
    description: z.string().optional().describe('New description.'),
    status: z.enum(['open', 'locked', 'closed']).optional().describe('New status.'),
    dueDate: isoDate.optional().describe('New target date (YYYY-MM-DD).'),
    sharing: z.enum(['none', 'descendants', 'hierarchy', 'tree', 'system']).optional().describe('New sharing mode.'),
    wikiPageTitle: z.string().optional().describe('New associated wiki page title.'),
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to update version', session, log, async client => {
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
    }),
});

redmineServer.addTool({
  name: 'deleteVersion',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Permanently delete a Redmine version. Issues targeting it are not deleted — their target version is cleared.',
  parameters: z.object({
    versionId: z.union([z.string(), z.number()]).describe('The version ID to delete.'),
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to delete version', session, log, async client => {
      log.info(`Deleting Redmine version ${args.versionId}`);
      await client.deleteVersion(args.versionId);
      return `Deleted version #${args.versionId}. Issues that targeted it now have no target version.`;
    }),
});

// ==================== Issue categories ====================

redmineServer.addTool({
  name: 'listIssueCategories',
  annotations: { readOnlyHint: true },
  description: 'List the issue categories defined on a Redmine project. Their IDs are what createIssue/updateIssue take as categoryId.',
  parameters: z.object({ projectId: projectIdParam }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to list issue categories', session, log, async client => {
      log.info(`Listing Redmine issue categories for project ${args.projectId}`);
      const res = await client.listIssueCategories(args.projectId);
      return formatCategoryList(res.items, res.page);
    }),
});

redmineServer.addTool({
  name: 'createIssueCategory',
  annotations: { readOnlyHint: false },
  description: 'Create an issue category in a Redmine project.',
  parameters: z.object({
    projectId: projectIdParam,
    name: z.string().min(1).describe('Category name.'),
    assignedToId: z.number().int().optional().describe('User ID that issues in this category are auto-assigned to.'),
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to create issue category', session, log, async client => {
      log.info(`Creating Redmine issue category "${args.name}" in project ${args.projectId}`);
      const res = await client.createIssueCategory(args.projectId, compact({
        name: args.name,
        assigned_to_id: args.assignedToId,
      }));
      return `Created issue category "${args.name}" (ID: ${res?.issue_category?.id ?? '?'}).`;
    }),
});

redmineServer.addTool({
  name: 'deleteIssueCategory',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Delete a Redmine issue category. Issues in it are not deleted — pass reassignToId to move them to another category, otherwise their category is cleared.',
  parameters: z.object({
    categoryId: z.union([z.string(), z.number()]).describe('The category ID to delete, from listIssueCategories.'),
    reassignToId: z.number().int().optional().describe('Category ID to move affected issues into. Omit to leave them with no category.'),
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to delete issue category', session, log, async client => {
      log.info(`Deleting Redmine issue category ${args.categoryId}`);
      await client.deleteIssueCategory(args.categoryId, args.reassignToId);
      const fate = args.reassignToId ? `reassigned to category #${args.reassignToId}` : 'left with no category';
      return `Deleted issue category #${args.categoryId}. Affected issues were ${fate}.`;
    }),
});

// ==================== Memberships ====================

redmineServer.addTool({
  name: 'listMemberships',
  annotations: { readOnlyHint: true },
  description: 'List the members of a Redmine project with their roles. This is the reliable way to find user IDs for assignment without administrator rights, since listUsers is admin-only.',
  parameters: z.object({
    projectId: projectIdParam,
    offset: offsetParam,
    limit: limitParam,
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to list project members', session, log, async client => {
      log.info(`Listing Redmine memberships for project ${args.projectId} (offset=${args.offset})`);
      const res = await client.listMemberships(args.projectId, { offset: args.offset, limit: args.limit });
      return formatMembershipList(res.items, res.page);
    }),
});

redmineServer.addTool({
  name: 'createMembership',
  annotations: { readOnlyHint: false },
  description: 'Add a user or group to a Redmine project with one or more roles.',
  parameters: z.object({
    projectId: projectIdParam,
    userId: z.number().int().describe('User OR group ID to add. Redmine uses the same field for both.'),
    roleIds: z.array(z.number().int()).min(1).describe('Role IDs to grant. At least one is required.'),
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to add project member', session, log, async client => {
      log.info(`Adding member ${args.userId} to Redmine project ${args.projectId}`);
      const res = await client.createMembership(args.projectId, {
        user_id: args.userId,
        role_ids: args.roleIds,
      });
      return `Added user/group #${args.userId} to project ${args.projectId} (membership #${res?.membership?.id ?? '?'}).`;
    }),
});

redmineServer.addTool({
  name: 'deleteMembership',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Remove a member from a Redmine project by membership ID (from listMemberships — NOT a user ID).',
  parameters: z.object({
    membershipId: z.union([z.string(), z.number()]).describe('The membership ID from listMemberships.'),
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to remove project member', session, log, async client => {
      log.info(`Deleting Redmine membership ${args.membershipId}`);
      await client.deleteMembership(args.membershipId);
      return `Removed membership #${args.membershipId}.`;
    }),
});

// ==================== Lookups ====================

redmineServer.addTool({
  name: 'listTrackers',
  annotations: { readOnlyHint: true },
  description: 'List the Redmine trackers (Bug, Feature, Support, …). Their IDs are what createIssue takes as trackerId.',
  parameters: z.object({}),
  execute: (_args, { log, session }) =>
    withRedmineClient('Failed to list trackers', session, log, async client => {
      log.info('Listing Redmine trackers');
      const res = await client.listTrackers();
      return formatRefList('Trackers', 'trackers', res.items, res.page);
    }),
});

redmineServer.addTool({
  name: 'listIssueStatuses',
  annotations: { readOnlyHint: true },
  description: 'List every Redmine issue status, flagging which ones count as closed. Their IDs are what updateIssue takes as statusId.',
  parameters: z.object({}),
  execute: (_args, { log, session }) =>
    withRedmineClient('Failed to list issue statuses', session, log, async client => {
      log.info('Listing Redmine issue statuses');
      const res = await client.listIssueStatuses();
      return formatRefList('Issue statuses', 'issue statuses', res.items, res.page);
    }),
});

redmineServer.addTool({
  name: 'listIssuePriorities',
  annotations: { readOnlyHint: true },
  description: 'List the Redmine issue priorities (Low, Normal, High, …), flagging the default. Their IDs are what createIssue takes as priorityId.',
  parameters: z.object({}),
  execute: (_args, { log, session }) =>
    withRedmineClient('Failed to list issue priorities', session, log, async client => {
      log.info('Listing Redmine issue priorities');
      const res = await client.listIssuePriorities();
      return formatRefList('Issue priorities', 'issue priorities', res.items, res.page);
    }),
});

redmineServer.addTool({
  name: 'listTimeEntryActivities',
  annotations: { readOnlyHint: true },
  description: 'List the Redmine time-tracking activities (Development, Design, …), flagging the default. Their IDs are what createTimeEntry takes as activityId.',
  parameters: z.object({}),
  execute: (_args, { log, session }) =>
    withRedmineClient('Failed to list time entry activities', session, log, async client => {
      log.info('Listing Redmine time entry activities');
      const res = await client.listTimeEntryActivities();
      return formatRefList('Time entry activities', 'time entry activities', res.items, res.page);
    }),
});

redmineServer.addTool({
  name: 'listCustomFields',
  annotations: { readOnlyHint: true },
  description: 'List the custom fields defined on this Redmine, with the `cf_<id>` filter key for each one that is filterable. Requires administrator rights. Call this before using the customFields filter on listIssues.',
  parameters: z.object({}),
  execute: (_args, { log, session }) =>
    withRedmineClient('Failed to list custom fields', session, log, async client => {
      log.info('Listing Redmine custom fields');
      const res = await client.listCustomFields();
      return formatCustomFieldDefList(res.items, res.page);
    }),
});

// ==================== Search ====================

redmineServer.addTool({
  name: 'searchRedmine',
  annotations: { readOnlyHint: true },
  description: 'Full-text search across Redmine issues, wiki pages, news, documents and messages. Scope it with projectId, or narrow the object types with the boolean flags.',
  parameters: z.object({
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
  }),
  execute: (args, { log, session }) =>
    withRedmineClient('Failed to search Redmine', session, log, async client => {
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
    }),
});
