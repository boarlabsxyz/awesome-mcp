// src/github/schemas.ts
// Zod parameter schemas for every GitHub tool, plus the fragments they share.
//
// Separate from server.ts so the tool bodies (ops.ts) can be typed from these
// and unit-tested without constructing a FastMCP server, and so a future REST
// sibling validates with exactly what the MCP tool validates.
//
// Parameter names are camelCase (this repo's convention) where the reference
// implementation used GitHub's snake_case; ops.ts maps them back onto the
// request body. That mapping is not cosmetic: the reference sent its
// `autoInit` field to GitHub verbatim, where the API reads `auto_init`, so
// "initialize with a README" was silently ignored.

import { z } from 'zod';

import { GITHUB_MAX_PER_PAGE } from './apiHelpers.js';

const owner = z.string().min(1).describe('Repository owner — a user or organization login, e.g. "octocat" (the part after github.com/).');
const repo = z.string().min(1).describe('Repository name without the owner, e.g. "hello-world".');
const page = z.number().int().min(1).optional().describe('Page number, starting at 1. Every list response says which page to ask for next.');
const perPage = z.number().int().min(1).max(GITHUB_MAX_PER_PAGE).optional()
  .describe(`Results per page, 1–${GITHUB_MAX_PER_PAGE} (GitHub's default is 30).`);
const issueNumber = z.number().int().min(1).describe('Issue number — the #N shown on GitHub. Pull requests share this numbering.');
const pullNumber = z.number().int().min(1).describe('Pull request number — the #N shown on GitHub.');
const sortOrder = z.enum(['asc', 'desc']).optional().describe('Sort direction. Only meaningful together with `sort`.');

const repoRef = { owner, repo };

// ---- Repositories & files ----

export const searchRepositoriesSchema = z.object({
  query: z.string().min(1).describe('GitHub repository search query, e.g. "mcp language:typescript stars:>100" or "org:github topic:cli". See GitHub search syntax.'),
  page,
  perPage,
});

export const createRepositorySchema = z.object({
  name: z.string().min(1).describe('Name of the new repository.'),
  description: z.string().optional().describe('Repository description.'),
  private: z.boolean().optional().describe('Create it private. GitHub defaults to public.'),
  autoInit: z.boolean().optional().describe('Create an initial commit with an empty README, so the repository has a default branch straight away.'),
});

export const forkRepositorySchema = z.object({
  ...repoRef,
  organization: z.string().optional().describe('Organization to fork into. Defaults to the connected account.'),
});

export const getFileContentsSchema = z.object({
  ...repoRef,
  path: z.string().optional().default('')
    .describe('Path to a file or directory, e.g. "src/index.ts". Omit or pass "" for the repository root.'),
  ref: z.string().optional()
    .describe('Branch, tag or commit SHA to read from. Defaults to the repository\'s default branch.'),
});

export const createOrUpdateFileSchema = z.object({
  ...repoRef,
  path: z.string().min(1).describe('Path of the file to create or replace, e.g. "docs/README.md".'),
  content: z.string().describe('The complete new file content, as plain text. Replaces the whole file.'),
  message: z.string().min(1).describe('Commit message.'),
  branch: z.string().min(1).describe('Branch to commit to. It must already exist (see createBranch).'),
  sha: z.string().optional().describe('Blob SHA of the file being replaced, from getFileContents. Pass it to make the write fail if the file changed since you read it; omit it to overwrite whatever is there.'),
});

const fileToPush = z.object({
  path: z.string().min(1).describe('Repository-relative path, e.g. "src/app.ts".'),
  content: z.string().describe('Complete UTF-8 text content of the file.'),
});

export const pushFilesSchema = z.object({
  ...repoRef,
  branch: z.string().min(1).describe('Existing branch to commit to, e.g. "main" or "feature/x". Create it first with createBranch if needed.'),
  files: z.array(fileToPush).min(1).max(100).describe('Files to add or replace in one commit (1–100). Each replaces the whole file.'),
  message: z.string().min(1).describe('Commit message.'),
});

export const createBranchSchema = z.object({
  ...repoRef,
  branch: z.string().min(1).describe('Name of the new branch, e.g. "feature/login".'),
  fromBranch: z.string().optional().describe('Branch to start from. Defaults to the repository\'s default branch.'),
});

export const listCommitsSchema = z.object({
  ...repoRef,
  sha: z.string().optional().describe('Branch name, tag or commit SHA to list history from. Defaults to the default branch.'),
  path: z.string().optional().describe('Only commits that touched this file or directory.'),
  author: z.string().optional().describe('Only commits by this GitHub login or email address.'),
  page,
  perPage,
});

// ---- Issues ----

export const listIssuesSchema = z.object({
  ...repoRef,
  state: z.enum(['open', 'closed', 'all']).optional().describe('Issue state (default: open).'),
  labels: z.array(z.string()).optional().describe('Only issues carrying ALL of these labels.'),
  sort: z.enum(['created', 'updated', 'comments']).optional().describe('Sort field (default: created).'),
  direction: sortOrder,
  since: z.string().optional().describe('Only issues updated at or after this ISO 8601 timestamp, e.g. "2026-01-01T00:00:00Z".'),
  page,
  perPage,
});

export const getIssueSchema = z.object({ ...repoRef, issueNumber });

export const createIssueSchema = z.object({
  ...repoRef,
  title: z.string().min(1).describe('Issue title.'),
  body: z.string().optional().describe('Issue body (GitHub Markdown).'),
  assignees: z.array(z.string()).optional().describe('Logins to assign.'),
  milestone: z.number().int().optional().describe('Milestone NUMBER (not title).'),
  labels: z.array(z.string()).optional().describe('Label names to apply.'),
});

export const updateIssueSchema = z.object({
  ...repoRef,
  issueNumber,
  title: z.string().optional().describe('New title.'),
  body: z.string().optional().describe('New body. Replaces the whole body.'),
  assignees: z.array(z.string()).optional().describe('The COMPLETE set of assignees — replaces the current set; [] clears them.'),
  milestone: z.number().int().nullable().optional().describe('Milestone NUMBER, or null to remove the milestone.'),
  labels: z.array(z.string()).optional().describe('The COMPLETE set of labels — replaces the current set; [] clears them.'),
  state: z.enum(['open', 'closed']).optional().describe('Open or close the issue.'),
  stateReason: z.enum(['completed', 'not_planned', 'reopened']).optional().describe('Why the state changed. Use with state: closed → completed / not_planned; open → reopened.'),
});

export const addIssueCommentSchema = z.object({
  ...repoRef,
  issueNumber,
  body: z.string().min(1).describe('Comment text (GitHub Markdown).'),
});

// ---- Search ----

export const searchCodeSchema = z.object({
  query: z.string().min(1).describe('Code search query, e.g. "useState repo:facebook/react" or "addClass in:file language:js". Add repo:, org: or user: to narrow it.'),
  page,
  perPage,
});

export const searchIssuesSchema = z.object({
  query: z.string().min(1).describe('Issue/PR search query, e.g. "repo:octocat/hello-world is:pr is:open review-requested:@me" or "is:issue label:bug author:octocat".'),
  sort: z.enum([
    'comments', 'reactions', 'reactions-+1', 'reactions--1', 'reactions-smile',
    'reactions-thinking_face', 'reactions-heart', 'reactions-tada', 'interactions', 'created', 'updated',
  ]).optional().describe('Sort field. Omit for best match.'),
  order: sortOrder,
  page,
  perPage,
});

export const searchUsersSchema = z.object({
  query: z.string().min(1).describe('User search query, e.g. "tom location:berlin" or "type:org mcp".'),
  sort: z.enum(['followers', 'repositories', 'joined']).optional().describe('Sort field. Omit for best match.'),
  order: sortOrder,
  page,
  perPage,
});

// ---- Pull requests ----

export const listPullRequestsSchema = z.object({
  ...repoRef,
  state: z.enum(['open', 'closed', 'all']).optional().describe('Pull request state (default: open). "closed" includes merged ones.'),
  head: z.string().optional().describe('Only PRs from this head, as "user:branch" or "org:branch".'),
  base: z.string().optional().describe('Only PRs targeting this base branch.'),
  sort: z.enum(['created', 'updated', 'popularity', 'long-running']).optional().describe('Sort field (default: created).'),
  direction: sortOrder,
  page,
  perPage,
});

export const getPullRequestSchema = z.object({ ...repoRef, pullNumber });

export const createPullRequestSchema = z.object({
  ...repoRef,
  title: z.string().min(1).describe('Pull request title.'),
  body: z.string().optional().describe('Pull request description (GitHub Markdown).'),
  head: z.string().min(1).describe('Branch with the changes. For a branch in a fork, "user:branch".'),
  base: z.string().min(1).describe('Branch to merge into, e.g. "main".'),
  draft: z.boolean().optional().describe('Open as a draft.'),
  maintainerCanModify: z.boolean().optional().describe('Let maintainers of the base repository push to the head branch.'),
});

const reviewComment = z.object({
  path: z.string().min(1).describe('File path the comment is on, relative to the repository root.'),
  body: z.string().min(1).describe('Comment text.'),
  line: z.number().int().min(1).optional().describe('Line number in the file. Give this OR position.'),
  side: z.enum(['LEFT', 'RIGHT']).optional().describe('With line: RIGHT for the new version (default), LEFT for the old.'),
  position: z.number().int().min(1).optional().describe('Legacy: line offset within the diff hunk. Give this OR line.'),
});

export const createPullRequestReviewSchema = z.object({
  ...repoRef,
  pullNumber,
  event: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']).describe('The review verdict to submit.'),
  body: z.string().optional().describe('Review summary. Required for REQUEST_CHANGES and COMMENT.'),
  commitId: z.string().optional().describe('SHA of the commit being reviewed. Defaults to the PR\'s latest commit.'),
  comments: z.array(reviewComment).optional().describe('Inline comments to attach to the review.'),
});

export const mergePullRequestSchema = z.object({
  ...repoRef,
  pullNumber,
  mergeMethod: z.enum(['merge', 'squash', 'rebase']).optional().describe('Merge method (default: merge). The repository may disallow some methods.'),
  commitTitle: z.string().optional().describe('Title for the merge or squash commit.'),
  commitMessage: z.string().optional().describe('Extra detail for the merge or squash commit message.'),
  expectedHeadSha: z.string().optional().describe('Only merge if the PR head is still this SHA (from getPullRequest). Guards against merging commits pushed after you reviewed.'),
});

export const getPullRequestFilesSchema = z.object({
  ...repoRef,
  pullNumber,
  includePatch: z.boolean().optional().default(true).describe('Include each file\'s diff hunk (capped per file). Set false for just the file list.'),
  page,
  perPage,
});

export const getPullRequestStatusSchema = z.object({ ...repoRef, pullNumber });

export const updatePullRequestBranchSchema = z.object({
  ...repoRef,
  pullNumber,
  expectedHeadSha: z.string().optional().describe('Only update if the PR head is still this SHA.'),
});

export const getPullRequestCommentsSchema = z.object({ ...repoRef, pullNumber, page, perPage });

export const getPullRequestReviewsSchema = z.object({ ...repoRef, pullNumber, page, perPage });

export type SearchRepositoriesArgs = z.infer<typeof searchRepositoriesSchema>;
export type CreateRepositoryArgs = z.infer<typeof createRepositorySchema>;
export type ForkRepositoryArgs = z.infer<typeof forkRepositorySchema>;
export type GetFileContentsArgs = z.infer<typeof getFileContentsSchema>;
export type CreateOrUpdateFileArgs = z.infer<typeof createOrUpdateFileSchema>;
export type PushFilesArgs = z.infer<typeof pushFilesSchema>;
export type CreateBranchArgs = z.infer<typeof createBranchSchema>;
export type ListCommitsArgs = z.infer<typeof listCommitsSchema>;
export type ListIssuesArgs = z.infer<typeof listIssuesSchema>;
export type GetIssueArgs = z.infer<typeof getIssueSchema>;
export type CreateIssueArgs = z.infer<typeof createIssueSchema>;
export type UpdateIssueArgs = z.infer<typeof updateIssueSchema>;
export type AddIssueCommentArgs = z.infer<typeof addIssueCommentSchema>;
export type SearchCodeArgs = z.infer<typeof searchCodeSchema>;
export type SearchIssuesArgs = z.infer<typeof searchIssuesSchema>;
export type SearchUsersArgs = z.infer<typeof searchUsersSchema>;
export type ListPullRequestsArgs = z.infer<typeof listPullRequestsSchema>;
export type GetPullRequestArgs = z.infer<typeof getPullRequestSchema>;
export type CreatePullRequestArgs = z.infer<typeof createPullRequestSchema>;
export type CreatePullRequestReviewArgs = z.infer<typeof createPullRequestReviewSchema>;
export type MergePullRequestArgs = z.infer<typeof mergePullRequestSchema>;
export type GetPullRequestFilesArgs = z.infer<typeof getPullRequestFilesSchema>;
export type GetPullRequestStatusArgs = z.infer<typeof getPullRequestStatusSchema>;
export type UpdatePullRequestBranchArgs = z.infer<typeof updatePullRequestBranchSchema>;
export type GetPullRequestCommentsArgs = z.infer<typeof getPullRequestCommentsSchema>;
export type GetPullRequestReviewsArgs = z.infer<typeof getPullRequestReviewsSchema>;
