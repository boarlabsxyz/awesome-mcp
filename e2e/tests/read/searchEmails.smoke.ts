import { test } from 'node:test';
import { runSmokeTest } from '../../runSmokeTest.ts';
import { outputContract } from '../../promptTemplates.ts';
import { CLIENT, fixtureEnv } from '../fixtureEnv.ts';

// The fixture query is a Gmail search string (e.g. `subject:"E2E Read Fixture"`)
// that matches exactly one pre-seeded message in the readonly mailbox.
const FIXTURE_QUERY = fixtureEnv('E2E_FIXTURE_GMAIL_QUERY', 'google-gmail');
const FIXTURE_NEEDLE = fixtureEnv('E2E_FIXTURE_GMAIL_NEEDLE', 'google-gmail');

test(`searchEmails finds the fixture message (${CLIENT})`, { timeout: 180_000 }, async () => {
  await runSmokeTest({
    name: 'searchEmails',
    service: 'google-gmail',
    client: CLIENT,
    mode: 'readonly',
    prompt: [
      `Call the searchEmails MCP tool with query ${JSON.stringify(FIXTURE_QUERY)} and maxResults 10.`,
      outputContract('the subject line of every message the tool returned, one per line'),
    ].join('\n'),
    assertions: {
      containsBetween: ['OUTPUT_BEGIN', 'OUTPUT_END'],
      includes: [FIXTURE_NEEDLE],
    },
  });
});
