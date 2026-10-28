// src/github/server.ts
// GitHub MCP server: repositories, files, branches, commits, issues, pull
// requests and search, against the GitHub REST API (api.github.com).
//
// Tool surface ported from the MIT-licensed reference implementation
//   https://github.com/modelcontextprotocol/servers-archived @ 9be4674d (src/github)
// — deprecated upstream in favour of https://github.com/github/github-mcp-server
// (Go, not portable here), which was used to cross-check behaviour. Every body
// is rewritten against UserSession; ops.ts lists where it deliberately departs
// from the reference and why.
//
// Conventions worth knowing before adding a tool here:
//
//   - Every list says which page it returned and what to ask for next, read
//     from GitHub's Link header. Do not add a tool that returns a first page
//     silently.
//   - Errors go through mapGitHubError, which reads response HEADERS to tell a
//     rate limit, an SSO block, a missing scope and a missing permission apart
//     — all of which GitHub answers with the same 403.
//   - Writes that GitHub can silently ignore (labels/assignees from accounts
//     without push access) are compared against the response, not assumed.

import { FastMCP } from 'fastmcp';
import { instrumentServer } from '../usage/instrumentServer.js';

import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import { registerMintRestBearerForCurl } from '../sharedTools/mintRestBearerForCurl.js';
import { registerListRestEndpoints } from '../sharedTools/listRestEndpoints.js';
import { withGitHubClient } from './apiHelpers.js';
import {
  searchRepositoriesSchema,
  createRepositorySchema,
  forkRepositorySchema,
  getFileContentsSchema,
  createOrUpdateFileSchema,
  pushFilesSchema,
  createBranchSchema,
  listCommitsSchema,
  listIssuesSchema,
  getIssueSchema,
  createIssueSchema,
  updateIssueSchema,
  addIssueCommentSchema,
  searchCodeSchema,
  searchIssuesSchema,
  searchUsersSchema,
  listOrganizationsSchema,
  listPullRequestsSchema,
  getPullRequestSchema,
  createPullRequestSchema,
  createPullRequestReviewSchema,
  mergePullRequestSchema,
  getPullRequestFilesSchema,
  getPullRequestStatusSchema,
  updatePullRequestBranchSchema,
  getPullRequestCommentsSchema,
  getPullRequestReviewsSchema,
} from './schemas.js';
import {
  opSearchRepositories,
  opCreateRepository,
  opForkRepository,
  opGetFileContents,
  opCreateOrUpdateFile,
  opPushFiles,
  opCreateBranch,
  opListCommits,
  opListIssues,
  opGetIssue,
  opCreateIssue,
  opUpdateIssue,
  opAddIssueComment,
  opSearchCode,
  opSearchIssues,
  opSearchUsers,
  opListOrganizations,
  opListPullRequests,
  opGetPullRequest,
  opCreatePullRequest,
  opCreatePullRequestReview,
  opMergePullRequest,
  opGetPullRequestFiles,
  opGetPullRequestStatus,
  opUpdatePullRequestBranch,
  opGetPullRequestComments,
  opGetPullRequestReviews,
} from './ops.js';

export const githubServer = instrumentServer(new FastMCP<UserSession>({
  name: 'GitHub MCP Server',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'github'),
}), 'github');

// The REST plane is live for this service (/api/v1/github/*): without these an
// MCP client could neither discover it nor mint the 5-minute bearer, leaving
// only the permanent dashboard API key.
registerMintRestBearerForCurl(githubServer);
registerListRestEndpoints(githubServer);

const repoName = (a: { owner: string; repo: string }) => `${a.owner}/${a.repo}`;
const repoCtx = (a: { owner: string; repo: string }) => ({ resource: `repository ${repoName(a)}` });

// ---- Repositories ----

githubServer.addTool({
  name: 'searchRepositories',
  annotations: { readOnlyHint: true },
  description: 'Search for GitHub repositories. Uses GitHub search syntax (e.g. "language:go stars:>500", "org:github", "user:octocat") and returns at most the first 1,000 matches across pages.',
  parameters: searchRepositoriesSchema,
  // Adapted from https://github.com/modelcontextprotocol/servers-archived@9be4674d src/github/operations/repository.ts:37
  execute: async (args, { log, session }) => {
    log.info(`searchRepositories: ${args.query}`);
    return withGitHubClient('Failed to search repositories', session, log, c => opSearchRepositories(c, args));
  },
});

githubServer.addTool({
  name: 'createRepository',
  annotations: { readOnlyHint: false },
  description: 'Create a new GitHub repository in your account. Always created under the connected account, never an organization; public unless private is set.',
  parameters: createRepositorySchema,
  // Adapted from https://github.com/modelcontextprotocol/servers-archived@9be4674d src/github/operations/repository.ts:29
  execute: async (args, { log, session }) => {
    log.info(`createRepository: ${args.name}`);
    return withGitHubClient(`Failed to create repository ${args.name}`, session, log, c => opCreateRepository(c, args), { write: true });
  },
});

githubServer.addTool({
  name: 'forkRepository',
  annotations: { readOnlyHint: false },
  description: 'Fork a GitHub repository to your account or specified organization. GitHub forks asynchronously, and returns the existing fork if there already is one.',
  parameters: forkRepositorySchema,
  // Adapted from https://github.com/modelcontextprotocol/servers-archived@9be4674d src/github/operations/repository.ts:51
  execute: async (args, { log, session }) => {
    log.info(`forkRepository: ${repoName(args)}${args.organization ? ` → ${args.organization}` : ''}`);
    return withGitHubClient(`Failed to fork ${repoName(args)}`, session, log, c => opForkRepository(c, args), { ...repoCtx(args), write: true });
  },
});

// ---- Files & branches ----

githubServer.addTool({
  name: 'getFileContents',
  annotations: { readOnlyHint: true },
  description: 'Get the contents of a file or directory from a GitHub repository. Returns the file\'s blob SHA (needed to update it safely); files over 1 MB and binary files are described rather than returned, and long text is truncated at 100,000 characters.',
  parameters: getFileContentsSchema,
  // Adapted from https://github.com/modelcontextprotocol/servers-archived@9be4674d src/github/operations/files.ts:72
  execute: async (args, { log, session }) => {
    log.info(`getFileContents: ${repoName(args)}:/${args.path}${args.ref ? ` @ ${args.ref}` : ''}`);
    return withGitHubClient(`Failed to read ${args.path || '/'} in ${repoName(args)}`, session, log, c => opGetFileContents(c, args), {
      resource: `"${args.path || '/'}" in ${repoName(args)}${args.ref ? ` at ${args.ref}` : ''}`,
    });
  },
});

githubServer.addTool({
  name: 'createOrUpdateFile',
  annotations: { readOnlyHint: false },
  description: 'Create or update a single file in a GitHub repository, as one commit on an existing branch. Replaces the whole file. Pass the sha from getFileContents to fail instead of overwriting if the file changed; without it the current version is overwritten.',
  parameters: createOrUpdateFileSchema,
  // Adapted from https://github.com/modelcontextprotocol/servers-archived@9be4674d src/github/operations/files.ts:94
  execute: async (args, { log, session }) => {
    log.info(`createOrUpdateFile: ${repoName(args)}:/${args.path} on ${args.branch}`);
    return withGitHubClient(`Failed to write ${args.path} in ${repoName(args)}`, session, log, c => opCreateOrUpdateFile(c, args), {
      resource: `"${args.path}" on branch ${args.branch} of ${repoName(args)}`,
      write: true,
    });
  },
});

githubServer.addTool({
  name: 'pushFiles',
  annotations: { readOnlyHint: false },
  description: 'Push multiple files to a GitHub repository in a single commit, on an existing branch. Never force-pushes: if the branch moves meanwhile, nothing is pushed. Keeps existing executable bits; cannot delete files or write .github/workflows/.',
  parameters: pushFilesSchema,
  // Adapted from https://github.com/modelcontextprotocol/servers-archived@9be4674d src/github/operations/files.ts:202
  execute: async (args, { log, session }) => {
    log.info(`pushFiles: ${args.files.length} file(s) to ${repoName(args)}@${args.branch}`);
    return withGitHubClient(`Failed to push to ${args.branch} in ${repoName(args)}`, session, log, c => opPushFiles(c, args), {
      ...repoCtx(args),
      write: true,
    });
  },
});

githubServer.addTool({
  name: 'createBranch',
  annotations: { readOnlyHint: false },
  description: 'Create a new branch in a GitHub repository, from fromBranch or (by default) the repository\'s actual default branch.',
  parameters: createBranchSchema,
  // Adapted from https://github.com/modelcontextprotocol/servers-archived@9be4674d src/github/operations/branches.ts:75
  execute: async (args, { log, session }) => {
    log.info(`createBranch: ${repoName(args)} ${args.branch} from ${args.fromBranch ?? '(default branch)'}`);
    return withGitHubClient(`Failed to create branch ${args.branch} in ${repoName(args)}`, session, log, c => opCreateBranch(c, args), {
      ...repoCtx(args),
      write: true,
    });
  },
});

githubServer.addTool({
  name: 'listCommits',
  annotations: { readOnlyHint: true },
  description: 'Get list of commits of a branch in a GitHub repository, newest first, optionally only those touching a path or by an author. Paginated.',
  parameters: listCommitsSchema,
  // Adapted from https://github.com/modelcontextprotocol/servers-archived@9be4674d src/github/operations/commits.ts:12
  execute: async (args, { log, session }) => {
    log.info(`listCommits: ${repoName(args)}${args.sha ? ` @ ${args.sha}` : ''}`);
    return withGitHubClient(`Failed to list commits in ${repoName(args)}`, session, log, c => opListCommits(c, args), repoCtx(args));
  },
});

// ---- Issues ----

githubServer.addTool({
  name: 'listIssues',
  annotations: { readOnlyHint: true },
  description: 'List issues in a GitHub repository with filtering options. GitHub includes pull requests in this list; they are marked [PR]. Paginated.',
  parameters: listIssuesSchema,
  // Adapted from https://github.com/modelcontextprotocol/servers-archived@9be4674d src/github/operations/issues.ts:85
  execute: async (args, { log, session }) => {
    log.info(`listIssues: ${repoName(args)} state=${args.state ?? 'open'}`);
    return withGitHubClient(`Failed to list issues in ${repoName(args)}`, session, log, c => opListIssues(c, args), repoCtx(args));
  },
});

githubServer.addTool({
  name: 'getIssue',
  annotations: { readOnlyHint: true },
  description: 'Get details of a specific issue in a GitHub repository: state, labels, assignees, milestone and body. The comment count is included, the comment text is not.',
  parameters: getIssueSchema,
  // Adapted from https://github.com/modelcontextprotocol/servers-archived@9be4674d src/github/operations/issues.ts:55
  execute: async (args, { log, session }) => {
    log.info(`getIssue: ${repoName(args)}#${args.issueNumber}`);
    return withGitHubClient(`Failed to get issue #${args.issueNumber} in ${repoName(args)}`, session, log, c => opGetIssue(c, args), {
      resource: `issue #${args.issueNumber} in ${repoName(args)}`,
    });
  },
});

githubServer.addTool({
  name: 'createIssue',
  annotations: { readOnlyHint: false },
  description: 'Create a new issue in a GitHub repository. Labels, assignees and milestone are only applied for accounts with push access — GitHub drops them silently otherwise, and the response says when that happened.',
  parameters: createIssueSchema,
  // Adapted from https://github.com/modelcontextprotocol/servers-archived@9be4674d src/github/operations/issues.ts:71
  execute: async (args, { log, session }) => {
    log.info(`createIssue: ${repoName(args)} "${args.title}"`);
    return withGitHubClient(`Failed to create an issue in ${repoName(args)}`, session, log, c => opCreateIssue(c, args), {
      ...repoCtx(args),
      write: true,
    });
  },
});

githubServer.addTool({
  name: 'updateIssue',
  annotations: { readOnlyHint: false },
  description: 'Update an existing issue in a GitHub repository. labels and assignees REPLACE the current set (pass [] to clear); omitted fields are left alone. Also opens/closes, with a reason.',
  parameters: updateIssueSchema,
  // Adapted from https://github.com/modelcontextprotocol/servers-archived@9be4674d src/github/operations/issues.ts:105
  execute: async (args, { log, session }) => {
    log.info(`updateIssue: ${repoName(args)}#${args.issueNumber}`);
    return withGitHubClient(`Failed to update issue #${args.issueNumber} in ${repoName(args)}`, session, log, c => opUpdateIssue(c, args), {
      resource: `issue #${args.issueNumber} in ${repoName(args)}`,
      write: true,
    });
  },
});

githubServer.addTool({
  name: 'addIssueComment',
  annotations: { readOnlyHint: false },
  description: 'Add a comment to an existing issue. Works for pull requests too (it posts to the main conversation, not as an inline review comment).',
  parameters: addIssueCommentSchema,
  // Adapted from https://github.com/modelcontextprotocol/servers-archived@9be4674d src/github/operations/issues.ts:59
  execute: async (args, { log, session }) => {
    log.info(`addIssueComment: ${repoName(args)}#${args.issueNumber}`);
    return withGitHubClient(`Failed to comment on #${args.issueNumber} in ${repoName(args)}`, session, log, c => opAddIssueComment(c, args), {
      resource: `issue #${args.issueNumber} in ${repoName(args)}`,
      write: true,
    });
  },
});

// ---- Search ----

githubServer.addTool({
  name: 'searchCode',
  annotations: { readOnlyHint: true },
  description: 'Search for code across GitHub repositories, with matching fragments. Covers default branches only; GitHub limits code search to 10 requests a minute.',
  parameters: searchCodeSchema,
  // Adapted from https://github.com/modelcontextprotocol/servers-archived@9be4674d src/github/operations/search.ts:35
  execute: async (args, { log, session }) => {
    log.info(`searchCode: ${args.query}`);
    return withGitHubClient('Failed to search code', session, log, c => opSearchCode(c, args));
  },
});

githubServer.addTool({
  name: 'searchIssues',
  annotations: { readOnlyHint: true },
  description: 'Search for issues and pull requests across GitHub repositories, e.g. "repo:o/r is:pr is:open" or "is:issue assignee:@me". Returns at most the first 1,000 matches.',
  parameters: searchIssuesSchema,
  // Adapted from https://github.com/modelcontextprotocol/servers-archived@9be4674d src/github/operations/search.ts:39
  execute: async (args, { log, session }) => {
    log.info(`searchIssues: ${args.query}`);
    return withGitHubClient('Failed to search issues', session, log, c => opSearchIssues(c, args));
  },
});

githubServer.addTool({
  name: 'searchUsers',
  annotations: { readOnlyHint: true },
  description: 'Search for users on GitHub (and organizations, with type:org).',
  parameters: searchUsersSchema,
  // Adapted from https://github.com/modelcontextprotocol/servers-archived@9be4674d src/github/operations/search.ts:43
  execute: async (args, { log, session }) => {
    log.info(`searchUsers: ${args.query}`);
    return withGitHubClient('Failed to search users', session, log, c => opSearchUsers(c, args));
  },
});

// ---- Organizations ----

githubServer.addTool({
  name: 'listOrganizations',
  annotations: { readOnlyHint: true },
  description:
    'List the organizations the connected GitHub account belongs to, how many repositories of each this connection can read, '
    + 'and whether this connector\'s access rules allow each. Use it when an organization seems missing: an organization you are '
    + 'a member of with no visible repositories usually restricts OAuth Apps and has not approved this app, and the output says how to request approval.',
  parameters: listOrganizationsSchema,
  execute: async (args, { log, session }) => {
    log.info('listOrganizations');
    return withGitHubClient('Failed to list organizations', session, log, c => opListOrganizations(c, args));
  },
});

// ---- Pull requests ----

githubServer.addTool({
  name: 'listPullRequests',
  annotations: { readOnlyHint: true },
  description: 'List and filter repository pull requests. Paginated.',
  parameters: listPullRequestsSchema,
  // Adapted from https://github.com/modelcontextprotocol/servers-archived@9be4674d src/github/operations/pulls.ts:199
  execute: async (args, { log, session }) => {
    log.info(`listPullRequests: ${repoName(args)} state=${args.state ?? 'open'}`);
    return withGitHubClient(`Failed to list pull requests in ${repoName(args)}`, session, log, c => opListPullRequests(c, args), repoCtx(args));
  },
});

githubServer.addTool({
  name: 'getPullRequest',
  annotations: { readOnlyHint: true },
  description: 'Get details of a specific pull request: state, head/base and their SHAs, mergeability, size, reviewers and description.',
  parameters: getPullRequestSchema,
  // Adapted from https://github.com/modelcontextprotocol/servers-archived@9be4674d src/github/operations/pulls.ts:188
  execute: async (args, { log, session }) => {
    log.info(`getPullRequest: ${repoName(args)}#${args.pullNumber}`);
    return withGitHubClient(`Failed to get pull request #${args.pullNumber} in ${repoName(args)}`, session, log, c => opGetPullRequest(c, args), {
      resource: `pull request #${args.pullNumber} in ${repoName(args)}`,
    });
  },
});

githubServer.addTool({
  name: 'createPullRequest',
  annotations: { readOnlyHint: false },
  description: 'Create a new pull request in a GitHub repository, from head into base. Both branches must already exist and differ.',
  parameters: createPullRequestSchema,
  // Adapted from https://github.com/modelcontextprotocol/servers-archived@9be4674d src/github/operations/pulls.ts:172
  execute: async (args, { log, session }) => {
    log.info(`createPullRequest: ${repoName(args)} ${args.head} → ${args.base}`);
    return withGitHubClient(`Failed to create a pull request in ${repoName(args)}`, session, log, c => opCreatePullRequest(c, args), {
      ...repoCtx(args),
      write: true,
    });
  },
});

githubServer.addTool({
  name: 'createPullRequestReview',
  annotations: { readOnlyHint: false },
  description: 'Create a review on a pull request: APPROVE, REQUEST_CHANGES or COMMENT, optionally with inline comments. Submitted immediately; GitHub does not let you approve your own pull request.',
  parameters: createPullRequestReviewSchema,
  // Adapted from https://github.com/modelcontextprotocol/servers-archived@9be4674d src/github/operations/pulls.ts:218
  execute: async (args, { log, session }) => {
    log.info(`createPullRequestReview: ${repoName(args)}#${args.pullNumber} ${args.event}`);
    return withGitHubClient(`Failed to review #${args.pullNumber} in ${repoName(args)}`, session, log, c => opCreatePullRequestReview(c, args), {
      resource: `pull request #${args.pullNumber} in ${repoName(args)}`,
      write: true,
    });
  },
});

githubServer.addTool({
  name: 'mergePullRequest',
  annotations: { readOnlyHint: false },
  description: 'Merge a pull request. Pass expectedHeadSha (from getPullRequest) so the merge is refused if new commits were pushed after you looked. An already-merged pull request is reported as such (with its merge commit) and nothing is merged; a closed, unmerged one is refused.',
  parameters: mergePullRequestSchema,
  // Adapted from https://github.com/modelcontextprotocol/servers-archived@9be4674d src/github/operations/pulls.ts:234
  execute: async (args, { log, session }) => {
    log.info(`mergePullRequest: ${repoName(args)}#${args.pullNumber} (${args.mergeMethod ?? 'merge'})`);
    return withGitHubClient(`Failed to merge #${args.pullNumber} in ${repoName(args)}`, session, log, c => opMergePullRequest(c, args), {
      resource: `pull request #${args.pullNumber} in ${repoName(args)}`,
      write: true,
    });
  },
});

githubServer.addTool({
  name: 'getPullRequestFiles',
  annotations: { readOnlyHint: true },
  description: 'Get the list of files changed in a pull request, with each file\'s diff (capped per file) unless includePatch is false. Paginated.',
  parameters: getPullRequestFilesSchema,
  // Adapted from https://github.com/modelcontextprotocol/servers-archived@9be4674d src/github/operations/pulls.ts:249
  execute: async (args, { log, session }) => {
    log.info(`getPullRequestFiles: ${repoName(args)}#${args.pullNumber}`);
    return withGitHubClient(`Failed to list files of #${args.pullNumber} in ${repoName(args)}`, session, log, c => opGetPullRequestFiles(c, args), {
      resource: `pull request #${args.pullNumber} in ${repoName(args)}`,
    });
  },
});

githubServer.addTool({
  name: 'getPullRequestStatus',
  annotations: { readOnlyHint: true },
  description: 'Get the combined status of all status checks for a pull request — both GitHub Actions/app check runs and legacy commit statuses — with an overall passing/failing/pending verdict.',
  parameters: getPullRequestStatusSchema,
  // Adapted from https://github.com/modelcontextprotocol/servers-archived@9be4674d src/github/operations/pulls.ts:297
  execute: async (args, { log, session }) => {
    log.info(`getPullRequestStatus: ${repoName(args)}#${args.pullNumber}`);
    return withGitHubClient(`Failed to get checks for #${args.pullNumber} in ${repoName(args)}`, session, log, c => opGetPullRequestStatus(c, args), {
      resource: `pull request #${args.pullNumber} in ${repoName(args)}`,
    });
  },
});

githubServer.addTool({
  name: 'updatePullRequestBranch',
  annotations: { readOnlyHint: false },
  description: 'Update a pull request branch with the latest changes from the base branch (a merge commit on the PR branch). Runs asynchronously on GitHub.',
  parameters: updatePullRequestBranchSchema,
  // Adapted from https://github.com/modelcontextprotocol/servers-archived@9be4674d src/github/operations/pulls.ts:260
  execute: async (args, { log, session }) => {
    log.info(`updatePullRequestBranch: ${repoName(args)}#${args.pullNumber}`);
    return withGitHubClient(`Failed to update the branch of #${args.pullNumber} in ${repoName(args)}`, session, log, c => opUpdatePullRequestBranch(c, args), {
      resource: `pull request #${args.pullNumber} in ${repoName(args)}`,
      write: true,
    });
  },
});

githubServer.addTool({
  name: 'getPullRequestComments',
  annotations: { readOnlyHint: true },
  description: 'Get the review comments on a pull request — the inline comments on diff lines. The main conversation thread is not included. Paginated.',
  parameters: getPullRequestCommentsSchema,
  // Adapted from https://github.com/modelcontextprotocol/servers-archived@9be4674d src/github/operations/pulls.ts:275
  execute: async (args, { log, session }) => {
    log.info(`getPullRequestComments: ${repoName(args)}#${args.pullNumber}`);
    return withGitHubClient(`Failed to get review comments on #${args.pullNumber} in ${repoName(args)}`, session, log, c => opGetPullRequestComments(c, args), {
      resource: `pull request #${args.pullNumber} in ${repoName(args)}`,
    });
  },
});

githubServer.addTool({
  name: 'getPullRequestReviews',
  annotations: { readOnlyHint: true },
  description: 'Get the reviews on a pull request: each reviewer\'s verdict (approved, changes requested, commented) and summary. Paginated.',
  parameters: getPullRequestReviewsSchema,
  // Adapted from https://github.com/modelcontextprotocol/servers-archived@9be4674d src/github/operations/pulls.ts:286
  execute: async (args, { log, session }) => {
    log.info(`getPullRequestReviews: ${repoName(args)}#${args.pullNumber}`);
    return withGitHubClient(`Failed to get reviews on #${args.pullNumber} in ${repoName(args)}`, session, log, c => opGetPullRequestReviews(c, args), {
      resource: `pull request #${args.pullNumber} in ${repoName(args)}`,
    });
  },
});
