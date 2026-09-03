import { test } from 'node:test';
import { runSmokeTest } from '../../runSmokeTest.ts';
import { outputContract } from '../../promptTemplates.ts';
import { CLIENT, fixtureEnv } from '../fixtureEnv.ts';

const FIXTURE_PRESENTATION_ID = fixtureEnv('E2E_FIXTURE_SLIDES_ID', 'google-slides');
const FIXTURE_NEEDLE = fixtureEnv('E2E_FIXTURE_SLIDES_NEEDLE', 'google-slides');

test(`getPresentation returns fixture slide text (${CLIENT})`, { timeout: 180_000 }, async () => {
  await runSmokeTest({
    name: 'getPresentation',
    service: 'google-slides',
    client: CLIENT,
    mode: 'readonly',
    prompt: [
      `Call the getPresentation MCP tool with presentationId "${FIXTURE_PRESENTATION_ID}".`,
      outputContract('the verbatim text content of every slide, one slide per line'),
    ].join('\n'),
    assertions: {
      containsBetween: ['OUTPUT_BEGIN', 'OUTPUT_END'],
      includes: [FIXTURE_NEEDLE],
    },
  });
});
