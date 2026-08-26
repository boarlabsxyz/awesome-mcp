// Source of truth: which Google Sheets MCP tools are read-only vs write/mutating.
//
// Generated from src/google-sheets/server.ts: every `addTool` call's `name:` appears
// here exactly once, split on that tool's `annotations.readOnlyHint`. When a tool
// is added or its hint flips, update this file in the same PR — the runbook tells
// operators to uncheck exactly WRITE_TOOLS on the readonly connector, so drift here
// silently widens what the readonly connector can mutate.

// The two SHARED tools below are hand-maintained, not derived.
//
// Every server registers them through the `registerMintRestBearerForCurl()` /
// `registerListRestEndpoints()` helpers rather than a literal `addTool` call,
// so the pattern over `src/<service>/server.ts` that produces the rest of this
// file will never find them — which is exactly how they went missing at first.
//
// `mintRestBearerForCurl` MUST stay in WRITE_TOOLS. It mints a bearer scoped to
// the USER, not to a service and not to reads: createServiceAuth resolves the
// token to a user and then looks up that user's connection per route
// (src/website/webServer.ts). A readonly connector that can still call it can
// reach WRITE endpoints on every service the account has connected, which
// defeats the entire point of the two-connector split.

export const READ_TOOLS = [
  'readSpreadsheet',
  'getSpreadsheetInfo',
  'listGoogleSheets',
  'findRowByValue',
  'readRowByField',
  'listRestEndpoints',    // shared — see note above
] as const;

export const WRITE_TOOLS = [
  'writeSpreadsheet',
  'appendSpreadsheetRows',
  'clearSpreadsheetRange',
  'addSpreadsheetSheet',
  'createSpreadsheet',
  'updateCellByFieldName',
  'batchUpdateSpreadsheet',
  'mintRestBearerForCurl',    // shared — see note above
] as const;

export const NOT_IMPLEMENTED = new Set<string>();

export type ReadTool = typeof READ_TOOLS[number];
export type WriteTool = typeof WRITE_TOOLS[number];
export type Tool = ReadTool | WriteTool;
