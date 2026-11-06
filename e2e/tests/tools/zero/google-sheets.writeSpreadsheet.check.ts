import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';
import { trashFile } from '../../../setup/docsScratch.ts';
import { createScratchSpreadsheet } from '../../../setup/sheetsScratch.ts';

// Writing into a spreadsheet that has never held anything, read back with
// readSpreadsheet rather than trusting writeSpreadsheet's own "Successfully wrote
// N cells" -- that sentence is built from Google's update counts and says nothing
// about WHERE the values landed.
//
// The row is a string and a number on purpose: the schema takes numbers,
// booleans and nulls as cells (src/google-sheets/CLAUDE.md), and a regression to
// strings-only would reject this call before it reached Google. RAW keeps the
// marker from being parsed as a formula or a date.
//
// The ranges are unqualified: Drive names a new spreadsheet's first tab in the
// account's locale, so `Sheet1!` is only right for English (setup/sheetsScratch.ts).

const env = serviceEnv('google-sheets');

test('writeSpreadsheet writes into an empty spreadsheet at the requested cell', { timeout: 90_000, skip: env.skip }, async () => {
  await runToolCheck<{ spreadsheetId: string; marker: string }>({
    tool: 'writeSpreadsheet',
    service: 'google-sheets',
    account: 'sandbox',
    shape: 'zero',
    writes: true,
    setup: async (c) => ({
      marker: `SHEET-WRITE-ZERO-${Date.now()}`,
      spreadsheetId: await createScratchSpreadsheet(c.mcp, 'writeSpreadsheet-zero'),
    }),
    args: ({ spreadsheetId, marker }) => ({
      spreadsheetId,
      range: 'A1:B1',
      values: [[marker, 42]],
      valueInputOption: 'RAW',
    }),
    readback: async (c, { spreadsheetId }) =>
      (await c.mcp.callTool('readSpreadsheet', { spreadsheetId, range: 'A1:B2' })).text,
    invariants: ({ marker }) => ({
      // Row format from readSpreadsheet: `Row ${index + 1}: ${JSON.stringify(row)}`
      // (src/google-sheets/server.ts:233). Asserting the whole row pins the
      // position too -- a marker that landed in A2 reads back as Row 2, and one
      // in B1 as ["", "<marker>"]. FORMATTED_VALUE renders the number as "42".
      includes: ['**Spreadsheet Range:** A1:B2', `Row 1: ${JSON.stringify([marker, '42'])}`],
      excludes: ['Row 2:', 'is empty or does not exist'],
      transportSafe: true,
    }),
    teardown: async (c, { spreadsheetId }) => trashFile(await c.service('google-drive'), spreadsheetId),
  });
});
