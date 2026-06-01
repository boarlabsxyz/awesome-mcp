import { test, after } from 'node:test';
import { runSmokeTest } from '../../runSmokeTest.ts';
import { preface } from '../../promptTemplates.ts';
import { createScratchDoc, trashFile, cleanupScratchFolder } from '../../setup/scratchFactory.ts';
import type { ClientName } from '../../drivers/driver.ts';

const CLIENT = (process.env.CLIENT ?? 'claude-desktop') as ClientName;

after(async () => {
  // Safety net: trash anything per-test teardown missed. Cheap, idempotent.
  await cleanupScratchFolder();
});

test(`appendToGoogleDoc writes a marker to a scratch doc (${CLIENT})`, { timeout: 240_000 }, async () => {
  await runSmokeTest({
    name: 'appendToGoogleDoc',
    client: CLIENT,
    mode: 'full',
    setup: async () => {
      const docId = await createScratchDoc('append smoke', 'initial content');
      const marker = `BANANA-APPEND-${Date.now()}`;
      return { docId, marker };
    },
    prompt: ({ docId, marker }) =>
      [
        preface('full') +
          `Call the appendToGoogleDoc MCP tool with documentId "${docId}" and text "${marker}".`,
        `Then call the readGoogleDoc MCP tool with documentId "${docId}" and format "text".`,
        'Reply with exactly this format and nothing else:',
        'OUTPUT_BEGIN<verbatim text of the doc after appending>OUTPUT_END',
        'Do not paraphrase, summarize, or add commentary. Do not use markdown formatting.',
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
