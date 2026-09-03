import { test, after } from 'node:test';
import { runSmokeTest } from '../../runSmokeTest.ts';
import { outputContract } from '../../promptTemplates.ts';
import { createScratchSheet, trashFile, cleanupScratchFolder } from '../../setup/scratchFactory.ts';
import { scratchMarker } from '../../setup/scratchNaming.ts';
import { CLIENT } from '../fixtureEnv.ts';

after(async () => {
  await cleanupScratchFolder();
});

test(`appendSpreadsheetRows appends a row to a scratch sheet (${CLIENT})`, { timeout: 240_000 }, async () => {
  await runSmokeTest({
    name: 'appendSpreadsheetRows',
    service: 'google-sheets',
    client: CLIENT,
    mode: 'full',
    setup: async () => {
      const spreadsheetId = await createScratchSheet('append rows smoke', [
        ['header-a', 'header-b'],
        ['seed-row', 'seed-value'],
      ]);
      return { spreadsheetId, marker: scratchMarker('sheets') };
    },
    prompt: ({ spreadsheetId, marker }) =>
      [
        `Call the appendSpreadsheetRows MCP tool with spreadsheetId "${spreadsheetId}", ` +
          `range "A1", valueInputOption "RAW", and values [["${marker}", "appended"]].`,
        `Then call the readSpreadsheet MCP tool with spreadsheetId "${spreadsheetId}" and range "A1:B10".`,
        outputContract('the verbatim cell values readSpreadsheet returned, one row per line'),
      ].join('\n'),
    assertions: ({ marker }) => ({
      containsBetween: ['OUTPUT_BEGIN', 'OUTPUT_END'],
      includes: ['seed-row', marker],
    }),
    teardown: async ({ spreadsheetId }) => {
      await trashFile(spreadsheetId);
    },
  });
});
