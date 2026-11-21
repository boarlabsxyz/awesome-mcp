// Creates the throwaway spreadsheets that Sheets write and zero-state checks run
// against. Same contract as docsScratch.ts -- setup goes through the MCP tools,
// and every file is named by `scratchTitle()` so it is run-scoped and self-dating
// -- and the file is trashed with the same drive `deleteFile` (`trashFile`).
//
// One difference from scratch docs: the spreadsheet is created on the SHEETS
// server (createSpreadsheet), because the drive server has no spreadsheet create.
// Removal still goes through drive, so a check needs both clients.
//
// A spreadsheet leaked by a run that died before its teardown is swept like a
// doc: sweepScratch searches all of Drive by the scratchTitle() prefix, so keep
// using it -- an unstamped title is never swept.

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
export async function createScratchSpreadsheet(
  clients: { sheets: McpClient; drive: McpClient },
  tool: string,
): Promise<string> {
  // Removal is on another server. Reach it before creating anything, so a
  // missing or broken drive connection fails setup instead of leaving a file
  // that teardown cannot trash. (It proves the endpoint answers and registers
  // deleteFile; Drive permission is the same Google grant that creates the file.)
  if (!(await clients.drive.listTools()).includes('deleteFile')) {
    throw new Error(
      `The sandbox drive server (${clients.drive.describe()}) has no deleteFile tool, so a scratch ` +
        'spreadsheet could not be trashed. Not creating one.',
    );
  }
  const sheets = clients.sheets;
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
