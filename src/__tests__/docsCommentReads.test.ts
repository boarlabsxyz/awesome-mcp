import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
  collectCommentAnchors,
  fetchDocumentThreads,
  findCommentThread,
  projectCommentThread,
  renderCommentThread,
  renderCommentThreadList,
  renderSuggestionThreadList,
} from '../google-docs/commentReads.js';

// The read half of the Docs comment surface, which both the MCP tools and the
// REST routes under /api/v1/docs/* go through. The things worth pinning here are
// the ones a plausible-looking implementation gets wrong silently: the three
// parameters Google requires together, the anchor map living on the TAB rather
// than the document, and the response keys the REST route has published for as
// long as it has existed.

const head = (over: any = {}) => ({
  postId: 'p-1',
  content: 'Nice',
  author: { displayName: 'Ada', me: true },
  createTime: '2026-10-19T10:00:00Z',
  ...over,
});

function mkDocs(data: any): any {
  return { documents: { get: mock.fn(async () => ({ data })) } };
}

describe('collectCommentAnchors', () => {
  it('resolves an anchor to the range in the tab it was found in', () => {
    const anchors = collectCommentAnchors([
      {
        tabProperties: { tabId: 't.0' },
        documentTab: { commentAnchors: { 'a-1': { ranges: [{ startIndex: 7, endIndex: 12 }] } } },
      },
    ]);
    // The range itself often carries no tabId; the tab always knows which it is.
    assert.deepEqual(anchors.get('a-1'), [{ startIndex: 7, endIndex: 12, segmentId: null, tabId: 't.0' }]);
  });

  it('walks CHILD tabs, which is where a nested comment anchor lives', () => {
    const anchors = collectCommentAnchors([
      {
        tabProperties: { tabId: 't.0' },
        documentTab: { commentAnchors: {} },
        childTabs: [
          {
            tabProperties: { tabId: 't.0.1' },
            documentTab: { commentAnchors: { 'a-deep': { ranges: [{ startIndex: 3, endIndex: 5 }] } } },
            // Nesting is arbitrary depth, so one level of recursion is not enough.
            childTabs: [{
              tabProperties: { tabId: 't.0.1.1' },
              documentTab: { commentAnchors: { 'a-deeper': { ranges: [{ startIndex: 9, endIndex: 11 }] } } },
            }],
          },
        ],
      },
    ]);
    assert.equal(anchors.get('a-deep')![0].tabId, 't.0.1');
    assert.equal(anchors.get('a-deeper')![0].tabId, 't.0.1.1');
  });

  it('keeps every range of a multi-range anchor, and prefers a range own tabId', () => {
    const anchors = collectCommentAnchors([{
      tabProperties: { tabId: 't.0' },
      documentTab: {
        commentAnchors: {
          'a-1': { ranges: [{ startIndex: 1, endIndex: 2 }, { startIndex: 5, endIndex: 9, tabId: 't.9', segmentId: 'h.1' }] },
        },
      },
    }]);
    assert.equal(anchors.get('a-1')!.length, 2);
    assert.equal(anchors.get('a-1')![1].tabId, 't.9');
    assert.equal(anchors.get('a-1')![1].segmentId, 'h.1');
  });

  it('is empty rather than throwing when there are no tabs at all', () => {
    assert.equal(collectCommentAnchors(undefined).size, 0);
    assert.equal(collectCommentAnchors([{ tabProperties: { tabId: 't.0' } }]).size, 0);
  });
});

describe('fetchDocumentThreads', () => {
  const payload = {
    documentId: 'd1',
    title: 'Spec',
    revisionId: 'rev-7',
    comments: [
      {
        commentId: 'cmt-1',
        anchorId: 'a-1',
        status: 'OPEN',
        plainTextQuote: 'brave',
        headPost: head({ assigneeEmail: 'bob@example.com' }),
        replies: [{ postId: 'p-2', content: 'Agreed', author: { displayName: 'Bob' }, createTime: '2026-10-19T11:00:00Z', updateTime: '2026-10-19T12:00:00Z' }],
      },
      { commentId: 'cmt-2', status: 'RESOLVED', headPost: head({ content: 'Done' }) },
    ],
    suggestions: [{ suggestionId: 'sug-1', status: 'OPEN', summaryText: 'Insert "very"', headPost: head({ content: 'Proposed' }) }],
    tabs: [{ tabProperties: { tabId: 't.0' }, documentTab: { commentAnchors: { 'a-1': { ranges: [{ startIndex: 7, endIndex: 12 }] } } } }],
  };

  it('sends the three parameters that only work together', async () => {
    const docs = mkDocs(payload);
    await fetchDocumentThreads(docs, 'd1');
    const sent = docs.documents.get.mock.calls[0].arguments[0];
    // Google rejects commentsViewMode without the other two, and omitting
    // commentsViewMode returns a document with no `comments` key at all — which
    // would read as "this document has no comments".
    assert.equal(sent.commentsViewMode, 'COMMENTS_VIEW_MODE_INCLUDED');
    assert.equal(sent.suggestionsViewMode, 'SUGGESTIONS_INLINE');
    assert.equal(sent.includeTabsContent, true);
    // And it asks for the anchor map without the document body.
    assert.match(sent.fields, /tabs\/documentTab\/commentAnchors/);
    assert.ok(!/body/.test(sent.fields), 'the body is not needed to read comments');
  });

  it('projects threads, replies and the resolved anchor range', async () => {
    const threads = await fetchDocumentThreads(mkDocs(payload), 'd1');
    assert.equal(threads.revisionId, 'rev-7');
    assert.equal(threads.comments.length, 2);

    const [first, second] = threads.comments;
    assert.equal(first.id, 'cmt-1');
    assert.equal(first.quotedText, 'brave');
    assert.equal(first.resolved, false);
    assert.equal(first.assigneeEmail, 'bob@example.com');
    assert.deepEqual(first.ranges, [{ startIndex: 7, endIndex: 12, segmentId: null, tabId: 't.0' }]);
    assert.equal(first.replies[0].postId, 'p-2');
    assert.equal(first.headPost!.authorIsMe, true);

    assert.equal(second.resolved, true, 'RESOLVED is read off status, not a separate flag');
    assert.deepEqual(second.ranges, [], 'a thread with no anchorId has no range to report');

    assert.equal(threads.suggestions[0].id, 'sug-1');
    assert.equal(threads.suggestions[0].summaryText, 'Insert "very"');
  });

  it('reports NO ranges rather than guessing when the anchor tab was not returned', async () => {
    const threads = await fetchDocumentThreads(mkDocs({ ...payload, tabs: [] }), 'd1');
    assert.equal(threads.comments[0].anchorId, 'a-1');
    assert.deepEqual(threads.comments[0].ranges, []);
  });

  it('handles an empty document without inventing keys', async () => {
    const threads = await fetchDocumentThreads(mkDocs({}), 'd1');
    assert.deepEqual(threads.comments, []);
    assert.deepEqual(threads.suggestions, []);
    assert.equal(threads.title, null);
  });

  it('names an anonymous author as such, not as unknown data', async () => {
    const threads = await fetchDocumentThreads(mkDocs({
      comments: [{ commentId: 'c', headPost: { postId: 'p', content: 'hi', author: { anonymous: true } } }],
    }), 'd1');
    assert.equal(threads.comments[0].author, 'Anonymous');
  });

  it('keeps a deleted post in the thread, flagged', async () => {
    const threads = await fetchDocumentThreads(mkDocs({
      comments: [{ commentId: 'c', headPost: head(), replies: [{ postId: 'p-9', deleted: true }] }],
    }), 'd1');
    assert.equal(threads.comments[0].replies[0].deleted, true);
    assert.equal(threads.comments[0].replies[0].content, null);
  });

  it('findCommentThread answers null for an id no thread carries', async () => {
    const threads = await fetchDocumentThreads(mkDocs(payload), 'd1');
    assert.equal(findCommentThread(threads, 'cmt-2')!.id, 'cmt-2');
    assert.equal(findCommentThread(threads, 'nope'), null);
  });
});

describe('projectCommentThread', () => {
  it('keeps every key the REST route has always published', async () => {
    const threads = await fetchDocumentThreads(mkDocs({
      comments: [{
        commentId: 'cmt-1',
        status: 'OPEN',
        plainTextQuote: 'brave',
        headPost: head(),
        replies: [{ postId: 'p-2', content: 'Agreed', author: { displayName: 'Bob' }, createTime: 'then' }],
      }],
    }), 'd1');
    const out = projectCommentThread(threads.comments[0]) as any;

    // Clients parse these. Keys may be ADDED by a migration, never renamed.
    for (const key of ['id', 'content', 'quotedText', 'author', 'createdTime', 'resolved', 'replies']) {
      assert.ok(key in out, `${key} is part of the published response shape`);
    }
    assert.equal(out.author, 'Ada', 'author stayed a display-name string, not an object');
    // A reply keeps `id` as well as gaining `postId`: the Drive-era response
    // published `id` and the Docs API calls the same thing postId.
    assert.equal(out.replies[0].id, 'p-2');
    assert.equal(out.replies[0].postId, 'p-2');
    // And the fields the Drive path could never produce.
    for (const key of ['anchorId', 'status', 'ranges', 'assigneeEmail']) {
      assert.ok(key in out, `${key} is new in this migration`);
    }
  });
});

describe('rendering', () => {
  const thread = {
    id: 'cmt-1',
    anchorId: 'a-1',
    status: 'OPEN',
    resolved: false,
    quotedText: 'brave',
    ranges: [{ startIndex: 7, endIndex: 12, segmentId: null, tabId: 't.0' }],
    content: 'Nice',
    author: 'Ada',
    createdTime: '2026-10-19T10:00:00Z',
    assigneeEmail: 'bob@example.com',
    headPost: null,
    replies: [],
  };

  it('renders the range, the quote, the status and the assignee', () => {
    const out = renderCommentThread(thread as any);
    assert.match(out, /\[OPEN\]/);
    assert.match(out, /Anchored to: "brave"/);
    assert.match(out, /Range: 7-12 \(tab t\.0\)/);
    assert.match(out, /Assigned to: bob@example\.com/);
    assert.match(out, /Comment ID: cmt-1/);
  });

  it('says the anchor could not be resolved rather than printing nothing', () => {
    // An anchored thread rendering with no range line is indistinguishable from
    // an unanchored one — which is the state this migration exists to end.
    const out = renderCommentThread({ ...thread, ranges: [] } as any);
    assert.match(out, /anchor present but its tab was not returned/);
  });

  it('omits the range line entirely for a thread with no anchor', () => {
    const out = renderCommentThread({ ...thread, anchorId: null, ranges: [] } as any);
    assert.ok(!/Range:/.test(out));
  });

  it('counts open and resolved separately in the list header', () => {
    const out = renderCommentThreadList({
      documentId: 'd1', title: null, revisionId: null, suggestions: [],
      comments: [thread, { ...thread, id: 'cmt-2', resolved: true, status: 'RESOLVED' }],
    } as any);
    assert.match(out, /Found 2 comment threads \(1 open, 1 resolved\)/);
  });

  it('marks an edited reply and shows its action', () => {
    const out = renderCommentThread({
      ...thread,
      replies: [{
        postId: 'p-2', author: 'Bob', content: 'Agreed', createdTime: '2026-10-19T11:00:00Z',
        updatedTime: '2026-10-19T12:00:00Z', deleted: false, action: 'RESOLVE', authorUser: null, authorIsMe: false, assigneeEmail: null,
      }],
    } as any);
    assert.match(out, /\[edited\]/);
    assert.match(out, /\[RESOLVE\]/);
    assert.match(out, /Post ID: p-2/);
  });

  it('reports an empty read as none found, for comments and suggestions alike', () => {
    const empty = { documentId: 'd1', title: null, revisionId: null, comments: [], suggestions: [] } as any;
    assert.match(renderCommentThreadList(empty), /No comments found/);
    assert.match(renderSuggestionThreadList(empty), /No suggestions found/);
  });

  it('renders a suggestion with its summary', () => {
    const out = renderSuggestionThreadList({
      documentId: 'd1', title: null, revisionId: null, comments: [],
      suggestions: [{
        id: 'sug-1', status: 'OPEN', summaryText: 'Insert "very"', content: 'Proposed',
        author: 'Cleo', createdTime: '2026-10-19T10:00:00Z', headPost: null, replies: [],
      }],
    } as any);
    assert.match(out, /Found 1 suggestion:/);
    assert.match(out, /Suggested change: Insert "very"/);
    assert.match(out, /Suggestion ID: sug-1/);
  });
});
