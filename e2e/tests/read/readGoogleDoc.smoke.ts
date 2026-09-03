import { test } from 'node:test';
import { runSmokeTest } from '../../runSmokeTest.ts';
import { outputContract } from '../../promptTemplates.ts';
import { CLIENT, fixtureEnv } from '../fixtureEnv.ts';

const FIXTURE_DOC_ID = fixtureEnv('E2E_FIXTURE_DOC_ID', 'google-docs');
const FIXTURE_DOC_NEEDLE = fixtureEnv('E2E_FIXTURE_DOC_NEEDLE', 'google-docs');

test(`readGoogleDoc returns fixture content (${CLIENT})`, { timeout: 180_000 }, async () => {
  await runSmokeTest({
    name: 'readGoogleDoc',
    service: 'google-docs',
    client: CLIENT,
    mode: 'readonly',
    prompt: [
      `Call the readGoogleDoc MCP tool with documentId "${FIXTURE_DOC_ID}" and format "text".`,
      outputContract('verbatim text content of the doc'),
    ].join('\n'),
    assertions: {
      containsBetween: ['OUTPUT_BEGIN', 'OUTPUT_END'],
      includes: [FIXTURE_DOC_NEEDLE],
    },
  });
});
