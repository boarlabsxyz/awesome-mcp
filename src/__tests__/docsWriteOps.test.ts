import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { UserError } from 'fastmcp';
import {
  performAddComment,
  performAppendToGoogleDoc,
  performApplyParagraphStyle,
  performApplyTextStyle,
  performBatchUpdateDoc,
  performDeleteComment,
  performDeleteRange,
  performFindAndReplace,
  performFormatMatchingText,
  performImportDocx,
  performImportToGoogleDoc,
  performInsertImageFromUrl,
  performInsertLocalImage,
  performInsertPageBreak,
  performInsertTable,
  performInsertText,
  performReplyToComment,
  performResolveComment,
} from '../google-docs/writeOps.js';

// These ops were the bodies of the Google Docs write tools, moved out so the MCP
// tools and the /api/v1/docs/* routes run the same code. Nothing had ever
// exercised them: the docs write path had no unit tests at all, and the REST
// handlers' success paths cannot be covered (googleapis goes through bundled
// node-fetch, so the global-fetch stub cannot reach it).
//
// What they assert is the request that would reach Google, which is the part a
// caller cannot verify from the outside.

const DOC_TEXT = 'Hello brave new world\n';

/** A docs_v1.Docs-shaped stub. documents.get returns one paragraph of DOC_TEXT. */
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
                paragraph: {
                  elements: [{ startIndex: 1, endIndex: 1 + DOC_TEXT.length, textRun: { content: DOC_TEXT } }],
                },
              },
            ],
          },
        },
      })),
      batchUpdate: mock.fn(async () => ({ data: { replies: [{}] } })),
      ...(overrides.documents || {}),
    },
  };
}

function mkDrive(overrides: any = {}): any {
  return {
    files: {
      get: mock.fn(async () => ({ data: { mimeType: 'image/png', webContentLink: 'https://drive/img.png', parents: ['folder-1'] } })),
      create: mock.fn(async () => ({ data: { id: 'new-1', name: 'New', webViewLink: 'https://docs/new-1' } })),
      copy: mock.fn(async () => ({ data: { id: 'copy-1', name: 'Converted', webViewLink: 'https://docs/copy-1' } })),
      ...(overrides.files || {}),
    },
    permissions: { create: mock.fn(async () => ({ data: {} })) },
    comments: {
      create: mock.fn(async () => ({ data: { id: 'cmt-1', content: 'Nice', resolved: false } })),
      get: mock.fn(async () => ({ data: { content: 'Nice', resolved: true } })),
      update: mock.fn(async () => ({ data: { id: 'cmt-1', resolved: true } })),
      delete: mock.fn(async () => ({})),
      ...(overrides.comments || {}),
    },
    replies: { create: mock.fn(async () => ({ data: { id: 'rep-1', content: 'Agreed' } })) },
  };
}

/** The requests array of the Nth batchUpdate call. */
const sentRequests = (docs: any, call = 0) =>
  docs.documents.batchUpdate.mock.calls[call].arguments[0].requestBody.requests;

describe('docs text ops', () => {
  describe('performAppendToGoogleDoc', () => {
    it('inserts before the final newline and prepends one of its own', async () => {
      const docs = mkDocs();
      const out = await performAppendToGoogleDoc(docs, {
        documentId: 'd1', textToAppend: 'More', addNewlineIfNeeded: true,
      } as any);
      // The doc's last element ends at 1+len; appending must land one before it,
      // or the text goes after the document's trailing newline.
      assert.equal(out.index, DOC_TEXT.length);
      assert.equal(out.appendedNewline, true);
      assert.deepEqual(sentRequests(docs)[0].insertText, { location: { index: DOC_TEXT.length }, text: '\nMore' });
    });

    it('skips the newline when asked', async () => {
      const docs = mkDocs();
      const out = await performAppendToGoogleDoc(docs, {
        documentId: 'd1', textToAppend: 'More', addNewlineIfNeeded: false,
      } as any);
      assert.equal(out.appendedNewline, false);
      assert.equal(sentRequests(docs)[0].insertText.text, 'More');
    });

    it('appends at index 1 in an empty doc, with no leading newline', async () => {
      const docs = mkDocs({ documents: { get: mock.fn(async () => ({
        data: { body: { content: [
          { endIndex: 1, sectionBreak: {} },
          { startIndex: 1, endIndex: 2, paragraph: { elements: [{ startIndex: 1, endIndex: 2, textRun: { content: '\n' } }] } },
        ] } },
      })) } });
      const out = await performAppendToGoogleDoc(docs, {
        documentId: 'd1', textToAppend: 'First', addNewlineIfNeeded: true,
      } as any);
      assert.equal(out.index, 1);
      assert.equal(out.appendedNewline, false, 'an empty doc must not get a leading blank line');
    });

    it('targets a tab by id and refuses an unknown one', async () => {
      const withTabs = {
        data: { tabs: [{ tabProperties: { tabId: 't1' }, documentTab: { body: { content: [{ endIndex: 10 }] } } }] },
      };
      const docs = mkDocs({ documents: { get: mock.fn(async () => withTabs) } });
      const out = await performAppendToGoogleDoc(docs, {
        documentId: 'd1', textToAppend: 'X', addNewlineIfNeeded: true, tabId: 't1',
      } as any);
      assert.equal(sentRequests(docs)[0].insertText.location.tabId, 't1');
      assert.equal(out.index, 9);

      await assert.rejects(
        () => performAppendToGoogleDoc(docs, { documentId: 'd1', textToAppend: 'X', addNewlineIfNeeded: true, tabId: 'nope' } as any),
        (err: any) => err instanceof UserError && /not found/.test(err.message),
      );
    });

    it('refuses a tab that carries no content', async () => {
      const docs = mkDocs({
        documents: { get: mock.fn(async () => ({ data: { tabs: [{ tabProperties: { tabId: 't1' } }] } })) },
      });
      await assert.rejects(
        () => performAppendToGoogleDoc(docs, { documentId: 'd1', textToAppend: 'X', addNewlineIfNeeded: true, tabId: 't1' } as any),
        (err: any) => err instanceof UserError && /does not have content/.test(err.message),
      );
    });
  });

  describe('performInsertText', () => {
    it('inserts at the given index with no tab lookup', async () => {
      const docs = mkDocs();
      await performInsertText(docs, { documentId: 'd1', textToInsert: 'Hi', index: 5 } as any);
      assert.equal(docs.documents.get.mock.calls.length, 0, 'no tab given, so no document read is needed');
      assert.deepEqual(sentRequests(docs)[0].insertText, { location: { index: 5 }, text: 'Hi' });
    });

    it('verifies the tab before writing to it', async () => {
      const docs = mkDocs({
        documents: {
          get: mock.fn(async () => ({ data: { tabs: [{ tabProperties: { tabId: 't1' }, documentTab: {} }] } })),
        },
      });
      await performInsertText(docs, { documentId: 'd1', textToInsert: 'Hi', index: 5, tabId: 't1' } as any);
      // Order matters: an unknown tab would otherwise be silently written to the
      // document body instead.
      assert.equal(docs.documents.get.mock.calls.length, 1);
      assert.equal(sentRequests(docs)[0].insertText.location.tabId, 't1');
    });
  });

  describe('the shared tab pre-flight', () => {
    // assertTabExists guards four ops. Its failure modes are worth pinning,
    // because Google does NOT fail a write whose location names an unknown tab —
    // it applies it to the document body, so the caller is told the write
    // succeeded while the text landed somewhere else.
    it('refuses an unknown tab before any write', async () => {
      const docs = mkDocs({ documents: { get: mock.fn(async () => ({ data: { tabs: [{ tabProperties: { tabId: 'other' }, documentTab: {} }] } })) } });
      await assert.rejects(
        () => performInsertText(docs, { documentId: 'd1', textToInsert: 'x', index: 2, tabId: 'missing' } as any),
        (err: any) => err instanceof UserError && /not found/.test(err.message),
      );
      assert.equal(docs.documents.batchUpdate.mock.calls.length, 0);
    });

    it('refuses a tab that carries no content', async () => {
      const docs = mkDocs({ documents: { get: mock.fn(async () => ({ data: { tabs: [{ tabProperties: { tabId: 't1' } }] } })) } });
      await assert.rejects(
        () => performDeleteRange(docs, { documentId: 'd1', startIndex: 2, endIndex: 5, tabId: 't1' } as any),
        (err: any) => err instanceof UserError && /does not have content/.test(err.message),
      );
      assert.equal(docs.documents.batchUpdate.mock.calls.length, 0);
    });
  });

  describe('performDeleteRange', () => {
    it('sends a deleteContentRange for the range', async () => {
      const docs = mkDocs();
      const out = await performDeleteRange(docs, { documentId: 'd1', startIndex: 3, endIndex: 9 } as any);
      assert.deepEqual(sentRequests(docs)[0].deleteContentRange.range, { startIndex: 3, endIndex: 9 });
      assert.deepEqual(out, { startIndex: 3, endIndex: 9 });
    });

    it('carries the tabId into the range', async () => {
      const docs = mkDocs({
        documents: { get: mock.fn(async () => ({ data: { tabs: [{ tabProperties: { tabId: 't1' }, documentTab: {} }] } })) },
      });
      await performDeleteRange(docs, { documentId: 'd1', startIndex: 3, endIndex: 9, tabId: 't1' } as any);
      assert.equal(sentRequests(docs)[0].deleteContentRange.range.tabId, 't1');
    });
  });

  describe('performFindAndReplace', () => {
    it('reports the count Google returned', async () => {
      const docs = mkDocs({
        documents: { batchUpdate: mock.fn(async () => ({ data: { replies: [{ replaceAllText: { occurrencesChanged: 3 } }] } })) },
      });
      const out = await performFindAndReplace(docs, {
        documentId: 'd1', findText: 'a', replaceText: 'b', matchCase: false,
      } as any);
      assert.equal(out.occurrencesChanged, 3);
      assert.deepEqual(sentRequests(docs)[0].replaceAllText.containsText, { text: 'a', matchCase: false });
    });

    it('reports zero when nothing matched, rather than treating it as a failure', async () => {
      const docs = mkDocs({ documents: { batchUpdate: mock.fn(async () => ({ data: { replies: [{}] } })) } });
      const out = await performFindAndReplace(docs, {
        documentId: 'd1', findText: 'zzz', replaceText: 'b', matchCase: true,
      } as any);
      assert.equal(out.occurrencesChanged, 0);
    });

    it('restricts to a tab when one is given', async () => {
      const docs = mkDocs();
      await performFindAndReplace(docs, {
        documentId: 'd1', findText: 'a', replaceText: 'b', matchCase: false, tabId: 't1',
      } as any);
      assert.deepEqual(sentRequests(docs)[0].replaceAllText.tabsCriteria, { tabIds: ['t1'] });
    });
  });
});

describe('docs styling ops', () => {
  it('performApplyTextStyle resolves a text target to a range', async () => {
    const docs = mkDocs();
    const out = await performApplyTextStyle(docs, {
      documentId: 'd1',
      target: { textToFind: 'brave', matchInstance: 1 },
      style: { bold: true },
    } as any);
    assert.ok(out.startIndex > 0 && out.endIndex > out.startIndex);
    assert.deepEqual(out.fields, ['bold']);
    assert.equal(sentRequests(docs)[0].updateTextStyle.textStyle.bold, true);
  });

  it('performApplyTextStyle refuses text it cannot find', async () => {
    const docs = mkDocs();
    await assert.rejects(
      () => performApplyTextStyle(docs, {
        documentId: 'd1', target: { textToFind: 'absent', matchInstance: 1 }, style: { bold: true },
      } as any),
      (err: any) => err instanceof UserError && /Could not find/.test(err.message),
    );
  });

  it('performApplyTextStyle reports fields null and writes nothing when no style was given', async () => {
    const docs = mkDocs();
    const out = await performApplyTextStyle(docs, {
      documentId: 'd1', target: { startIndex: 2, endIndex: 5 }, style: {},
    } as any);
    assert.equal(out.fields, null);
    assert.equal(docs.documents.batchUpdate.mock.calls.length, 0, 'nothing to apply must mean no call');
  });

  it('performApplyTextStyle rejects an inverted range', async () => {
    await assert.rejects(
      () => performApplyTextStyle(mkDocs(), {
        documentId: 'd1', target: { startIndex: 9, endIndex: 4 }, style: { bold: true },
      } as any),
      (err: any) => err instanceof UserError && /greater than start/.test(err.message),
    );
  });

  it('performApplyParagraphStyle widens a text target to its paragraph', async () => {
    const docs = mkDocs();
    const out = await performApplyParagraphStyle(docs, {
      documentId: 'd1', target: { textToFind: 'brave' }, style: { alignment: 'CENTER' },
    } as any);
    // The paragraph is wider than the matched word — that is the point of the
    // second lookup.
    assert.equal(out.startIndex, 1);
    assert.equal(out.endIndex, 1 + DOC_TEXT.length);
    assert.ok(out.fields?.length);
  });

  it('performApplyParagraphStyle accepts an index within the paragraph', async () => {
    const docs = mkDocs();
    const out = await performApplyParagraphStyle(docs, {
      documentId: 'd1', target: { indexWithinParagraph: 4 }, style: { alignment: 'END' },
    } as any);
    assert.equal(out.startIndex, 1);
  });

  it('performApplyParagraphStyle accepts an explicit range', async () => {
    const docs = mkDocs();
    const out = await performApplyParagraphStyle(docs, {
      documentId: 'd1', target: { startIndex: 1, endIndex: 10 }, style: { alignment: 'START' },
    } as any);
    assert.equal(out.startIndex, 1);
    assert.equal(out.endIndex, 10);
  });

  it('performApplyParagraphStyle refuses an index that is in no paragraph', async () => {
    const docs = mkDocs({ documents: { get: mock.fn(async () => ({ data: { body: { content: [{ endIndex: 1, sectionBreak: {} }] } } })) } });
    await assert.rejects(
      () => performApplyParagraphStyle(docs, {
        documentId: 'd1', target: { indexWithinParagraph: 99 }, style: { alignment: 'CENTER' },
      } as any),
      (err: any) => err instanceof UserError && /Could not find paragraph/.test(err.message),
    );
  });

  it('performApplyParagraphStyle refuses a target shape it cannot read', async () => {
    await assert.rejects(
      () => performApplyParagraphStyle(mkDocs(), {
        documentId: 'd1', target: { somethingElse: 1 }, style: { alignment: 'CENTER' },
      } as any),
      (err: any) => err instanceof UserError && /Could not determine target paragraph range/.test(err.message),
    );
  });

  it('performApplyParagraphStyle refuses a text match whose paragraph cannot be located', async () => {
    // findTextRange succeeds against the paragraph, then the paragraph lookup is
    // given a body that no longer contains it.
    let n = 0;
    const full = {
      data: { body: { content: [
        { endIndex: 1, sectionBreak: {} },
        { startIndex: 1, endIndex: 1 + DOC_TEXT.length, paragraph: { elements: [{ startIndex: 1, endIndex: 1 + DOC_TEXT.length, textRun: { content: DOC_TEXT } }] } },
      ] } },
    };
    const docs = mkDocs({ documents: { get: mock.fn(async () => (n++ === 0 ? full : { data: { body: { content: [] } } })) } });
    await assert.rejects(
      () => performApplyParagraphStyle(docs, { documentId: 'd1', target: { textToFind: 'brave' }, style: { alignment: 'CENTER' } } as any),
      (err: any) => err instanceof UserError && /could not determine the paragraph boundaries/.test(err.message),
    );
  });

  it('performApplyTextStyle refuses a target carrying neither text nor indices', async () => {
    await assert.rejects(
      () => performApplyTextStyle(mkDocs(), { documentId: 'd1', target: {}, style: { bold: true } } as any),
      (err: any) => err instanceof UserError && /Target range could not be determined/.test(err.message),
    );
  });

  it('performFormatMatchingText maps its flat parameters onto the style request', async () => {
    const docs = mkDocs();
    const out = await performFormatMatchingText(docs, {
      documentId: 'd1', textToFind: 'brave', matchInstance: 1, bold: true, italic: true, fontSize: 14,
    } as any);
    assert.ok(out.fields && out.fields.length >= 3);
    const style = sentRequests(docs)[0].updateTextStyle.textStyle;
    assert.equal(style.bold, true);
    assert.equal(style.italic, true);
  });

  it('performFormatMatchingText refuses a missing instance', async () => {
    await assert.rejects(
      () => performFormatMatchingText(mkDocs(), {
        documentId: 'd1', textToFind: 'brave', matchInstance: 9, bold: true,
      } as any),
      (err: any) => err instanceof UserError && /instance 9/.test(err.message),
    );
  });
});

describe('docs structure ops', () => {
  it('performInsertTable asks for the given dimensions', async () => {
    const docs = mkDocs();
    const out = await performInsertTable(docs, { documentId: 'd1', rows: 2, columns: 3, index: 5 } as any);
    assert.deepEqual(out, { rows: 2, columns: 3, index: 5 });
    assert.deepEqual(sentRequests(docs)[0].insertTable, { location: { index: 5 }, rows: 2, columns: 3 });
  });

  it('performInsertPageBreak inserts at the index', async () => {
    const docs = mkDocs();
    await performInsertPageBreak(docs, { documentId: 'd1', index: 7 } as any);
    assert.deepEqual(sentRequests(docs)[0].insertPageBreak, { location: { index: 7 } });
  });

  describe('performBatchUpdateDoc', () => {
    it('sorts index-based operations descending so they do not shift each other', async () => {
      const docs = mkDocs();
      const out = await performBatchUpdateDoc(docs, {
        documentId: 'd1',
        operations: [
          { type: 'insert_text', text: 'A', index: 2 },
          { type: 'insert_text', text: 'B', index: 40 },
          { type: 'insert_text', text: 'C', index: 20 },
        ],
      } as any);
      const indices = sentRequests(docs).map((r: any) => r.insertText.location.index);
      assert.deepEqual(indices, [40, 20, 2], 'ascending order would invalidate every later index');
      assert.equal(out.executed, 3);
      assert.deepEqual(out.typeCounts, { insert_text: 3 });
    });

    it('refuses to mix global replacements with index-based operations', async () => {
      await assert.rejects(
        () => performBatchUpdateDoc(mkDocs(), {
          documentId: 'd1',
          operations: [
            { type: 'insert_text', text: 'A', index: 2 },
            { type: 'replace_text', findText: 'x', replaceText: 'y' },
          ],
        } as any),
        (err: any) => {
          assert.ok(err instanceof UserError);
          // There is no ordering that makes this mean what the caller intended,
          // so it is refused rather than reordered.
          assert.match(err.message, /Cannot mix global operations/);
          return true;
        },
      );
    });

    it('leaves a global-only batch in the given order', async () => {
      const docs = mkDocs();
      const out = await performBatchUpdateDoc(docs, {
        documentId: 'd1',
        operations: [
          { type: 'replace_text', findText: 'a', replaceText: 'b' },
          { type: 'replace_text', findText: 'c', replaceText: 'd' },
        ],
      } as any);
      assert.equal(out.executed, 2);
      assert.equal(sentRequests(docs)[0].replaceAllText.containsText.text, 'a');
    });
  });
});

describe('docs image ops', () => {
  it('performInsertImageFromUrl sends the URI and the size when both dimensions are given', async () => {
    const docs = mkDocs();
    const out = await performInsertImageFromUrl(docs, {
      documentId: 'd1', imageUrl: 'https://example.com/a.png', index: 3, width: 100, height: 50,
    } as any);
    const req = sentRequests(docs)[0].insertInlineImage;
    assert.equal(req.uri, 'https://example.com/a.png');
    assert.equal(req.objectSize.width.magnitude, 100);
    assert.equal(out.index, 3);
  });

  it('performInsertImageFromUrl rejects a malformed URL before calling Google', async () => {
    const docs = mkDocs();
    await assert.rejects(
      () => performInsertImageFromUrl(docs, { documentId: 'd1', imageUrl: 'not-a-url', index: 3 } as any),
      (err: any) => err instanceof UserError,
    );
    assert.equal(docs.documents.batchUpdate.mock.calls.length, 0);
  });

  describe('performInsertLocalImage', () => {
    it('publishes an existing Drive file rather than uploading a copy', async () => {
      const docs = mkDocs();
      const drive = mkDrive();
      const out = await performInsertLocalImage(docs, drive, {
        documentId: 'd1', driveFileId: 'img-1', index: 2, uploadToSameFolder: true,
      } as any);
      assert.equal(out.uploadedToDrive, false);
      assert.equal(drive.files.create.mock.calls.length, 0, 'the file is already in Drive');
      assert.equal(drive.permissions.create.mock.calls.length, 1, 'Google must be able to fetch it');
      assert.equal(out.resolvedImageUrl, 'https://drive/img.png');
    });

    it('refuses a Drive file that is not an image', async () => {
      const drive = mkDrive({ files: { get: mock.fn(async () => ({ data: { mimeType: 'application/pdf' } })) } });
      await assert.rejects(
        () => performInsertLocalImage(mkDocs(), drive, {
          documentId: 'd1', driveFileId: 'doc-1', index: 2, uploadToSameFolder: true,
        } as any),
        (err: any) => err instanceof UserError && /not an image/.test(err.message),
      );
      assert.equal(drive.permissions.create.mock.calls.length, 0, 'must not publish a non-image');
    });

    it('rejects base64 that is not base64, before allocating a buffer', async () => {
      await assert.rejects(
        () => performInsertLocalImage(mkDocs(), mkDrive(), {
          documentId: 'd1', imageBase64: 'not base64!!', fileName: 'a.png', index: 2, uploadToSameFolder: false,
        } as any),
        (err: any) => err instanceof UserError && /invalid characters/.test(err.message),
      );
    });

    it('rejects an oversize base64 payload from its length, not by decoding it', async () => {
      // 21 MB of base64 — the cap exists so a 20 MB+ image never gets a Buffer.
      const huge = 'A'.repeat(29 * 1024 * 1024);
      await assert.rejects(
        () => performInsertLocalImage(mkDocs(), mkDrive(), {
          documentId: 'd1', imageBase64: huge, fileName: 'a.png', index: 2, uploadToSameFolder: false,
        } as any),
        (err: any) => err instanceof UserError && /exceeding the/.test(err.message),
      );
    });

    it('refuses when no source was given at all', async () => {
      await assert.rejects(
        () => performInsertLocalImage(mkDocs(), mkDrive(), { documentId: 'd1', index: 2, uploadToSameFolder: true } as any),
        (err: any) => err instanceof UserError,
      );
    });
  });
});

describe('docs comment ops', () => {
  it('performAddComment quotes exactly the requested range', async () => {
    const docs = mkDocs();
    const drive = mkDrive();
    // "Hello brave new world" — indices 7..12 are "brave".
    const out = await performAddComment(docs, drive, {
      documentId: 'd1', startIndex: 7, endIndex: 12, commentText: 'Nice',
    } as any);
    const sent = drive.comments.create.mock.calls[0].arguments[0];
    assert.equal(sent.requestBody.quotedFileContent.value, 'brave');
    assert.equal(out.quotedText, 'brave');
    assert.equal(out.id, 'cmt-1');
  });

  it('performAddComment quotes across the whole range when it spans the paragraph', async () => {
    const drive = mkDrive();
    await performAddComment(mkDocs(), drive, {
      documentId: 'd1', startIndex: 1, endIndex: 6, commentText: 'Nice',
    } as any);
    assert.equal(drive.comments.create.mock.calls[0].arguments[0].requestBody.quotedFileContent.value, 'Hello');
  });

  it('performReplyToComment posts the reply under the comment', async () => {
    const drive = mkDrive();
    const out = await performReplyToComment(drive, { documentId: 'd1', commentId: 'cmt-1', replyText: 'Agreed' } as any);
    const sent = drive.replies.create.mock.calls[0].arguments[0];
    assert.equal(sent.commentId, 'cmt-1');
    assert.equal(sent.requestBody.content, 'Agreed');
    assert.equal(out.id, 'rep-1');
  });

  describe('performResolveComment', () => {
    it('echoes the existing content back, which the API requires', async () => {
      const drive = mkDrive();
      const out = await performResolveComment(drive, { documentId: 'd1', commentId: 'cmt-1' } as any);
      const sent = drive.comments.update.mock.calls[0].arguments[0];
      assert.equal(sent.requestBody.content, 'Nice');
      assert.equal(sent.requestBody.resolved, true);
      assert.equal(out.resolved, true);
    });

    it('reports resolved false when Google did not persist it', async () => {
      // The documented failure mode on Google Docs: the update is accepted and
      // the flag does not stick. Reporting the request as the outcome would lie.
      let call = 0;
      const drive = mkDrive({
        comments: {
          get: mock.fn(async () => ({ data: (call++ === 0 ? { content: 'Nice' } : { resolved: false }) })),
          update: mock.fn(async () => ({ data: {} })),
        },
      });
      const out = await performResolveComment(drive, { documentId: 'd1', commentId: 'cmt-1' } as any);
      assert.equal(out.resolved, false);
    });
  });

  it('performDeleteComment deletes and reports the id', async () => {
    const drive = mkDrive();
    const out = await performDeleteComment(drive, { documentId: 'd1', commentId: 'cmt-1' } as any);
    assert.deepEqual(out, { commentId: 'cmt-1', deleted: true });
    assert.equal(drive.comments.delete.mock.calls[0].arguments[0].commentId, 'cmt-1');
  });
});

describe('docs import ops', () => {
  it('performImportDocx converts by copying with the Docs mimeType', async () => {
    const drive = mkDrive({ files: {
      get: mock.fn(async () => ({ data: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: 'Report.docx' } })),
      copy: mock.fn(async () => ({ data: { id: 'copy-1', name: 'Report', webViewLink: 'https://docs/copy-1' } })),
    } });
    const out = await performImportDocx(drive, { fileId: 'docx-1', targetFolderId: 'folder-9' } as any);
    const sent = drive.files.copy.mock.calls[0].arguments[0];
    assert.equal(sent.requestBody.mimeType, 'application/vnd.google-apps.document');
    assert.deepEqual(sent.requestBody.parents, ['folder-9']);
    assert.equal(out.id, 'copy-1');
  });

  it('performImportDocx refuses a source that is not a .docx', async () => {
    const drive = mkDrive({ files: {
      get: mock.fn(async () => ({ data: { mimeType: 'application/pdf', name: 'a.pdf' } })),
      copy: mock.fn(async () => ({ data: {} })),
    } });
    await assert.rejects(
      () => performImportDocx(drive, { fileId: 'pdf-1' } as any),
      (err: any) => err instanceof UserError && /not a .docx/.test(err.message),
    );
    assert.equal(drive.files.copy.mock.calls.length, 0, 'Drive would convert it into an unreadable doc');
  });

  it('performImportToGoogleDoc uploads the content with the source mimeType for conversion', async () => {
    const drive = mkDrive();
    const out = await performImportToGoogleDoc(drive, {
      title: 'From Markdown', content: '# Heading', mimeType: 'text/markdown', parentFolderId: 'folder-2',
    } as any);
    const sent = drive.files.create.mock.calls[0].arguments[0];
    assert.equal(sent.requestBody.mimeType, 'application/vnd.google-apps.document');
    assert.equal(sent.media.mimeType, 'text/markdown', 'the SOURCE type is what Drive converts from');
    assert.deepEqual(sent.requestBody.parents, ['folder-2']);
    assert.equal(out.id, 'new-1');
  });

  it('performImportToGoogleDoc defaults to text/plain and Drive root', async () => {
    const drive = mkDrive();
    await performImportToGoogleDoc(drive, { title: 'Plain', content: 'hello', mimeType: 'text/plain' } as any);
    const sent = drive.files.create.mock.calls[0].arguments[0];
    assert.equal(sent.media.mimeType, 'text/plain');
    assert.equal('parents' in sent.requestBody, false);
  });
});
