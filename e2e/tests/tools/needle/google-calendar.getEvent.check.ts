import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// The frozen fixture event, read by ID. The start is compared as an instant, not
// a string: getEvent prints Google's dateTime, which is rendered in the
// calendar's zone, so the same event reads "10:00:00Z" on one calendar and
// "12:00:00+02:00" on another. E2E_FIXTURE_CAL_EVENT_START may be written in
// any offset.

const env = serviceEnv('google-calendar', [
  'E2E_FIXTURE_CAL_EVENT_ID',
  'E2E_FIXTURE_CAL_NEEDLE',
  'E2E_FIXTURE_CAL_EVENT_START',
]);

test('getEvent returns the frozen fixture event', { timeout: 30_000, skip: env.skip }, async () => {
  const EVENT_ID = env.get('E2E_FIXTURE_CAL_EVENT_ID');
  const NEEDLE = env.get('E2E_FIXTURE_CAL_NEEDLE');
  const START = Date.parse(env.get('E2E_FIXTURE_CAL_EVENT_START'));
  if (!Number.isFinite(START)) throw new Error('E2E_FIXTURE_CAL_EVENT_START is not an ISO 8601 date-time');

  await runToolCheck({
    tool: 'getEvent',
    service: 'google-calendar',
    account: 'fixture',
    shape: 'needle',
    args: { calendarId: process.env.E2E_FIXTURE_CAL_ID || 'primary', eventId: EVENT_ID },
    invariants: {
      // Lines from getEvent (src/google-calendar/server.ts).
      includes: [NEEDLE, `**ID:** ${EVENT_ID}`],
      matches: [/^\*\*Title:\*\* .+$/m],
      transportSafe: true,
      predicate: (body) => {
        const title = body.match(/^\*\*Title:\*\* (.+)$/m)?.[1] ?? '';
        if (!title.includes(NEEDLE)) return `the needle is not in the title line: ${JSON.stringify(title)}`;
        const start = body.match(/^\*\*Start:\*\* (\S+)$/m)?.[1];
        if (!start) return 'getEvent did not render a Start line';
        if (Date.parse(start) !== START) {
          return `fixture event should start at ${new Date(START).toISOString()}, getEvent says ${start}`;
        }
        return undefined;
      },
    },
  });
});
