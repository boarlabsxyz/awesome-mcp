import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';
import { sandboxCalendarId } from '../../../setup/calendarScratch.ts';

// The empty-window answer, asserted verbatim against listEvents in
// src/google-calendar/server.ts. A day in 2001 on the sandbox calendar: nothing
// the harness writes lands there (scratch events are a day in the future), so
// this stays empty however many createEvent runs have leaked.
//
// The window is also what keeps this honest about timeMin/timeMax being passed
// through: if they were dropped, the tool would fall back to "now + 30 days",
// which is exactly where scratch events live.

const env = serviceEnv('google-calendar');

test('listEvents says the window is empty, and does not read as an error', { timeout: 30_000, skip: env.skip }, async () => {
  await runToolCheck({
    tool: 'listEvents',
    service: 'google-calendar',
    account: 'sandbox',
    shape: 'zero',
    args: {
      calendarId: sandboxCalendarId(),
      timeMin: '2001-03-14T00:00:00Z',
      timeMax: '2001-03-15T00:00:00Z',
    },
    invariants: {
      includes: ['No events found in the specified time range.'],
      excludes: ['Found ', 'Failed to', 'Permission denied', 'Calendar not found'],
    },
  });
});
