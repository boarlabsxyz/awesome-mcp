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
// strings-only would reject this call before it reached Google. The marker is
// a formula on purpose: RAW stores it as the literal "=1+1", USER_ENTERED would
// evaluate it to 2, so a tool that drops valueInputOption reads back wrong.
//
// It writes to B2:C2, not A1: a tool that ignored the range and wrote at the
// origin would leave B2:C2 empty, which A1 could never show.
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
      marker: '=1+1',
      spreadsheetId: await createScratchSpreadsheet({ sheets: c.mcp, drive: await c.service('google-drive') }, 'writeSpreadsheet-zero'),
    }),
    args: ({ spreadsheetId, marker }) => ({
      spreadsheetId,
      range: 'B2:C2',
      values: [[marker, 42]],
      valueInputOption: 'RAW',
    }),
    readback: async (c, { spreadsheetId }) =>
      (await c.mcp.callTool('readSpreadsheet', { spreadsheetId, range: 'B2:C2' })).text,
    invariants: ({ marker }) => ({
      // Row format from readSpreadsheet: `Row ${index + 1}: ${JSON.stringify(row)}`
      // (src/google-sheets/server.ts), numbered within the range read, so B2 is
      // Row 1. Asserting the whole row pins the position: a value one cell off
      // reads back as ["", "=1+1"] or not at all. FORMATTED_VALUE renders the
      // number as "42".
      includes: ['**Spreadsheet Range:** B2:C2', `Row 1: ${JSON.stringify([marker, '42'])}`],
      excludes: ['is empty or does not exist'],
      transportSafe: true,
    }),
    teardown: async (c, { spreadsheetId }) => trashFile(await c.service('google-drive'), spreadsheetId),
  });
});
