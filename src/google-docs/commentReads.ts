// Reading comment and suggestion threads off the Docs API, for both surfaces.
//
// There is NO per-comment GET anywhere in the Docs API — `documents` exposes
// exactly `get`, `create` and `batchUpdate` — so reading one thread and reading
// all of them are the same request, and `getComment` is `listComments` plus a
// find. That is why this module exists rather than two call sites each doing
// their own projection: webServer.ts previously held a second copy of the Drive
// list/get handlers, and the copies had already drifted from the MCP tools.
//
// Three parameters are load-bearing and must travel together (Google documents
// the constraints, and violating them is a 400, not a degraded read):
//   - commentsViewMode: COMMENTS_VIEW_MODE_INCLUDED   — else `comments` is absent
//   - suggestionsViewMode: SUGGESTIONS_INLINE         — required WITH the above
//   - includeTabsContent: true                        — required WITH the above
//
// The anchor → range map lives on DocumentTab.commentAnchors, NOT on the
// top-level Document, which is the real reason tabs content is mandatory: a
// thread's `anchorId` is meaningless without it, and the range is the whole
// point of the migration off Drive.

import { docs_v1 } from 'googleapis';

type Docs = docs_v1.Docs;

/** A range a thread is anchored to, flattened out of the per-tab anchor map. */
export interface AnchoredRange {
  startIndex: number | null;
  endIndex: number | null;
  segmentId: string | null;
  tabId: string | null;
}

/** One comment or reply. Mirrors Google's Post, minus the provenance flags. */
export interface PostView {
  postId: string | null;
  author: string;
  /** People API resource name (`users/{id}`). Google sends no email for an author. */
  authorUser: string | null;
  authorIsMe: boolean;
  content: string | null;
  createdTime: string | null;
  updatedTime: string | null;
  deleted: boolean;
  /** RESOLVE / REOPEN on a comment post; the suggestion action on a suggestion post. */
  action: string | null;
  assigneeEmail: string | null;
}

export interface CommentThreadView {
  id: string | null;
  anchorId: string | null;
  /** OPEN or RESOLVED, as Google reports it. */
  status: string | null;
  resolved: boolean;
  /** Google's own plain-text quote of the anchored text, recorded at creation. */
  quotedText: string | null;
  /** Empty when the anchor could not be resolved — see resolveAnchorRanges. */
  ranges: AnchoredRange[];
  content: string | null;
  author: string;
  createdTime: string | null;
  assigneeEmail: string | null;
  headPost: PostView | null;
  replies: PostView[];
}

export interface SuggestionThreadView {
  id: string | null;
  /** OPEN, ACCEPTED or REJECTED, as Google reports it. */
  status: string | null;
  summaryText: string | null;
  content: string | null;
  author: string;
  createdTime: string | null;
  headPost: PostView | null;
  replies: PostView[];
}

export interface DocumentThreads {
  documentId: string;
  title: string | null;
  revisionId: string | null;
  comments: CommentThreadView[];
  suggestions: SuggestionThreadView[];
}

/**
 * Only populated if `commentsViewMode` asks for comments, and Google rejects that
 * parameter unless the other two accompany it. Spread this rather than writing
 * the three out per call site: two of the three look optional and are not.
 */
export const COMMENT_READ_PARAMS = {
  commentsViewMode: 'COMMENTS_VIEW_MODE_INCLUDED',
  suggestionsViewMode: 'SUGGESTIONS_INLINE',
  includeTabsContent: true,
} as const;

/**
 * Keeps a comment read from dragging the whole document body along: one thread
 * can otherwise cost a megabyte of paragraphs nobody asked for. Only the anchor
 * map is taken from the tabs, which is all the ranges need.
 */
const COMMENT_READ_FIELDS = [
  'documentId',
  'title',
  'revisionId',
  'comments',
  'suggestions',
  'tabs/tabProperties/tabId',
  'tabs/documentTab/commentAnchors',
].join(',');

function postView(post?: docs_v1.Schema$Post | null): PostView | null {
  if (!post) return null;
  return {
    postId: post.postId ?? null,
    // An anonymous author has no displayName at all, which is a real state
    // rather than missing data — do not render it as an absent field.
    author: post.author?.displayName || (post.author?.anonymous ? 'Anonymous' : 'Unknown'),
    authorUser: post.author?.user ?? null,
    authorIsMe: Boolean(post.author?.me),
    // A deleted post keeps its id and loses its content and author; Google says
    // so explicitly, so an empty body here is not a read failure.
    content: post.content ?? null,
    createdTime: post.createTime ?? null,
    updatedTime: post.updateTime ?? null,
    deleted: Boolean(post.deleted),
    action: post.commentAction ?? post.suggestionAction ?? null,
    assigneeEmail: post.assigneeEmail ?? null,
  };
}

/**
 * Walk every tab, including child tabs, collecting anchorId → ranges.
 *
 * Child tabs nest arbitrarily deep and carry their own anchor maps, so a
 * top-level-only walk silently loses the ranges of every comment in a nested
 * tab — which reads as "this comment is not anchored", the exact failure this
 * whole migration exists to end.
 */
export function collectCommentAnchors(tabs?: docs_v1.Schema$Tab[] | null): Map<string, AnchoredRange[]> {
  const anchors = new Map<string, AnchoredRange[]>();

  const walk = (tabList?: docs_v1.Schema$Tab[] | null): void => {
    for (const tab of tabList || []) {
      const tabId = tab.tabProperties?.tabId ?? null;
      const map = tab.documentTab?.commentAnchors || {};
      for (const [anchorId, anchor] of Object.entries(map)) {
        const ranges = (anchor?.ranges || []).map((range) => ({
          startIndex: range.startIndex ?? null,
          endIndex: range.endIndex ?? null,
          segmentId: range.segmentId ?? null,
          // The range carries its own tabId only sometimes; the tab we found it
          // in always knows which one it is.
          tabId: range.tabId ?? tabId,
        }));
        anchors.set(anchorId, [...(anchors.get(anchorId) || []), ...ranges]);
      }
      walk(tab.childTabs);
    }
  };

  walk(tabs);
  return anchors;
}

function commentThreadView(
  thread: docs_v1.Schema$CommentThread,
  anchors: Map<string, AnchoredRange[]>,
): CommentThreadView {
  const head = postView(thread.headPost);
  return {
    id: thread.commentId ?? null,
    anchorId: thread.anchorId ?? null,
    status: thread.status ?? null,
    resolved: thread.status === 'RESOLVED',
    quotedText: thread.plainTextQuote ?? null,
    // Absent rather than guessed: several threads may share one anchor, and an
    // anchor whose tab was not returned has no range we can honestly report.
    ranges: (thread.anchorId && anchors.get(thread.anchorId)) || [],
    content: head?.content ?? null,
    author: head?.author ?? 'Unknown',
    createdTime: head?.createdTime ?? null,
    assigneeEmail: head?.assigneeEmail ?? null,
    headPost: head,
    replies: (thread.replies || []).map(postView).filter((p): p is PostView => p !== null),
  };
}

function suggestionThreadView(thread: docs_v1.Schema$SuggestionThread): SuggestionThreadView {
  const head = postView(thread.headPost);
  return {
    id: thread.suggestionId ?? null,
    status: thread.status ?? null,
    summaryText: thread.summaryText ?? null,
    content: head?.content ?? null,
    author: head?.author ?? 'Unknown',
    createdTime: head?.createdTime ?? null,
    headPost: head,
    replies: (thread.replies || []).map(postView).filter((p): p is PostView => p !== null),
  };
}

/** One document read, every thread and every resolved anchor range. */
export async function fetchDocumentThreads(docs: Docs, documentId: string): Promise<DocumentThreads> {
  const response = await docs.documents.get({
    documentId,
    ...COMMENT_READ_PARAMS,
    fields: COMMENT_READ_FIELDS,
  });

  const doc = response.data || {};
  const anchors = collectCommentAnchors(doc.tabs);
  return {
    documentId,
    title: doc.title ?? null,
    revisionId: doc.revisionId ?? null,
    comments: (doc.comments || []).map((thread) => commentThreadView(thread, anchors)),
    suggestions: (doc.suggestions || []).map(suggestionThreadView),
  };
}

/**
 * Null when no thread carries that id. The caller decides whether that is a 404
 * or a refusal — the Docs API has no per-comment endpoint to 404 on its behalf.
 */
export function findCommentThread(threads: DocumentThreads, commentId: string): CommentThreadView | null {
  return threads.comments.find((thread) => thread.id === commentId) ?? null;
}

// === Projection, for the REST plane ===

/**
 * The thread as /api/v1/docs/{id}/comments has always published it, plus the
 * fields the Drive path could not produce.
 *
 * `id` on both the thread and each reply is the compatibility half: the
 * ChatGPT-compat route published those keys and clients read them, so they are
 * kept even though the Docs API calls a reply's identifier `postId`. Keys are
 * ADDED here, never renamed or removed.
 */
export function projectCommentThread(thread: CommentThreadView) {
  return {
    id: thread.id,
    content: thread.content,
    quotedText: thread.quotedText,
    author: thread.author,
    createdTime: thread.createdTime,
    resolved: thread.resolved,
    anchorId: thread.anchorId,
    status: thread.status,
    ranges: thread.ranges,
    assigneeEmail: thread.assigneeEmail,
    replies: thread.replies.map((reply) => ({
      id: reply.postId,
      postId: reply.postId,
      content: reply.content,
      author: reply.author,
      createdTime: reply.createdTime,
      updatedTime: reply.updatedTime,
      action: reply.action,
      deleted: reply.deleted,
    })),
  };
}

// === Rendering, for the MCP tools ===

function renderRanges(ranges: AnchoredRange[]): string {
  if (ranges.length === 0) return '';
  return ranges
    .map((r) => `${r.startIndex ?? '?'}-${r.endIndex ?? '?'}${r.tabId ? ` (tab ${r.tabId})` : ''}`)
    .join(', ');
}

function renderPost(post: PostView, index: number): string {
  const when = post.createdTime ? new Date(post.createdTime).toLocaleString() : 'Unknown date';
  const edited = post.updatedTime && post.updatedTime !== post.createdTime ? ' [edited]' : '';
  const action = post.action ? ` [${post.action}]` : '';
  const body = post.deleted ? '(deleted)' : post.content || '';
  return `\n   ${index}. **${post.author}** (${when})${edited}${action}\n      ${body}\n      Post ID: ${post.postId ?? 'unknown'}`;
}

/** The per-thread block shared by listComments and getComment. */
export function renderCommentThread(thread: CommentThreadView): string {
  const when = thread.createdTime ? new Date(thread.createdTime).toLocaleString() : 'Unknown date';
  const lines = [`**${thread.author}** (${when}) [${thread.status || 'UNKNOWN'}]`];

  if (thread.quotedText) lines.push(`  Anchored to: "${thread.quotedText}"`);
  const ranges = renderRanges(thread.ranges);
  if (ranges) lines.push(`  Range: ${ranges}`);
  else if (thread.anchorId) lines.push('  Range: anchor present but its tab was not returned');
  if (thread.assigneeEmail) lines.push(`  Assigned to: ${thread.assigneeEmail}`);
  lines.push(`  ${thread.content || '(no content)'}`);
  lines.push(`  Comment ID: ${thread.id ?? 'unknown'}`);
  if (thread.replies.length > 0) {
    lines.push(`  Replies (${thread.replies.length}):${thread.replies.map((p, i) => renderPost(p, i + 1)).join('')}`);
  }
  return lines.join('\n');
}

export function renderCommentThreadList(threads: DocumentThreads): string {
  if (threads.comments.length === 0) {
    // Said in full because an empty list from a successful read is a real answer,
    // whereas the same sentence after a failed one would be a lie — the callers
    // only reach this line on success.
    return 'No comments found in this document.';
  }
  const open = threads.comments.filter((t) => !t.resolved).length;
  const header = `Found ${threads.comments.length} comment thread${threads.comments.length === 1 ? '' : 's'} `
    + `(${open} open, ${threads.comments.length - open} resolved):`;
  return [header, ...threads.comments.map((t, i) => `\n${i + 1}. ${renderCommentThread(t)}`)].join('\n');
}

export function renderSuggestionThread(thread: SuggestionThreadView): string {
  const when = thread.createdTime ? new Date(thread.createdTime).toLocaleString() : 'Unknown date';
  const lines = [`**${thread.author}** (${when}) [${thread.status || 'UNKNOWN'}]`];
  if (thread.summaryText) lines.push(`  Suggested change: ${thread.summaryText}`);
  if (thread.content) lines.push(`  ${thread.content}`);
  lines.push(`  Suggestion ID: ${thread.id ?? 'unknown'}`);
  if (thread.replies.length > 0) {
    lines.push(`  Replies (${thread.replies.length}):${thread.replies.map((p, i) => renderPost(p, i + 1)).join('')}`);
  }
  return lines.join('\n');
}

export function renderSuggestionThreadList(threads: DocumentThreads): string {
  if (threads.suggestions.length === 0) {
    return 'No suggestions found in this document.';
  }
  const header = `Found ${threads.suggestions.length} suggestion${threads.suggestions.length === 1 ? '' : 's'}:`;
  return [header, ...threads.suggestions.map((t, i) => `\n${i + 1}. ${renderSuggestionThread(t)}`)].join('\n');
}
