// Source of truth: which Google Sheets MCP tools are read-only vs write/mutating.
//
// Generated from src/google-sheets/server.ts: every `addTool` call's `name:` appears
// here exactly once, split on that tool's `annotations.readOnlyHint`. When a tool
// is added or its hint flips, update this file in the same PR — the runbook tells
// operators to uncheck exactly WRITE_TOOLS on the readonly connector, so drift here
// silently widens what the readonly connector can mutate.

export const READ_TOOLS = [
  'readSpreadsheet',
  'getSpreadsheetInfo',
  'listGoogleSheets',
  'findRowByValue',
  'readRowByField',
] as const;

export const WRITE_TOOLS = [
  'writeSpreadsheet',
  'appendSpreadsheetRows',
  'clearSpreadsheetRange',
  'addSpreadsheetSheet',
  'createSpreadsheet',
  'updateCellByFieldName',
  'batchUpdateSpreadsheet',
] as const;

export const NOT_IMPLEMENTED = new Set<string>();

export type ReadTool = typeof READ_TOOLS[number];
export type WriteTool = typeof WRITE_TOOLS[number];
export type Tool = ReadTool | WriteTool;
