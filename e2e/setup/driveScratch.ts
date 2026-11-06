// Scratch Drive folders, for the checks that need a container rather than a
// document. Removal goes through trashFile in docsScratch.ts -- deleteFile takes
// any file ID, folders included -- so there is one trash path, not two.
//
// KNOWN GAP: sweepScratch (docsScratch.ts) finds leftovers with listGoogleDocs,
// which only returns Docs, so a folder leaked by a run that died before its
// teardown is never swept. It is self-dated by scratchTitle() so a sweeper that
// lists folders can pick it up later; until then, putting it under
// E2E_SANDBOX_FOLDER_ID keeps any leak in one place.

import { explainToolError } from '../accounts.ts';
import type { McpClient } from '../transports/mcpHttp.ts';
import { scratchTitle } from './docsScratch.ts';

/** Create an empty scratch folder on the drive server and return its ID. */
export async function createScratchFolder(drive: McpClient, tool: string): Promise<string> {
  const args: Record<string, unknown> = { name: scratchTitle(tool) };
  const parentFolderId = process.env.E2E_SANDBOX_FOLDER_ID;
  if (parentFolderId) args.parentFolderId = parentFolderId;

  const created = await drive.callTool('createFolder', args);
  if (created.isError) throw new Error(explainToolError('sandbox', 'createFolder', created.text));

  // handleCreateFolder: `Successfully created folder "<name>" (ID: <id>)...`
  const id = created.text.match(/\(ID: ([^)]+)\)/)?.[1];
  if (!id) throw new Error(`Could not parse a folder ID out of createFolder's reply: ${created.text}`);
  return id;
}
