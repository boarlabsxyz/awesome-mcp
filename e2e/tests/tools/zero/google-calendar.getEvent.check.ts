import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';
import { sandboxCalendarId } from '../../../setup/calendarScratch.ts';

// A well-formed event ID that does not exist. Calendar IDs are base32hex
// (0-9, a-v), and every character here is in that range, so Google answers 404
// rather than 400 -- the 404 is what getEvent maps to "Event not found"
// (src/google-calendar/server.ts, getEvent's catch). A malformed ID would take
// the generic "Failed to get event:" branch and test the wrong mapping.

const env = serviceEnv('google-calendar');
const NO_SUCH_EVENT = 'e2enosuchevent9f3a1c7b';

test('getEvent says a nonexistent event was not found', { timeout: 30_000, skip: env.skip }, async () => {
  await runToolCheck({
    tool: 'getEvent',
    service: 'google-calendar',
    account: 'sandbox',
    shape: 'zero',
    args: { calendarId: sandboxCalendarId(), eventId: NO_SUCH_EVENT },
    expectToolError: true,
    invariants: {
      includes: [`Event not found (ID: ${NO_SUCH_EVENT}).`],
      excludes: ['undefined', 'Permission denied', 'Failed to get event', 'at Object.<anonymous>'],
    },
  });
});
