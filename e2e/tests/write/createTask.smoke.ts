import { test, after } from 'node:test';
import { runSmokeTest } from '../../runSmokeTest.ts';
import { outputContract } from '../../promptTemplates.ts';
import { scratchListId, cleanupScratchList } from '../../setup/clickupScratch.ts';
import { scratchMarker, scratchName } from '../../setup/scratchNaming.ts';
import { CLIENT } from '../fixtureEnv.ts';

after(async () => {
  await cleanupScratchList();
});

test(`createTask adds a task to the scratch list (${CLIENT})`, { timeout: 240_000 }, async () => {
  await runSmokeTest({
    name: 'createTask',
    service: 'clickup',
    client: CLIENT,
    mode: 'full',
    setup: async () => {
      const marker = scratchMarker('clickup');
      return {
        listId: scratchListId(),
        marker,
        taskName: scratchName(`clickup write ${marker}`),
      };
    },
    prompt: ({ listId, taskName }) =>
      [
        `Call the createTask MCP tool with listId "${listId}" and name "${taskName}".`,
        `Then call the listTasks MCP tool with listId "${listId}" and includeClosed true.`,
        outputContract('the name of every task listTasks returned, one per line'),
      ].join('\n'),
    assertions: ({ marker }) => ({
      containsBetween: ['OUTPUT_BEGIN', 'OUTPUT_END'],
      includes: [marker],
    }),
    // The task name carries the `[e2e]` prefix and lives in the scratch list,
    // so the list sweep is the teardown — no need to parse the created task's
    // id back out of the model's reply.
    teardown: async () => {
      await cleanupScratchList();
    },
  });
});
