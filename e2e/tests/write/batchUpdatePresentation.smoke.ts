import { test, after } from 'node:test';
import { runSmokeTest } from '../../runSmokeTest.ts';
import { outputContract } from '../../promptTemplates.ts';
import {
  createScratchPresentation,
  trashFile,
  cleanupScratchFolder,
} from '../../setup/scratchFactory.ts';
import { scratchMarker } from '../../setup/scratchNaming.ts';
import { CLIENT } from '../fixtureEnv.ts';

after(async () => {
  await cleanupScratchFolder();
});

test(`batchUpdatePresentation adds a slide to a scratch deck (${CLIENT})`, { timeout: 240_000 }, async () => {
  await runSmokeTest({
    name: 'batchUpdatePresentation',
    service: 'google-slides',
    client: CLIENT,
    mode: 'full',
    setup: async () => {
      const presentationId = await createScratchPresentation('slides write smoke');
      // Caller-supplied objectIds must match [a-zA-Z0-9_-]{5,50}; the marker
      // shape (BANANA-SLIDES-<epoch ms>) already satisfies that, which lets the
      // assertion key off the round-tripped id rather than slide body text.
      return { presentationId, marker: scratchMarker('slides') };
    },
    prompt: ({ presentationId, marker }) =>
      [
        `Call the batchUpdatePresentation MCP tool with presentationId "${presentationId}" ` +
          `and requests [{"createSlide": {"objectId": "${marker}"}}].`,
        `Then call the getPresentation MCP tool with presentationId "${presentationId}".`,
        outputContract('the objectId of every slide getPresentation returned, one per line'),
      ].join('\n'),
    assertions: ({ marker }) => ({
      containsBetween: ['OUTPUT_BEGIN', 'OUTPUT_END'],
      includes: [marker],
    }),
    teardown: async ({ presentationId }) => {
      await trashFile(presentationId);
    },
  });
});
