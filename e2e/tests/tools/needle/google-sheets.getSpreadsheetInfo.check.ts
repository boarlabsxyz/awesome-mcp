import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// The fixture spreadsheet's metadata: title, ID and the tab the other Sheets
// needle checks read from. Line formats are copied from the handler
// (src/google-sheets/server.ts:347-355). The ID is asserted twice -- on its own
// line and inside the URL built from it -- because a title match alone is also
// satisfied by a second spreadsheet someone named the same thing, and the tab
// line is what tells a caller which name to put in a range.

const env = serviceEnv('google-sheets', [
  'E2E_FIXTURE_SHEET_ID',
  'E2E_FIXTURE_SHEET_TITLE',
  'E2E_FIXTURE_SHEET_TAB',
]);

test('getSpreadsheetInfo returns the fixture spreadsheet title, ID and tab', { timeout: 30_000, skip: env.skip }, async () => {
  const SHEET_ID = env.get('E2E_FIXTURE_SHEET_ID');
  const TITLE = env.get('E2E_FIXTURE_SHEET_TITLE');
  const TAB = env.get('E2E_FIXTURE_SHEET_TAB');

  await runToolCheck({
    tool: 'getSpreadsheetInfo',
    service: 'google-sheets',
    account: 'fixture',
    shape: 'needle',
    args: { spreadsheetId: SHEET_ID },
    invariants: {
      includes: [
        `**Title:** ${TITLE}\n`,
        `**ID:** ${SHEET_ID}\n`,
        `**URL:** https://docs.google.com/spreadsheets/d/${SHEET_ID}\n`,
        `. **${TAB}**\n`,
      ],
      matches: [/\*\*Sheets \(\d+\):\*\*/],
      excludes: ['undefined'],
      transportSafe: true,
    },
  });
});
