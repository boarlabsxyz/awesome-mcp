// One exported op per Google Docs write tool: the half that decides what the
// request to Google IS, with no formatting and no transport concerns.
//
// Moved out of the `addTool` bodies in google-docs/server.ts so the MCP tools and
// the REST routes under /api/v1/docs/* run the same code. The alternative is a
// second copy of the request building in webServer.ts, and this repo already has
// the scar from that: the Calendar event resource and its response projection
// existed twice and the copies drifted.
//
// It is a module of its own rather than exports from server.ts for the reason
// writeSchemas.ts explains — server.ts is the application entry point and imports
// the web server, so nothing the web server needs may live there.
//
// Each op returns DATA. The tool renders it into its human string; the route puts
// it in JSON. Anything either surface would otherwise compute itself (a resolved
// range, the number of replacements, a Drive link) belongs in the return value.

import { docs_v1, drive_v3 } from 'googleapis';
import { UserError } from 'fastmcp';
import * as GDocsHelpers from './apiHelpers.js';
import { TextStyleArgs } from '../types.js';
import type {
  AddCommentArgs,
  AppendToGoogleDocArgs,
  BatchUpdateDocArgs,
  DeleteCommentArgs,
  DeleteRangeArgs,
  FindAndReplaceArgs,
  FormatMatchingTextArgs,
  ImportDocxArgs,
  ImportToGoogleDocArgs,
  InsertImageFromUrlArgs,
  InsertLocalImageArgs,
  InsertPageBreakArgs,
  InsertTableArgs,
  InsertTextArgs,
  ReplyToCommentArgs,
  ResolveCommentArgs,
} from './writeSchemas.js';
import type { ApplyParagraphStyleToolArgs, ApplyTextStyleToolArgs } from '../types.js';

type Docs = docs_v1.Docs;
type Drive = drive_v3.Drive;

/**
 * Confirm a tab exists and carries content, before anything is written to it.
 *
 * Shared because four ops need it and the failure is otherwise silent: Google
 * accepts a write whose location names an unknown tab by applying it to the
 * document body instead, so the caller is told the write succeeded while the text
 * landed somewhere they did not ask for.
 */
async function assertTabExists(docs: Docs, documentId: string, tabId: string): Promise<docs_v1.Schema$Tab> {
  const docInfo = await docs.documents.get({
    documentId,
    includeTabsContent: true,
    fields: 'tabs(tabProperties,documentTab)',
  });
  const targetTab = GDocsHelpers.findTabById(docInfo.data, tabId);
  if (!targetTab) {
    throw new UserError(`Tab with ID "${tabId}" not found in document.`);
  }
  if (!targetTab.documentTab) {
    throw new UserError(`Tab "${tabId}" does not have content (may not be a document tab).`);
  }
  return targetTab;
}

// === Text content ===

export async function performAppendToGoogleDoc(
  docs: Docs,
  args: AppendToGoogleDocArgs,
): Promise<{ index: number; appendedNewline: boolean; characters: number }> {
  const needsTabsContent = !!args.tabId;
  const docInfo = await docs.documents.get({
    documentId: args.documentId,
    includeTabsContent: needsTabsContent,
    fields: needsTabsContent ? 'tabs' : 'body(content(endIndex)),documentStyle(pageSize)',
  });

  let bodyContent: docs_v1.Schema$StructuralElement[] | undefined;
  if (args.tabId) {
    const targetTab = GDocsHelpers.findTabById(docInfo.data, args.tabId);
    if (!targetTab) throw new UserError(`Tab with ID "${args.tabId}" not found in document.`);
    if (!targetTab.documentTab) throw new UserError(`Tab "${args.tabId}" does not have content (may not be a document tab).`);
    bodyContent = targetTab.documentTab.body?.content ?? undefined;
  } else {
    bodyContent = docInfo.data.body?.content ?? undefined;
  }

  // Insert *before* the final newline the document always ends with.
  let endIndex = 1;
  if (bodyContent?.length) {
    const lastElement = bodyContent[bodyContent.length - 1];
    if (lastElement?.endIndex) endIndex = lastElement.endIndex - 1;
  }

  const appendedNewline = Boolean(args.addNewlineIfNeeded) && endIndex > 1;
  const textToInsert = (appendedNewline ? '\n' : '') + args.textToAppend;

  const location: docs_v1.Schema$Location = { index: endIndex };
  if (args.tabId) location.tabId = args.tabId;
  await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [
    { insertText: { location, text: textToInsert } },
  ]);

  return { index: endIndex, appendedNewline, characters: textToInsert.length };
}

export async function performInsertText(docs: Docs, args: InsertTextArgs): Promise<{ index: number }> {
  if (args.tabId) {
    await assertTabExists(docs, args.documentId, args.tabId);
    const location: docs_v1.Schema$Location = { index: args.index, tabId: args.tabId };
    await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [
      { insertText: { location, text: args.textToInsert } },
    ]);
  } else {
    await GDocsHelpers.insertText(docs, args.documentId, args.textToInsert, args.index);
  }
  return { index: args.index };
}

export async function performDeleteRange(
  docs: Docs,
  args: DeleteRangeArgs,
): Promise<{ startIndex: number; endIndex: number }> {
  if (args.tabId) await assertTabExists(docs, args.documentId, args.tabId);
  const range: docs_v1.Schema$Range = { startIndex: args.startIndex, endIndex: args.endIndex };
  if (args.tabId) range.tabId = args.tabId;
  await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [{ deleteContentRange: { range } }]);
  return { startIndex: args.startIndex, endIndex: args.endIndex };
}

// === Styling ===

/** `null` fields means the caller named no style at all — not a failure, but nothing was written. */
export async function performApplyTextStyle(
  docs: Docs,
  args: ApplyTextStyleToolArgs,
): Promise<{ startIndex: number; endIndex: number; fields: string[] | null }> {
  let startIndex: number | undefined;
  let endIndex: number | undefined;

  if ('textToFind' in args.target) {
    const range = await GDocsHelpers.findTextRange(docs, args.documentId, args.target.textToFind, args.target.matchInstance);
    if (!range) {
      throw new UserError(`Could not find instance ${args.target.matchInstance} of text "${args.target.textToFind}".`);
    }
    startIndex = range.startIndex;
    endIndex = range.endIndex;
  } else {
    startIndex = args.target.startIndex;
    endIndex = args.target.endIndex;
  }

  if (startIndex === undefined || endIndex === undefined) {
    throw new UserError('Target range could not be determined.');
  }
  if (endIndex <= startIndex) {
    throw new UserError('End index must be greater than start index for styling.');
  }

  const requestInfo = GDocsHelpers.buildUpdateTextStyleRequest(startIndex, endIndex, args.style);
  if (!requestInfo) return { startIndex, endIndex, fields: null };

  await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [requestInfo.request]);
  return { startIndex, endIndex, fields: requestInfo.fields };
}

export async function performApplyParagraphStyle(
  docs: Docs,
  args: ApplyParagraphStyleToolArgs,
): Promise<{ startIndex: number; endIndex: number; fields: string[] | null }> {
  let startIndex: number | undefined;
  let endIndex: number | undefined;

  if ('textToFind' in args.target) {
    // Two hops: find the text, then widen to the paragraph containing it —
    // a paragraph style applied to a text range alone would not take.
    const textRange = await GDocsHelpers.findTextRange(
      docs, args.documentId, args.target.textToFind, args.target.matchInstance || 1,
    );
    if (!textRange) throw new UserError(`Could not find "${args.target.textToFind}" in the document.`);
    const paragraphRange = await GDocsHelpers.getParagraphRange(docs, args.documentId, textRange.startIndex);
    if (!paragraphRange) throw new UserError('Found the text but could not determine the paragraph boundaries.');
    startIndex = paragraphRange.startIndex;
    endIndex = paragraphRange.endIndex;
  } else if ('indexWithinParagraph' in args.target) {
    const paragraphRange = await GDocsHelpers.getParagraphRange(docs, args.documentId, args.target.indexWithinParagraph);
    if (!paragraphRange) {
      throw new UserError(`Could not find paragraph containing index ${args.target.indexWithinParagraph}.`);
    }
    startIndex = paragraphRange.startIndex;
    endIndex = paragraphRange.endIndex;
  } else if ('startIndex' in args.target && 'endIndex' in args.target) {
    startIndex = args.target.startIndex;
    endIndex = args.target.endIndex;
  }

  if (startIndex === undefined || endIndex === undefined) {
    throw new UserError('Could not determine target paragraph range from the provided information.');
  }
  if (endIndex <= startIndex) {
    throw new UserError(`Invalid paragraph range: end index (${endIndex}) must be greater than start index (${startIndex}).`);
  }

  const requestInfo = GDocsHelpers.buildUpdateParagraphStyleRequest(startIndex, endIndex, args.style);
  if (!requestInfo) return { startIndex, endIndex, fields: null };

  await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [requestInfo.request]);
  return { startIndex, endIndex, fields: requestInfo.fields };
}

export async function performFormatMatchingText(
  docs: Docs,
  args: FormatMatchingTextArgs,
): Promise<{ startIndex: number; endIndex: number; fields: string[] | null }> {
  const styleParams: TextStyleArgs = {};
  if (args.bold !== undefined) styleParams.bold = args.bold;
  if (args.italic !== undefined) styleParams.italic = args.italic;
  if (args.underline !== undefined) styleParams.underline = args.underline;
  if (args.strikethrough !== undefined) styleParams.strikethrough = args.strikethrough;
  if (args.fontSize !== undefined) styleParams.fontSize = args.fontSize;
  if (args.fontFamily !== undefined) styleParams.fontFamily = args.fontFamily;
  if (args.foregroundColor !== undefined) styleParams.foregroundColor = args.foregroundColor;
  if (args.backgroundColor !== undefined) styleParams.backgroundColor = args.backgroundColor;
  if (args.linkUrl !== undefined) styleParams.linkUrl = args.linkUrl;

  const range = await GDocsHelpers.findTextRange(docs, args.documentId, args.textToFind, args.matchInstance);
  if (!range) {
    throw new UserError(`Could not find instance ${args.matchInstance} of text "${args.textToFind}".`);
  }

  const requestInfo = GDocsHelpers.buildUpdateTextStyleRequest(range.startIndex, range.endIndex, styleParams);
  if (!requestInfo) return { startIndex: range.startIndex, endIndex: range.endIndex, fields: null };

  await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [requestInfo.request]);
  return { startIndex: range.startIndex, endIndex: range.endIndex, fields: requestInfo.fields };
}

export async function performFindAndReplace(
  docs: Docs,
  args: FindAndReplaceArgs,
): Promise<{ occurrencesChanged: number }> {
  const request: docs_v1.Schema$Request = {
    replaceAllText: {
      containsText: { text: args.findText, matchCase: args.matchCase ?? false },
      replaceText: args.replaceText,
    },
  };
  if (args.tabId) {
    (request.replaceAllText as any).tabsCriteria = { tabIds: [args.tabId] };
  }

  const response = await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [request]);
  // The count only exists in the reply, so it has to be read here rather than
  // reported as "done" — a replace that matched nothing is the common case.
  let occurrencesChanged = 0;
  for (const reply of response.replies || []) {
    if (reply.replaceAllText?.occurrencesChanged) occurrencesChanged += reply.replaceAllText.occurrencesChanged;
  }
  return { occurrencesChanged };
}

// === Structure ===

export async function performInsertTable(
  docs: Docs,
  args: InsertTableArgs,
): Promise<{ rows: number; columns: number; index: number }> {
  await GDocsHelpers.createTable(docs, args.documentId, args.rows, args.columns, args.index);
  return { rows: args.rows, columns: args.columns, index: args.index };
}

export async function performInsertPageBreak(
  docs: Docs,
  args: InsertPageBreakArgs,
): Promise<{ index: number }> {
  await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [
    { insertPageBreak: { location: { index: args.index } } },
  ]);
  return { index: args.index };
}

export async function performBatchUpdateDoc(
  docs: Docs,
  args: BatchUpdateDocArgs,
): Promise<{ requested: number; executed: number; typeCounts: Record<string, number> }> {
  // Global replacements change the document's length, so every index captured
  // before them is wrong afterwards. Refused rather than reordered: there is no
  // ordering that makes a mixed batch mean what the caller intended.
  const hasGlobal = args.operations.some((op) => op.type === 'replace_text' || op.type === 'find_replace');
  const hasIndexBased = args.operations.some((op) => op.type !== 'replace_text' && op.type !== 'find_replace');
  if (hasGlobal && hasIndexBased) {
    throw new UserError(
      'Cannot mix global operations (replace_text, find_replace) with index-based operations in the same batch. '
      + 'Global replacements change document length and invalidate indices. Submit them in separate batches.',
    );
  }

  // Descending index order, so applying one operation does not shift the
  // positions the later ones were computed against.
  const opsToProcess = hasIndexBased
    ? [...args.operations].sort((a, b) => {
      const aIdx = ('index' in a ? (a as any).index : (a as any).startIndex) ?? 0;
      const bIdx = ('index' in b ? (b as any).index : (b as any).startIndex) ?? 0;
      return bIdx - aIdx;
    })
    : args.operations;

  const allRequests: docs_v1.Schema$Request[] = [];
  const typeCounts: Record<string, number> = {};
  for (const op of opsToProcess) {
    const requests = GDocsHelpers.mapBatchOperationToRequest(op);
    if (requests.length > 0) {
      allRequests.push(...requests);
      typeCounts[op.type] = (typeCounts[op.type] || 0) + 1;
    }
  }

  if (allRequests.length === 0) {
    return { requested: args.operations.length, executed: 0, typeCounts };
  }

  await GDocsHelpers.executeBatchUpdate(docs, args.documentId, allRequests);
  return { requested: args.operations.length, executed: allRequests.length, typeCounts };
}

// === Images ===

export async function performInsertImageFromUrl(
  docs: Docs,
  args: InsertImageFromUrlArgs,
): Promise<{ index: number; imageUrl: string; width?: number; height?: number }> {
  await GDocsHelpers.insertInlineImage(docs, args.documentId, args.imageUrl, args.index, args.width, args.height);
  return { index: args.index, imageUrl: args.imageUrl, width: args.width, height: args.height };
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Four input shapes collapse to one: resolve the bytes to a URL Google can fetch,
 * then insert. `resolvedImageUrl` is returned because it is a real side effect —
 * for every path but `driveFile` a new file now exists in the user's Drive.
 */
export async function performInsertLocalImage(
  docs: Docs,
  drive: Drive,
  args: InsertLocalImageArgs,
): Promise<{ index: number; resolvedImageUrl: string; uploadedToDrive: boolean }> {
  const strategy = GDocsHelpers.validateImageSource(args);
  let resolvedImageUrl: string;

  if (strategy === 'driveFile') {
    resolvedImageUrl = await GDocsHelpers.getPublicUrlForDriveFile(drive, args.driveFileId!);
  } else {
    let imageBuffer: Buffer | undefined;
    if (args.imageBase64) {
      const b64 = args.imageBase64;
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
        throw new UserError('imageBase64 contains invalid characters. Provide a valid base64-encoded string.');
      }
      // Size is checked from the base64 length BEFORE decoding, so an oversize
      // payload never gets a buffer allocated for it.
      const decodedSize = Math.floor((b64.length * 3) / 4)
        - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
      if (decodedSize > MAX_IMAGE_BYTES) {
        throw new UserError(`imageBase64 decodes to ${decodedSize} bytes, exceeding the ${MAX_IMAGE_BYTES} byte limit.`);
      }
      imageBuffer = Buffer.from(b64, 'base64');
    }

    let parentFolderId: string | undefined;
    if (args.uploadToSameFolder) {
      try {
        const docInfo = await drive.files.get({ fileId: args.documentId, fields: 'parents' });
        if (docInfo.data.parents?.length) parentFolderId = docInfo.data.parents[0];
      } catch {
        // Best effort: the image lands in Drive root rather than failing the insert.
      }
    }

    resolvedImageUrl = await GDocsHelpers.uploadImageToDrive(
      drive, args.localImagePath, parentFolderId, imageBuffer, args.fileName, args.imageUrl,
    );
  }

  await GDocsHelpers.insertInlineImage(docs, args.documentId, resolvedImageUrl, args.index, args.width, args.height);
  return { index: args.index, resolvedImageUrl, uploadedToDrive: strategy !== 'driveFile' };
}

// === Comments ===

/**
 * Read the text the comment refers to, then create the comment on the Drive API.
 *
 * The quoted text is assembled here rather than left to Google: the Drive API
 * ignores `anchor` for Google Docs, so quoting the range is the ONLY way the
 * comment says which text it is about (see the tool description).
 */
export async function performAddComment(
  docs: Docs,
  drive: Drive,
  args: AddCommentArgs,
): Promise<drive_v3.Schema$Comment & { quotedText: string }> {
  const doc = await docs.documents.get({ documentId: args.documentId });

  let quotedText = '';
  for (const element of doc.data.body?.content || []) {
    for (const textElement of element.paragraph?.elements || []) {
      if (!textElement.textRun) continue;
      const elementStart = textElement.startIndex || 0;
      const elementEnd = textElement.endIndex || 0;
      if (elementEnd > args.startIndex && elementStart < args.endIndex) {
        const text = textElement.textRun.content || '';
        const startOffset = Math.max(0, args.startIndex - elementStart);
        const endOffset = Math.min(text.length, args.endIndex - elementStart);
        quotedText += text.substring(startOffset, endOffset);
      }
    }
  }

  const response = await drive.comments.create({
    fileId: args.documentId,
    fields: 'id,content,quotedFileContent,author,createdTime,resolved',
    requestBody: {
      content: args.commentText,
      quotedFileContent: { value: quotedText, mimeType: 'text/html' },
    },
  });
  return { ...response.data, quotedText };
}

export async function performReplyToComment(
  drive: Drive,
  args: ReplyToCommentArgs,
): Promise<drive_v3.Schema$Reply> {
  const response = await drive.replies.create({
    fileId: args.documentId,
    commentId: args.commentId,
    fields: 'id,content,author,createdTime',
    requestBody: { content: args.replyText },
  });
  return response.data;
}

/**
 * Resolving needs the current content echoed back, and the result is verified
 * rather than assumed: the Drive API accepts `resolved: true` on a Google Doc
 * comment and frequently does not persist it, so `resolved` here is what Google
 * reported on a re-read, not what was requested.
 */
export async function performResolveComment(
  drive: Drive,
  args: ResolveCommentArgs,
): Promise<{ commentId: string; resolved: boolean }> {
  const currentComment = await drive.comments.get({
    fileId: args.documentId,
    commentId: args.commentId,
    fields: 'content',
  });
  await drive.comments.update({
    fileId: args.documentId,
    commentId: args.commentId,
    fields: 'id,resolved',
    requestBody: { content: currentComment.data.content, resolved: true },
  });
  const verify = await drive.comments.get({
    fileId: args.documentId,
    commentId: args.commentId,
    fields: 'resolved',
  });
  return { commentId: args.commentId, resolved: Boolean(verify.data.resolved) };
}

export async function performDeleteComment(
  drive: Drive,
  args: DeleteCommentArgs,
): Promise<{ commentId: string; deleted: true }> {
  await drive.comments.delete({ fileId: args.documentId, commentId: args.commentId });
  return { commentId: args.commentId, deleted: true };
}

// === Import ===

export async function performImportDocx(
  drive: Drive,
  args: ImportDocxArgs,
): Promise<drive_v3.Schema$File> {
  const fileInfo = await drive.files.get({
    fileId: args.fileId,
    supportsAllDrives: true,
    fields: 'mimeType,name',
  });
  const mime = fileInfo.data.mimeType || '';
  // Checked first because Drive would happily "convert" something else and hand
  // back an unreadable document.
  if (mime !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    throw new UserError(`File is not a .docx file (mimeType: ${mime}). Only Word documents (.docx) can be imported.`);
  }

  const copyMetadata: drive_v3.Schema$File = { mimeType: 'application/vnd.google-apps.document' };
  if (args.targetFolderId) copyMetadata.parents = [args.targetFolderId];

  const copyResponse = await drive.files.copy({
    fileId: args.fileId,
    requestBody: copyMetadata,
    supportsAllDrives: true,
    fields: 'id,name,webViewLink',
  });
  return copyResponse.data;
}

export async function performImportToGoogleDoc(
  drive: Drive,
  args: ImportToGoogleDocArgs,
): Promise<drive_v3.Schema$File> {
  const { Readable } = await import('stream');
  const fileMetadata: drive_v3.Schema$File = {
    name: args.title,
    mimeType: 'application/vnd.google-apps.document',
  };
  if (args.parentFolderId) fileMetadata.parents = [args.parentFolderId];

  const response = await drive.files.create({
    requestBody: fileMetadata,
    media: {
      mimeType: args.mimeType || 'text/plain',
      body: Readable.from(Buffer.from(args.content, 'utf-8')),
    },
    supportsAllDrives: true,
    fields: 'id,name,webViewLink,mimeType',
  });
  return response.data;
}
