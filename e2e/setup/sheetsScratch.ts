// Creates the throwaway spreadsheets that Sheets write and zero-state checks run
// against. Same contract as docsScratch.ts -- setup goes through the MCP tools,
// and every file is named by `scratchTitle()` so it is run-scoped and self-dating
// -- and the file is trashed with the same drive `deleteFile` (`trashFile`).
//
// One difference from scratch docs: the spreadsheet is created on the SHEETS
// server (createSpreadsheet), because the drive server has no spreadsheet create.
// Removal still goes through drive, so a check needs both clients.
//
// NOT SWEPT YET. `sweepScratch` lists with `listGoogleDocs`, which only returns
// Google Docs, so a scratch spreadsheet leaked by a run that died before its
// teardown stays in the sandbox Drive. Until the sweeper also lists spreadsheets
// (listGoogleSheets on the sheets server), a leak here is permanent -- and the
// title prefix is what a future sweep will date it by, so keep using it.

import { explainToolError } from '../accounts.ts';
import type { McpClient } from '../transports/mcpHttp.ts';
import { scratchTitle } from './docsScratch.ts';

/**
 * Create an empty scratch spreadsheet and return its ID.
 *
 * Deliberately no `initialData`: createSpreadsheet reports a failed seed only in
 * the prose of a successful reply ("Spreadsheet created but failed to add
 * initial data", src/google-sheets/server.ts), the same trap createDocument's
 * `initialContent` set for scratch docs. A check that needs content writes it
 * itself and reads it back.
 *
 * Ranges against the result should be unqualified (`A1:B2`). Drive names the
 * first tab in the account's locale -- "Sheet1" only for English -- so a
 * hard-coded `Sheet1!` is a locale bug waiting for the sandbox account.
 */
export async function createScratchSpreadsheet(sheets: McpClient, tool: string): Promise<string> {
  const args: Record<string, unknown> = { title: scratchTitle(tool) };
  const parentFolderId = process.env.E2E_SANDBOX_FOLDER_ID;
  if (parentFolderId) args.parentFolderId = parentFolderId;

  const created = await sheets.callTool('createSpreadsheet', args);
  if (created.isError) throw new Error(explainToolError('sandbox', 'createSpreadsheet', created.text));

  // "Successfully created spreadsheet "<title>" (ID: <id>)..." -- server.ts createSpreadsheet.
  const id = created.text.match(/\(ID: ([^)]+)\)/)?.[1];
  if (!id) throw new Error(`Could not parse a spreadsheet ID out of createSpreadsheet's reply: ${created.text}`);
  return id;
}
