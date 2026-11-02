// src/redmine/restRoutes.ts
// Redmine's admin and destructive REST writes as data: one descriptor per
// endpoint, which webServer.ts registers from a loop. Same shape and reasons as
// src/github/restRoutes.ts: one handler holds the validation, status and error
// contract, and each descriptor is a plain function of (client, args) that a
// test can drive against a stub. Every body comes from the builders in ops.ts,
// so the tool and the route cannot send Redmine different requests.
//
// Each route answers raw upstream JSON rather than the tool's formatted string.
// Redmine answers most writes 204 with no body, so an update re-reads the
// record instead of echoing the request back.
//
// deleteProject is absent on purpose: it cascades into subprojects' issues,
// wiki, versions and time entries with no recycle bin, and it was left out when
// the other destructive routes were signed off. archiveProject is the
// reversible way to do this over REST.

import type { ZodTypeAny } from 'zod';

import type { RedmineClient } from './apiHelpers.js';
import * as ops from './ops.js';
import * as schemas from './schemas.js';

/** The parts of an Express request a descriptor reads. */
export interface RedmineRestRequest {
  params: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface RedmineWriteResult {
  status: number;
  body: unknown;
}

export interface RedmineWriteRoute {
  path: string;
  tool: string;
  schema: ZodTypeAny;
  /** Path params, which override same-named body keys. */
  params: (req: RedmineRestRequest) => Record<string, unknown>;
  run: (client: RedmineClient, args: any) => Promise<RedmineWriteResult>;
  fallback: string;
  /** Named in the 403 text, as on the MCP read tools. */
  permission?: string;
  adminOnly?: boolean;
}

const param = (req: RedmineRestRequest, name: string): string => {
  const v = req.params[name];
  return Array.isArray(v) ? v.join('/') : (v ?? '');
};
/** A path number. NaN on garbage, so the schema answers 400 instead of guessing. */
const num = (req: RedmineRestRequest, name: string): number => Number(param(req, name));

const nothingToUpdate = (): RedmineWriteResult => ({
  status: 400,
  body: { error: 'Nothing to update — pass at least one field to change.' },
});

/** 201 with Redmine's payload, or 502: the request was valid, so 400 would misdirect. */
function created(result: object | undefined, key: string, label: string): RedmineWriteResult {
  return (result as Record<string, unknown> | undefined)?.[key]
    ? { status: 201, body: result }
    : { status: 502, body: { error: `Redmine accepted the request but returned no ${label}` } };
}

/**
 * Whether the user is on the issue's watcher list after a write: true, false,
 * or null when that cannot be read. Redmine answers 204 whether or not the list
 * changed, and only includes watchers for accounts with view_issue_watchers, so
 * an absent list or a failed re-read is "unconfirmed", never a failure of the
 * write that already succeeded.
 */
async function watching(client: RedmineClient, issueId: number | string, userId: number): Promise<boolean | null> {
  try {
    const res = await client.getIssue(issueId, ['watchers']);
    const watchers = res?.issue?.watchers;
    return Array.isArray(watchers) ? watchers.some((w) => w.id === userId) : null;
  } catch {
    return null;
  }
}

export const REDMINE_WRITE_ROUTES: ReadonlyArray<RedmineWriteRoute> = [
  // ---- Issues ----
  {
    path: '/api/v1/redmine/issues/:issueId/delete', tool: 'deleteIssue', schema: schemas.deleteIssueSchema,
    params: (req) => ({ issueId: param(req, 'issueId') }),
    run: async (client, args) => {
      await client.deleteIssue(args.issueId);
      return { status: 200, body: { deleted: true, issueId: args.issueId } };
    },
    fallback: 'Failed to delete issue', permission: 'delete_issues',
  },
  {
    path: '/api/v1/redmine/issues/:issueId/watchers', tool: 'addIssueWatcher', schema: schemas.addIssueWatcherSchema,
    params: (req) => ({ issueId: param(req, 'issueId') }),
    run: async (client, args) => {
      await client.addIssueWatcher(args.issueId, args.userId);
      return { status: 200, body: { issueId: args.issueId, userId: args.userId, watching: await watching(client, args.issueId, args.userId) } };
    },
    fallback: 'Failed to add watcher', permission: 'add_issue_watchers',
  },
  {
    path: '/api/v1/redmine/issues/:issueId/watchers/:userId/remove', tool: 'removeIssueWatcher', schema: schemas.removeIssueWatcherSchema,
    params: (req) => ({ issueId: param(req, 'issueId'), userId: num(req, 'userId') }),
    run: async (client, args) => {
      await client.removeIssueWatcher(args.issueId, args.userId);
      return { status: 200, body: { issueId: args.issueId, userId: args.userId, watching: await watching(client, args.issueId, args.userId) } };
    },
    fallback: 'Failed to remove watcher', permission: 'delete_issue_watchers',
  },
  {
    path: '/api/v1/redmine/issues/:issueId/relations', tool: 'createIssueRelation', schema: schemas.createIssueRelationSchema,
    params: (req) => ({ issueId: param(req, 'issueId') }),
    run: async (client, args) => created(await client.createIssueRelation(args.issueId, ops.relationBody(args)), 'relation', 'relation'),
    fallback: 'Failed to create issue relation', permission: 'manage_issue_relations',
  },
  {
    path: '/api/v1/redmine/relations/:relationId/delete', tool: 'deleteIssueRelation', schema: schemas.deleteIssueRelationSchema,
    params: (req) => ({ relationId: param(req, 'relationId') }),
    run: async (client, args) => {
      await client.deleteIssueRelation(args.relationId);
      return { status: 200, body: { deleted: true, relationId: args.relationId } };
    },
    fallback: 'Failed to delete issue relation', permission: 'manage_issue_relations',
  },

  // ---- Projects ----
  {
    path: '/api/v1/redmine/projects', tool: 'createProject', schema: schemas.createProjectSchema,
    params: () => ({}),
    run: async (client, args) => created(await client.createProject(ops.projectBody(args)), 'project', 'project'),
    fallback: 'Failed to create project', permission: 'add_project',
  },
  {
    path: '/api/v1/redmine/projects/:projectId', tool: 'updateProject', schema: schemas.updateProjectSchema,
    params: (req) => ({ projectId: param(req, 'projectId') }),
    run: async (client, args) => {
      const body = ops.projectBody(args);
      if (Object.keys(body).length === 0) return nothingToUpdate();
      await client.updateProject(args.projectId, body);
      return { status: 200, body: await client.getProject(args.projectId) };
    },
    fallback: 'Failed to update project', permission: 'edit_project',
  },
  {
    path: '/api/v1/redmine/projects/:projectId/archive', tool: 'archiveProject', schema: schemas.archiveProjectSchema,
    params: (req) => ({ projectId: param(req, 'projectId') }),
    run: async (client, args) => {
      await client.archiveProject(args.projectId);
      return { status: 200, body: { archived: true, projectId: args.projectId } };
    },
    fallback: 'Failed to archive project', adminOnly: true,
  },
  {
    path: '/api/v1/redmine/projects/:projectId/unarchive', tool: 'unarchiveProject', schema: schemas.unarchiveProjectSchema,
    params: (req) => ({ projectId: param(req, 'projectId') }),
    run: async (client, args) => {
      await client.unarchiveProject(args.projectId);
      return { status: 200, body: { archived: false, projectId: args.projectId } };
    },
    fallback: 'Failed to unarchive project', adminOnly: true,
  },

  // ---- Time entries ----
  {
    path: '/api/v1/redmine/time-entries/:timeEntryId', tool: 'updateTimeEntry', schema: schemas.updateTimeEntrySchema,
    params: (req) => ({ timeEntryId: param(req, 'timeEntryId') }),
    run: async (client, args) => {
      const body = ops.timeEntryUpdateBody(args);
      if (Object.keys(body).length === 0) return nothingToUpdate();
      await client.updateTimeEntry(args.timeEntryId, body);
      return { status: 200, body: await client.getTimeEntry(args.timeEntryId) };
    },
    fallback: 'Failed to update time entry', permission: 'edit_time_entries',
  },
  {
    path: '/api/v1/redmine/time-entries/:timeEntryId/delete', tool: 'deleteTimeEntry', schema: schemas.deleteTimeEntrySchema,
    params: (req) => ({ timeEntryId: param(req, 'timeEntryId') }),
    run: async (client, args) => {
      await client.deleteTimeEntry(args.timeEntryId);
      return { status: 200, body: { deleted: true, timeEntryId: args.timeEntryId } };
    },
    fallback: 'Failed to delete time entry', permission: 'edit_time_entries',
  },

  // ---- Wiki ----
  {
    path: '/api/v1/redmine/projects/:projectId/wiki/:title/delete', tool: 'deleteWikiPage', schema: schemas.deleteWikiPageSchema,
    params: (req) => ({ projectId: param(req, 'projectId'), title: param(req, 'title') }),
    run: async (client, args) => {
      await client.deleteWikiPage(args.projectId, args.title);
      return { status: 200, body: { deleted: true, projectId: args.projectId, title: args.title } };
    },
    fallback: 'Failed to delete wiki page', permission: 'delete_wiki_pages',
  },

  // ---- Versions ----
  {
    path: '/api/v1/redmine/projects/:projectId/versions', tool: 'createVersion', schema: schemas.createVersionSchema,
    params: (req) => ({ projectId: param(req, 'projectId') }),
    run: async (client, args) => created(await client.createVersion(args.projectId, ops.versionBody(args)), 'version', 'version'),
    fallback: 'Failed to create version', permission: 'manage_versions',
  },
  {
    path: '/api/v1/redmine/versions/:versionId', tool: 'updateVersion', schema: schemas.updateVersionSchema,
    params: (req) => ({ versionId: param(req, 'versionId') }),
    run: async (client, args) => {
      const body = ops.versionBody(args);
      if (Object.keys(body).length === 0) return nothingToUpdate();
      await client.updateVersion(args.versionId, body);
      return { status: 200, body: await client.getVersion(args.versionId) };
    },
    fallback: 'Failed to update version', permission: 'manage_versions',
  },
  {
    path: '/api/v1/redmine/versions/:versionId/delete', tool: 'deleteVersion', schema: schemas.deleteVersionSchema,
    params: (req) => ({ versionId: param(req, 'versionId') }),
    run: async (client, args) => {
      await client.deleteVersion(args.versionId);
      return { status: 200, body: { deleted: true, versionId: args.versionId } };
    },
    fallback: 'Failed to delete version', permission: 'manage_versions',
  },

  // ---- Issue categories ----
  {
    path: '/api/v1/redmine/projects/:projectId/issue-categories', tool: 'createIssueCategory', schema: schemas.createIssueCategorySchema,
    params: (req) => ({ projectId: param(req, 'projectId') }),
    run: async (client, args) => created(await client.createIssueCategory(args.projectId, ops.categoryBody(args)), 'issue_category', 'issue category'),
    fallback: 'Failed to create issue category', permission: 'manage_categories',
  },
  {
    path: '/api/v1/redmine/issue-categories/:categoryId/delete', tool: 'deleteIssueCategory', schema: schemas.deleteIssueCategorySchema,
    params: (req) => ({ categoryId: param(req, 'categoryId') }),
    run: async (client, args) => {
      await client.deleteIssueCategory(args.categoryId, args.reassignToId);
      return { status: 200, body: { deleted: true, categoryId: args.categoryId, reassignedTo: args.reassignToId ?? null } };
    },
    fallback: 'Failed to delete issue category', permission: 'manage_categories',
  },

  // ---- Memberships ----
  {
    path: '/api/v1/redmine/projects/:projectId/memberships', tool: 'createMembership', schema: schemas.createMembershipSchema,
    params: (req) => ({ projectId: param(req, 'projectId') }),
    run: async (client, args) => created(await client.createMembership(args.projectId, ops.membershipBody(args)), 'membership', 'membership'),
    fallback: 'Failed to create membership', permission: 'manage_members',
  },
  {
    path: '/api/v1/redmine/memberships/:membershipId/delete', tool: 'deleteMembership', schema: schemas.deleteMembershipSchema,
    params: (req) => ({ membershipId: param(req, 'membershipId') }),
    run: async (client, args) => {
      await client.deleteMembership(args.membershipId);
      return { status: 200, body: { deleted: true, membershipId: args.membershipId } };
    },
    fallback: 'Failed to delete membership', permission: 'manage_members',
  },
];

/** The body merged with the path params; a URL and a mismatched body key cannot disagree. */
export function writeArgs(route: RedmineWriteRoute, req: RedmineRestRequest): Record<string, unknown> {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
  return { ...body, ...route.params(req) };
}
