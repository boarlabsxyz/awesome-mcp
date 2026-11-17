import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { UserError } from 'fastmcp';
import {
  performAcceptSuggestion,
  performAddComment,
  performAppendToGoogleDoc,
  performAssignComment,
  performApplyParagraphStyle,
  performApplyTextStyle,
  performBatchUpdateDoc,
  performCreateDocumentTab,
  performCreateFootnote,
  performDeleteComment,
  performDeleteDocumentTab,
  performDeleteTableRowOrColumn,
  performFormatTableCells,
  performModifyTableStructure,
  performUpdateDocumentTab,
  performDeleteCommentReply,
  performDeleteRange,
  performDeleteSuggestion,
  performFindAndReplace,
  performFormatMatchingText,
  performImportDocx,
  performImportToGoogleDoc,
  performInsertImageFromUrl,
  performInsertLocalImage,
  performInsertPageBreak,
  performInsertTable,
  performInsertText,
  performRejectSuggestion,
  performReopenComment,
  performReplyToComment,
  performResolveComment,
  performUpdateCommentPost,
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
      // revisionId is null because the stub's reply carries no writeControl.
      assert.deepEqual(out, { startIndex: 3, endIndex: 9, revisionId: null });
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

describe('upstream status survives the UserError wrapper', () => {
  // The docs helpers wrap Google's 404s and 403s for a human, and a bare
  // `new UserError(message)` drops `error.code` — which is what sendUpstreamError
  // reads. Reported on #183: a missing document came back as 400 ("fix your
  // request body") from the routes that map a code-less UserError, and as a flat
  // 500 from the rest. The status now rides along, so both answer 404.
  function throwingDocs(code: number): any {
    const err: any = new Error('upstream');
    err.code = code;
    return {
      documents: {
        get: mock.fn(async () => { throw err; }),
        batchUpdate: mock.fn(async () => { throw err; }),
      },
    };
  }

  for (const code of [404, 403] as const) {
    it(`keeps ${code} through a write`, async () => {
      await assert.rejects(
        () => performInsertPageBreak(throwingDocs(code), { documentId: 'd1', index: 2 } as any),
        (err: any) => {
          assert.ok(err instanceof UserError);
          assert.equal((err as any).code, code);
          return true;
        },
      );
    });

    it(`keeps ${code} through a text search`, async () => {
      await assert.rejects(
        () => performApplyTextStyle(throwingDocs(code), {
          documentId: 'd1', target: { textToFind: 'x', matchInstance: 1 }, style: { bold: true },
        } as any),
        (err: any) => (err as any).code === code,
      );
    });

    it(`keeps ${code} through a paragraph lookup`, async () => {
      await assert.rejects(
        () => performApplyParagraphStyle(throwingDocs(code), {
          documentId: 'd1', target: { indexWithinParagraph: 2 }, style: { alignment: 'CENTER' },
        } as any),
        (err: any) => (err as any).code === code,
      );
    });
  }

  it('keeps 400 on an invalid batch request, which is genuinely the caller\'s fault', async () => {
    const err: any = new Error('Invalid requests[0]');
    err.code = 400;
    const docs = { documents: { batchUpdate: mock.fn(async () => { throw err; }) } } as any;
    await assert.rejects(
      () => performInsertPageBreak(docs, { documentId: 'd1', index: 2 } as any),
      (e: any) => (e as any).code === 400 && /Invalid request sent to Google Docs API/.test(e.message),
    );
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

    // CWE-73. Reported on #183: over REST this was a complete file-exfiltration
    // primitive for anyone holding an API key. The helper reads the path with
    // fs.createReadStream, uploads the bytes to the caller's Drive, grants
    // `anyone` reader and returns the link — and nothing downstream checks the
    // extension or MIME type (it falls back to application/octet-stream), so
    // /proc/self/environ or a credentials file goes through whole. The upload
    // completes before the insert, so a later failure does not undo the leak.
    it('refuses localImagePath unless the caller explicitly opts in', async () => {
      const drive = mkDrive();
      await assert.rejects(
        () => performInsertLocalImage(mkDocs(), drive, {
          documentId: 'd1', localImagePath: '/proc/self/environ', index: 2, uploadToSameFolder: false,
        } as any),
        (err: any) => {
          assert.ok(err instanceof UserError);
          assert.match(err.message, /only accepted on a local \(stdio\) deployment/);
          return true;
        },
      );
      // Nothing was read and nothing was published.
      assert.equal(drive.files.create.mock.calls.length, 0);
      assert.equal(drive.permissions.create.mock.calls.length, 0);
    });

    it('allows localImagePath when the caller opts in, which only stdio does', async () => {
      // The opt-in exists for the documented local deployment, where the caller
      // owns the filesystem being read. The upload itself is stubbed here; what
      // matters is that the gate lets it through rather than refusing.
      const drive = mkDrive({ files: { create: mock.fn(async () => { throw new Error('upload reached'); }) } });
      await assert.rejects(
        () => performInsertLocalImage(mkDocs(), drive, {
          documentId: 'd1', localImagePath: '/tmp/x.png', index: 2, uploadToSameFolder: false,
        } as any, { allowLocalFilesystem: true }),
        (err: any) => !/only accepted on a local/.test(err.message),
      );
    });

    // Reported on #183 alongside the filesystem finding. uploadImageToDrive used
    // to validate the FIRST hostname and then call fetch with the default
    // redirect:'follow', so a perfectly public URL answering 302 to
    // 169.254.169.254 (cloud metadata) or 127.0.0.1 was fetched unchecked and its
    // bytes uploaded to the caller's Drive and published with `anyone` reader.
    it('refuses a redirect to an internal address, not just an internal first hop', async () => {
      const realFetch = globalThis.fetch;
      const seen: string[] = [];
      globalThis.fetch = (async (input: any) => {
        seen.push(String(input));
        // A public first hop that redirects inward — the shape the first-hop-only
        // check could not see.
        return {
          status: 302,
          ok: false,
          headers: new Headers({ location: 'http://169.254.169.254/latest/meta-data/' }),
          body: { cancel: async () => {} },
        } as any;
      }) as any;
      try {
        await assert.rejects(
          () => performInsertLocalImage(mkDocs(), mkDrive(), {
            documentId: 'd1', imageUrl: 'https://example.com/innocent.png', index: 2, uploadToSameFolder: false,
          } as any),
          (err: any) => {
            assert.ok(err instanceof UserError);
            assert.match(err.message, /private\/internal address/);
            return true;
          },
        );
        // It fetched the first hop and stopped; the internal address was never requested.
        assert.deepEqual(seen, ['https://example.com/innocent.png']);
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    it('refuses an internal first hop too', async () => {
      await assert.rejects(
        () => performInsertLocalImage(mkDocs(), mkDrive(), {
          documentId: 'd1', imageUrl: 'http://127.0.0.1:8080/x.png', index: 2, uploadToSameFolder: false,
        } as any),
        (err: any) => err instanceof UserError && /private\/internal address/.test(err.message),
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
  /** A batchUpdate stub that records the request and answers with `data`. */
  function mkCommentDocs(data: any = { commentUpdateState: 'ALL_SAVED', replies: [{}] }): any {
    return mkDocs({ documents: { batchUpdate: mock.fn(async () => ({ data })) } });
  }
  const sentRequest = (docs: any) => docs.documents.batchUpdate.mock.calls[0].arguments[0].requestBody.requests[0];

  describe('performAddComment', () => {
    const thread = {
      commentId: 'cmt-1',
      anchorId: 'anchor-1',
      status: 'OPEN',
      plainTextQuote: 'brave',
      headPost: { postId: 'post-1', content: 'Nice', author: { displayName: 'Ada' }, createTime: '2026-10-19T10:00:00Z' },
    };

    it('anchors the comment to the requested range', async () => {
      const docs = mkCommentDocs({ commentUpdateState: 'ALL_SAVED', replies: [{ insertComment: { commentThread: thread } }] });
      const out = await performAddComment(docs, {
        documentId: 'd1', startIndex: 7, endIndex: 12, commentText: 'Nice',
      } as any);

      // The RANGE is the point of the migration: the Drive API took an anchor and
      // filed the comment unanchored regardless.
      assert.deepEqual(sentRequest(docs).insertComment, {
        content: 'Nice',
        range: { startIndex: 7, endIndex: 12 },
      });
      assert.equal(out.id, 'cmt-1');
      assert.equal(out.anchorId, 'anchor-1');
      assert.equal(out.quotedText, 'brave');
      assert.equal(out.author, 'Ada');
      assert.equal(out.confirmed, true);
      // No document read any more: Google records the quote itself.
      assert.equal(docs.documents.get.mock.calls.length, 0);
    });

    it('passes the tab, segment and assignee only when given', async () => {
      const docs = mkCommentDocs({ commentUpdateState: 'ALL_SAVED', replies: [{ insertComment: { commentThread: thread } }] });
      await performAddComment(docs, {
        documentId: 'd1', startIndex: 7, endIndex: 12, commentText: 'Nice',
        tabId: 't.0', segmentId: 'h.1', assigneeEmail: 'ada@example.com',
      } as any);
      assert.deepEqual(sentRequest(docs).insertComment, {
        content: 'Nice',
        assigneeEmailAddress: 'ada@example.com',
        range: { startIndex: 7, endIndex: 12, tabId: 't.0', segmentId: 'h.1' },
      });
    });

    it('reports ONLY the assignee Google recorded, with the request kept separate', async () => {
      // Google echoing no assignee back does not mean the assignment applied.
      // Reporting args.assigneeEmail as `assigneeEmail` would claim it did.
      const docs = mkCommentDocs({
        commentUpdateState: 'ALL_SAVED',
        replies: [{ insertComment: { commentThread: { commentId: 'cmt-1', headPost: { postId: 'p-1' } } } }],
      });
      const out = await performAddComment(docs, {
        documentId: 'd1', startIndex: 1, endIndex: 2, commentText: 'x', assigneeEmail: 'ada@example.com',
      } as any);
      assert.equal(out.assigneeEmail, null);
      assert.equal(out.requestedAssigneeEmail, 'ada@example.com');
    });

    it('reports the recorded assignee when Google does echo one', async () => {
      const docs = mkCommentDocs({
        commentUpdateState: 'ALL_SAVED',
        replies: [{ insertComment: { commentThread: { commentId: 'cmt-1', headPost: { postId: 'p-1', assigneeEmail: 'bob@example.com' } } } }],
      });
      const out = await performAddComment(docs, {
        documentId: 'd1', startIndex: 1, endIndex: 2, commentText: 'x', assigneeEmail: 'ada@example.com',
      } as any);
      assert.equal(out.assigneeEmail, 'bob@example.com', 'what Google stored wins over what was asked for');
    });

    it('refuses a body over the 2048-BYTE cap, counting UTF-8 rather than length', async () => {
      const docs = mkCommentDocs();
      // 600 four-byte emoji = 2400 UTF-8 bytes but only 1200 UTF-16 units, so a
      // String.length check would send a body Google rejects.
      const emoji = '\u{1F600}'.repeat(600);
      assert.ok(emoji.length < 2048, 'the test case has to be short by String.length to be meaningful');
      await assert.rejects(
        () => performAddComment(docs, { documentId: 'd1', startIndex: 1, endIndex: 2, commentText: emoji } as any),
        (err: any) => err instanceof UserError && /2400 UTF-8 bytes/.test(err.message),
      );
      assert.equal(docs.documents.batchUpdate.mock.calls.length, 0, 'nothing is written on a refusal');
    });

    it('throws when Google answers 200 and reports the comment was NOT applied', async () => {
      const docs = mkCommentDocs({ commentUpdateState: 'ALL_FAILED_UNKNOWN_REASON', replies: [{}] });
      await assert.rejects(
        () => performAddComment(docs, { documentId: 'd1', startIndex: 1, endIndex: 2, commentText: 'x' } as any),
        (err: any) => err instanceof UserError && /was NOT applied/.test(err.message),
      );
    });

    it('reports confirmed false, not success, when Google states no verdict', async () => {
      const docs = mkCommentDocs({ replies: [{ insertComment: { commentThread: thread } }] });
      const out = await performAddComment(docs, { documentId: 'd1', startIndex: 1, endIndex: 2, commentText: 'x' } as any);
      assert.equal(out.confirmed, false);
      assert.equal(out.commentUpdateState, null);
    });
  });

  describe('thread targeting', () => {
    it('refuses both ids at once, with nothing written', async () => {
      const docs = mkCommentDocs();
      await assert.rejects(
        () => performReplyToComment(docs, { documentId: 'd1', commentId: 'c1', suggestionId: 's1', replyText: 'hi' } as any),
        (err: any) => err instanceof UserError && /not both/.test(err.message),
      );
      assert.equal(docs.documents.batchUpdate.mock.calls.length, 0);
    });

    it('refuses neither id, naming both parameters', async () => {
      await assert.rejects(
        () => performReplyToComment(mkCommentDocs(), { documentId: 'd1', replyText: 'hi' } as any),
        (err: any) => err instanceof UserError && /commentId or suggestionId/.test(err.message),
      );
    });

    it('posts on a suggestion thread when that is the id given', async () => {
      const docs = mkCommentDocs({ commentUpdateState: 'ALL_SAVED', replies: [{ addCommentReply: { post: { postId: 'p-9' } } }] });
      const out = await performReplyToComment(docs, { documentId: 'd1', suggestionId: 'sug-1', replyText: 'ok' } as any);
      assert.deepEqual(sentRequest(docs).addCommentReply, { suggestionId: 'sug-1', post: { content: 'ok' } });
      assert.equal(out.postId, 'p-9');
      assert.equal(out.id, 'p-9', 'the pre-existing response key is kept alongside postId');
    });
  });

  describe('resolve and reopen', () => {
    it('resolves with a reply ACTION, since there is no thread-status field', async () => {
      const docs = mkCommentDocs();
      const out = await performResolveComment(docs, { documentId: 'd1', commentId: 'cmt-1' } as any);
      assert.deepEqual(sentRequest(docs).addCommentReply, {
        commentId: 'cmt-1',
        post: { commentAction: 'RESOLVE' },
      });
      assert.equal(out.resolved, true);
    });

    it('carries a closing note when one is given', async () => {
      const docs = mkCommentDocs();
      await performResolveComment(docs, { documentId: 'd1', commentId: 'cmt-1', replyText: 'Fixed in v2' } as any);
      assert.equal(sentRequest(docs).addCommentReply.post.content, 'Fixed in v2');
    });

    it('reports resolved false when Google did not confirm it', async () => {
      const docs = mkCommentDocs({ replies: [{}] });
      const out = await performResolveComment(docs, { documentId: 'd1', commentId: 'cmt-1' } as any);
      assert.equal(out.resolved, false);
      assert.equal(out.confirmed, false);
    });

    it('reopens with REOPEN', async () => {
      const docs = mkCommentDocs();
      const out = await performReopenComment(docs, { documentId: 'd1', commentId: 'cmt-1' } as any);
      assert.equal(sentRequest(docs).addCommentReply.post.commentAction, 'REOPEN');
      assert.equal(out.reopened, true);
    });
  });

  describe('performAssignComment', () => {
    it('sends the assignee as a post on the thread', async () => {
      const docs = mkCommentDocs();
      const out = await performAssignComment(docs, {
        documentId: 'd1', commentId: 'cmt-1', assigneeEmail: 'ada@example.com',
      } as any);
      assert.deepEqual(sentRequest(docs).addCommentReply, {
        commentId: 'cmt-1',
        post: { assigneeEmail: 'ada@example.com' },
      });
      assert.equal(out.assigned, true);
    });

    it('rewrites Google 400 to name every documented cause rather than guessing one', async () => {
      const docs = mkDocs({ documents: {
        batchUpdate: mock.fn(async () => {
          const err: any = new Error('Invalid requests[0].addCommentReply');
          err.code = 400;
          throw err;
        }),
      } });
      await assert.rejects(
        () => performAssignComment(docs, { documentId: 'd1', commentId: 'cmt-1', assigneeEmail: 'ada@example.com' } as any),
        (err: any) => {
          assert.ok(err instanceof UserError);
          // An unassigned thread can never be assigned, and the response does not
          // say that is what happened — so all the causes are listed.
          assert.match(err.message, /WITHOUT an assignee/);
          assert.match(err.message, /suggestion thread/);
          return true;
        },
      );
    });
  });

  describe('edits and deletions', () => {
    it('performUpdateCommentPost rewrites one post', async () => {
      const docs = mkCommentDocs();
      const out = await performUpdateCommentPost(docs, {
        documentId: 'd1', commentId: 'cmt-1', postId: 'post-2', content: 'Reworded',
      } as any);
      assert.deepEqual(sentRequest(docs).updateCommentPost, {
        commentId: 'cmt-1', postId: 'post-2', content: 'Reworded',
      });
      assert.equal(out.updated, true);
      assert.equal(out.threadId, 'cmt-1');
    });

    it('performDeleteComment takes the whole thread', async () => {
      const docs = mkCommentDocs();
      const out = await performDeleteComment(docs, { documentId: 'd1', commentId: 'cmt-1' } as any);
      assert.deepEqual(sentRequest(docs).deleteComment, { commentId: 'cmt-1' });
      assert.equal(out.deleted, true);
    });

    it('performDeleteCommentReply takes one reply and leaves the thread', async () => {
      const docs = mkCommentDocs();
      const out = await performDeleteCommentReply(docs, {
        documentId: 'd1', commentId: 'cmt-1', postId: 'post-3',
      } as any);
      assert.deepEqual(sentRequest(docs).deleteCommentReply, { commentId: 'cmt-1', postId: 'post-3' });
      assert.equal(out.deleted, true);
    });
  });

  describe('suggestion verdicts', () => {
    // Suggestions report through suggestionResponses, NOT commentUpdateState:
    // confirmation is the id turning up in the matching list.
    it('confirms an accept from acceptedSuggestionIds', async () => {
      const docs = mkCommentDocs({ suggestionResponses: [{ acceptedSuggestionIds: ['sug-1'] }] });
      const out = await performAcceptSuggestion(docs, { documentId: 'd1', suggestionId: 'sug-1' } as any);
      assert.deepEqual(sentRequest(docs).acceptSuggestion, { suggestionId: 'sug-1' });
      assert.equal(out.confirmed, true);
    });

    it('does NOT confirm when the id is absent from the list Google reports', async () => {
      const docs = mkCommentDocs({ suggestionResponses: [{ acceptedSuggestionIds: ['other'] }] });
      const out = await performAcceptSuggestion(docs, { documentId: 'd1', suggestionId: 'sug-1' } as any);
      assert.equal(out.confirmed, false);
      assert.deepEqual(out.reportedIds, ['other']);
    });

    it('reads the rejected and deleted lists, not the accepted one', async () => {
      const rejectDocs = mkCommentDocs({ suggestionResponses: [{ rejectedSuggestionIds: ['sug-2'] }] });
      assert.equal((await performRejectSuggestion(rejectDocs, { documentId: 'd1', suggestionId: 'sug-2' } as any)).confirmed, true);
      assert.equal(sentRequest(rejectDocs).rejectSuggestion.suggestionId, 'sug-2');

      const deleteDocs = mkCommentDocs({ suggestionResponses: [{ deletedSuggestionIds: ['sug-3'] }] });
      assert.equal((await performDeleteSuggestion(deleteDocs, { documentId: 'd1', suggestionId: 'sug-3' } as any)).confirmed, true);
      assert.equal(sentRequest(deleteDocs).deleteSuggestion.suggestionId, 'sug-3');
    });

    it('reports an absent suggestionResponses as unconfirmed, never as failure', async () => {
      const docs = mkCommentDocs({ replies: [{}] });
      const out = await performAcceptSuggestion(docs, { documentId: 'd1', suggestionId: 'sug-1' } as any);
      assert.equal(out.confirmed, false);
      assert.equal(out.reportedIds, null);
    });
  });

  describe('suggest mode on batchUpdateDoc', () => {
    const op = { type: 'insert_text', index: 1, text: 'hi' };

    it('sends writeControl SUGGEST when asked', async () => {
      const docs = mkCommentDocs();
      const out = await performBatchUpdateDoc(docs, { documentId: 'd1', operations: [op], suggestMode: true } as any);
      assert.deepEqual(docs.documents.batchUpdate.mock.calls[0].arguments[0].requestBody.writeControl, { writeMode: 'SUGGEST' });
      assert.equal(out.suggested, true);
    });

    it('omits writeControl entirely otherwise, so existing callers send what they always did', async () => {
      const docs = mkCommentDocs();
      const out = await performBatchUpdateDoc(docs, { documentId: 'd1', operations: [op] } as any);
      const body = docs.documents.batchUpdate.mock.calls[0].arguments[0].requestBody;
      assert.ok(!('writeControl' in body), 'an absent writeControl is not the same as an empty one');
      assert.equal(out.suggested, false);
    });
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

// --- Tabs, footnotes, tables and revision pinning ---

/** A doc with one 2x3 table at index 5 in the body, and tab t.1 with child t.2 holding the same table. */
function mkTableDoc(overrides: any = {}): any {
  const table = { startIndex: 5, endIndex: 40, table: { rows: 2, columns: 3 } };
  const body = { content: [{ startIndex: 1, endIndex: 5, paragraph: { elements: [] } }, table] };
  return mkDocs({
    documents: {
      get: mock.fn(async () => ({
        data: {
          revisionId: 'rev-1',
          body,
          tabs: [{
            tabProperties: { tabId: 't.1', title: 'One', index: 0 },
            documentTab: { body },
            childTabs: [{ tabProperties: { tabId: 't.2', title: 'Child', index: 0, parentTabId: 't.1' }, documentTab: { body } }],
          }],
        },
      })),
      batchUpdate: mock.fn(async () => ({ data: { replies: [{}], writeControl: { requiredRevisionId: 'rev-2' } } })),
      ...overrides,
    },
  });
}

const sentWriteControl = (docs: any, call = 0) =>
  docs.documents.batchUpdate.mock.calls[call].arguments[0].requestBody.writeControl;

describe('revision pinning', () => {
  it('sends requiredRevisionId only when given, and reports the revision after the write', async () => {
    const docs = mkTableDoc();
    const out = await performInsertText(docs, { documentId: 'd1', textToInsert: 'x', index: 2, requiredRevisionId: 'rev-1' } as any);
    assert.deepEqual(sentWriteControl(docs), { requiredRevisionId: 'rev-1' });
    assert.equal(out.revisionId, 'rev-2');

    const unpinned = mkTableDoc();
    await performInsertText(unpinned, { documentId: 'd1', textToInsert: 'x', index: 2 } as any);
    assert.equal(sentWriteControl(unpinned), undefined, 'an unpinned write must send the body it always did');
  });

  it('combines suggest mode and a pinned revision in one write control', async () => {
    const docs = mkTableDoc();
    await performBatchUpdateDoc(docs, {
      documentId: 'd1', suggestMode: true, requiredRevisionId: 'rev-1',
      operations: [{ type: 'insert_text', index: 2, text: 'x' }],
    } as any);
    assert.deepEqual(sentWriteControl(docs), { writeMode: 'SUGGEST', requiredRevisionId: 'rev-1' });
  });

  it('names a stale revision instead of reporting a malformed request', async () => {
    const stale = Object.assign(new Error('The required revision ID rev-1 does not match the latest revision.'), { code: 400 });
    const docs = mkTableDoc({ batchUpdate: mock.fn(async () => { throw stale; }) });
    await assert.rejects(
      () => performDeleteRange(docs, { documentId: 'd1', startIndex: 1, endIndex: 3, requiredRevisionId: 'rev-1' } as any),
      (err: any) => err instanceof UserError && /changed after revision rev-1/.test(err.message) && /nothing was written/.test(err.message),
    );
  });
});

describe('tab-aware formatting', () => {
  it('finds text in the named tab and sends that tab on the range', async () => {
    const tabText = 'Only in tab two\n';
    const docs = mkDocs({ documents: { get: mock.fn(async () => ({
      data: { tabs: [
        { tabProperties: { tabId: 't.1' }, documentTab: { body: { content: [] } } },
        { tabProperties: { tabId: 't.2' }, documentTab: { body: { content: [
          { startIndex: 1, endIndex: 1 + tabText.length, paragraph: { elements: [{ startIndex: 1, endIndex: 1 + tabText.length, textRun: { content: tabText } }] } },
        ] } } },
      ] },
    })) } });
    const out = await performApplyTextStyle(docs, {
      documentId: 'd1', tabId: 't.2', target: { textToFind: 'tab two', matchInstance: 1 }, style: { bold: true },
    } as any);
    assert.deepEqual([out.startIndex, out.endIndex], [9, 16]);
    assert.deepEqual(sentRequests(docs)[0].updateTextStyle.range, { startIndex: 9, endIndex: 16, tabId: 't.2' });
    assert.equal(docs.documents.get.mock.calls[0].arguments[0].includeTabsContent, true);
  });

  it('refuses an unknown tab on an index target before writing', async () => {
    const docs = mkTableDoc();
    await assert.rejects(
      () => performApplyParagraphStyle(docs, {
        documentId: 'd1', tabId: 'nope', target: { startIndex: 1, endIndex: 3 }, style: { alignment: 'CENTER' },
      } as any),
      /Tab with ID "nope" not found/,
    );
    assert.equal(docs.documents.batchUpdate.mock.callCount(), 0);
  });

  it('accepts a nested tab, which the old field mask could not see', async () => {
    const docs = mkTableDoc();
    await performBatchUpdateDoc(docs, { documentId: 'd1', operations: [{ type: 'insert_text', index: 2, text: 'x', tabId: 't.2' }] } as any);
    assert.equal(sentRequests(docs)[0].insertText.location.tabId, 't.2');
  });
});

describe('document tabs', () => {
  it('creates a nested tab and returns what Google reported', async () => {
    const docs = mkTableDoc({ batchUpdate: mock.fn(async () => ({ data: { replies: [{ addDocumentTab: {
      tabProperties: { tabId: 't.9', title: 'Notes', index: 1, parentTabId: 't.1', nestingLevel: 1 },
    } }] } })) });
    const out = await performCreateDocumentTab(docs, { documentId: 'd1', title: 'Notes', parentTabId: 't.1' } as any);
    assert.deepEqual(sentRequests(docs)[0], { addDocumentTab: { tabProperties: { title: 'Notes', parentTabId: 't.1' } } });
    assert.equal(out.tabId, 't.9');
    assert.equal(out.nestingLevel, 1);
  });

  it('refuses to report a created tab when Google returns no id', async () => {
    const docs = mkTableDoc({ batchUpdate: mock.fn(async () => ({ data: { replies: [{}] } })) });
    await assert.rejects(() => performCreateDocumentTab(docs, { documentId: 'd1', title: 'X' } as any), /no tab ID/);
  });

  it('updates only the named fields and confirms from a re-read', async () => {
    const docs = mkTableDoc();
    const out = await performUpdateDocumentTab(docs, { documentId: 'd1', tabId: 't.1', title: 'One' } as any);
    assert.deepEqual(sentRequests(docs)[0].updateDocumentTabProperties, { tabProperties: { tabId: 't.1', title: 'One' }, fields: 'title' });
    assert.equal(out.confirmed, true);

    const stale = mkTableDoc();
    const notApplied = await performUpdateDocumentTab(stale, { documentId: 'd1', tabId: 't.1', title: 'Renamed' } as any);
    assert.equal(notApplied.confirmed, false, 'a 200 that left the title unchanged must not read as success');
  });

  it('refuses an update that names nothing to change', async () => {
    await assert.rejects(() => performUpdateDocumentTab(mkTableDoc(), { documentId: 'd1', tabId: 't.1' } as any), /Nothing to change/);
  });

  it('deletes a tab, counts the nested tabs that go with it, and confirms it is gone', async () => {
    let deleted = false;
    const base = mkTableDoc();
    const docs = mkTableDoc({
      get: mock.fn(async (args: any) => {
        const res = await base.documents.get(args);
        return deleted ? { data: { ...res.data, tabs: [] } } : res;
      }),
      batchUpdate: mock.fn(async () => { deleted = true; return { data: { replies: [{}] } }; }),
    });
    const out = await performDeleteDocumentTab(docs, { documentId: 'd1', tabId: 't.1' } as any);
    assert.deepEqual(sentRequests(docs)[0], { deleteTab: { tabId: 't.1' } });
    assert.equal(out.childTabsDeleted, 1);
    assert.equal(out.confirmed, true);
  });
});

describe('footnotes', () => {
  it('creates the reference, then writes the text into the new footnote segment', async () => {
    const docs = mkTableDoc({ batchUpdate: mock.fn(async (req: any) => ({ data: {
      replies: [req.requestBody.requests[0].createFootnote ? { createFootnote: { footnoteId: 'kix.fn1' } } : {}],
      writeControl: { requiredRevisionId: 'rev-3' },
    } })) });
    const out = await performCreateFootnote(docs, { documentId: 'd1', index: 4, text: 'Source: X', tabId: 't.1', requiredRevisionId: 'rev-1' } as any);
    assert.deepEqual(sentRequests(docs, 0)[0], { createFootnote: { location: { index: 4, tabId: 't.1' } } });
    assert.deepEqual(sentWriteControl(docs, 0), { requiredRevisionId: 'rev-1' });
    assert.deepEqual(sentRequests(docs, 1)[0], { insertText: { endOfSegmentLocation: { segmentId: 'kix.fn1', tabId: 't.1' }, text: 'Source: X' } });
    assert.deepEqual(out, { footnoteId: 'kix.fn1', index: 4, revisionId: 'rev-3' });
  });

  it('names the empty footnote left behind when the text write fails', async () => {
    let call = 0;
    const docs = mkTableDoc({ batchUpdate: mock.fn(async () => {
      call += 1;
      if (call === 1) return { data: { replies: [{ createFootnote: { footnoteId: 'kix.fn1' } }] } };
      throw new Error('boom');
    }) });
    await assert.rejects(
      () => performCreateFootnote(docs, { documentId: 'd1', index: 4, text: 'x' } as any),
      (err: any) => err instanceof UserError && /kix\.fn1/.test(err.message) && /empty footnote is still in the document/.test(err.message),
    );
  });
});

describe('table structure and cell formatting', () => {
  it('inserts N rows below the reference cell and reports the new shape', async () => {
    const docs = mkTableDoc();
    const out = await performModifyTableStructure(docs, {
      documentId: 'd1', tableStartIndex: 5, action: 'insert_rows_below', rowIndex: 1, columnIndex: 0, count: 2,
    } as any);
    const reqs = sentRequests(docs);
    assert.equal(reqs.length, 2);
    assert.deepEqual(reqs[0].insertTableRow, {
      tableCellLocation: { tableStartLocation: { index: 5 }, rowIndex: 1, columnIndex: 0 }, insertBelow: true,
    });
    assert.deepEqual(out.tableAfter, { rows: 4, columns: 3 });
  });

  it('merges a cell block in a tab', async () => {
    const docs = mkTableDoc();
    await performModifyTableStructure(docs, {
      documentId: 'd1', tableStartIndex: 5, tabId: 't.1', action: 'merge_cells', rowIndex: 0, columnIndex: 0, columnSpan: 3,
    } as any);
    assert.deepEqual(sentRequests(docs)[0].mergeTableCells.tableRange, {
      tableCellLocation: { tableStartLocation: { index: 5, tabId: 't.1' }, rowIndex: 0, columnIndex: 0 }, rowSpan: 1, columnSpan: 3,
    });
  });

  it('refuses a one-cell merge, a block outside the table, and an index with no table', async () => {
    await assert.rejects(() => performModifyTableStructure(mkTableDoc(), {
      documentId: 'd1', tableStartIndex: 5, action: 'merge_cells', rowIndex: 0, columnIndex: 0,
    } as any), /at least two cells/);
    await assert.rejects(() => performModifyTableStructure(mkTableDoc(), {
      documentId: 'd1', tableStartIndex: 5, action: 'merge_cells', rowIndex: 1, columnIndex: 2, rowSpan: 2,
    } as any), /outside the 2x3 table/);
    await assert.rejects(() => performModifyTableStructure(mkTableDoc(), {
      documentId: 'd1', tableStartIndex: 6, action: 'insert_rows_above', rowIndex: 0, columnIndex: 0,
    } as any), /No table starts at index 6\. Tables start at: 5/);
  });

  it('deletes a column but refuses to delete the last row, which would remove the table', async () => {
    const docs = mkTableDoc();
    await performDeleteTableRowOrColumn(docs, { documentId: 'd1', tableStartIndex: 5, target: 'column', index: 2 } as any);
    assert.deepEqual(sentRequests(docs)[0].deleteTableColumn.tableCellLocation, {
      tableStartLocation: { index: 5 }, rowIndex: 0, columnIndex: 2,
    });

    const oneRow = mkTableDoc({ get: mock.fn(async () => ({ data: { body: { content: [{ startIndex: 5, table: { rows: 1, columns: 2 } }] } } })) });
    await assert.rejects(
      () => performDeleteTableRowOrColumn(oneRow, { documentId: 'd1', tableStartIndex: 5, target: 'row', index: 0 } as any),
      /would delete the whole table/,
    );
    await assert.rejects(
      () => performDeleteTableRowOrColumn(mkTableDoc(), { documentId: 'd1', tableStartIndex: 5, target: 'row', index: 2 } as any),
      /there is no row 2/,
    );
  });

  it('formats a header row across every column, with row height and border defaults', async () => {
    const docs = mkTableDoc();
    const out = await performFormatTableCells(docs, {
      documentId: 'd1', tableStartIndex: 5, rowIndex: 0, backgroundColor: '#FFF2CC', borderWidthPt: 2, minRowHeightPt: 20,
    } as any);
    const [cellReq, rowReq] = sentRequests(docs);
    assert.deepEqual(cellReq.updateTableCellStyle.tableRange, {
      tableCellLocation: { tableStartLocation: { index: 5 }, rowIndex: 0, columnIndex: 0 }, rowSpan: 1, columnSpan: 3,
    });
    assert.equal(cellReq.updateTableCellStyle.fields, 'backgroundColor,borderTop,borderBottom,borderLeft,borderRight');
    assert.deepEqual(cellReq.updateTableCellStyle.tableCellStyle.borderTop, {
      color: { color: { rgbColor: { red: 0, green: 0, blue: 0 } } }, width: { magnitude: 2, unit: 'PT' }, dashStyle: 'SOLID',
    });
    assert.deepEqual(rowReq.updateTableRowStyle, {
      tableStartLocation: { index: 5 }, rowIndices: [0], tableRowStyle: { minRowHeight: { magnitude: 20, unit: 'PT' } }, fields: 'minRowHeight',
    });
    assert.equal(out.revisionId, 'rev-2');
  });

  it('sets fixed column widths for the named columns only', async () => {
    const docs = mkTableDoc();
    await performFormatTableCells(docs, { documentId: 'd1', tableStartIndex: 5, columnIndex: 1, columnSpan: 2, columnWidthPt: 90 } as any);
    const reqs = sentRequests(docs);
    assert.equal(reqs.length, 1);
    assert.deepEqual(reqs[0].updateTableColumnProperties.columnIndices, [1, 2]);
    assert.equal(reqs[0].updateTableColumnProperties.fields, 'width,widthType');
  });

  it('refuses a call that names no formatting, before reading the doc', async () => {
    const docs = mkTableDoc();
    await assert.rejects(() => performFormatTableCells(docs, { documentId: 'd1', tableStartIndex: 5 } as any), /Nothing to format/);
    assert.equal(docs.documents.get.mock.callCount(), 0);
  });
});

describe('review follow-ups', () => {
  /** A doc whose table at index 5 reads back with `after` once anything is written. */
  function shapeChanging(before: { rows: number; columns: number }, after: { rows: number; columns: number }) {
    let written = false;
    const body = () => ({ content: [{ startIndex: 5, table: written ? after : before }] });
    return mkDocs({ documents: {
      get: mock.fn(async () => ({ data: { body: body() } })),
      batchUpdate: mock.fn(async () => { written = true; return { data: { replies: [{}] } }; }),
    } });
  }

  it('confirms an insert from the re-read table, and reports a mismatch as false', async () => {
    const ok = await performModifyTableStructure(shapeChanging({ rows: 2, columns: 3 }, { rows: 3, columns: 3 }), {
      documentId: 'd1', tableStartIndex: 5, action: 'insert_rows_below', rowIndex: 0, columnIndex: 0,
    } as any);
    assert.equal(ok.confirmed, true);
    const off = await performModifyTableStructure(shapeChanging({ rows: 2, columns: 3 }, { rows: 2, columns: 3 }), {
      documentId: 'd1', tableStartIndex: 5, action: 'insert_rows_below', rowIndex: 0, columnIndex: 0,
    } as any);
    assert.equal(off.confirmed, false);
  });

  it('reports a merge as unconfirmed (null), never as proven', async () => {
    const r = await performModifyTableStructure(shapeChanging({ rows: 2, columns: 3 }, { rows: 2, columns: 3 }), {
      documentId: 'd1', tableStartIndex: 5, action: 'merge_cells', rowIndex: 0, columnIndex: 0, columnSpan: 2,
    } as any);
    assert.equal(r.confirmed, null);
  });

  it('confirms a row delete only when exactly one row went', async () => {
    const one = await performDeleteTableRowOrColumn(shapeChanging({ rows: 3, columns: 2 }, { rows: 2, columns: 2 }), {
      documentId: 'd1', tableStartIndex: 5, target: 'row', index: 1,
    } as any);
    assert.equal(one.confirmed, true);
    const merged = await performDeleteTableRowOrColumn(shapeChanging({ rows: 3, columns: 2 }, { rows: 1, columns: 2 }), {
      documentId: 'd1', tableStartIndex: 5, target: 'row', index: 1,
    } as any);
    assert.equal(merged.confirmed, false);
  });

  it('keeps the upstream status when a footnote\'s text write fails', async () => {
    let call = 0;
    const docs = mkDocs({ documents: { batchUpdate: mock.fn(async () => {
      call += 1;
      if (call === 1) return { data: { replies: [{ createFootnote: { footnoteId: 'kix.fn1' } }] } };
      throw Object.assign(new Error('The caller does not have permission'), { code: 403 });
    }) } });
    await assert.rejects(
      () => performCreateFootnote(docs, { documentId: 'd1', index: 4, text: 'x' } as any),
      (err: any) => err.code === 403 && /kix\.fn1/.test(err.message),
    );
  });

  it('widens a paragraph target inside the named tab', async () => {
    const text = 'Tab para\n';
    const docs = mkDocs({ documents: { get: mock.fn(async () => ({ data: { tabs: [
      { tabProperties: { tabId: 't.2' }, documentTab: { body: { content: [
        { startIndex: 1, endIndex: 1 + text.length, paragraph: { elements: [{ startIndex: 1, endIndex: 1 + text.length, textRun: { content: text } }] } },
      ] } } },
    ] } })) } });
    await performApplyParagraphStyle(docs, { documentId: 'd1', tabId: 't.2', target: { textToFind: 'para', matchInstance: 1 }, style: { alignment: 'CENTER' } } as any);
    assert.deepEqual(sentRequests(docs)[0].updateParagraphStyle.range, { startIndex: 1, endIndex: 1 + text.length, tabId: 't.2' });
  });

  it('formats one column across every row when only columnIndex is given', async () => {
    const docs = shapeChanging({ rows: 4, columns: 3 }, { rows: 4, columns: 3 });
    const r = await performFormatTableCells(docs, { documentId: 'd1', tableStartIndex: 5, columnIndex: 2, backgroundColor: '#EEE' } as any);
    assert.deepEqual(r.cells, { rowIndex: 0, columnIndex: 2, rowSpan: 4, columnSpan: 1 });
  });

  it('refuses a batch naming an unknown tab before writing', async () => {
    const docs = mkDocs({ documents: { get: mock.fn(async () => ({ data: { tabs: [{ tabProperties: { tabId: 't.1' }, documentTab: { body: {} } }] } })) } });
    await assert.rejects(
      () => performBatchUpdateDoc(docs, { documentId: 'd1', operations: [{ type: 'insert_text', index: 1, text: 'x', tabId: 't.9' }] } as any),
      /Tab with ID "t\.9" not found/,
    );
    assert.equal(docs.documents.batchUpdate.mock.callCount(), 0);
  });
});
