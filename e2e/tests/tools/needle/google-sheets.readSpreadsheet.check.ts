import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// The frozen fixture cell, read through a QUOTED tab name with a space in it --
// 'Smoke Data'!A1:B2, not A1:B2. Tab-qualified ranges are where readSpreadsheet
// fails in production (see the todo in zero/google-sheets.readSpreadsheet.check.ts):
// this pins that the quoted form itself works, so when the unknown-tab case is
// fixed a regression in plain quoting cannot hide behind it.
//
// The handler passes the range to Google untouched and echoes it back in its
// header (src/google-sheets/server.ts:231), and prints each row as
// `Row ${n}: ${JSON.stringify(row)}` (server.ts:233). The output carries no
// spreadsheet ID, so the needle sits in A1 and is asserted as the first cell of
// Row 1 -- a needle that merely appears somewhere in the tab would not pass.

const env = serviceEnv('google-sheets', [
  'E2E_FIXTURE_SHEET_ID',
  'E2E_FIXTURE_SHEET_TAB',
  'E2E_FIXTURE_SHEET_NEEDLE',
]);

test('readSpreadsheet returns the frozen fixture cell through a quoted tab name', { timeout: 30_000, skip: env.skip }, async () => {
  const SHEET_ID = env.get('E2E_FIXTURE_SHEET_ID');
  const TAB = env.get('E2E_FIXTURE_SHEET_TAB');
  const NEEDLE = env.get('E2E_FIXTURE_SHEET_NEEDLE');

  // Without a space the quotes are optional and this check would prove nothing
  // the unqualified form does not. An apostrophe would need doubling ('') in A1
  // notation, which this check does not do.
  if (!TAB.includes(' ') || TAB.includes("'")) {
    throw new Error(
      `E2E_FIXTURE_SHEET_TAB must name a tab with a space and no apostrophe (e.g. "Smoke Data"), got ${JSON.stringify(TAB)}.`,
    );
  }
  const range = `'${TAB}'!A1:B2`;

  await runToolCheck({
    tool: 'readSpreadsheet',
    service: 'google-sheets',
    account: 'fixture',
    shape: 'needle',
    args: { spreadsheetId: SHEET_ID, range },
    invariants: {
      includes: [`**Spreadsheet Range:** ${range}`, `Row 1: [${JSON.stringify(NEEDLE)}`],
      excludes: ['is empty or does not exist'],
      transportSafe: true,
    },
  });
});
