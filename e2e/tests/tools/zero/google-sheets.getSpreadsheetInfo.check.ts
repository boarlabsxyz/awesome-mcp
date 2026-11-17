import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// A well-formed spreadsheet ID that names nothing. The zero shape for a
// get-by-id tool is the not-found answer, not an empty spreadsheet: a fresh
// spreadsheet is never empty to this tool -- it always has one tab and a 1000x26
// grid -- so it would only re-run the needle's format against less data, and
// would cost a scratch file to do it.
//
// Google answers 404, which getSpreadsheetMetadata maps to the sentence below
// (src/google-sheets/apiHelpers.ts:243-244); production shows it reaching
// callers verbatim. Worth pinning: the 403 branch beside it says "Permission
// denied", and a caller told that goes to fix sharing on a file that does not
// exist.
//
// 44 characters of the ID alphabet, like a real one, so Google sees an ID it
// could have issued rather than rejecting the shape.
const NONEXISTENT_ID = '1zzzNoSuchSpreadsheetzzz9f3a1c7b000000000000';

const env = serviceEnv('google-sheets');

test('getSpreadsheetInfo says a nonexistent spreadsheet was not found', { timeout: 30_000, skip: env.skip }, async () => {
  await runToolCheck({
    tool: 'getSpreadsheetInfo',
    service: 'google-sheets',
    account: 'sandbox',
    shape: 'zero',
    args: { spreadsheetId: NONEXISTENT_ID },
    expectToolError: true,
    invariants: {
      includes: [`Spreadsheet not found (ID: ${NONEXISTENT_ID}). Check the ID.`],
      excludes: ['Permission denied', 'Failed to get spreadsheet', 'undefined', '    at '],
    },
  });
});
