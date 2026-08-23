import { test } from 'node:test';
import { runSmokeTest } from '../../runSmokeTest.ts';
import { outputContract } from '../../promptTemplates.ts';
import { CLIENT, fixtureEnv } from '../fixtureEnv.ts';

const FIXTURE_CALENDAR_ID = fixtureEnv('E2E_FIXTURE_CALENDAR_ID', 'google-calendar');
const FIXTURE_NEEDLE = fixtureEnv('E2E_FIXTURE_CALENDAR_NEEDLE', 'google-calendar');
// The fixture event is a yearly recurring all-day event, so a fixed wide window
// always contains exactly one instance regardless of when the suite runs.
// `||`, not `??`: GitHub Actions sets an unconfigured `vars.*` to the empty
// string rather than leaving it undefined, and '' must fall back to the default.
const FIXTURE_TIME_MIN = process.env.E2E_FIXTURE_CALENDAR_TIME_MIN || '2020-01-01T00:00:00Z';
const FIXTURE_TIME_MAX = process.env.E2E_FIXTURE_CALENDAR_TIME_MAX || '2040-01-01T00:00:00Z';

test(`listEvents returns the fixture event (${CLIENT})`, { timeout: 180_000 }, async () => {
  await runSmokeTest({
    name: 'listEvents',
    service: 'google-calendar',
    client: CLIENT,
    mode: 'readonly',
    prompt: [
      `Call the listEvents MCP tool with calendarId "${FIXTURE_CALENDAR_ID}", ` +
        `timeMin "${FIXTURE_TIME_MIN}", timeMax "${FIXTURE_TIME_MAX}" and maxResults 50.`,
      outputContract('the summary of every event the tool returned, one per line'),
    ].join('\n'),
    assertions: {
      containsBetween: ['OUTPUT_BEGIN', 'OUTPUT_END'],
      includes: [FIXTURE_NEEDLE],
    },
  });
});
