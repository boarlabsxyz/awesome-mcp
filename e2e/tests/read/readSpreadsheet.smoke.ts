import { test } from 'node:test';
import { runSmokeTest } from '../../runSmokeTest.ts';
import { outputContract } from '../../promptTemplates.ts';
import { CLIENT, fixtureEnv } from '../fixtureEnv.ts';

const FIXTURE_SHEET_ID = fixtureEnv('E2E_FIXTURE_SHEET_ID', 'google-sheets');
const FIXTURE_NEEDLE = fixtureEnv('E2E_FIXTURE_SHEET_NEEDLE', 'google-sheets');
// `||`, not `??`: an unconfigured GHA `vars.*` arrives as '' , not undefined.
const FIXTURE_RANGE = process.env.E2E_FIXTURE_SHEET_RANGE || 'A1:C10';

test(`readSpreadsheet returns fixture cells (${CLIENT})`, { timeout: 180_000 }, async () => {
  await runSmokeTest({
    name: 'readSpreadsheet',
    service: 'google-sheets',
    client: CLIENT,
    mode: 'readonly',
    prompt: [
      `Call the readSpreadsheet MCP tool with spreadsheetId "${FIXTURE_SHEET_ID}" ` +
        `and range "${FIXTURE_RANGE}".`,
      outputContract('the verbatim cell values the tool returned, one row per line'),
    ].join('\n'),
    assertions: {
      containsBetween: ['OUTPUT_BEGIN', 'OUTPUT_END'],
      includes: [FIXTURE_NEEDLE],
    },
  });
});
