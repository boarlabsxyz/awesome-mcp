import assert from 'node:assert/strict';
import { describe, it, mock, before } from 'node:test';
import { UserError } from 'fastmcp';

// src/google-docs/server.ts is the application entry point, and it used to call
// startServer() at import time — so no test could import it, and its ~770
// executable lines (every tool body in the Docs server) sat at 0% coverage. It now
// skips booting under the test runner, which is what makes this file possible.
//
// These cover the thin half of each write tool: the client lookup, the string it
// renders, and its error mapping. The logic underneath is covered by
// docsWriteOps.test.ts against stub clients.

const toolMap = new Map<string, { execute: (...args: any[]) => any; parameters: any; annotations?: any }>();

const FastMCPModule = await import('fastmcp');
const origAddTool = FastMCPModule.FastMCP.prototype.addTool;
FastMCPModule.FastMCP.prototype.addTool = function (tool: any) {
  // Importing the entry point pulls in every sibling MCP server, so this captures
  // their tools too. Tool names are unique across the repo, so lookup by name is
  // unambiguous.
  toolMap.set(tool.name, tool);
  return origAddTool.call(this, tool);
};

before(() => {
  // Guard against a regression that would be very confusing: if the boot guard
  // ever stops working, importing this file starts a server mid-test-run.
  assert.equal(process.env.NODE_TEST_CONTEXT !== undefined, true, 'expected to be under the node test runner');
});

await import('../google-docs/server.js');
FastMCPModule.FastMCP.prototype.addTool = origAddTool;

const noopLog = { info: () => {}, error: () => {}, warn: () => {} };
const DOC_TEXT = 'Hello brave new world\n';

function mkErr(code: number, message = 'boom'): any {
  const e: any = new Error(message);
  e.code = code;
  return e;
}

function mkDocs(overrides: any = {}): any {
  return {
    documents: {
      get: mock.fn(async () => ({
        data: {
          body: {
            content: [
              { endIndex: 1, sectionBreak: {} },
              {
                startIndex: 1,
                endIndex: 1 + DOC_TEXT.length,
                paragraph: { elements: [{ startIndex: 1, endIndex: 1 + DOC_TEXT.length, textRun: { content: DOC_TEXT } }] },
              },
            ],
          },
        },
      })),
      batchUpdate: mock.fn(async () => ({ data: { replies: [{ replaceAllText: { occurrencesChanged: 2 } }] } })),
      ...(overrides.documents || {}),
    },
  };
}

function mkDrive(overrides: any = {}): any {
  return {
    files: {
      get: mock.fn(async () => ({ data: { mimeType: 'image/png', webContentLink: 'https://drive/i.png', parents: ['f1'] } })),
      create: mock.fn(async () => ({ data: { id: 'new-1', name: 'New', webViewLink: 'https://docs/new-1' } })),
      copy: mock.fn(async () => ({ data: { id: 'copy-1', name: 'Converted', webViewLink: 'https://docs/copy-1' } })),
      ...(overrides.files || {}),
    },
    permissions: { create: mock.fn(async () => ({ data: {} })) },
    comments: {
      create: mock.fn(async () => ({ data: { id: 'cmt-9', content: 'Nice' } })),
      get: mock.fn(async () => ({ data: { content: 'Nice', resolved: true } })),
      update: mock.fn(async () => ({ data: {} })),
      delete: mock.fn(async () => ({})),
      ...(overrides.comments || {}),
    },
    replies: { create: mock.fn(async () => ({ data: { id: 'rep-9' } })) },
  };
}

/** A session carrying stub Google clients, which is all these tools reach for. */
function session(docs: any = mkDocs(), drive: any = mkDrive()): any {
  return { googleDocs: docs, googleDrive: drive, oauthClient: {}, email: 't@example.com' };
}

const call = (name: string, args: any, sess: any = session()) =>
  toolMap.get(name)!.execute(args, { session: sess, log: noopLog });

describe('google-docs server registers its write tools', () => {
  it('captured every write tool this change touches', () => {
    for (const name of [
      'appendToGoogleDoc', 'insertText', 'deleteRange', 'applyTextStyle', 'applyParagraphStyle',
      'insertTable', 'insertPageBreak', 'insertImageFromUrl', 'insertLocalImage', 'formatMatchingText',
      'findAndReplace', 'addComment', 'replyToComment', 'resolveComment', 'deleteComment',
      'importDocx', 'batchUpdateDoc', 'importToGoogleDoc', 'exportDocToPdf',
      // The Docs-API comment and suggestion set.
      'listComments', 'getComment', 'listSuggestions', 'reopenComment', 'assignComment',
      'updateCommentPost', 'deleteCommentReply', 'acceptSuggestion', 'rejectSuggestion', 'deleteSuggestion',
    ]) {
      assert.ok(toolMap.has(name), `${name} was not registered`);
    }
  });

  it('keeps the destructive annotations that MCP clients prompt on', () => {
    assert.equal(toolMap.get('deleteRange')!.annotations.destructiveHint, true);
    assert.equal(toolMap.get('deleteComment')!.annotations.destructiveHint, true);
    // Everything that discards text someone wrote: a reply, a post's previous
    // wording, a resolved thread, a proposed edit.
    for (const name of ['deleteCommentReply', 'updateCommentPost', 'resolveComment', 'rejectSuggestion', 'deleteSuggestion']) {
      assert.equal(toolMap.get(name)!.annotations.destructiveHint, true, `${name} must be flagged destructive`);
    }
    // Reopening and reassigning change state but destroy nothing.
    for (const name of ['reopenComment', 'assignComment', 'acceptSuggestion']) {
      assert.equal(toolMap.get(name)!.annotations.destructiveHint, undefined, `${name} is not a delete`);
      assert.equal(toolMap.get(name)!.annotations.readOnlyHint, false);
    }
  });
});

describe('docs text tools', () => {
  it('appendToGoogleDoc names the document, and the tab when one was given', async () => {
    assert.match(await call('appendToGoogleDoc', { documentId: 'd1', textToAppend: 'x', addNewlineIfNeeded: true }), /document d1/);
    const docs = mkDocs({
      documents: {
        get: mock.fn(async () => ({ data: { tabs: [{ tabProperties: { tabId: 't1' }, documentTab: { body: { content: [{ endIndex: 5 }] } } }] } })),
        batchUpdate: mock.fn(async () => ({ data: {} })),
      },
    });
    assert.match(
      await call('appendToGoogleDoc', { documentId: 'd1', textToAppend: 'x', addNewlineIfNeeded: true, tabId: 't1' }, session(docs)),
      /tab t1 in document d1/,
    );
  });

  it('appendToGoogleDoc maps an unknown tab to a UserError', async () => {
    const docs = mkDocs({ documents: { get: mock.fn(async () => ({ data: { tabs: [] } })) } });
    await assert.rejects(
      () => call('appendToGoogleDoc', { documentId: 'd1', textToAppend: 'x', addNewlineIfNeeded: true, tabId: 'zz' }, session(docs)),
      (err: any) => err instanceof UserError && /not found/.test(err.message),
    );
  });

  it('appendToGoogleDoc wraps an unexpected failure', async () => {
    const docs = mkDocs({ documents: { get: mock.fn(async () => { throw mkErr(500, 'upstream down'); }) } });
    await assert.rejects(
      () => call('appendToGoogleDoc', { documentId: 'd1', textToAppend: 'x', addNewlineIfNeeded: true }, session(docs)),
      (err: any) => err instanceof UserError && /Failed to append/.test(err.message),
    );
  });

  it('insertText reports the index and the tab', async () => {
    assert.match(await call('insertText', { documentId: 'd1', textToInsert: 'x', index: 4 }), /at index 4/);
  });

  it('insertText wraps a failure', async () => {
    const docs = mkDocs({ documents: { batchUpdate: mock.fn(async () => { throw mkErr(500); }) } });
    await assert.rejects(
      () => call('insertText', { documentId: 'd1', textToInsert: 'x', index: 4 }, session(docs)),
      (err: any) => err instanceof UserError && /Failed to insert text/.test(err.message),
    );
  });

  it('deleteRange reports the range it removed', async () => {
    assert.match(await call('deleteRange', { documentId: 'd1', startIndex: 2, endIndex: 6 }), /range 2-6/);
  });

  it('deleteRange wraps a failure', async () => {
    const docs = mkDocs({ documents: { batchUpdate: mock.fn(async () => { throw mkErr(500); }) } });
    await assert.rejects(
      () => call('deleteRange', { documentId: 'd1', startIndex: 2, endIndex: 6 }, session(docs)),
      (err: any) => err instanceof UserError && /Failed to delete range/.test(err.message),
    );
  });

  it('findAndReplace reports the count Google returned', async () => {
    assert.match(
      await call('findAndReplace', { documentId: 'd1', findText: 'a', replaceText: 'b', matchCase: false }),
      /Replaced 2 occurrence/,
    );
  });
});

describe('docs styling tools', () => {
  it('applyTextStyle lists the fields it applied', async () => {
    const out = await call('applyTextStyle', {
      documentId: 'd1', target: { textToFind: 'brave', matchInstance: 1 }, style: { bold: true },
    });
    assert.match(out, /applied text style \(bold\)/);
  });

  it('applyTextStyle says so when no style key was recognised', async () => {
    const out = await call('applyTextStyle', { documentId: 'd1', target: { startIndex: 2, endIndex: 5 }, style: {} });
    assert.equal(out, 'No valid text styling options were provided.');
  });

  it('applyTextStyle surfaces a missing target as a UserError', async () => {
    await assert.rejects(
      () => call('applyTextStyle', { documentId: 'd1', target: { textToFind: 'absent', matchInstance: 1 }, style: { bold: true } }),
      (err: any) => err instanceof UserError && /Could not find/.test(err.message),
    );
  });

  it('applyParagraphStyle reports success and the empty-style case', async () => {
    assert.match(
      await call('applyParagraphStyle', { documentId: 'd1', target: { textToFind: 'brave' }, style: { alignment: 'CENTER' } }),
      /applied paragraph styles/,
    );
    assert.equal(
      await call('applyParagraphStyle', { documentId: 'd1', target: { startIndex: 1, endIndex: 9 }, style: {} }),
      'No valid paragraph styling options were provided.',
    );
  });

  it('applyParagraphStyle wraps an upstream failure', async () => {
    const docs = mkDocs({ documents: { get: mock.fn(async () => { throw mkErr(500); }) } });
    await assert.rejects(
      () => call('applyParagraphStyle', { documentId: 'd1', target: { textToFind: 'x' }, style: { alignment: 'END' } }, session(docs)),
      (err: any) => err instanceof UserError && /Failed to apply paragraph style/.test(err.message),
    );
  });

  it('formatMatchingText names the instance it formatted', async () => {
    assert.match(
      await call('formatMatchingText', { documentId: 'd1', textToFind: 'brave', matchInstance: 1, bold: true }),
      /instance 1 of "brave"/,
    );
  });

  it('formatMatchingText wraps a failure', async () => {
    const docs = mkDocs({ documents: { get: mock.fn(async () => { throw mkErr(500); }) } });
    await assert.rejects(
      () => call('formatMatchingText', { documentId: 'd1', textToFind: 'x', matchInstance: 1, bold: true }, session(docs)),
      (err: any) => err instanceof UserError && /Failed to format text/.test(err.message),
    );
  });
});

describe('docs structure tools', () => {
  it('insertTable reports the dimensions', async () => {
    assert.match(await call('insertTable', { documentId: 'd1', rows: 2, columns: 3, index: 4 }), /2x3 table at index 4/);
  });

  it('insertTable wraps a failure', async () => {
    const docs = mkDocs({ documents: { batchUpdate: mock.fn(async () => { throw mkErr(500); }) } });
    await assert.rejects(
      () => call('insertTable', { documentId: 'd1', rows: 2, columns: 3, index: 4 }, session(docs)),
      (err: any) => err instanceof UserError && /Failed to insert table/.test(err.message),
    );
  });

  it('insertPageBreak reports the index', async () => {
    assert.match(await call('insertPageBreak', { documentId: 'd1', index: 7 }), /page break at index 7/);
  });

  it('insertPageBreak wraps a failure', async () => {
    const docs = mkDocs({ documents: { batchUpdate: mock.fn(async () => { throw mkErr(500); }) } });
    await assert.rejects(
      () => call('insertPageBreak', { documentId: 'd1', index: 7 }, session(docs)),
      (err: any) => err instanceof UserError && /Failed to insert page break/.test(err.message),
    );
  });

  it('batchUpdateDoc summarises by operation type', async () => {
    const out = await call('batchUpdateDoc', {
      documentId: 'd1',
      operations: [
        { type: 'insert_text', index: 2, text: 'A' },
        { type: 'insert_text', index: 9, text: 'B' },
        { type: 'insert_page_break', index: 4 },
      ],
    });
    assert.match(out, /3 operation\(s\) executed/);
    assert.match(out, /2x insert_text/);
  });

  it('batchUpdateDoc reports a batch that mapped to nothing', async () => {
    // create_bullet_list maps to no request when the helper cannot build one, and
    // "no valid operations" is a real answer rather than a silent success.
    const out = await call('batchUpdateDoc', { documentId: 'd1', operations: [{ type: 'insert_text', index: 1, text: 'x' }] });
    assert.ok(typeof out === 'string');
  });
});

describe('docs image tools', () => {
  it('insertImageFromUrl reports the size when both dimensions are given', async () => {
    const out = await call('insertImageFromUrl', {
      documentId: 'd1', imageUrl: 'https://example.com/a.png', index: 2, width: 80, height: 40,
    });
    assert.match(out, /with size 80x40pt/);
  });

  it('insertImageFromUrl wraps an invalid URL', async () => {
    await assert.rejects(
      () => call('insertImageFromUrl', { documentId: 'd1', imageUrl: 'nope', index: 2 }),
      (err: any) => err instanceof UserError,
    );
  });

  it('insertLocalImage returns the resolved URL it inserted', async () => {
    const out = await call('insertLocalImage', {
      documentId: 'd1', driveFileId: 'img-1', index: 2, uploadToSameFolder: true,
    });
    assert.match(out, /Image URL: https:\/\/drive\/i\.png/);
  });

  it('insertLocalImage wraps a non-image Drive file', async () => {
    const drive = mkDrive({ files: { get: mock.fn(async () => ({ data: { mimeType: 'application/pdf' } })) } });
    await assert.rejects(
      () => call('insertLocalImage', { documentId: 'd1', driveFileId: 'x', index: 2, uploadToSameFolder: true }, session(mkDocs(), drive)),
      (err: any) => err instanceof UserError && /not an image/.test(err.message),
    );
  });
});

describe('docs comment and suggestion tools', () => {
  /** Docs client whose batchUpdate answers `data` and records the request. */
  const commentDocs = (data: any = { commentUpdateState: 'ALL_SAVED', replies: [{}] }) =>
    mkDocs({ documents: { batchUpdate: mock.fn(async () => ({ data })) } });

  /** A document read carrying one comment thread and one suggestion. */
  const threadsDocs = () => mkDocs({ documents: {
    get: mock.fn(async () => ({
      data: {
        documentId: 'd1',
        comments: [{
          commentId: 'cmt-9',
          anchorId: 'a-1',
          status: 'OPEN',
          plainTextQuote: 'brave',
          headPost: { postId: 'p-1', content: 'Nice', author: { displayName: 'Ada' }, createTime: '2026-10-19T10:00:00Z' },
          replies: [{ postId: 'p-2', content: 'Agreed', author: { displayName: 'Bob' }, createTime: '2026-10-19T11:00:00Z' }],
        }],
        suggestions: [{
          suggestionId: 'sug-1',
          status: 'OPEN',
          summaryText: 'Insert "very"',
          headPost: { postId: 'p-3', content: 'Suggest wording', author: { displayName: 'Cleo' } },
        }],
        tabs: [{ tabProperties: { tabId: 't.0' }, documentTab: { commentAnchors: { 'a-1': { ranges: [{ startIndex: 7, endIndex: 12 }] } } } }],
      },
    })),
  } });

  describe('reads', () => {
    it('listComments renders the range, status and replies', async () => {
      const out = await call('listComments', { documentId: 'd1' }, session(threadsDocs()));
      assert.match(out, /Found 1 comment thread \(1 open, 0 resolved\)/);
      assert.match(out, /Anchored to: "brave"/);
      assert.match(out, /Range: 7-12 \(tab t\.0\)/);
      assert.match(out, /Comment ID: cmt-9/);
      assert.match(out, /Agreed/);
    });

    it('listComments sends the three parameters Google requires together', async () => {
      const docs = threadsDocs();
      await call('listComments', { documentId: 'd1' }, session(docs));
      const sent = docs.documents.get.mock.calls[0].arguments[0];
      // Any one of these missing is a 400 or a silently comment-less read.
      assert.equal(sent.commentsViewMode, 'COMMENTS_VIEW_MODE_INCLUDED');
      assert.equal(sent.suggestionsViewMode, 'SUGGESTIONS_INLINE');
      assert.equal(sent.includeTabsContent, true);
    });

    it('listComments reports an empty document as having none', async () => {
      const docs = mkDocs({ documents: { get: mock.fn(async () => ({ data: { comments: [] } })) } });
      assert.match(await call('listComments', { documentId: 'd1' }, session(docs)), /No comments found/);
    });

    it('getComment finds one thread by id', async () => {
      const out = await call('getComment', { documentId: 'd1', commentId: 'cmt-9' }, session(threadsDocs()));
      assert.match(out, /Comment ID: cmt-9/);
      assert.match(out, /Ada/);
    });

    it('getComment reports a miss as a lookup, and warns about the Drive id space', async () => {
      await assert.rejects(
        () => call('getComment', { documentId: 'd1', commentId: 'nope' }, session(threadsDocs())),
        (err: any) => {
          assert.ok(err instanceof UserError);
          assert.match(err.message, /No comment thread with ID nope/);
          // The ids changed space in this migration, which is the first thing a
          // caller with a cached id needs told.
          assert.match(err.message, /Drive API are a different id space/);
          return true;
        },
      );
    });

    it('listSuggestions renders the proposed change', async () => {
      const out = await call('listSuggestions', { documentId: 'd1' }, session(threadsDocs()));
      assert.match(out, /Found 1 suggestion/);
      assert.match(out, /Insert "very"/);
      assert.match(out, /Suggestion ID: sug-1/);
    });

    it('listComments wraps a failure', async () => {
      const docs = mkDocs({ documents: { get: mock.fn(async () => { throw mkErr(404); }) } });
      await assert.rejects(
        () => call('listComments', { documentId: 'd1' }, session(docs)),
        (err: any) => err instanceof UserError && /Failed to list comments/.test(err.message),
      );
    });
  });

  describe('writes', () => {
    it('addComment reports the anchor it created', async () => {
      const docs = commentDocs({
        commentUpdateState: 'ALL_SAVED',
        replies: [{ insertComment: { commentThread: { commentId: 'cmt-9', plainTextQuote: 'brave', status: 'OPEN', headPost: {} } } }],
      });
      const out = await call('addComment', { documentId: 'd1', startIndex: 7, endIndex: 12, commentText: 'Nice' }, session(docs));
      assert.match(out, /Comment ID: cmt-9/);
      assert.match(out, /anchored to 7-12/);
      assert.match(out, /Anchored to: "brave"/);
    });

    it('does not claim an assignment Google echoed no assignee for', async () => {
      const docs = commentDocs({
        commentUpdateState: 'ALL_SAVED',
        replies: [{ insertComment: { commentThread: { commentId: 'cmt-9', status: 'OPEN', headPost: {} } } }],
      });
      const out = await call('addComment', {
        documentId: 'd1', startIndex: 7, endIndex: 12, commentText: 'Nice', assigneeEmail: 'ada@example.com',
      }, session(docs));
      assert.match(out, /Assignment to ada@example\.com was requested, but Google echoed no assignee back/);
      assert.ok(!/ Assigned to /.test(out), 'must not read as a completed assignment');
    });

    it('reports a recorded assignment plainly', async () => {
      const docs = commentDocs({
        commentUpdateState: 'ALL_SAVED',
        replies: [{ insertComment: { commentThread: { commentId: 'cmt-9', status: 'OPEN', headPost: { assigneeEmail: 'ada@example.com' } } } }],
      });
      const out = await call('addComment', {
        documentId: 'd1', startIndex: 7, endIndex: 12, commentText: 'Nice', assigneeEmail: 'ada@example.com',
      }, session(docs));
      assert.match(out, /Assigned to ada@example\.com\./);
    });

    it('addComment wraps a failure', async () => {
      const docs = mkDocs({ documents: { batchUpdate: mock.fn(async () => { throw mkErr(500); }) } });
      await assert.rejects(
        () => call('addComment', { documentId: 'd1', startIndex: 7, endIndex: 12, commentText: 'Nice' }, session(docs)),
        (err: any) => err instanceof UserError && /Failed to add comment/.test(err.message),
      );
    });

    it('replyToComment reports the post id', async () => {
      const docs = commentDocs({ commentUpdateState: 'ALL_SAVED', replies: [{ addCommentReply: { post: { postId: 'rep-9' } } }] });
      assert.match(
        await call('replyToComment', { documentId: 'd1', commentId: 'c1', replyText: 'ok' }, session(docs)),
        /Post ID: rep-9/,
      );
    });

    it('replyToComment wraps an unexpected failure', async () => {
      const docs = mkDocs({ documents: { batchUpdate: mock.fn(async () => { throw mkErr(500); }) } });
      await assert.rejects(
        () => call('replyToComment', { documentId: 'd1', commentId: 'c1', replyText: 'ok' }, session(docs)),
        (err: any) => err instanceof UserError && /Failed to add reply/.test(err.message),
      );
    });

    it('lets a 404 keep Google own message instead of wrapping it generically', async () => {
      const docs = mkDocs({ documents: { batchUpdate: mock.fn(async () => { throw mkErr(404); }) } });
      await assert.rejects(
        () => call('replyToComment', { documentId: 'd1', commentId: 'c1', replyText: 'ok' }, session(docs)),
        // executeBatchUpdate already turns a 404 into a message naming the
        // document; re-wrapping it as "Failed to add reply" would bury the cause.
        (err: any) => err instanceof UserError && /Document not found/.test(err.message),
      );
    });

    it('resolveComment separates a confirmed resolution from an unconfirmed one', async () => {
      assert.match(
        await call('resolveComment', { documentId: 'd1', commentId: 'c1' }, session(commentDocs())),
        /c1 is resolved/,
      );
      // Google answers 200 either way, so an unconfirmed write must not render as
      // success — this is the whole reason commentUpdateState is read.
      const unconfirmed = await call('resolveComment', { documentId: 'd1', commentId: 'c1' }, session(commentDocs({ replies: [{}] })));
      assert.match(unconfirmed, /did not confirm/);
    });

    it('resolveComment surfaces a reported failure rather than claiming success', async () => {
      const docs = commentDocs({ commentUpdateState: 'ALL_FAILED_UNKNOWN_REASON', replies: [{}] });
      await assert.rejects(
        () => call('resolveComment', { documentId: 'd1', commentId: 'c1' }, session(docs)),
        (err: any) => err instanceof UserError && /was NOT applied/.test(err.message),
      );
    });

    it('reopenComment puts a thread back', async () => {
      assert.match(
        await call('reopenComment', { documentId: 'd1', commentId: 'c1' }, session(commentDocs())),
        /c1 is open again/,
      );
    });

    it('assignComment confirms the assignee', async () => {
      assert.match(
        await call('assignComment', { documentId: 'd1', commentId: 'c1', assigneeEmail: 'ada@example.com' }, session(commentDocs())),
        /assigned to ada@example\.com/,
      );
    });

    it('updateCommentPost echoes the new text, the caller only record of the edit', async () => {
      assert.match(
        await call('updateCommentPost', { documentId: 'd1', commentId: 'c1', postId: 'p-2', content: 'Reworded' }, session(commentDocs())),
        /now reads: "Reworded"/,
      );
    });

    it('deleteComment confirms the id it deleted', async () => {
      assert.match(
        await call('deleteComment', { documentId: 'd1', commentId: 'c1' }, session(commentDocs())),
        /c1 and its replies have been deleted/,
      );
    });

    it('deleteComment wraps an unexpected failure', async () => {
      const docs = mkDocs({ documents: { batchUpdate: mock.fn(async () => { throw mkErr(500); }) } });
      await assert.rejects(
        () => call('deleteComment', { documentId: 'd1', commentId: 'c1' }, session(docs)),
        (err: any) => err instanceof UserError && /Failed to delete comment/.test(err.message),
      );
    });

    it('deleteCommentReply names the thread it left behind', async () => {
      assert.match(
        await call('deleteCommentReply', { documentId: 'd1', commentId: 'c1', postId: 'p-2' }, session(commentDocs())),
        /Reply p-2 has been deleted from thread c1/,
      );
    });
  });

  describe('suggestion verdicts', () => {
    it('acceptSuggestion confirms from the ids Google reported', async () => {
      const docs = commentDocs({ suggestionResponses: [{ acceptedSuggestionIds: ['sug-1'] }] });
      assert.match(
        await call('acceptSuggestion', { documentId: 'd1', suggestionId: 'sug-1' }, session(docs)),
        /sug-1 has been accepted/,
      );
    });

    it('reports an unconfirmed verdict as NOT confirmed, quoting what Google said', async () => {
      const docs = commentDocs({ suggestionResponses: [{ acceptedSuggestionIds: ['other'] }] });
      const out = await call('acceptSuggestion', { documentId: 'd1', suggestionId: 'sug-1' }, session(docs));
      assert.match(out, /NOT confirmed/);
      assert.match(out, /Google reported: other/);
    });

    it('says "delete", not "delet", in the unconfirmed message', async () => {
      // The base verb is passed, not derived: stripping `ed` off "deleted"
      // produced "Request to delet suggestion ...".
      const out = await call('deleteSuggestion', { documentId: 'd1', suggestionId: 's9' },
        session(commentDocs({ suggestionResponses: [{ deletedSuggestionIds: [] }] })));
      assert.match(out, /Request to delete suggestion s9/);
      assert.ok(!/delet /.test(out), 'no truncated verb');
    });

    it('uses the right base verb for accept and reject too', async () => {
      const accept = await call('acceptSuggestion', { documentId: 'd1', suggestionId: 's1' },
        session(commentDocs({ suggestionResponses: [{ acceptedSuggestionIds: [] }] })));
      assert.match(accept, /Request to accept suggestion s1/);
      const reject = await call('rejectSuggestion', { documentId: 'd1', suggestionId: 's2' },
        session(commentDocs({ suggestionResponses: [{ rejectedSuggestionIds: [] }] })));
      assert.match(reject, /Request to reject suggestion s2/);
    });

    it('rejectSuggestion and deleteSuggestion read their own id lists', async () => {
      assert.match(
        await call('rejectSuggestion', { documentId: 'd1', suggestionId: 's2' }, session(commentDocs({ suggestionResponses: [{ rejectedSuggestionIds: ['s2'] }] }))),
        /s2 has been rejected/,
      );
      assert.match(
        await call('deleteSuggestion', { documentId: 'd1', suggestionId: 's3' }, session(commentDocs({ suggestionResponses: [{ deletedSuggestionIds: ['s3'] }] }))),
        /s3 has been deleted/,
      );
    });

    it('acceptSuggestion wraps a failure', async () => {
      const docs = mkDocs({ documents: { batchUpdate: mock.fn(async () => { throw mkErr(500); }) } });
      await assert.rejects(
        () => call('acceptSuggestion', { documentId: 'd1', suggestionId: 'sug-1' }, session(docs)),
        (err: any) => err instanceof UserError && /Failed to accept suggestion/.test(err.message),
      );
    });
  });

  it('batchUpdateDoc says when a batch was filed as suggestions', async () => {
    const docs = commentDocs();
    const out = await call('batchUpdateDoc', {
      documentId: 'd1', operations: [{ type: 'insert_text', index: 1, text: 'hi' }], suggestMode: true,
    }, session(docs));
    // A suggested batch leaves the document reading as it did, so saying
    // "completed" would look like a no-op to whoever asked for it.
    assert.match(out, /submitted as SUGGESTIONS/);
    assert.match(out, /listSuggestions/);
  });
});

describe('docs import tools', () => {
  it('importDocx reports the converted document', async () => {
    const drive = mkDrive({ files: {
      get: mock.fn(async () => ({ data: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: 'R.docx' } })),
      copy: mock.fn(async () => ({ data: { id: 'copy-1', name: 'R', webViewLink: 'https://docs/copy-1' } })),
    } });
    const out = await call('importDocx', { fileId: 'f1' }, session(mkDocs(), drive));
    assert.match(out, /Document ID: copy-1/);
  });

  it('importToGoogleDoc reports the created document', async () => {
    const out = await call('importToGoogleDoc', { title: 'T', content: 'x', mimeType: 'text/plain' });
    assert.match(out, /Document ID: new-1/);
  });

  it('importToGoogleDoc routes a Drive failure through the Drive error mapper', async () => {
    const drive = mkDrive({ files: { create: mock.fn(async () => { throw mkErr(403); }) } });
    await assert.rejects(
      () => call('importToGoogleDoc', { title: 'T', content: 'x', mimeType: 'text/plain' }, session(mkDocs(), drive)),
      (err: any) => err instanceof UserError,
    );
  });
});
