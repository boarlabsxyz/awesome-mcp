import { test, after } from 'node:test';
import { runSmokeTest } from '../../runSmokeTest.ts';
import { outputContract } from '../../promptTemplates.ts';
import {
  scratchCalendarId,
  eventWindow,
  cleanupScratchCalendar,
} from '../../setup/calendarScratch.ts';
import { scratchMarker, scratchName } from '../../setup/scratchNaming.ts';
import { CLIENT } from '../fixtureEnv.ts';

after(async () => {
  await cleanupScratchCalendar();
});

test(`createEvent adds an event to the scratch calendar (${CLIENT})`, { timeout: 240_000 }, async () => {
  await runSmokeTest({
    name: 'createEvent',
    service: 'google-calendar',
    client: CLIENT,
    mode: 'full',
    setup: async () => {
      const marker = scratchMarker('calendar');
      // A day out, on the hour: far enough that a slow run can't have the
      // event roll into the past and drop out of the listEvents window.
      const window = eventWindow(24);
      return {
        calendarId: scratchCalendarId(),
        marker,
        summary: scratchName(`calendar write ${marker}`),
        window,
      };
    },
    prompt: ({ calendarId, summary, window }) =>
      [
        `Call the createEvent MCP tool with calendarId "${calendarId}", summary "${summary}", ` +
          `startDateTime "${window.startIso}" and endDateTime "${window.endIso}".`,
        `Then call the listEvents MCP tool with calendarId "${calendarId}", ` +
          `timeMin "${window.startIso}" and timeMax "${window.endIso}".`,
        outputContract('the summary of every event listEvents returned, one per line'),
      ].join('\n'),
    assertions: ({ marker }) => ({
      containsBetween: ['OUTPUT_BEGIN', 'OUTPUT_END'],
      includes: [marker],
    }),
    // The event summary carries the `[e2e]` prefix, so the calendar-wide sweep
    // is the teardown — there's no id to delete without parsing it out of the
    // model's reply, which is exactly the coupling the sweep exists to avoid.
    teardown: async () => {
      await cleanupScratchCalendar();
    },
  });
});
