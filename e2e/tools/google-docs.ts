// Source of truth: which Google Docs MCP tools are read-only vs write/mutating.
//
// Generated from src/google-docs/server.ts: every `addTool` call's `name:` appears
// here exactly once, split on that tool's `annotations.readOnlyHint`. When a tool
// is added or its hint flips, update this file in the same PR — the runbook tells
// operators to uncheck exactly WRITE_TOOLS on the readonly connector, so drift here
// silently widens what the readonly connector can mutate.

export const READ_TOOLS = [
  'listGoogleDocs',
  'searchGoogleDocs',
  'getRecentGoogleDocs',
  'readGoogleDoc',
  'listDocumentTabs',
  'listComments',
  'getComment',
  'findElement',
  'inspectDocStructure',
] as const;

export const WRITE_TOOLS = [
  'exportDocToPdf',        // creates a PDF file in Drive
  'appendToGoogleDoc',
  'insertText',
  'deleteRange',
  'applyTextStyle',
  'applyParagraphStyle',
  'insertTable',
  'editTableCell',         // NOT_IMPLEMENTED — block anyway
  'insertPageBreak',
  'insertImageFromUrl',
  'insertLocalImage',
  'fixListFormatting',     // NOT_IMPLEMENTED — block anyway
  'addComment',
  'replyToComment',
  'resolveComment',
  'deleteComment',
  'formatMatchingText',
  'findAndReplace',
  'importDocx',
  'batchUpdateDoc',
  'importToGoogleDoc',
] as const;

// Listed in WRITE_TOOLS for safety, but the server implementation is a stub —
// skip these when generating regression cases.
export const NOT_IMPLEMENTED = new Set<string>([
  'editTableCell',
  'fixListFormatting',
]);

export type ReadTool = typeof READ_TOOLS[number];
export type WriteTool = typeof WRITE_TOOLS[number];
export type Tool = ReadTool | WriteTool;
