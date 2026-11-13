import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';
import { trashFile } from '../../../setup/docsScratch.ts';
import { createScratchSpreadsheet } from '../../../setup/sheetsScratch.ts';

// Reading cells that hold nothing, in a spreadsheet created for the purpose.
// Google answers with no `values` at all, and the handler turns that into one
// sentence, asserted verbatim from src/google-sheets/server.ts:228. Pinned
// because it is the whole empty-state contract: anything else -- "Row 1: []",
// a header over nothing, "undefined" -- reads to a caller like data or a fault.
//
// writes: true because setup creates a file, so it must resolve sandbox
// credentials (same as zero/readGoogleDoc.check.ts). The range is unqualified
// because the first tab's name is locale-dependent (setup/sheetsScratch.ts).

const env = serviceEnv('google-sheets');

test('readSpreadsheet says an empty range is empty, and does not read as an error', { timeout: 60_000, skip: env.skip }, async () => {
  await runToolCheck<{ spreadsheetId: string }>({
    tool: 'readSpreadsheet',
    service: 'google-sheets',
    account: 'sandbox',
    shape: 'zero',
    writes: true,
    setup: async (c) => ({ spreadsheetId: await createScratchSpreadsheet(c.mcp, 'readSpreadsheet-zero') }),
    args: ({ spreadsheetId }) => ({ spreadsheetId, range: 'A1:B2' }),
    invariants: {
      includes: ['Range A1:B2 is empty or does not exist.'],
      excludes: ['Row 1:', '**Spreadsheet Range:**', 'Failed to read', 'undefined'],
    },
    teardown: async (c, { spreadsheetId }) => trashFile(await c.service('google-drive'), spreadsheetId),
  });
});

// The production failure behind most of readSpreadsheet's error rate (admin
// listTopErrors, 30 days to 2026-11-06): ranges naming a tab the spreadsheet does
// not have -- 'Payslip 2026'!A1:P12, Benefits_report!A1:H40, 'September '!A1:B2
// with a trailing space -- each retried 6-7 times with a different row extent.
// Quoted and unquoted names fail alike, so quoting is not the cause.
//
// Google answers 400 "Unable to parse range: <range>", and readRange passes that
// through as "Failed to read range: Unable to parse range: ..."
// (src/google-sheets/apiHelpers.ts:107). It never says the TAB is unknown, nor
// which tabs exist, so the model changes the cell extent instead of the tab name.
// Flip to a real check (scratch spreadsheet, range 'zzz-no-such-tab-9f3a1c7b'!A1:B2,
// expectToolError, assert the message names the tab as missing and lists the
// real ones) in the commit that teaches readRange to say so.
test(
  'readSpreadsheet says when a range names a tab that does not exist',
  { todo: 'apiHelpers.ts:107 surfaces Google\'s "Unable to parse range" for an unknown tab without saying the tab is missing or listing the tabs that exist' },
  () => {},
);
