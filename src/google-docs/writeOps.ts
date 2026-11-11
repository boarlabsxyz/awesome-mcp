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
import { TextStyleArgs, hexToRgbColor } from '../types.js';
import type {
  AddCommentArgs,
  AppendToGoogleDocArgs,
  BatchUpdateDocArgs,
  CreateDocumentTabArgs,
  CreateFootnoteArgs,
  DeleteDocumentTabArgs,
  DeleteTableRowOrColumnArgs,
  FormatTableCellsArgs,
  ModifyTableStructureArgs,
  UpdateDocumentTabArgs,
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
  ReopenCommentArgs,
  AssignCommentArgs,
  UpdateCommentPostArgs,
  DeleteCommentReplyArgs,
  AcceptSuggestionArgs,
  RejectSuggestionArgs,
  DeleteSuggestionArgs,
} from './writeSchemas.js';
import type { ApplyParagraphStyleToolArgs, ApplyTextStyleToolArgs } from '../types.js';

type Docs = docs_v1.Docs;
type Drive = drive_v3.Drive;

/**
 * Confirm tabs exist and carry content, before anything is written to them.
 *
 * Shared because most ops need it and the failure is otherwise silent: Google
 * accepts a write whose location names an unknown tab by applying it to the
 * document body instead, so the caller is told the write succeeded while the text
 * landed somewhere they did not ask for.
 *
 * No `fields` mask: a mask cannot recurse into `childTabs`, and the previous
 * `tabs(tabProperties,documentTab)` left every nested tab out, so a write to a
 * child tab was refused as "not found".
 */
async function assertTabsExist(docs: Docs, documentId: string, tabIds: string[]): Promise<docs_v1.Schema$Tab[]> {
  const docInfo = await docs.documents.get({ documentId, includeTabsContent: true });
  return tabIds.map((tabId) => {
    const tab = GDocsHelpers.findTabById(docInfo.data, tabId);
    if (!tab) throw new UserError(`Tab with ID "${tabId}" not found in document.`);
    if (!tab.documentTab) throw new UserError(`Tab "${tabId}" does not have content (may not be a document tab).`);
    return tab;
  });
}

async function assertTabExists(docs: Docs, documentId: string, tabId: string): Promise<docs_v1.Schema$Tab> {
  const [tab] = await assertTabsExist(docs, documentId, [tabId]);
  return tab;
}

/**
 * The write control that pins an edit to the revision the caller read. Undefined
 * when no revision was named, so the request body is unchanged for every caller
 * that does not use it.
 */
function pinnedTo(requiredRevisionId: string | undefined): docs_v1.Schema$WriteControl | undefined {
  return requiredRevisionId ? { requiredRevisionId } : undefined;
}

/** The document's revision after a write, for the caller to pin its next edit to. */
function revisionAfter(response: docs_v1.Schema$BatchUpdateDocumentResponse): string | null {
  return response.writeControl?.requiredRevisionId ?? null;
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

export async function performInsertText(
  docs: Docs,
  args: InsertTextArgs,
): Promise<{ index: number; revisionId: string | null }> {
  const location: docs_v1.Schema$Location = { index: args.index };
  if (args.tabId) {
    await assertTabExists(docs, args.documentId, args.tabId);
    location.tabId = args.tabId;
  }
  const response = await GDocsHelpers.executeBatchUpdate(
    docs,
    args.documentId,
    [{ insertText: { location, text: args.textToInsert } }],
    pinnedTo(args.requiredRevisionId),
  );
  return { index: args.index, revisionId: revisionAfter(response) };
}

export async function performDeleteRange(
  docs: Docs,
  args: DeleteRangeArgs,
): Promise<{ startIndex: number; endIndex: number; revisionId: string | null }> {
  if (args.tabId) await assertTabExists(docs, args.documentId, args.tabId);
  const range: docs_v1.Schema$Range = { startIndex: args.startIndex, endIndex: args.endIndex };
  if (args.tabId) range.tabId = args.tabId;
  const response = await GDocsHelpers.executeBatchUpdate(
    docs, args.documentId, [{ deleteContentRange: { range } }], pinnedTo(args.requiredRevisionId),
  );
  return { startIndex: args.startIndex, endIndex: args.endIndex, revisionId: revisionAfter(response) };
}

// === Styling ===

/** `null` fields means the caller named no style at all — not a failure, but nothing was written. */
export async function performApplyTextStyle(
  docs: Docs,
  args: ApplyTextStyleToolArgs,
): Promise<{ startIndex: number; endIndex: number; fields: string[] | null; revisionId?: string | null }> {
  let startIndex: number | undefined;
  let endIndex: number | undefined;

  if ('textToFind' in args.target) {
    const range = await GDocsHelpers.findTextRange(
      docs, args.documentId, args.target.textToFind, args.target.matchInstance, args.tabId,
    );
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

  const requestInfo = GDocsHelpers.buildUpdateTextStyleRequest(startIndex, endIndex, args.style, args.tabId);
  if (!requestInfo) return { startIndex, endIndex, fields: null };

  // An index target never read the tab, and Google applies a write naming an
  // unknown tab to the first tab instead — so it is checked before writing.
  if (args.tabId && !('textToFind' in args.target)) await assertTabExists(docs, args.documentId, args.tabId);
  const response = await GDocsHelpers.executeBatchUpdate(
    docs, args.documentId, [requestInfo.request], pinnedTo(args.requiredRevisionId),
  );
  return { startIndex, endIndex, fields: requestInfo.fields, revisionId: revisionAfter(response) };
}

export async function performApplyParagraphStyle(
  docs: Docs,
  args: ApplyParagraphStyleToolArgs,
): Promise<{ startIndex: number; endIndex: number; fields: string[] | null; revisionId?: string | null }> {
  let startIndex: number | undefined;
  let endIndex: number | undefined;

  if ('textToFind' in args.target) {
    // Two hops: find the text, then widen to the paragraph containing it —
    // a paragraph style applied to a text range alone would not take.
    const textRange = await GDocsHelpers.findTextRange(
      docs, args.documentId, args.target.textToFind, args.target.matchInstance || 1, args.tabId,
    );
    if (!textRange) throw new UserError(`Could not find "${args.target.textToFind}" in the document.`);
    const paragraphRange = await GDocsHelpers.getParagraphRange(docs, args.documentId, textRange.startIndex, args.tabId);
    if (!paragraphRange) throw new UserError('Found the text but could not determine the paragraph boundaries.');
    startIndex = paragraphRange.startIndex;
    endIndex = paragraphRange.endIndex;
  } else if ('indexWithinParagraph' in args.target) {
    const paragraphRange = await GDocsHelpers.getParagraphRange(
      docs, args.documentId, args.target.indexWithinParagraph, args.tabId,
    );
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

  const requestInfo = GDocsHelpers.buildUpdateParagraphStyleRequest(startIndex, endIndex, args.style, args.tabId);
  if (!requestInfo) return { startIndex, endIndex, fields: null };

  // Only a text or paragraph lookup has read the tab already.
  if (args.tabId && 'startIndex' in args.target) await assertTabExists(docs, args.documentId, args.tabId);
  const response = await GDocsHelpers.executeBatchUpdate(
    docs, args.documentId, [requestInfo.request], pinnedTo(args.requiredRevisionId),
  );
  return { startIndex, endIndex, fields: requestInfo.fields, revisionId: revisionAfter(response) };
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
): Promise<{
  requested: number; executed: number; typeCounts: Record<string, number>; suggested: boolean; revisionId?: string | null;
}> {
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
    return { requested: args.operations.length, executed: 0, typeCounts, suggested: Boolean(args.suggestMode) };
  }

  // Every tab named is checked once up front: Google applies an operation whose
  // tab does not exist to the first tab, so a typo would edit the wrong tab.
  const tabIds = [...new Set(args.operations.map((op) => op.tabId).filter((id): id is string => Boolean(id)))];
  if (tabIds.length > 0) await assertTabsExist(docs, args.documentId, tabIds);

  // SUGGEST applies the whole batch as tracked suggestions instead of edits. Sent
  // only when asked for: writeControl is omitted otherwise, so every existing
  // caller's request body is byte-identical to before.
  const writeControl: docs_v1.Schema$WriteControl = {
    ...(args.suggestMode ? { writeMode: 'SUGGEST' } : {}),
    ...pinnedTo(args.requiredRevisionId),
  };
  const response = await GDocsHelpers.executeBatchUpdate(
    docs,
    args.documentId,
    allRequests,
    Object.keys(writeControl).length > 0 ? writeControl : undefined,
  );
  return {
    requested: args.operations.length,
    executed: allRequests.length,
    typeCounts,
    suggested: Boolean(args.suggestMode),
    revisionId: revisionAfter(response),
  };
}

// === Tabs ===

/** Properties of a tab as Google reports them, for both surfaces to show. */
function tabSummary(props: docs_v1.Schema$TabProperties | undefined) {
  return {
    tabId: props?.tabId ?? null,
    title: props?.title ?? null,
    index: props?.index ?? null,
    parentTabId: props?.parentTabId ?? null,
    nestingLevel: props?.nestingLevel ?? 0,
    iconEmoji: props?.iconEmoji ?? null,
  };
}

function countDescendantTabs(tab: docs_v1.Schema$Tab): number {
  return (tab.childTabs ?? []).reduce((n, child) => n + 1 + countDescendantTabs(child), 0);
}

export async function performCreateDocumentTab(docs: Docs, args: CreateDocumentTabArgs) {
  // An unknown parent is checked here rather than left to Google, which treats a
  // tab id it does not know as "no tab" elsewhere in this API.
  if (args.parentTabId) await assertTabExists(docs, args.documentId, args.parentTabId);
  const tabProperties: docs_v1.Schema$TabProperties = {};
  if (args.title !== undefined) tabProperties.title = args.title;
  if (args.parentTabId !== undefined) tabProperties.parentTabId = args.parentTabId;
  if (args.index !== undefined) tabProperties.index = args.index;
  if (args.iconEmoji !== undefined) tabProperties.iconEmoji = args.iconEmoji;

  const response = await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [{ addDocumentTab: { tabProperties } }]);
  const created = response.replies?.[0]?.addDocumentTab?.tabProperties;
  if (!created?.tabId) {
    throw new Error('Google accepted the request but returned no tab ID, so the new tab cannot be confirmed. Check listDocumentTabs.');
  }
  return tabSummary(created);
}

export async function performUpdateDocumentTab(docs: Docs, args: UpdateDocumentTabArgs) {
  const tabProperties: docs_v1.Schema$TabProperties = { tabId: args.tabId };
  const fields: string[] = [];
  if (args.title !== undefined) { tabProperties.title = args.title; fields.push('title'); }
  if (args.iconEmoji !== undefined) { tabProperties.iconEmoji = args.iconEmoji; fields.push('iconEmoji'); }
  if (args.index !== undefined) { tabProperties.index = args.index; fields.push('index'); }
  if (fields.length === 0) throw new UserError('Nothing to change: give at least one of title, iconEmoji or index.');

  await assertTabExists(docs, args.documentId, args.tabId);
  await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [
    { updateDocumentTabProperties: { tabProperties, fields: fields.join(',') } },
  ]);

  // Re-read rather than echo the request: `confirmed` is true only when every
  // field now reads back as asked.
  const after = await docs.documents.get({ documentId: args.documentId, includeTabsContent: true });
  const props = GDocsHelpers.findTabById(after.data, args.tabId)?.tabProperties;
  const confirmed = Boolean(props) && fields.every((f) => (props as any)[f] === (tabProperties as any)[f]);
  return { ...tabSummary(props), updatedFields: fields, confirmed };
}

export async function performDeleteDocumentTab(docs: Docs, args: DeleteDocumentTabArgs) {
  const tab = await assertTabExists(docs, args.documentId, args.tabId);
  const childTabsDeleted = countDescendantTabs(tab);
  await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [{ deleteTab: { tabId: args.tabId } }]);

  const after = await docs.documents.get({ documentId: args.documentId, includeTabsContent: true });
  const confirmed = GDocsHelpers.findTabById(after.data, args.tabId) === null;
  return { tabId: args.tabId, title: tab.tabProperties?.title ?? null, childTabsDeleted, confirmed };
}

// === Footnotes ===

export async function performCreateFootnote(docs: Docs, args: CreateFootnoteArgs) {
  const tab = args.tabId ? { tabId: args.tabId } : {};
  if (args.tabId) await assertTabExists(docs, args.documentId, args.tabId);

  // Two writes, because the text goes into the footnote's own segment and its id
  // only exists once the first write returns.
  const created = await GDocsHelpers.executeBatchUpdate(
    docs,
    args.documentId,
    [{ createFootnote: { location: { index: args.index, ...tab } } }],
    pinnedTo(args.requiredRevisionId),
  );
  const footnoteId = created.replies?.[0]?.createFootnote?.footnoteId;
  if (!footnoteId) {
    throw new Error(`Google returned no footnote ID, so it is unknown whether a footnote reference was added at index ${args.index}. `
      + 'Read the document before retrying.');
  }

  let filled: docs_v1.Schema$BatchUpdateDocumentResponse;
  try {
    filled = await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [
      { insertText: { endOfSegmentLocation: { segmentId: footnoteId, ...tab }, text: args.text } },
    ]);
  } catch (error: any) {
    const partial = new UserError(`Footnote ${footnoteId} was created at index ${args.index}, but writing its text failed: `
      + `${error.message || error}. The empty footnote is still in the document.`);
    // Keep the upstream status, so REST answers a 403/5xx as what it was rather
    // than as the caller's 400.
    if (typeof error?.code === 'number') (partial as any).code = error.code;
    throw partial;
  }
  return { footnoteId, index: args.index, revisionId: revisionAfter(filled) };
}

// === Tables ===

/**
 * The table starting at `tableStartIndex`, read before writing so a wrong index
 * or an out-of-range cell is refused by name. Google's own answer to either is a
 * bare "Invalid requests[0]" that does not say which.
 */
async function readTable(
  docs: Docs,
  documentId: string,
  tableStartIndex: number,
  tabId: string | undefined,
): Promise<{ rows: number; columns: number }> {
  let content: docs_v1.Schema$StructuralElement[] | undefined;
  if (tabId) {
    content = (await assertTabExists(docs, documentId, tabId)).documentTab?.body?.content;
  } else {
    const res = await docs.documents.get({ documentId, fields: 'body(content(startIndex,table(rows,columns)))' });
    content = res.data.body?.content;
  }
  const tables = (content ?? []).filter((el) => el.table);
  const table = tables.find((el) => el.startIndex === tableStartIndex)?.table;
  if (!table) {
    const starts = tables.map((el) => el.startIndex).join(', ');
    throw new UserError(`No table starts at index ${tableStartIndex}${tabId ? ` in tab ${tabId}` : ''}. `
      + (starts ? `Tables start at: ${starts}.` : 'This tab has no top-level tables.')
      + ' Use inspectDocStructure to find a table\'s start index.');
  }
  return { rows: table.rows ?? 0, columns: table.columns ?? 0 };
}

function assertCellBlock(
  table: { rows: number; columns: number },
  rowIndex: number,
  columnIndex: number,
  rowSpan = 1,
  columnSpan = 1,
): void {
  if (rowIndex + rowSpan > table.rows || columnIndex + columnSpan > table.columns) {
    throw new UserError(`Cell block rows ${rowIndex}-${rowIndex + rowSpan - 1}, columns ${columnIndex}-${columnIndex + columnSpan - 1} `
      + `is outside the ${table.rows}x${table.columns} table (indices are zero-based).`);
  }
}

const pt = (magnitude: number): docs_v1.Schema$Dimension => ({ magnitude, unit: 'PT' });

function rgb(hex: string): docs_v1.Schema$OptionalColor {
  const rgbColor = hexToRgbColor(hex);
  if (!rgbColor) throw new UserError(`Invalid hex color format: ${hex}`);
  return { color: { rgbColor } };
}

export async function performModifyTableStructure(docs: Docs, args: ModifyTableStructureArgs) {
  const table = await readTable(docs, args.documentId, args.tableStartIndex, args.tabId);
  const isMerge = args.action === 'merge_cells' || args.action === 'unmerge_cells';
  const rowSpan = args.rowSpan ?? 1;
  const columnSpan = args.columnSpan ?? 1;
  assertCellBlock(table, args.rowIndex, args.columnIndex, isMerge ? rowSpan : 1, isMerge ? columnSpan : 1);
  if (args.action === 'merge_cells' && rowSpan * columnSpan < 2) {
    throw new UserError('merge_cells needs a block of at least two cells: set rowSpan and/or columnSpan.');
  }

  const tableCellLocation: docs_v1.Schema$TableCellLocation = {
    tableStartLocation: { index: args.tableStartIndex, ...(args.tabId ? { tabId: args.tabId } : {}) },
    rowIndex: args.rowIndex,
    columnIndex: args.columnIndex,
  };
  const count = args.count ?? 1;
  const repeat = (request: docs_v1.Schema$Request) => Array.from({ length: count }, () => request);

  let requests: docs_v1.Schema$Request[];
  let after = { ...table };
  switch (args.action) {
    case 'insert_rows_above':
    case 'insert_rows_below':
      requests = repeat({ insertTableRow: { tableCellLocation, insertBelow: args.action === 'insert_rows_below' } });
      after = { ...table, rows: table.rows + count };
      break;
    case 'insert_columns_left':
    case 'insert_columns_right':
      requests = repeat({ insertTableColumn: { tableCellLocation, insertRight: args.action === 'insert_columns_right' } });
      after = { ...table, columns: table.columns + count };
      break;
    case 'merge_cells':
      requests = [{ mergeTableCells: { tableRange: { tableCellLocation, rowSpan, columnSpan } } }];
      break;
    case 'unmerge_cells':
      requests = [{ unmergeTableCells: { tableRange: { tableCellLocation, rowSpan, columnSpan } } }];
      break;
  }

  const response = await GDocsHelpers.executeBatchUpdate(docs, args.documentId, requests, pinnedTo(args.requiredRevisionId));
  return {
    action: args.action,
    tableBefore: table,
    tableAfter: after,
    // Re-read rather than echo the arithmetic. Merges change no row or column
    // count, so the re-read cannot prove them: null, not true.
    confirmed: isMerge ? null : await tableHasShape(docs, args.documentId, args.tableStartIndex, args.tabId, after),
    revisionId: revisionAfter(response),
  };
}

/** Whether the table now has the expected shape; null when it cannot be re-read. */
async function tableHasShape(
  docs: Docs, documentId: string, tableStartIndex: number, tabId: string | undefined, expected: { rows: number; columns: number },
): Promise<boolean | null> {
  try {
    const now = await readTable(docs, documentId, tableStartIndex, tabId);
    return now.rows === expected.rows && now.columns === expected.columns;
  } catch {
    return null;
  }
}

export async function performDeleteTableRowOrColumn(docs: Docs, args: DeleteTableRowOrColumnArgs) {
  const table = await readTable(docs, args.documentId, args.tableStartIndex, args.tabId);
  const isRow = args.target === 'row';
  const size = isRow ? table.rows : table.columns;
  if (args.index >= size) {
    throw new UserError(`The table has ${size} ${args.target}s (indices 0-${size - 1}); there is no ${args.target} ${args.index}.`);
  }
  // Google deletes the whole table when its last row or column goes. That is a
  // different, larger edit than the one asked for, so it is refused.
  if (size === 1) {
    throw new UserError(`That is the table's only ${args.target}; deleting it would delete the whole table. `
      + 'Use deleteRange over the table if that is what you want.');
  }

  const tableCellLocation: docs_v1.Schema$TableCellLocation = {
    tableStartLocation: { index: args.tableStartIndex, ...(args.tabId ? { tabId: args.tabId } : {}) },
    rowIndex: isRow ? args.index : 0,
    columnIndex: isRow ? 0 : args.index,
  };
  const request: docs_v1.Schema$Request = isRow
    ? { deleteTableRow: { tableCellLocation } }
    : { deleteTableColumn: { tableCellLocation } };
  const response = await GDocsHelpers.executeBatchUpdate(docs, args.documentId, [request], pinnedTo(args.requiredRevisionId));
  // A merged cell spanning several rows/columns takes all of them, so "one
  // fewer" is a lower bound: confirmed only when exactly one went.
  const expected = isRow ? { rows: table.rows - 1, columns: table.columns } : { rows: table.rows, columns: table.columns - 1 };
  const confirmed = await tableHasShape(docs, args.documentId, args.tableStartIndex, args.tabId, expected);
  return { target: args.target, index: args.index, tableBefore: table, confirmed, revisionId: revisionAfter(response) };
}

export async function performFormatTableCells(docs: Docs, args: FormatTableCellsArgs) {
  const cellStyle: docs_v1.Schema$TableCellStyle = {};
  const cellFields: string[] = [];
  if (args.backgroundColor !== undefined) { cellStyle.backgroundColor = rgb(args.backgroundColor); cellFields.push('backgroundColor'); }
  if (args.contentAlignment !== undefined) { cellStyle.contentAlignment = args.contentAlignment; cellFields.push('contentAlignment'); }
  if (args.paddingPt !== undefined) {
    for (const side of ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight'] as const) {
      cellStyle[side] = pt(args.paddingPt);
      cellFields.push(side);
    }
  }
  if (args.borderColor !== undefined || args.borderWidthPt !== undefined || args.borderDashStyle !== undefined) {
    // A border is written whole, so unnamed parts get a stated default rather
    // than being reset to Google's (which may not be what the cell had).
    const border: docs_v1.Schema$TableCellBorder = {
      color: rgb(args.borderColor ?? '#000000'),
      width: pt(args.borderWidthPt ?? 1),
      dashStyle: args.borderDashStyle ?? 'SOLID',
    };
    for (const side of ['borderTop', 'borderBottom', 'borderLeft', 'borderRight'] as const) {
      cellStyle[side] = border;
      cellFields.push(side);
    }
  }
  if (cellFields.length === 0 && args.minRowHeightPt === undefined && args.columnWidthPt === undefined) {
    throw new UserError('Nothing to format: give at least one of backgroundColor, contentAlignment, paddingPt, '
      + 'borderColor/borderWidthPt/borderDashStyle, minRowHeightPt or columnWidthPt.');
  }

  const table = await readTable(docs, args.documentId, args.tableStartIndex, args.tabId);
  // Naming only a row formats that row across every column, and vice versa.
  const rowIndex = args.rowIndex ?? 0;
  const columnIndex = args.columnIndex ?? 0;
  const rowSpan = args.rowIndex === undefined ? table.rows : (args.rowSpan ?? 1);
  const columnSpan = args.columnIndex === undefined ? table.columns : (args.columnSpan ?? 1);
  assertCellBlock(table, rowIndex, columnIndex, rowSpan, columnSpan);

  const tableStartLocation: docs_v1.Schema$Location = { index: args.tableStartIndex, ...(args.tabId ? { tabId: args.tabId } : {}) };
  const span = (start: number, length: number) => Array.from({ length }, (_, i) => start + i);
  const requests: docs_v1.Schema$Request[] = [];
  if (cellFields.length > 0) {
    requests.push({
      updateTableCellStyle: {
        tableRange: { tableCellLocation: { tableStartLocation, rowIndex, columnIndex }, rowSpan, columnSpan },
        tableCellStyle: cellStyle,
        fields: cellFields.join(','),
      },
    });
  }
  if (args.minRowHeightPt !== undefined) {
    requests.push({
      updateTableRowStyle: {
        tableStartLocation,
        rowIndices: span(rowIndex, rowSpan),
        tableRowStyle: { minRowHeight: pt(args.minRowHeightPt) },
        fields: 'minRowHeight',
      },
    });
  }
  if (args.columnWidthPt !== undefined) {
    requests.push({
      updateTableColumnProperties: {
        tableStartLocation,
        columnIndices: span(columnIndex, columnSpan),
        tableColumnProperties: { widthType: 'FIXED_WIDTH', width: pt(args.columnWidthPt) },
        fields: 'width,widthType',
      },
    });
  }

  const response = await GDocsHelpers.executeBatchUpdate(docs, args.documentId, requests, pinnedTo(args.requiredRevisionId));
  return {
    cells: { rowIndex, columnIndex, rowSpan, columnSpan },
    cellStyleFields: cellFields,
    rowHeightSet: args.minRowHeightPt !== undefined,
    columnWidthSet: args.columnWidthPt !== undefined,
    revisionId: revisionAfter(response),
  };
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
  opts: { allowLocalFilesystem?: boolean } = {},
): Promise<{ index: number; resolvedImageUrl: string; uploadedToDrive: boolean }> {
  // `localImagePath` reads a file from the SERVER's filesystem, uploads it to the
  // caller's Drive and grants `anyone` reader on it. On a hosted deployment that
  // is a complete file-exfiltration primitive for anyone holding a credential —
  // /proc/self/environ, a credentials file, anything the process can read — and
  // nothing downstream checks the extension or MIME type (it falls back to
  // application/octet-stream, so any bytes go through).
  //
  // So it is refused unless the caller explicitly opts in. The MCP tool opts in
  // only in stdio mode, where the user owns the process and the file, which is
  // what its description has always claimed. The REST plane never opts in, and
  // refuses the field at the schema so the error names it.
  if (args.localImagePath && !opts.allowLocalFilesystem) {
    throw new UserError(
      'localImagePath is only accepted on a local (stdio) deployment, where the caller owns the filesystem being '
      + 'read. On a hosted deployment it would read a file from the SERVER and publish it. Use imageUrl, '
      + 'driveFileId, or imageBase64 + fileName instead.',
    );
  }
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

// === Comments and suggestions ===
//
// Every one of these is a `documents.batchUpdate` request. They used to be
// `drive.comments.*` calls, which could not anchor a comment to a range at all:
// the Drive API stores an `anchor` string the Docs editor refuses to resolve
// ("Google Workspace editor apps ... treat these comments as unanchored
// comments"), and a Drive anchor on a Doc renders the thread as "Original
// content deleted". The Docs API takes the range as a first-class field.
//
// The response is the other half of why this is better. Drive answered a
// resolve it had silently dropped with 200, so `performResolveComment` used to
// resolve-then-re-read and report whichever answer came back. batchUpdate
// reports `commentUpdateState` directly, so a write Google declined is now
// distinguishable from one it applied WITHOUT a second request.

/** Google's documented cap on a comment or reply body, in UTF-8 bytes. */
const COMMENT_CONTENT_MAX_BYTES = 2048;

/**
 * Refused locally, before the request, because the byte count is knowable here
 * and Google's rejection names neither the field nor the limit. Measured in
 * UTF-8 bytes rather than `String.length`: an emoji is one or two UTF-16 units
 * and four UTF-8 bytes, so a length check would accept bodies Google refuses.
 */
function assertCommentLength(what: string, text?: string | null): void {
  if (!text) return;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > COMMENT_CONTENT_MAX_BYTES) {
    throw new UserError(
      `${what} is ${bytes} UTF-8 bytes, over Google's ${COMMENT_CONTENT_MAX_BYTES}-byte limit for comment text. `
      + 'Shorten it, or put the detail in the document and keep the comment short.',
    );
  }
}

/** Which thread a post belongs to: a comment thread or a suggestion thread. */
type ThreadTargetArgs = { commentId?: string; suggestionId?: string };

/**
 * Google requires EXACTLY ONE of commentId / suggestionId and rejects the other
 * two cases with a 400 naming neither parameter. Refused here rather than in
 * Zod, because a Zod rejection surfaces as FastMCP's generic `InvalidParams`
 * ("Expected string, received undefined"), which is the unexplained failure
 * these messages exist to replace — the same call as ClickUp's
 * `resolveDueDateUpdate`.
 */
function threadTarget(args: ThreadTargetArgs): { commentId: string } | { suggestionId: string } {
  if (args.commentId && args.suggestionId) {
    throw new UserError(
      'Pass either commentId or suggestionId, not both: they name different threads and which one was meant '
      + 'cannot be inferred. Nothing was written.',
    );
  }
  if (args.commentId) return { commentId: args.commentId };
  if (args.suggestionId) return { suggestionId: args.suggestionId };
  throw new UserError(
    'One of commentId or suggestionId is required: commentId for a comment thread, suggestionId to post on a '
    + 'suggested edit. Get either from listComments or listSuggestions.',
  );
}

/** The id a thread-scoped result echoes back, for the message and the JSON. */
const threadLabel = (args: ThreadTargetArgs): string => args.commentId || args.suggestionId || 'unknown';

interface CommentWriteResult<T> {
  reply: T;
  /** true = Google reported it saved, false = unconfirmed. Never a silent maybe. */
  confirmed: boolean;
  /** Google's own word for it, kept so an unconfirmed result can be diagnosed. */
  commentUpdateState: string | null;
}

/**
 * Run one comment request and read Google's verdict off the response.
 *
 * `commentUpdateState` is the point. ALL_SAVED is the only value that means the
 * write happened; ALL_FAILED_UNKNOWN_REASON means Google answered 200 and
 * applied nothing, which is exactly the silent no-op the Drive path used to
 * report as success, so it THROWS rather than returning a cheerful result.
 * Anything else (NO_UPDATES_REQUESTED, the unspecified value, an older server
 * that omits the field) is reported as unconfirmed — absence of evidence is not
 * evidence, and claiming either outcome from it would be a guess.
 */
async function runCommentRequest<T>(
  docs: Docs,
  documentId: string,
  request: docs_v1.Schema$Request,
  what: string,
  pick: (reply: docs_v1.Schema$Response | undefined) => T,
): Promise<CommentWriteResult<T>> {
  const response = await GDocsHelpers.executeBatchUpdate(docs, documentId, [request]);
  const state = response.commentUpdateState ?? null;
  if (state === 'ALL_FAILED_UNKNOWN_REASON') {
    throw new UserError(
      `Google accepted the request and then reported that the ${what} was NOT applied `
      + '(commentUpdateState: ALL_FAILED_UNKNOWN_REASON). The document is unchanged. This is usually a '
      + 'permission on the document or a thread that no longer exists; retrying the identical request rarely helps.',
    );
  }
  return {
    reply: pick(response.replies?.[0]),
    confirmed: state === 'ALL_SAVED',
    commentUpdateState: state,
  };
}

export interface AddCommentResult {
  // The first six keys are the response shape the REST route has always
  // published and clients parse; `id` is now the Docs commentId rather than the
  // Drive one, which is the same field meaning a different id space.
  id: string | null;
  content: string | null;
  quotedText: string | null;
  author: string;
  createdTime: string | null;
  resolved: boolean;
  // Added by the migration. `ranges` is what the Drive path could never give.
  anchorId: string | null;
  status: string | null;
  /** What Google recorded. Null when it echoed none back, even if one was asked for. */
  assigneeEmail: string | null;
  /** What the caller asked for, so an unechoed assignment is visible but not claimed. */
  requestedAssigneeEmail: string | null;
  requestedRange: { startIndex: number; endIndex: number; tabId?: string; segmentId?: string };
  confirmed: boolean;
  commentUpdateState: string | null;
}

/**
 * Insert a comment ANCHORED to a range, which is the whole point of the move off
 * Drive: Docs highlights the text in the body instead of filing the thread as
 * unanchored.
 *
 * No document read any more. The Drive version fetched the document to assemble
 * the quoted text by hand, because quoting the range was the only record of what
 * the comment referred to; Google now records that itself as `plainTextQuote`.
 */
export async function performAddComment(docs: Docs, args: AddCommentArgs): Promise<AddCommentResult> {
  assertCommentLength('The comment text', args.commentText);

  const { reply, confirmed, commentUpdateState } = await runCommentRequest(
    docs,
    args.documentId,
    {
      insertComment: {
        content: args.commentText,
        ...(args.assigneeEmail ? { assigneeEmailAddress: args.assigneeEmail } : {}),
        range: {
          startIndex: args.startIndex,
          endIndex: args.endIndex,
          ...(args.tabId ? { tabId: args.tabId } : {}),
          ...(args.segmentId ? { segmentId: args.segmentId } : {}),
        },
      },
    },
    'comment',
    (r) => r?.insertComment?.commentThread,
  );

  const head = reply?.headPost;
  return {
    id: reply?.commentId ?? null,
    content: head?.content ?? args.commentText,
    quotedText: reply?.plainTextQuote ?? null,
    author: head?.author?.displayName || 'Unknown',
    createdTime: head?.createTime ?? null,
    resolved: reply?.status === 'RESOLVED',
    anchorId: reply?.anchorId ?? null,
    status: reply?.status ?? null,
    // ONLY what Google recorded. Falling back to args.assigneeEmail here would
    // make the response claim an assignment that may not have been applied,
    // which is the same lie as reporting an unconfirmed write as success. The
    // requested value is reported separately, like requestedRange.
    assigneeEmail: head?.assigneeEmail ?? null,
    requestedAssigneeEmail: args.assigneeEmail ?? null,
    requestedRange: {
      startIndex: args.startIndex,
      endIndex: args.endIndex,
      ...(args.tabId ? { tabId: args.tabId } : {}),
      ...(args.segmentId ? { segmentId: args.segmentId } : {}),
    },
    confirmed,
    commentUpdateState,
  };
}

export interface CommentReplyResult {
  /** Kept as `id` as well as `postId`: the Drive-era route published `id`. */
  id: string | null;
  postId: string | null;
  content: string | null;
  /** An object, not a string, because the old response shape had author.displayName. */
  author: { displayName: string; isMe: boolean };
  createdTime: string | null;
  action: string | null;
  assigneeEmail: string | null;
  confirmed: boolean;
  commentUpdateState: string | null;
}

function replyResult(
  post: docs_v1.Schema$Post | undefined,
  confirmed: boolean,
  commentUpdateState: string | null,
): CommentReplyResult {
  return {
    id: post?.postId ?? null,
    postId: post?.postId ?? null,
    content: post?.content ?? null,
    author: {
      displayName: post?.author?.displayName || (post?.author?.anonymous ? 'Anonymous' : 'Unknown'),
      isMe: Boolean(post?.author?.me),
    },
    createdTime: post?.createTime ?? null,
    action: post?.commentAction ?? null,
    assigneeEmail: post?.assigneeEmail ?? null,
    confirmed,
    commentUpdateState,
  };
}

export async function performReplyToComment(docs: Docs, args: ReplyToCommentArgs): Promise<CommentReplyResult> {
  assertCommentLength('The reply text', args.replyText);
  const target = threadTarget(args);

  const { reply, confirmed, commentUpdateState } = await runCommentRequest(
    docs,
    args.documentId,
    { addCommentReply: { ...target, post: { content: args.replyText } } },
    'reply',
    (r) => r?.addCommentReply?.post,
  );
  return replyResult(reply, confirmed, commentUpdateState);
}

/**
 * Resolving is a reply carrying `commentAction: RESOLVE`, not a field on the
 * thread — there is no update-thread-status request. `content` is optional only
 * for RESOLVE and REOPEN, which is why the note can be left out.
 */
export async function performResolveComment(
  docs: Docs,
  args: ResolveCommentArgs,
): Promise<{ commentId: string; resolved: boolean; confirmed: boolean; commentUpdateState: string | null }> {
  assertCommentLength('The closing note', args.replyText);
  const { confirmed, commentUpdateState } = await runCommentRequest(
    docs,
    args.documentId,
    {
      addCommentReply: {
        commentId: args.commentId,
        post: { commentAction: 'RESOLVE', ...(args.replyText ? { content: args.replyText } : {}) },
      },
    },
    'resolution',
    () => undefined,
  );
  return { commentId: args.commentId, resolved: confirmed, confirmed, commentUpdateState };
}

export async function performReopenComment(
  docs: Docs,
  args: ReopenCommentArgs,
): Promise<{ commentId: string; reopened: boolean; confirmed: boolean; commentUpdateState: string | null }> {
  assertCommentLength('The note', args.replyText);
  const { confirmed, commentUpdateState } = await runCommentRequest(
    docs,
    args.documentId,
    {
      addCommentReply: {
        commentId: args.commentId,
        post: { commentAction: 'REOPEN', ...(args.replyText ? { content: args.replyText } : {}) },
      },
    },
    'reopening',
    () => undefined,
  );
  return { commentId: args.commentId, reopened: confirmed, confirmed, commentUpdateState };
}

/**
 * Reassign an already-assigned thread.
 *
 * It cannot assign an UNASSIGNED one, and that is Google's rule rather than a
 * limitation of this wrapper: `assigneeEmail` on a reply "returns a 400 bad
 * request error if the parent thread is a CommentThread whose headPost does not
 * have an assignee". So the only way to create an assigned thread is
 * `addComment` with `assigneeEmail`, and a thread created without one can never
 * get one.
 *
 * The 400 is rewritten to list ALL the documented causes rather than asserting
 * one: the response does not say which applied, and guessing sends the caller to
 * fix the wrong thing (the same reasoning as the Redmine 403 wording).
 */
export async function performAssignComment(
  docs: Docs,
  args: AssignCommentArgs,
): Promise<{ commentId: string; assigneeEmail: string; assigned: boolean; confirmed: boolean; commentUpdateState: string | null }> {
  assertCommentLength('The note', args.replyText);
  try {
    const { confirmed, commentUpdateState } = await runCommentRequest(
      docs,
      args.documentId,
      {
        addCommentReply: {
          commentId: args.commentId,
          post: { assigneeEmail: args.assigneeEmail, ...(args.replyText ? { content: args.replyText } : {}) },
        },
      },
      'assignment',
      () => undefined,
    );
    return { commentId: args.commentId, assigneeEmail: args.assigneeEmail, assigned: confirmed, confirmed, commentUpdateState };
  } catch (error: any) {
    if (error?.code === 400 || error?.response?.status === 400) {
      throw new UserError(
        `Google refused to assign comment ${args.commentId}. It rejects an assignment when any of these hold, and the `
        + 'response does not say which: the thread was created WITHOUT an assignee (an unassigned thread can never be '
        + 'assigned — create it with addComment + assigneeEmail instead); the id names a suggestion thread rather than a '
        + 'comment thread; or the email address is over 2048 bytes. Nothing was written.',
      );
    }
    throw error;
  }
}

export async function performUpdateCommentPost(
  docs: Docs,
  args: UpdateCommentPostArgs,
): Promise<{ postId: string; threadId: string; content: string; updated: boolean; confirmed: boolean; commentUpdateState: string | null }> {
  assertCommentLength('The replacement text', args.content);
  const target = threadTarget(args);
  const { confirmed, commentUpdateState } = await runCommentRequest(
    docs,
    args.documentId,
    { updateCommentPost: { ...target, postId: args.postId, content: args.content } },
    'edit',
    () => undefined,
  );
  return {
    postId: args.postId,
    threadId: threadLabel(args),
    content: args.content,
    updated: confirmed,
    confirmed,
    commentUpdateState,
  };
}

export async function performDeleteComment(
  docs: Docs,
  args: DeleteCommentArgs,
): Promise<{ commentId: string; deleted: boolean; confirmed: boolean; commentUpdateState: string | null }> {
  const { confirmed, commentUpdateState } = await runCommentRequest(
    docs,
    args.documentId,
    { deleteComment: { commentId: args.commentId } },
    'deletion',
    () => undefined,
  );
  return { commentId: args.commentId, deleted: confirmed, confirmed, commentUpdateState };
}

export async function performDeleteCommentReply(
  docs: Docs,
  args: DeleteCommentReplyArgs,
): Promise<{ postId: string; threadId: string; deleted: boolean; confirmed: boolean; commentUpdateState: string | null }> {
  const target = threadTarget(args);
  const { confirmed, commentUpdateState } = await runCommentRequest(
    docs,
    args.documentId,
    { deleteCommentReply: { ...target, postId: args.postId } },
    'reply deletion',
    () => undefined,
  );
  return { postId: args.postId, threadId: threadLabel(args), deleted: confirmed, confirmed, commentUpdateState };
}

/**
 * Suggestion verdicts report through `suggestionResponses`, not
 * `commentUpdateState` — that field is documented as covering COMMENT updates,
 * so reading it here would be reading the wrong signal. Each response lists the
 * ids actually accepted / rejected / deleted, so confirmation is the id turning
 * up in the matching list; an absent list is unconfirmed, never a failure.
 */
async function runSuggestionRequest(
  docs: Docs,
  documentId: string,
  request: docs_v1.Schema$Request,
  suggestionId: string,
  field: 'acceptedSuggestionIds' | 'rejectedSuggestionIds' | 'deletedSuggestionIds',
): Promise<{ suggestionId: string; confirmed: boolean; reportedIds: string[] | null }> {
  const response = await GDocsHelpers.executeBatchUpdate(docs, documentId, [request]);
  const reported = response.suggestionResponses?.[0]?.[field] ?? null;
  return {
    suggestionId,
    confirmed: Array.isArray(reported) && reported.includes(suggestionId),
    reportedIds: reported ?? null,
  };
}

export async function performAcceptSuggestion(docs: Docs, args: AcceptSuggestionArgs) {
  return runSuggestionRequest(
    docs, args.documentId, { acceptSuggestion: { suggestionId: args.suggestionId } }, args.suggestionId, 'acceptedSuggestionIds',
  );
}

export async function performRejectSuggestion(docs: Docs, args: RejectSuggestionArgs) {
  return runSuggestionRequest(
    docs, args.documentId, { rejectSuggestion: { suggestionId: args.suggestionId } }, args.suggestionId, 'rejectedSuggestionIds',
  );
}

export async function performDeleteSuggestion(docs: Docs, args: DeleteSuggestionArgs) {
  return runSuggestionRequest(
    docs, args.documentId, { deleteSuggestion: { suggestionId: args.suggestionId } }, args.suggestionId, 'deletedSuggestionIds',
  );
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
