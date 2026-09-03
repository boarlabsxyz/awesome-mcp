import { test, after } from 'node:test';
import { runSmokeTest } from '../../runSmokeTest.ts';
import { outputContract } from '../../promptTemplates.ts';
import { createScratchDoc, trashFile, cleanupScratchFolder } from '../../setup/scratchFactory.ts';
import { scratchMarker } from '../../setup/scratchNaming.ts';
import { CLIENT } from '../fixtureEnv.ts';

after(async () => {
  // Safety net: trash anything per-test teardown missed. Cheap, idempotent.
  await cleanupScratchFolder();
});

test(`appendToGoogleDoc writes a marker to a scratch doc (${CLIENT})`, { timeout: 240_000 }, async () => {
  await runSmokeTest({
    name: 'appendToGoogleDoc',
    service: 'google-docs',
    client: CLIENT,
    mode: 'full',
    setup: async () => {
      const docId = await createScratchDoc('append smoke', 'initial content');
      return { docId, marker: scratchMarker('append') };
    },
    prompt: ({ docId, marker }) =>
      [
        `Call the appendToGoogleDoc MCP tool with documentId "${docId}" and text "${marker}".`,
        `Then call the readGoogleDoc MCP tool with documentId "${docId}" and format "text".`,
        outputContract('verbatim text of the doc after appending'),
      ].join('\n'),
    assertions: ({ marker }) => ({
      containsBetween: ['OUTPUT_BEGIN', 'OUTPUT_END'],
      includes: ['initial content', marker],
    }),
    teardown: async ({ docId }) => {
      await trashFile(docId);
    },
  });
});
