// src/github/ops.ts
// One exported `op*` per tool body, taking a GitHubClient and the parsed args
// and returning the text the model sees. Kept out of server.ts so every body
// can be driven against a stubbed client in tests (the Redmine/HubSpot split).
//
// Behaviour that deliberately DIFFERS from the reference implementation
// (modelcontextprotocol/servers-archived src/github), each because the
// original produced a wrong answer that read as a right one:
//
//   - pushFiles moved the branch with `force: true`, so a commit someone else
//     pushed between our read and our write was silently discarded. It now
//     fast-forwards only, and reports the race instead of winning it.
//   - pushFiles wrote every file as mode 100644, silently stripping the
//     executable bit from any script it touched. Existing modes are kept.
//   - createBranch guessed the default branch as `main`, then `master`. It is
//     read from the repository instead.
//   - Branch lookups used `git/refs/heads/<name>` (plural), a PREFIX match that
//     returns an array when other branches start with the same name, so
//     "feat" could resolve to "feat/x". The exact `git/ref/` form is used.
//   - createOrUpdateFile treated ANY failure of its existence check (401, rate
//     limit, 5xx) as "file does not exist" and went on to create it. Only a
//     404 means that now.
//   - getPullRequestStatus read only legacy commit statuses, which GitHub
//     Actions never writes — an Actions-only repository reported "pending"
//     forever. Check runs are read too.
//   - getFileContents decoded binary files as UTF-8 garbage and returned an
//     empty string for files over 1 MB. Both are now reported as what they are.
//   - list endpoints returned GitHub's first page with no indication that more
//     existed. Every list says which page it is and what to ask for next.

import { UserError } from 'fastmcp';

import { sliceSafe } from '../google-docs/textSafety.js';
import { describeGitHubError, repoPath, slashPath, seg, type GitHubClient, type GitHubResponse, type PageInfo, type QueryValue } from './apiHelpers.js';
import type {
  AddIssueCommentArgs,
  CreateBranchArgs,
  CreateIssueArgs,
  CreateOrUpdateFileArgs,
  CreatePullRequestArgs,
  CreatePullRequestReviewArgs,
  CreateRepositoryArgs,
  ForkRepositoryArgs,
  GetFileContentsArgs,
  GetIssueArgs,
  GetPullRequestArgs,
  GetPullRequestCommentsArgs,
  GetPullRequestFilesArgs,
  GetPullRequestReviewsArgs,
  GetPullRequestStatusArgs,
  ListCommitsArgs,
  ListIssuesArgs,
  ListPullRequestsArgs,
  MergePullRequestArgs,
  PushFilesArgs,
  SearchCodeArgs,
  SearchIssuesArgs,
  SearchRepositoriesArgs,
  SearchUsersArgs,
  UpdateIssueArgs,
  UpdatePullRequestBranchArgs,
} from './schemas.js';

// ---- GitHub payload shapes (only the fields read here) ----

interface GhUser { login: string; type?: string; html_url?: string }
type GhLabel = { name: string } | string;
interface GhMilestone { number: number; title: string }

interface GhRepo {
  full_name: string;
  description: string | null;
  private: boolean;
  html_url: string;
  default_branch?: string;
  stargazers_count?: number;
  language?: string | null;
  updated_at?: string;
  created_at?: string;
  archived?: boolean;
  fork?: boolean;
}

interface GhIssue {
  number: number;
  title: string;
  state: string;
  state_reason?: string | null;
  user: GhUser | null;
  labels: GhLabel[];
  assignees?: GhUser[] | null;
  milestone?: GhMilestone | null;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  html_url: string;
  body?: string | null;
  pull_request?: unknown;
  repository_url?: string;
}

interface GhPull {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  merged_by?: GhUser | null;
  mergeable?: boolean | null;
  mergeable_state?: string;
  user: GhUser | null;
  head: { ref: string; sha: string; label?: string };
  base: { ref: string; sha: string };
  html_url: string;
  body?: string | null;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  commits?: number;
  review_comments?: number;
  requested_reviewers?: GhUser[];
  labels?: GhLabel[];
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
}

interface GhContentEntry {
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  name: string;
  path: string;
  size: number;
  sha: string;
  html_url?: string | null;
  download_url?: string | null;
  content?: string;
  encoding?: string;
  target?: string;
  submodule_git_url?: string;
}

interface GhSearch<T> { total_count: number; incomplete_results: boolean; items: T[] }

// ---- Rendering helpers ----

/** Most of a file a single response carries before it is cut. */
export const FILE_CONTENT_MAX_CHARS = 100_000;
const ISSUE_BODY_MAX_CHARS = 20_000;
const COMMENT_MAX_CHARS = 4_000;
const PATCH_MAX_CHARS = 3_000;
/** GitHub's search API never returns past this many results, whatever the total. */
const SEARCH_RESULT_CEILING = 1000;

function cap(text: string, max: number, what: string): string {
  if (text.length <= max) return text;
  return `${sliceSafe(text, max)}\n…[${what} truncated: showing ${max.toLocaleString('en-US')} of ${text.length.toLocaleString('en-US')} characters]`;
}

const day = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : '?');
const short = (sha: string): string => sha.slice(0, 7);
const who = (user: GhUser | null | undefined): string => (user?.login ? `@${user.login}` : '(deleted user)');
const labelName = (label: GhLabel): string => (typeof label === 'string' ? label : label.name);
const firstLine = (text: string): string => text.split('\n', 1)[0];

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The paging line every list ends with. "These are all the results" is only
 * said when GitHub sent no next link — never inferred from a short page.
 */
export function pageFooter(page: PageInfo, current: number, shown: number): string {
  if (shown === 0 && current > 1) return `Page ${current} is empty — it is past the last page.`;
  const of = page.last ? ` of ${page.last}` : '';
  if (page.next) return `Page ${current}${of}. More results exist: call again with page=${page.next}.`;
  return current > 1 ? `Page ${current}${of} — this is the last page.` : 'These are all the results.';
}

function searchHeader(noun: string, query: string, result: GhSearch<unknown>): string[] {
  const lines = [`Found ${result.total_count.toLocaleString('en-US')} ${noun} matching "${query}".`];
  if (result.incomplete_results) {
    lines.push('⚠ GitHub flagged these results as INCOMPLETE (the search timed out on its side), so matches may be missing. Narrow the query or retry.');
  }
  if (result.total_count > SEARCH_RESULT_CEILING) {
    lines.push(`Note: GitHub search only ever returns the first ${SEARCH_RESULT_CEILING.toLocaleString('en-US')} results; narrow the query to reach the rest.`);
  }
  return lines;
}

/** `https://api.github.com/repos/o/r` → `o/r`. */
function repoFromUrl(url: string | undefined): string {
  return url?.split('/repos/')[1] ?? '?';
}

// ---- Path validation (pushFiles / createOrUpdateFile) ----

/**
 * Normalise a repository-relative path, refusing anything that is not one.
 * GitHub's tree API would otherwise create a literal `..` directory or reject
 * the whole batch with an error that names no path.
 */
export function normalizeRepoPath(raw: string): string {
  const path = raw.trim().replace(/^\.\//, '');
  if (!path) throw new UserError('A file path is empty.');
  if (path.startsWith('/')) throw new UserError(`"${raw}" is absolute; give a path relative to the repository root.`);
  if (path.includes('\\')) throw new UserError(`"${raw}" uses backslashes; repository paths use forward slashes.`);
  const parts = path.split('/');
  if (parts.some(p => p === '' || p === '.' || p === '..')) {
    throw new UserError(`"${raw}" is not a clean repository path (empty, "." or ".." segment).`);
  }
  return path;
}

// ---- Read requests (shared with the REST plane) ----

/**
 * The upstream request a read tool makes, as data. The MCP op and the REST
 * route both build their request from here, so the two surfaces cannot ask
 * GitHub different questions — the drift the Calendar REST copy suffered.
 */
export interface GitHubRead {
  path: string;
  query?: Record<string, QueryValue>;
  /** Media type, when a read needs more than the default representation. */
  accept?: string;
}

/** Strip leading/trailing slashes; "" is the repository root. */
export function cleanContentPath(path: string | undefined): string {
  return (path ?? '').replace(/^\/+|\/+$/g, '');
}

const pullPath = (a: { owner: string; repo: string; pullNumber: number }) => `${repoPath(a.owner, a.repo)}/pulls/${a.pullNumber}`;

export const READS = {
  searchRepositories: (a: SearchRepositoriesArgs): GitHubRead => ({
    path: '/search/repositories', query: { q: a.query, page: a.page, per_page: a.perPage },
  }),
  searchCode: (a: SearchCodeArgs): GitHubRead => ({
    path: '/search/code', query: { q: a.query, page: a.page, per_page: a.perPage },
    // The text-match media type is what makes GitHub return the matching
    // fragments; without it a result is only a path.
    accept: 'application/vnd.github.text-match+json',
  }),
  searchIssues: (a: SearchIssuesArgs): GitHubRead => ({
    path: '/search/issues', query: { q: a.query, sort: a.sort, order: a.order, page: a.page, per_page: a.perPage },
  }),
  searchUsers: (a: SearchUsersArgs): GitHubRead => ({
    path: '/search/users', query: { q: a.query, sort: a.sort, order: a.order, page: a.page, per_page: a.perPage },
  }),
  getFileContents: (a: GetFileContentsArgs): GitHubRead => {
    const path = cleanContentPath(a.path);
    return { path: `${repoPath(a.owner, a.repo)}/contents${path ? `/${slashPath(path)}` : ''}`, query: { ref: a.ref } };
  },
  listCommits: (a: ListCommitsArgs): GitHubRead => ({
    path: `${repoPath(a.owner, a.repo)}/commits`,
    query: { sha: a.sha, path: a.path, author: a.author, page: a.page, per_page: a.perPage },
  }),
  listIssues: (a: ListIssuesArgs): GitHubRead => ({
    path: `${repoPath(a.owner, a.repo)}/issues`,
    query: {
      state: a.state, labels: a.labels?.join(','), sort: a.sort, direction: a.direction,
      since: a.since, page: a.page, per_page: a.perPage,
    },
  }),
  getIssue: (a: GetIssueArgs): GitHubRead => ({ path: `${repoPath(a.owner, a.repo)}/issues/${a.issueNumber}` }),
  listPullRequests: (a: ListPullRequestsArgs): GitHubRead => ({
    path: `${repoPath(a.owner, a.repo)}/pulls`,
    query: {
      state: a.state, head: a.head, base: a.base, sort: a.sort, direction: a.direction,
      page: a.page, per_page: a.perPage,
    },
  }),
  getPullRequest: (a: GetPullRequestArgs): GitHubRead => ({ path: pullPath(a) }),
  getPullRequestFiles: (a: GetPullRequestFilesArgs): GitHubRead => ({
    path: `${pullPath(a)}/files`, query: { page: a.page, per_page: a.perPage },
  }),
  getPullRequestComments: (a: GetPullRequestCommentsArgs): GitHubRead => ({
    path: `${pullPath(a)}/comments`, query: { page: a.page, per_page: a.perPage },
  }),
  getPullRequestReviews: (a: GetPullRequestReviewsArgs): GitHubRead => ({
    path: `${pullPath(a)}/reviews`, query: { page: a.page, per_page: a.perPage },
  }),
};

export function runRead<T>(client: GitHubClient, read: GitHubRead): Promise<GitHubResponse<T>> {
  return client.get<T>(read.path, read.query, read.accept);
}

/**
 * A UserError that carries the upstream status it stands for, so the REST
 * plane answers 404/409 rather than 400 when an op has already turned
 * GitHub's answer into a sentence. The MCP surface only reads the message.
 */
function statusError(message: string, status: number): UserError {
  const error = new UserError(message);
  (error as any).status = status;
  return error;
}

/**
 * Say how many search hits this connector's access rules removed. Without it
 * a short or empty page reads as "GitHub found nothing" — and GitHub's
 * total_count, which still counts them, would contradict the list.
 */
function hiddenNote(hidden: number | undefined): string[] {
  return hidden
    ? [`Note: ${hidden} result(s) on this page are in organizations this connector's access rules exclude, and were left out. total_count still counts them, so a page can come back short or empty while more allowed results follow.`]
    : [];
}

// ---- Repositories ----

export async function opSearchRepositories(client: GitHubClient, args: SearchRepositoriesArgs): Promise<string> {
  const current = args.page ?? 1;
  const { data, page, hiddenByAccessRules } = await runRead<GhSearch<GhRepo>>(client, READS.searchRepositories(args));
  const lines = searchHeader('repositories', args.query, data);
  lines.push(...hiddenNote(hiddenByAccessRules), '');
  data.items.forEach((r, i) => {
    const facts = [
      `★${r.stargazers_count ?? 0}`,
      r.language,
      r.private ? 'private' : null,
      r.archived ? 'archived' : null,
      r.fork ? 'fork' : null,
      r.updated_at ? `updated ${day(r.updated_at)}` : null,
    ].filter(Boolean).join(' · ');
    lines.push(`${(current - 1) * (args.perPage ?? 30) + i + 1}. ${r.full_name} — ${facts}`);
    if (r.description) lines.push(`   ${r.description}`);
    lines.push(`   ${r.html_url}`);
  });
  lines.push('', pageFooter(page, current, data.items.length));
  return lines.join('\n');
}

export async function opCreateRepository(client: GitHubClient, args: CreateRepositoryArgs): Promise<string> {
  const { data } = await client.post<GhRepo>('/user/repos', {
    name: args.name,
    description: args.description,
    private: args.private,
    auto_init: args.autoInit,
  });
  const lines = [
    `Created repository ${data.full_name} (${data.private ? 'private' : 'public'}).`,
    `  URL: ${data.html_url}`,
  ];
  if (args.autoInit) {
    lines.push(`  Default branch: ${data.default_branch ?? 'main'} (initialized with a README).`);
  } else {
    lines.push('  It has no commits yet, so no branch exists. The first createOrUpdateFile call creates one; pushFiles and createBranch need an existing branch.');
  }
  return lines.join('\n');
}

/** A fork older than this when GitHub answers was already there, not just made. */
const FRESH_FORK_MS = 2 * 60_000;

export async function opForkRepository(client: GitHubClient, args: ForkRepositoryArgs): Promise<string> {
  const { data } = await client.post<GhRepo>(`${repoPath(args.owner, args.repo)}/forks`, {
    ...(args.organization ? { organization: args.organization } : {}),
  });
  const created = data.created_at ? Date.parse(data.created_at) : NaN;
  const preExisting = Number.isFinite(created) && Date.now() - created > FRESH_FORK_MS;
  const lines = [
    preExisting
      ? `A fork already existed, so GitHub returned it: ${data.full_name} (created ${day(data.created_at)}). Nothing new was created.`
      : `Forked ${args.owner}/${args.repo} to ${data.full_name}.`,
    `  URL: ${data.html_url}`,
  ];
  if (!preExisting) {
    lines.push('  GitHub creates forks asynchronously: the contents can take a few seconds (longer for a large repository) to appear, so a read that 404s right after this should be retried shortly.');
  }
  return lines.join('\n');
}

// ---- Files ----

function renderDirectory(args: GetFileContentsArgs, entries: GhContentEntry[]): string {
  const where = `${args.owner}/${args.repo}:/${args.path ?? ''}${args.ref ? ` @ ${args.ref}` : ''}`;
  if (!entries.length) return `Directory ${where} is empty.`;
  const sorted = [...entries].sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
  const lines = [`Directory ${where} — ${entries.length} entries:`, ''];
  for (const e of sorted) {
    if (e.type === 'dir') lines.push(`  dir   ${e.path}/`);
    else if (e.type === 'file') lines.push(`  file  ${e.path} (${sizeLabel(e.size)})`);
    else lines.push(`  ${e.type.padEnd(5)} ${e.path}`);
  }
  if (entries.length >= 1000) {
    lines.push('', 'Note: GitHub\'s contents API lists at most 1,000 entries per directory, so this listing may be incomplete.');
  }
  return lines.join('\n');
}

/** Decode a base64 blob as UTF-8, or null when it is not text. */
export function decodeTextBlob(base64: string): string | null {
  const bytes = Buffer.from(base64, 'base64');
  // A NUL in the first 8 KB is git's own binary heuristic.
  if (bytes.subarray(0, 8000).includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function renderFile(args: GetFileContentsArgs, file: GhContentEntry): string {
  const header = [
    `File ${args.owner}/${args.repo}:/${file.path}${args.ref ? ` @ ${args.ref}` : ''}`,
    `  Size: ${sizeLabel(file.size)}`,
    `  Blob SHA: ${file.sha} (pass as \`sha\` to createOrUpdateFile to update this file only if it has not changed)`,
  ];
  if (file.html_url) header.push(`  URL: ${file.html_url}`);

  // Files between 1 and 100 MB come back with `encoding: "none"` and empty
  // content. Reporting that as an empty file would be a lie with real
  // consequences — an edit based on it would replace the file with nothing.
  if (file.encoding === 'none' || (file.size > 0 && !file.content)) {
    header.push('', `The content was NOT returned: the file is ${sizeLabel(file.size)}, more than the 1 MB GitHub's contents API returns inline.${file.download_url ? ` Raw download: ${file.download_url}` : ''}`);
    return header.join('\n');
  }

  const text = decodeTextBlob(file.content ?? '');
  if (text === null) {
    header.push('', `This is a binary file, so its content is not shown.${file.download_url ? ` Raw download: ${file.download_url}` : ''}`);
    return header.join('\n');
  }
  header.push('', '--- content ---', cap(text, FILE_CONTENT_MAX_CHARS, 'file'));
  return header.join('\n');
}

export async function opGetFileContents(client: GitHubClient, args: GetFileContentsArgs): Promise<string> {
  const { data } = await runRead<GhContentEntry | GhContentEntry[]>(client, READS.getFileContents(args));
  const normalized = { ...args, path: cleanContentPath(args.path) };
  if (Array.isArray(data)) return renderDirectory(normalized, data);
  if (data.type === 'symlink') return `${data.path} is a symlink to ${data.target ?? '(unknown target)'}.`;
  if (data.type === 'submodule') return `${data.path} is a git submodule pointing at ${data.submodule_git_url ?? '(unknown URL)'} @ ${data.sha}.`;
  return renderFile(normalized, data);
}

export interface FileWriteResult {
  /** True when the file did not exist before (GitHub answered 201). */
  created: boolean;
  path: string;
  branch: string;
  commit: { sha: string; html_url?: string };
  /** Blob SHA of the new content. */
  blobSha: string | null;
  /** True when no `sha` was given, so the existing file was replaced unchecked. */
  overwroteUnchecked: boolean;
}

export async function performCreateOrUpdateFile(client: GitHubClient, args: CreateOrUpdateFileArgs): Promise<FileWriteResult> {
  const path = normalizeRepoPath(args.path);
  const rp = repoPath(args.owner, args.repo);
  const contentUrl = `${rp}/contents/${slashPath(path)}`;

  let sha = args.sha;
  let overwroteUnchecked = false;
  if (!sha) {
    try {
      const { data } = await client.get<GhContentEntry | GhContentEntry[]>(contentUrl, { ref: args.branch });
      if (Array.isArray(data) || data.type === 'dir') {
        throw new UserError(`"${path}" is a directory on ${args.branch} in ${args.owner}/${args.repo}; give the path of a file.`);
      }
      if (data.type !== 'file') {
        throw new UserError(`"${path}" is a ${data.type}, not a regular file, on ${args.branch}; refusing to replace it.`);
      }
      sha = data.sha;
      overwroteUnchecked = true;
    } catch (error: any) {
      // ONLY a 404 means "no such file yet". Anything else — a rate limit, a
      // revoked token, a 5xx — says nothing about the file, and treating it as
      // absence is what made the reference implementation attempt a create on
      // top of an existing file.
      if (error?.status !== 404) throw error;
    }
  }

  const { data, status } = await client.put<{ content: { sha: string; html_url?: string } | null; commit: { sha: string; html_url?: string } }>(contentUrl, {
    message: args.message,
    content: Buffer.from(args.content, 'utf8').toString('base64'),
    branch: args.branch,
    ...(sha ? { sha } : {}),
  });
  return {
    created: status === 201,
    path,
    branch: args.branch,
    commit: data.commit,
    blobSha: data.content?.sha ?? null,
    overwroteUnchecked,
  };
}

export async function opCreateOrUpdateFile(client: GitHubClient, args: CreateOrUpdateFileArgs): Promise<string> {
  const r = await performCreateOrUpdateFile(client, args);
  const lines = [
    `${r.created ? 'Created' : 'Updated'} ${r.path} on ${r.branch} in ${args.owner}/${args.repo}.`,
    `  Commit: ${r.commit.sha}${r.commit.html_url ? ` — ${r.commit.html_url}` : ''}`,
  ];
  if (r.blobSha) lines.push(`  New blob SHA: ${r.blobSha}`);
  if (r.overwroteUnchecked) {
    lines.push('  No `sha` was given, so the current version was replaced without checking whether it had changed since you last read it.');
  }
  return lines.join('\n');
}

interface GhTreeEntry { path: string; mode: string; type: 'blob' | 'tree' | 'commit'; sha: string }

/** Git file modes this tool will write. Anything else at a path is refused. */
const REGULAR_FILE = '100644';
const EXECUTABLE_FILE = '100755';

async function branchHead(client: GitHubClient, rp: string, owner: string, repo: string, branch: string): Promise<string> {
  try {
    const { data } = await client.get<{ object: { sha: string } }>(`${rp}/git/ref/heads/${slashPath(branch)}`);
    return data.object.sha;
  } catch (error: any) {
    if (error?.status === 404) {
      throw statusError(`Branch "${branch}" does not exist in ${owner}/${repo}. Create it with createBranch first.`, 404);
    }
    throw error;
  }
}

export interface PushResult {
  /** False when every file already had this content, so nothing was committed. */
  pushed: boolean;
  branch: string;
  commitSha: string | null;
  commitUrl: string | null;
  files: Array<{ path: string; change: 'added' | 'modified'; mode: string }>;
  /** New paths written without checking the old mode, because GitHub truncated the tree listing. */
  modesUnverified: string[];
}

export async function performPushFiles(client: GitHubClient, args: PushFilesArgs): Promise<PushResult> {
  const files = args.files.map(f => ({ path: normalizeRepoPath(f.path), content: f.content }));
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.path)) throw new UserError(`"${f.path}" appears more than once in files; each path can be written once per commit.`);
    seen.add(f.path);
  }

  const rp = repoPath(args.owner, args.repo);
  const headSha = await branchHead(client, rp, args.owner, args.repo, args.branch);
  const { data: headCommit } = await client.get<{ tree: { sha: string } }>(`${rp}/git/commits/${seg(headSha)}`);
  const baseTreeSha = headCommit.tree.sha;

  // Existing entries at the target paths, so a script keeps its executable bit
  // and a symlink, directory or submodule is never silently overwritten with a
  // regular file.
  const { data: tree } = await client.get<{ tree: GhTreeEntry[]; truncated: boolean }>(
    `${rp}/git/trees/${seg(baseTreeSha)}`, { recursive: 1 },
  );
  const existing = new Map(tree.tree.map(e => [e.path, e]));
  for (const f of files) {
    const at = existing.get(f.path);
    if (at && at.type !== 'blob') {
      throw new UserError(`"${f.path}" is a ${at.type === 'tree' ? 'directory' : 'submodule'} on ${args.branch}; refusing to replace it with a file. Nothing was pushed.`);
    }
    if (at && at.mode !== REGULAR_FILE && at.mode !== EXECUTABLE_FILE) {
      throw new UserError(`"${f.path}" is a symlink (mode ${at.mode}) on ${args.branch}; refusing to replace it with a regular file. Nothing was pushed.`);
    }
  }

  const { data: newTree } = await client.post<{ sha: string }>(`${rp}/git/trees`, {
    base_tree: baseTreeSha,
    tree: files.map(f => ({
      path: f.path,
      mode: existing.get(f.path)?.mode ?? REGULAR_FILE,
      type: 'blob',
      content: f.content,
    })),
  });
  const changed = files.map(f => ({
    path: f.path,
    change: existing.has(f.path) ? 'modified' as const : 'added' as const,
    mode: existing.get(f.path)?.mode ?? REGULAR_FILE,
  }));
  const modesUnverified = tree.truncated ? files.filter(f => !existing.has(f.path)).map(f => f.path) : [];
  if (newTree.sha === baseTreeSha) {
    return { pushed: false, branch: args.branch, commitSha: null, commitUrl: null, files: changed, modesUnverified };
  }

  const { data: commit } = await client.post<{ sha: string }>(`${rp}/git/commits`, {
    message: args.message,
    tree: newTree.sha,
    parents: [headSha],
  });

  try {
    // force: false — a fast-forward or nothing. The reference implementation
    // forced this, which discards any commit pushed since we read the head.
    await client.patch(`${rp}/git/refs/heads/${slashPath(args.branch)}`, { sha: commit.sha, force: false });
  } catch (error: any) {
    if (error?.status === 422 && /fast[- ]forward/i.test(error?.body ?? '')) {
      throw statusError(`Branch ${args.branch} moved while this commit was being built (someone pushed in the meantime), so it was NOT updated and nothing was pushed. Run pushFiles again to commit on top of the new head.`, 409);
    }
    throw error;
  }

  return {
    pushed: true,
    branch: args.branch,
    commitSha: commit.sha,
    commitUrl: `https://github.com/${args.owner}/${args.repo}/commit/${commit.sha}`,
    files: changed,
    modesUnverified,
  };
}

export async function opPushFiles(client: GitHubClient, args: PushFilesArgs): Promise<string> {
  const r = await performPushFiles(client, args);
  if (!r.pushed) {
    return `No changes: every file already has exactly this content on ${args.branch} in ${args.owner}/${args.repo}, so nothing was committed.`;
  }
  const lines = [
    `Pushed ${r.files.length} file(s) to ${args.branch} in ${args.owner}/${args.repo} as one commit.`,
    `  Commit: ${r.commitSha} — ${r.commitUrl}`,
    ...r.files.map(f => `  ${f.change === 'modified' ? 'M' : 'A'} ${f.path}${f.mode === EXECUTABLE_FILE ? ' (kept executable)' : ''}`),
  ];
  if (r.modesUnverified.length) {
    lines.push(`  Note: the repository tree was too large for GitHub to list in full, so these were written as regular non-executable files without checking what was there before: ${r.modesUnverified.join(', ')}.`);
  }
  return lines.join('\n');
}

export async function opCreateBranch(client: GitHubClient, args: CreateBranchArgs): Promise<string> {
  const rp = repoPath(args.owner, args.repo);
  let from = args.fromBranch;
  if (!from) {
    const { data: repo } = await client.get<GhRepo>(rp);
    from = repo.default_branch;
    if (!from) throw new UserError(`${args.owner}/${args.repo} reports no default branch; pass fromBranch.`);
  }
  let sha: string;
  try {
    sha = (await client.get<{ object: { sha: string } }>(`${rp}/git/ref/heads/${slashPath(from)}`)).data.object.sha;
  } catch (error: any) {
    if (error?.status === 404) throw statusError(`Source branch "${from}" does not exist in ${args.owner}/${args.repo}.`, 404);
    throw error;
  }
  try {
    await client.post(`${rp}/git/refs`, { ref: `refs/heads/${args.branch}`, sha });
  } catch (error: any) {
    if (error?.status === 422 && /already exists/i.test(error?.body ?? '')) {
      throw statusError(`Branch "${args.branch}" already exists in ${args.owner}/${args.repo}; nothing was changed.`, 409);
    }
    throw error;
  }
  return `Created branch ${args.branch} in ${args.owner}/${args.repo} from ${from} (${short(sha)}).`;
}

export async function opListCommits(client: GitHubClient, args: ListCommitsArgs): Promise<string> {
  const current = args.page ?? 1;
  const { data, page } = await runRead<Array<{
    sha: string;
    html_url: string;
    author: GhUser | null;
    commit: { message: string; author: { name?: string; date?: string } | null };
  }>>(client, READS.listCommits(args));
  const scope = [args.sha && `on ${args.sha}`, args.path && `touching ${args.path}`, args.author && `by ${args.author}`].filter(Boolean).join(' ');
  if (!data.length) return `No commits ${scope || 'found'} in ${args.owner}/${args.repo}${current > 1 ? ` on page ${current}` : ''}.`;
  const lines = [`Commits in ${args.owner}/${args.repo}${scope ? ` ${scope}` : ''} (newest first):`, ''];
  for (const c of data) {
    const author = c.author?.login ? `@${c.author.login}` : (c.commit.author?.name ?? 'unknown');
    lines.push(`- ${short(c.sha)} ${day(c.commit.author?.date)} ${author}: ${firstLine(c.commit.message)}`);
  }
  lines.push('', pageFooter(page, current, data.length));
  return lines.join('\n');
}

// ---- Issues ----

function issueLine(issue: GhIssue, repoName?: string): string {
  const kind = issue.pull_request ? '[PR] ' : '';
  const labels = issue.labels?.length ? ` · labels: ${issue.labels.map(labelName).join(', ')}` : '';
  const where = repoName ? `${repoName}` : '';
  return `${where}#${issue.number} ${kind}[${issue.state}] ${issue.title} — ${who(issue.user)} · ${issue.comments} comments · updated ${day(issue.updated_at)}${labels}`;
}

export async function opListIssues(client: GitHubClient, args: ListIssuesArgs): Promise<string> {
  const current = args.page ?? 1;
  const { data, page } = await runRead<GhIssue[]>(client, READS.listIssues(args));
  if (!data.length) {
    return current > 1
      ? `Page ${current} of ${args.state ?? 'open'} issues in ${args.owner}/${args.repo} is empty — it is past the last page.`
      : `No ${args.state ?? 'open'} issues in ${args.owner}/${args.repo} match.`;
  }
  const lines = [`${args.state ?? 'open'} issues in ${args.owner}/${args.repo}:`, ''];
  for (const issue of data) lines.push(`- ${issueLine(issue)}`);
  const pulls = data.filter(i => i.pull_request).length;
  if (pulls) {
    lines.push('', `${pulls} of these are pull requests (marked [PR]) — GitHub's issues list includes them. Use listPullRequests for pull requests only.`);
  }
  lines.push('', pageFooter(page, current, data.length));
  return lines.join('\n');
}

export async function opGetIssue(client: GitHubClient, args: GetIssueArgs): Promise<string> {
  const { data: i } = await runRead<GhIssue>(client, READS.getIssue(args));
  const lines = [
    `${i.pull_request ? 'Pull request' : 'Issue'} #${i.number} in ${args.owner}/${args.repo}: ${i.title}`,
    `  State: ${i.state}${i.state_reason ? ` (${i.state_reason})` : ''}`,
    `  Author: ${who(i.user)}`,
    `  Labels: ${i.labels?.length ? i.labels.map(labelName).join(', ') : 'none'}`,
    `  Assignees: ${i.assignees?.length ? i.assignees.map(who).join(', ') : 'none'}`,
    `  Milestone: ${i.milestone ? `${i.milestone.title} (#${i.milestone.number})` : 'none'}`,
    `  Created: ${i.created_at} · Updated: ${i.updated_at}${i.closed_at ? ` · Closed: ${i.closed_at}` : ''}`,
    `  Comments: ${i.comments} (their text is not part of this response)`,
    `  URL: ${i.html_url}`,
  ];
  if (i.pull_request) {
    lines.push('  This number is a pull request — use getPullRequest for its branches, mergeability and diff.');
  }
  lines.push('', i.body ? cap(i.body, ISSUE_BODY_MAX_CHARS, 'body') : '(no description)');
  return lines.join('\n');
}

/**
 * GitHub SILENTLY DROPS labels, assignees and milestone on an issue write from
 * an account without push access — the write answers 200/201 and the fields
 * are simply absent. Compare what was asked for with what came back, so a
 * triage pass that labelled nothing does not report that it labelled.
 */
export function droppedIssueFields(
  requested: { labels?: string[]; assignees?: string[]; milestone?: number | null },
  result: GhIssue,
): string[] {
  const dropped: string[] = [];
  if (requested.labels?.length) {
    const got = new Set(result.labels.map(l => labelName(l).toLowerCase()));
    const missing = requested.labels.filter(l => !got.has(l.toLowerCase()));
    if (missing.length) dropped.push(`labels [${missing.join(', ')}]`);
  }
  if (requested.assignees?.length) {
    const got = new Set((result.assignees ?? []).map(a => a.login.toLowerCase()));
    const missing = requested.assignees.filter(a => !got.has(a.toLowerCase()));
    if (missing.length) dropped.push(`assignees [${missing.join(', ')}]`);
  }
  if (typeof requested.milestone === 'number' && result.milestone?.number !== requested.milestone) {
    dropped.push(`milestone #${requested.milestone}`);
  }
  return dropped;
}

function droppedNote(dropped: string[]): string[] {
  if (!dropped.length) return [];
  return [`  ⚠ GitHub did not apply: ${dropped.join('; ')}. It silently ignores these from accounts without push access to the repository (and ignores assignees who cannot be assigned), so they were NOT set.`];
}

export async function performCreateIssue(client: GitHubClient, args: CreateIssueArgs): Promise<{ issue: GhIssue; notApplied: string[] }> {
  const { data } = await client.post<GhIssue>(`${repoPath(args.owner, args.repo)}/issues`, {
    title: args.title,
    body: args.body,
    assignees: args.assignees,
    milestone: args.milestone,
    labels: args.labels,
  });
  return { issue: data, notApplied: droppedIssueFields(args, data) };
}

export async function opCreateIssue(client: GitHubClient, args: CreateIssueArgs): Promise<string> {
  const { issue, notApplied } = await performCreateIssue(client, args);
  return [
    `Created issue #${issue.number} in ${args.owner}/${args.repo}: ${issue.title}`,
    `  URL: ${issue.html_url}`,
    ...droppedNote(notApplied),
  ].join('\n');
}

export async function opUpdateIssue(client: GitHubClient, args: UpdateIssueArgs): Promise<string> {
  if (args.stateReason && !args.state) {
    throw new UserError('stateReason only takes effect together with state (closed → completed / not_planned, open → reopened). Nothing was changed.');
  }
  if (args.stateReason) {
    const fits = args.state === 'open' ? args.stateReason === 'reopened' : args.stateReason !== 'reopened';
    if (!fits) throw new UserError(`stateReason "${args.stateReason}" does not go with state "${args.state}". Nothing was changed.`);
  }
  const body: Record<string, unknown> = {};
  if (args.title !== undefined) body.title = args.title;
  if (args.body !== undefined) body.body = args.body;
  if (args.assignees !== undefined) body.assignees = args.assignees;
  if (args.milestone !== undefined) body.milestone = args.milestone;
  if (args.labels !== undefined) body.labels = args.labels;
  if (args.state !== undefined) body.state = args.state;
  if (args.stateReason !== undefined) body.state_reason = args.stateReason;
  if (!Object.keys(body).length) {
    throw new UserError('Nothing to update: pass at least one of title, body, assignees, milestone, labels, state.');
  }
  const { data } = await client.patch<GhIssue>(`${repoPath(args.owner, args.repo)}/issues/${args.issueNumber}`, body);
  return [
    `Updated #${data.number} in ${args.owner}/${args.repo} (${Object.keys(body).join(', ')}).`,
    `  Now: [${data.state}${data.state_reason ? `, ${data.state_reason}` : ''}] ${data.title}`,
    `  Labels: ${data.labels.length ? data.labels.map(labelName).join(', ') : 'none'} · Assignees: ${data.assignees?.length ? data.assignees.map(who).join(', ') : 'none'}`,
    `  URL: ${data.html_url}`,
    ...droppedNote(droppedIssueFields(args, data)),
  ].join('\n');
}

export async function performAddIssueComment(client: GitHubClient, args: AddIssueCommentArgs): Promise<{ id: number; html_url: string }> {
  const { data } = await client.post<{ id: number; html_url: string }>(
    `${repoPath(args.owner, args.repo)}/issues/${args.issueNumber}/comments`, { body: args.body },
  );
  return data;
}

export async function opAddIssueComment(client: GitHubClient, args: AddIssueCommentArgs): Promise<string> {
  const data = await performAddIssueComment(client, args);
  return `Added a comment to #${args.issueNumber} in ${args.owner}/${args.repo}: ${data.html_url}`;
}

// ---- Search ----

export async function opSearchCode(client: GitHubClient, args: SearchCodeArgs): Promise<string> {
  const current = args.page ?? 1;
  const { data, page, hiddenByAccessRules } = await runRead<GhSearch<{
    path: string;
    html_url: string;
    repository: { full_name: string };
    text_matches?: Array<{ fragment: string }>;
  }>>(client, READS.searchCode(args));
  const lines = searchHeader('code results', args.query, data);
  lines.push(...hiddenNote(hiddenByAccessRules), 'Note: GitHub code search covers each repository\'s default branch only, and skips files over 384 KB.', '');
  for (const item of data.items) {
    lines.push(`- ${item.repository.full_name} — ${item.path}`, `  ${item.html_url}`);
    for (const m of (item.text_matches ?? []).slice(0, 2)) {
      lines.push(`  > ${sliceSafe(m.fragment.replace(/\s+/g, ' ').trim(), 300)}`);
    }
  }
  lines.push('', pageFooter(page, current, data.items.length));
  return lines.join('\n');
}

export async function opSearchIssues(client: GitHubClient, args: SearchIssuesArgs): Promise<string> {
  const current = args.page ?? 1;
  const { data, page, hiddenByAccessRules } = await runRead<GhSearch<GhIssue>>(client, READS.searchIssues(args));
  const lines = searchHeader('issues and pull requests', args.query, data);
  lines.push(...hiddenNote(hiddenByAccessRules), '');
  for (const issue of data.items) lines.push(`- ${issueLine(issue, repoFromUrl(issue.repository_url))}`, `  ${issue.html_url}`);
  lines.push('', pageFooter(page, current, data.items.length));
  return lines.join('\n');
}

export async function opSearchUsers(client: GitHubClient, args: SearchUsersArgs): Promise<string> {
  const current = args.page ?? 1;
  const { data, page } = await runRead<GhSearch<GhUser>>(client, READS.searchUsers(args));
  const lines = searchHeader('users', args.query, data);
  lines.push('');
  for (const u of data.items) lines.push(`- ${u.login}${u.type && u.type !== 'User' ? ` (${u.type})` : ''} — ${u.html_url ?? ''}`);
  lines.push('', pageFooter(page, current, data.items.length));
  return lines.join('\n');
}

// ---- Pull requests ----

function pullState(pr: GhPull): string {
  if (pr.merged || pr.merged_at) return 'merged';
  if (pr.state === 'open' && pr.draft) return 'draft';
  return pr.state;
}

export async function opListPullRequests(client: GitHubClient, args: ListPullRequestsArgs): Promise<string> {
  const current = args.page ?? 1;
  const { data, page } = await runRead<GhPull[]>(client, READS.listPullRequests(args));
  if (!data.length) {
    return current > 1
      ? `Page ${current} of pull requests in ${args.owner}/${args.repo} is empty — it is past the last page.`
      : `No ${args.state ?? 'open'} pull requests in ${args.owner}/${args.repo} match.`;
  }
  const lines = [`${args.state ?? 'open'} pull requests in ${args.owner}/${args.repo}:`, ''];
  for (const pr of data) {
    lines.push(`- #${pr.number} [${pullState(pr)}] ${pr.title} — ${who(pr.user)} · ${pr.head.label ?? pr.head.ref} → ${pr.base.ref} · updated ${day(pr.updated_at)}`);
  }
  lines.push('', pageFooter(page, current, data.length));
  return lines.join('\n');
}

function mergeabilityLine(pr: GhPull): string {
  if (pullState(pr) === 'merged' || pr.state === 'closed') return 'n/a (not open)';
  if (pr.mergeable === null || pr.mergeable === undefined) {
    return 'not computed yet — GitHub works this out in the background after a push; ask again in a few seconds';
  }
  return `${pr.mergeable ? 'yes' : 'NO'}${pr.mergeable_state ? ` (${pr.mergeable_state})` : ''}`;
}

export async function opGetPullRequest(client: GitHubClient, args: GetPullRequestArgs): Promise<string> {
  const { data: pr } = await runRead<GhPull>(client, READS.getPullRequest(args));
  const lines = [
    `Pull request #${pr.number} in ${args.owner}/${args.repo}: ${pr.title}`,
    `  State: ${pullState(pr)}${pr.merged_at ? ` at ${pr.merged_at}${pr.merged_by ? ` by ${who(pr.merged_by)}` : ''}` : ''}`,
    `  Author: ${who(pr.user)}`,
    `  Head: ${pr.head.label ?? pr.head.ref} @ ${pr.head.sha}`,
    `  Base: ${pr.base.ref} @ ${short(pr.base.sha)}`,
    `  Mergeable: ${mergeabilityLine(pr)}`,
    `  Changes: ${pr.commits ?? '?'} commits, ${pr.changed_files ?? '?'} files, +${pr.additions ?? '?'} −${pr.deletions ?? '?'}`,
    `  Review comments: ${pr.review_comments ?? 0}`,
    `  Requested reviewers: ${pr.requested_reviewers?.length ? pr.requested_reviewers.map(who).join(', ') : 'none'}`,
    `  Labels: ${pr.labels?.length ? pr.labels.map(labelName).join(', ') : 'none'}`,
    `  Created: ${pr.created_at} · Updated: ${pr.updated_at}`,
    `  URL: ${pr.html_url}`,
    '',
    pr.body ? cap(pr.body, ISSUE_BODY_MAX_CHARS, 'description') : '(no description)',
  ];
  return lines.join('\n');
}

export async function opCreatePullRequest(client: GitHubClient, args: CreatePullRequestArgs): Promise<string> {
  const { data } = await client.post<GhPull>(`${repoPath(args.owner, args.repo)}/pulls`, {
    title: args.title,
    body: args.body,
    head: args.head,
    base: args.base,
    draft: args.draft,
    maintainer_can_modify: args.maintainerCanModify,
  });
  return [
    `Created ${data.draft ? 'draft ' : ''}pull request #${data.number} in ${args.owner}/${args.repo}: ${data.title}`,
    `  ${data.head.label ?? data.head.ref} → ${data.base.ref}`,
    `  URL: ${data.html_url}`,
  ].join('\n');
}

export async function opCreatePullRequestReview(client: GitHubClient, args: CreatePullRequestReviewArgs): Promise<string> {
  if (args.event !== 'APPROVE' && !args.body?.trim()) {
    throw new UserError(`A ${args.event} review needs a body. Nothing was submitted.`);
  }
  const comments = (args.comments ?? []).map((c, i) => {
    const hasLine = c.line !== undefined;
    const hasPosition = c.position !== undefined;
    if (hasLine === hasPosition) {
      throw new UserError(`comments[${i}] (${c.path}) must give exactly one of line or position. Nothing was submitted.`);
    }
    if (c.side && !hasLine) throw new UserError(`comments[${i}] (${c.path}): side only applies with line. Nothing was submitted.`);
    return { path: c.path, body: c.body, line: c.line, side: c.side, position: c.position };
  });
  const { data } = await client.post<{ id: number; state: string; html_url: string }>(
    `${repoPath(args.owner, args.repo)}/pulls/${args.pullNumber}/reviews`,
    { event: args.event, body: args.body, commit_id: args.commitId, ...(comments.length ? { comments } : {}) },
  );
  return [
    `Submitted a review on #${args.pullNumber} in ${args.owner}/${args.repo}: ${data.state}${comments.length ? ` with ${comments.length} inline comment(s)` : ''}.`,
    `  URL: ${data.html_url}`,
  ].join('\n');
}

export async function performMergePullRequest(client: GitHubClient, args: MergePullRequestArgs): Promise<{ merged: boolean; sha: string; message: string }> {
  const { data } = await client.put<{ merged: boolean; sha: string; message: string }>(
    `${pullPath(args)}/merge`,
    {
      merge_method: args.mergeMethod,
      commit_title: args.commitTitle,
      commit_message: args.commitMessage,
      sha: args.expectedHeadSha,
    },
  );
  return data;
}

export async function opMergePullRequest(client: GitHubClient, args: MergePullRequestArgs): Promise<string> {
  const data = await performMergePullRequest(client, args);
  if (!data.merged) {
    return `GitHub did NOT merge #${args.pullNumber} in ${args.owner}/${args.repo}: ${data.message}`;
  }
  return `Merged #${args.pullNumber} in ${args.owner}/${args.repo} (${args.mergeMethod ?? 'merge'}). Resulting commit: ${data.sha}`;
}

const FILE_STATUS: Record<string, string> = {
  added: 'A', removed: 'D', modified: 'M', renamed: 'R', copied: 'C', changed: 'T', unchanged: '=',
};

export async function opGetPullRequestFiles(client: GitHubClient, args: GetPullRequestFilesArgs): Promise<string> {
  const current = args.page ?? 1;
  const { data, page } = await runRead<Array<{
    filename: string;
    previous_filename?: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }>>(client, READS.getPullRequestFiles(args));
  if (!data.length) {
    return current > 1
      ? `Page ${current} of the files in #${args.pullNumber} is empty — it is past the last page.`
      : `#${args.pullNumber} in ${args.owner}/${args.repo} changes no files.`;
  }
  const lines = [`Files changed in #${args.pullNumber} in ${args.owner}/${args.repo}:`, ''];
  for (const f of data) {
    const name = f.previous_filename ? `${f.previous_filename} → ${f.filename}` : f.filename;
    lines.push(`${FILE_STATUS[f.status] ?? '?'} ${name} (+${f.additions} −${f.deletions})`);
    if (args.includePatch !== false) {
      if (f.patch) lines.push(cap(f.patch, PATCH_MAX_CHARS, 'diff'), '');
      else if (f.status !== 'renamed' || f.additions || f.deletions) lines.push('  (no diff from GitHub: binary file, or too large for the API)', '');
    }
  }
  lines.push(pageFooter(page, current, data.length));
  lines.push('GitHub lists at most 3,000 files for a pull request.');
  return lines.join('\n');
}

/** Check-run conclusions that mean "this did not pass". */
const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);

interface GhStatus { state: string; context: string; description: string | null; target_url: string | null }
interface GhCheckRun { name: string; status: string; conclusion: string | null; html_url?: string; app?: { name?: string } }

/** Everything getPullRequestStatus learns, as data — what the REST route answers with. */
export interface PullRequestChecks {
  headSha: string;
  /** passing | failing | pending | no_checks | unknown */
  verdict: 'passing' | 'failing' | 'pending' | 'no_checks' | 'unknown';
  failing: number;
  pending: number;
  statuses: GhStatus[];
  statusesTotal: number;
  checkRuns: GhCheckRun[];
  checkRunsTotal: number;
  /** Why check runs could not be read, or null when they were. */
  checkRunsError: string | null;
  /** Checks past the first page of either list, which were not read. */
  unread: number;
}

export async function fetchPullRequestStatus(client: GitHubClient, args: GetPullRequestStatusArgs): Promise<PullRequestChecks> {
  const rp = repoPath(args.owner, args.repo);
  const { data: pr } = await runRead<GhPull>(client, READS.getPullRequest(args));
  const sha = pr.head.sha;

  const { data: combined } = await client.get<{ total_count: number; statuses: GhStatus[] }>(
    `${rp}/commits/${seg(sha)}/status`, { per_page: 100 },
  );

  // Check runs are where GitHub Actions (and most modern CI) report. Read
  // best-effort: a fine-grained token without the Checks permission 403s here,
  // and the legacy statuses above are still worth returning.
  let checkRuns: GhCheckRun[] = [];
  let checkRunsTotal = 0;
  let checkRunsError: string | null = null;
  try {
    const { data } = await client.get<{ total_count: number; check_runs: GhCheckRun[] }>(
      `${rp}/commits/${seg(sha)}/check-runs`, { per_page: 100 },
    );
    checkRuns = data.check_runs;
    checkRunsTotal = data.total_count;
  } catch (error) {
    checkRunsError = describeGitHubError(error);
  }

  const statuses = combined.statuses ?? [];
  const failing = statuses.filter(s => s.state === 'failure' || s.state === 'error').length
    + checkRuns.filter(r => r.status === 'completed' && FAILING_CONCLUSIONS.has(r.conclusion ?? '')).length;
  const pending = statuses.filter(s => s.state === 'pending').length + checkRuns.filter(r => r.status !== 'completed').length;

  // The legacy combined `state` is deliberately ignored: it reads "pending"
  // when NO status has ever been posted, which is the Actions-only case.
  // PASSING is the verdict a model (or a pipeline) merges on, so it needs
  // every check read: a failure past the first page, or in check runs that
  // could not be read at all, would otherwise pass for green.
  const statusesTotal = combined.total_count ?? statuses.length;
  const unread = Math.max(0, checkRunsTotal - checkRuns.length) + Math.max(0, statusesTotal - statuses.length);
  let verdict: PullRequestChecks['verdict'];
  if (!statuses.length && !checkRuns.length) verdict = checkRunsError ? 'unknown' : 'no_checks';
  else if (failing) verdict = 'failing';
  else if (pending) verdict = 'pending';
  else if (checkRunsError || unread) verdict = 'unknown';
  else verdict = 'passing';

  return {
    headSha: sha, verdict, failing, pending,
    statuses, statusesTotal, checkRuns, checkRunsTotal, checkRunsError, unread,
  };
}

const VERDICT_TEXT: Record<PullRequestChecks['verdict'], (c: PullRequestChecks) => string> = {
  unknown: c => {
    if (!c.statuses.length && !c.checkRuns.length) return 'UNKNOWN — no commit statuses, and check runs could not be read';
    if (c.checkRunsError) return 'UNKNOWN — every commit status passed, but check runs could not be read';
    return `UNKNOWN — the first ${c.checkRuns.length + c.statuses.length} checks passed, but ${c.unread} more were not read`;
  },
  no_checks: () => 'NO CHECKS have reported on this commit',
  failing: c => `FAILING (${c.failing} failed)`,
  pending: c => `PENDING (${c.pending} still running or queued)`,
  passing: () => 'PASSING',
};

export async function opGetPullRequestStatus(client: GitHubClient, args: GetPullRequestStatusArgs): Promise<string> {
  const c = await fetchPullRequestStatus(client, args);
  const lines = [
    `Checks for #${args.pullNumber} in ${args.owner}/${args.repo} at head ${short(c.headSha)}: ${VERDICT_TEXT[c.verdict](c)}`,
    '',
  ];
  if (c.checkRuns.length) {
    lines.push(`Check runs (${c.checkRunsTotal}):`);
    for (const r of c.checkRuns) {
      const result = r.status === 'completed' ? (r.conclusion ?? 'completed') : r.status;
      lines.push(`  - ${r.name}${r.app?.name ? ` [${r.app.name}]` : ''}: ${result}${r.html_url ? ` — ${r.html_url}` : ''}`);
    }
    if (c.checkRunsTotal > c.checkRuns.length) lines.push(`  (showing the first ${c.checkRuns.length} of ${c.checkRunsTotal})`);
  } else if (c.checkRunsError) {
    lines.push(`Check runs: could not be read — ${c.checkRunsError}`);
  }
  if (c.statuses.length) {
    lines.push(`Commit statuses (${c.statusesTotal}):`);
    for (const s of c.statuses) {
      lines.push(`  - ${s.context}: ${s.state}${s.description ? ` — ${s.description}` : ''}${s.target_url ? ` (${s.target_url})` : ''}`);
    }
  }
  return lines.join('\n').trimEnd();
}

export async function opUpdatePullRequestBranch(client: GitHubClient, args: UpdatePullRequestBranchArgs): Promise<string> {
  const { data } = await client.put<{ message?: string }>(
    `${repoPath(args.owner, args.repo)}/pulls/${args.pullNumber}/update-branch`,
    args.expectedHeadSha ? { expected_head_sha: args.expectedHeadSha } : {},
  );
  return `GitHub accepted the request to bring #${args.pullNumber}'s branch up to date with its base${data?.message ? ` (“${data.message}”)` : ''}. It runs asynchronously: the new head appears shortly, and a merge conflict makes it fail without changing the branch — check getPullRequest afterwards.`;
}

export async function opGetPullRequestComments(client: GitHubClient, args: GetPullRequestCommentsArgs): Promise<string> {
  const current = args.page ?? 1;
  const { data, page } = await runRead<Array<{
    id: number;
    user: GhUser | null;
    body: string;
    path: string;
    line?: number | null;
    original_line?: number | null;
    in_reply_to_id?: number;
    created_at: string;
    html_url: string;
  }>>(client, READS.getPullRequestComments(args));
  if (!data.length) {
    return current > 1
      ? `Page ${current} of review comments on #${args.pullNumber} is empty — it is past the last page.`
      : `No inline review comments on #${args.pullNumber} in ${args.owner}/${args.repo}. (The PR's main conversation thread is not covered by this tool.)`;
  }
  const lines = [`Inline review comments on #${args.pullNumber} in ${args.owner}/${args.repo} (the main conversation thread is not included):`, ''];
  for (const c of data) {
    const line = c.line ?? c.original_line;
    const outdated = c.line == null && c.original_line != null ? ' (outdated)' : '';
    const reply = c.in_reply_to_id ? ` · reply to ${c.in_reply_to_id}` : '';
    lines.push(`- [${c.id}] ${who(c.user)} on ${c.path}${line ? `:${line}` : ''}${outdated} · ${day(c.created_at)}${reply}`);
    lines.push(`  ${cap(c.body, COMMENT_MAX_CHARS, 'comment').replace(/\n/g, '\n  ')}`);
  }
  lines.push('', pageFooter(page, current, data.length));
  return lines.join('\n');
}

export async function opGetPullRequestReviews(client: GitHubClient, args: GetPullRequestReviewsArgs): Promise<string> {
  const current = args.page ?? 1;
  const { data, page } = await runRead<Array<{
    id: number;
    user: GhUser | null;
    state: string;
    body: string | null;
    submitted_at?: string | null;
    html_url: string;
  }>>(client, READS.getPullRequestReviews(args));
  if (!data.length) {
    return current > 1
      ? `Page ${current} of reviews on #${args.pullNumber} is empty — it is past the last page.`
      : `No reviews on #${args.pullNumber} in ${args.owner}/${args.repo}.`;
  }
  const lines = [`Reviews on #${args.pullNumber} in ${args.owner}/${args.repo} (oldest first):`, ''];
  for (const r of data) {
    lines.push(`- ${who(r.user)}: ${r.state} · ${r.submitted_at ? day(r.submitted_at) : 'not submitted'}`);
    if (r.body) lines.push(`  ${cap(r.body, COMMENT_MAX_CHARS, 'review').replace(/\n/g, '\n  ')}`);
  }
  lines.push('', pageFooter(page, current, data.length));
  return lines.join('\n');
}
