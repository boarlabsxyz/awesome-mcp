// Source of truth: which Google Docs MCP tools are read-only vs write/mutating.
//
// The runbook references WRITE_TOOLS as the list of tools to UNCHECK on the
// awesome-mcp-readonly connector's Tools panel in Claude Desktop. Keep these
// arrays in sync with src/google-docs/server.ts (every `name:` in an addTool
// call should appear here once).
//
// Tools marked NOT_IMPLEMENTED are listed in the WRITE column for safety but
// CLAUDE.md notes they don't fully work — skip them when generating regression
// cases.

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

export const NOT_IMPLEMENTED = new Set<string>([
  'editTableCell',
  'fixListFormatting',
]);

export type ReadTool = typeof READ_TOOLS[number];
export type WriteTool = typeof WRITE_TOOLS[number];
export type Tool = ReadTool | WriteTool;
