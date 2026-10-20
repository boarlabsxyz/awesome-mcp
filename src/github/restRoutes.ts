// src/github/restRoutes.ts
// The GitHub REST data plane (/api/v1/github/*) as data: one descriptor per
// endpoint, which webServer.ts registers from a loop. Kept out of webServer.ts
// for two reasons. A table plus one generic handler is what keeps the
// validation, status and error contract in one place (the HubSpot / Redmine /
// Outline lesson). And a descriptor is a plain function of (client, request),
// so every route's argument mapping and response shape can be tested against a
// stubbed client — a handler inside webServer.ts cannot be.
//
// Every request is validated with the MCP tool's own Zod schema, built from the
// same argument names, and every upstream call goes through the same READS
// builder or perform* function the tool uses, so the two surfaces cannot ask
// GitHub different questions or answer the same one two ways.

import type { ZodTypeAny } from 'zod';

import { qarr, qflag, qoptint, qstr } from '../util/queryParams.js';
import type { GitHubClient } from './apiHelpers.js';
import * as ops from './ops.js';
import * as schemas from './schemas.js';

/** The parts of an Express request a descriptor reads. */
export interface GitHubRestRequest {
  params: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  body?: unknown;
}

export interface GitHubReadRoute {
  /** Express 5 path. Array order is registration order. */
  path: string;
  tool: string;
  schema: ZodTypeAny;
  args: (req: GitHubRestRequest) => Record<string, unknown>;
  /** The JSON answer: raw upstream data, with a `page` envelope on lists. */
  json: (client: GitHubClient, args: any) => Promise<unknown>;
  /** `?format=text` — exactly what the MCP tool returns. */
  text: (client: GitHubClient, args: any) => Promise<string>;
  fallback: string;
}

export interface GitHubWriteRoute {
  path: string;
  tool: string;
  schema: ZodTypeAny;
  /** Path params, which override same-named body keys. */
  params: (req: GitHubRestRequest) => Record<string, unknown>;
  run: (client: GitHubClient, args: any) => Promise<{ status: number; body: unknown }>;
  fallback: string;
}

const REPO = '/api/v1/github/repos/:owner/:repo';
/** Express 5 wildcard: the rest of the URL as a file path, optional so the root lists. */
const CONTENTS = `${REPO}/contents{/*path}`;

const str = (v: unknown): string | undefined => qstr(v) || undefined;
const param = (req: GitHubRestRequest, name: string): string => {
  const v = req.params[name];
  return Array.isArray(v) ? v.join('/') : (v ?? '');
};
/** A path number. NaN on garbage, so the schema answers 400 instead of guessing. */
const num = (req: GitHubRestRequest, name: string): number => Number(param(req, name));
const repo = (req: GitHubRestRequest) => ({ owner: param(req, 'owner'), repo: param(req, 'repo') });
const paging = (req: GitHubRestRequest) => ({ page: qoptint(req.query.page), perPage: qoptint(req.query.perPage) });

async function listJson(client: GitHubClient, read: ops.GitHubRead) {
  const { data, page } = await ops.runRead<unknown[]>(client, read);
  return { items: data, page };
}

async function searchJson(client: GitHubClient, read: ops.GitHubRead) {
  const { data, page, hiddenByAccessRules } = await ops.runRead<{ total_count: number; incomplete_results: boolean; items: unknown[] }>(client, read);
  // hiddenByAccessRules appears only when the connector's rules removed hits;
  // total_count is GitHub's and still counts them.
  return {
    total_count: data.total_count, incomplete_results: data.incomplete_results, items: data.items, page,
    ...(hiddenByAccessRules ? { hiddenByAccessRules } : {}),
  };
}

async function rawJson(client: GitHubClient, read: ops.GitHubRead) {
  return (await ops.runRead<unknown>(client, read)).data;
}

// Static segments (/search/...) and the per-repo routes never share a
// segment count at the same position, so order only matters within a group.
export const GITHUB_READ_ROUTES: ReadonlyArray<GitHubReadRoute> = [
  {
    path: '/api/v1/github/search/repositories', tool: 'searchRepositories', schema: schemas.searchRepositoriesSchema,
    args: req => ({ query: str(req.query.q), ...paging(req) }),
    json: (c, a) => searchJson(c, ops.READS.searchRepositories(a)), text: ops.opSearchRepositories,
    fallback: 'Failed to search repositories',
  },
  {
    path: '/api/v1/github/search/code', tool: 'searchCode', schema: schemas.searchCodeSchema,
    args: req => ({ query: str(req.query.q), ...paging(req) }),
    json: (c, a) => searchJson(c, ops.READS.searchCode(a)), text: ops.opSearchCode,
    fallback: 'Failed to search code',
  },
  {
    path: '/api/v1/github/search/issues', tool: 'searchIssues', schema: schemas.searchIssuesSchema,
    args: req => ({ query: str(req.query.q), sort: str(req.query.sort), order: str(req.query.order), ...paging(req) }),
    json: (c, a) => searchJson(c, ops.READS.searchIssues(a)), text: ops.opSearchIssues,
    fallback: 'Failed to search issues',
  },
  {
    path: '/api/v1/github/search/users', tool: 'searchUsers', schema: schemas.searchUsersSchema,
    args: req => ({ query: str(req.query.q), sort: str(req.query.sort), order: str(req.query.order), ...paging(req) }),
    json: (c, a) => searchJson(c, ops.READS.searchUsers(a)), text: ops.opSearchUsers,
    fallback: 'Failed to search users',
  },
  {
    path: CONTENTS, tool: 'getFileContents', schema: schemas.getFileContentsSchema,
    args: req => ({ ...repo(req), path: param(req, 'path'), ref: str(req.query.ref) }),
    json: (c, a) => rawJson(c, ops.READS.getFileContents(a)), text: ops.opGetFileContents,
    fallback: 'Failed to read repository contents',
  },
  {
    path: `${REPO}/commits`, tool: 'listCommits', schema: schemas.listCommitsSchema,
    args: req => ({ ...repo(req), sha: str(req.query.sha), path: str(req.query.path), author: str(req.query.author), ...paging(req) }),
    json: (c, a) => listJson(c, ops.READS.listCommits(a)), text: ops.opListCommits,
    fallback: 'Failed to list commits',
  },
  {
    path: `${REPO}/issues`, tool: 'listIssues', schema: schemas.listIssuesSchema,
    args: req => ({
      ...repo(req), state: str(req.query.state), labels: qarr(req.query.labels), sort: str(req.query.sort),
      direction: str(req.query.direction), since: str(req.query.since), ...paging(req),
    }),
    json: (c, a) => listJson(c, ops.READS.listIssues(a)), text: ops.opListIssues,
    fallback: 'Failed to list issues',
  },
  {
    path: `${REPO}/issues/:issueNumber`, tool: 'getIssue', schema: schemas.getIssueSchema,
    args: req => ({ ...repo(req), issueNumber: num(req, 'issueNumber') }),
    json: (c, a) => rawJson(c, ops.READS.getIssue(a)), text: ops.opGetIssue,
    fallback: 'Failed to get issue',
  },
  {
    path: `${REPO}/pulls`, tool: 'listPullRequests', schema: schemas.listPullRequestsSchema,
    args: req => ({
      ...repo(req), state: str(req.query.state), head: str(req.query.head), base: str(req.query.base),
      sort: str(req.query.sort), direction: str(req.query.direction), ...paging(req),
    }),
    json: (c, a) => listJson(c, ops.READS.listPullRequests(a)), text: ops.opListPullRequests,
    fallback: 'Failed to list pull requests',
  },
  {
    path: `${REPO}/pulls/:pullNumber`, tool: 'getPullRequest', schema: schemas.getPullRequestSchema,
    args: req => ({ ...repo(req), pullNumber: num(req, 'pullNumber') }),
    json: (c, a) => rawJson(c, ops.READS.getPullRequest(a)), text: ops.opGetPullRequest,
    fallback: 'Failed to get pull request',
  },
  {
    path: `${REPO}/pulls/:pullNumber/files`, tool: 'getPullRequestFiles', schema: schemas.getPullRequestFilesSchema,
    args: req => ({ ...repo(req), pullNumber: num(req, 'pullNumber'), includePatch: qflag(req.query.includePatch), ...paging(req) }),
    json: (c, a) => listJson(c, ops.READS.getPullRequestFiles(a)), text: ops.opGetPullRequestFiles,
    fallback: 'Failed to list pull request files',
  },
  {
    path: `${REPO}/pulls/:pullNumber/status`, tool: 'getPullRequestStatus', schema: schemas.getPullRequestStatusSchema,
    args: req => ({ ...repo(req), pullNumber: num(req, 'pullNumber') }),
    json: ops.fetchPullRequestStatus, text: ops.opGetPullRequestStatus,
    fallback: 'Failed to get pull request checks',
  },
  {
    path: `${REPO}/pulls/:pullNumber/comments`, tool: 'getPullRequestComments', schema: schemas.getPullRequestCommentsSchema,
    args: req => ({ ...repo(req), pullNumber: num(req, 'pullNumber'), ...paging(req) }),
    json: (c, a) => listJson(c, ops.READS.getPullRequestComments(a)), text: ops.opGetPullRequestComments,
    fallback: 'Failed to list review comments',
  },
  {
    path: `${REPO}/pulls/:pullNumber/reviews`, tool: 'getPullRequestReviews', schema: schemas.getPullRequestReviewsSchema,
    args: req => ({ ...repo(req), pullNumber: num(req, 'pullNumber'), ...paging(req) }),
    json: (c, a) => listJson(c, ops.READS.getPullRequestReviews(a)), text: ops.opGetPullRequestReviews,
    fallback: 'Failed to list reviews',
  },
];

export const GITHUB_WRITE_ROUTES: ReadonlyArray<GitHubWriteRoute> = [
  {
    path: `${REPO}/issues`, tool: 'createIssue', schema: schemas.createIssueSchema,
    params: repo,
    // 201 even when GitHub dropped labels/assignees: the issue exists, and an
    // error status would invite a retry that files it twice. notApplied says
    // what did not stick.
    run: async (c, a) => ({ status: 201, body: await ops.performCreateIssue(c, a) }),
    fallback: 'Failed to create issue',
  },
  {
    path: `${REPO}/issues/:issueNumber/comments`, tool: 'addIssueComment', schema: schemas.addIssueCommentSchema,
    params: req => ({ ...repo(req), issueNumber: num(req, 'issueNumber') }),
    run: async (c, a) => ({ status: 201, body: await ops.performAddIssueComment(c, a) }),
    fallback: 'Failed to add comment',
  },
  {
    path: `${REPO}/push`, tool: 'pushFiles', schema: schemas.pushFilesSchema,
    params: repo,
    run: async (c, a) => {
      const result = await ops.performPushFiles(c, a);
      // 200, not 201, when nothing changed: no commit was created.
      return { status: result.pushed ? 201 : 200, body: result };
    },
    fallback: 'Failed to push files',
  },
  {
    path: CONTENTS, tool: 'createOrUpdateFile', schema: schemas.createOrUpdateFileSchema,
    params: req => ({ ...repo(req), path: param(req, 'path') }),
    run: async (c, a) => {
      const result = await ops.performCreateOrUpdateFile(c, a);
      return { status: result.created ? 201 : 200, body: result };
    },
    fallback: 'Failed to write file',
  },
  {
    path: `${REPO}/pulls/:pullNumber/merge`, tool: 'mergePullRequest', schema: schemas.mergePullRequestSchema,
    params: req => ({ ...repo(req), pullNumber: num(req, 'pullNumber') }),
    run: async (c, a) => {
      const result = await ops.performMergePullRequest(c, a);
      // A 200 that says merged:false did not do what was asked; a pipeline
      // checking only the status must not read it as merged.
      return { status: result.merged ? 200 : 409, body: result };
    },
    fallback: 'Failed to merge pull request',
  },
];

/**
 * Build a write route's args: body first, path params over it, so a URL and a
 * mismatched body cannot disagree about which repository is written.
 */
export function writeArgs(route: GitHubWriteRoute, req: GitHubRestRequest): Record<string, unknown> {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
  return { ...body, ...route.params(req) };
}
