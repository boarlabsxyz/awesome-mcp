import { test, after } from 'node:test';
import { runSmokeTest } from '../../runSmokeTest.ts';
import { outputContract } from '../../promptTemplates.ts';
import {
  scratchRecipient,
  findScratchDraftIds,
  deleteDraft,
  cleanupScratchMail,
} from '../../setup/gmailScratch.ts';
import { scratchMarker, scratchName } from '../../setup/scratchNaming.ts';
import { CLIENT } from '../fixtureEnv.ts';

after(async () => {
  await cleanupScratchMail();
});

// draftEmail, not sendEmail: a draft is fully reversible, so a missed teardown
// leaves litter in the write account rather than mail in a real inbox.
test(`draftEmail creates a retrievable draft (${CLIENT})`, { timeout: 240_000 }, async () => {
  await runSmokeTest({
    name: 'draftEmail',
    service: 'google-gmail',
    client: CLIENT,
    mode: 'full',
    setup: async () => {
      const marker = scratchMarker('gmail');
      return {
        to: await scratchRecipient(),
        marker,
        subject: scratchName(`gmail write ${marker}`),
      };
    },
    prompt: ({ to, subject, marker }) =>
      [
        `Call the draftEmail MCP tool with to "${to}", subject "${subject}", and body "${marker}".`,
        `Then call the searchEmails MCP tool with query "in:draft ${marker}" and maxResults 10.`,
        outputContract('the subject line of every message searchEmails returned, one per line'),
      ].join('\n'),
    assertions: ({ marker }) => ({
      containsBetween: ['OUTPUT_BEGIN', 'OUTPUT_END'],
      includes: [marker],
    }),
    teardown: async ({ marker }) => {
      for (const draftId of await findScratchDraftIds(marker)) {
        await deleteDraft(draftId);
      }
    },
  });
});
