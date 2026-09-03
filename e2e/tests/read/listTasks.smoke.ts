import { test } from 'node:test';
import { runSmokeTest } from '../../runSmokeTest.ts';
import { outputContract } from '../../promptTemplates.ts';
import { CLIENT, fixtureEnv } from '../fixtureEnv.ts';

// A read-only ClickUp list in the test workspace, pre-seeded with fixture
// tasks. Distinct from E2E_CLICKUP_SCRATCH_LIST_ID, which write tests mutate.
const FIXTURE_LIST_ID = fixtureEnv('E2E_FIXTURE_CLICKUP_LIST_ID', 'clickup');
const FIXTURE_NEEDLE = fixtureEnv('E2E_FIXTURE_CLICKUP_NEEDLE', 'clickup');

test(`listTasks returns fixture tasks (${CLIENT})`, { timeout: 180_000 }, async () => {
  await runSmokeTest({
    name: 'listTasks',
    service: 'clickup',
    client: CLIENT,
    mode: 'readonly',
    prompt: [
      `Call the listTasks MCP tool with listId "${FIXTURE_LIST_ID}" and includeClosed true.`,
      outputContract('the name of every task the tool returned, one per line'),
    ].join('\n'),
    assertions: {
      containsBetween: ['OUTPUT_BEGIN', 'OUTPUT_END'],
      includes: [FIXTURE_NEEDLE],
    },
  });
});
