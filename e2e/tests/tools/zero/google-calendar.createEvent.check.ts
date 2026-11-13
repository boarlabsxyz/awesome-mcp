import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';
import { scratchTitle } from '../../../setup/docsScratch.ts';
import {
  sandboxCalendarId,
  scratchEventWindow,
  isoWithOffset,
  findScratchEventId,
  deleteScratchEvent,
} from '../../../setup/calendarScratch.ts';

// Creating an event and reading it back with listEvents + getEvent, rather than
// trusting createEvent's "Event created successfully!" -- that reply is built
// from Google's insert response, and says nothing about whether the event is
// where a later read will look for it.
//
// The times go in with a +05:30 offset and no `timeZone`. The assertion is on
// the INSTANT, not the string: Google stores and returns dateTime in the
// calendar's own zone, so "15:30:00+05:30" legitimately reads back as
// "10:00:00Z" or "12:00:00+02:00". A tool that dropped the offset, or applied
// `timeZone` on top of it, lands the event hours away -- which a string compare
// against Google's echo would never notice, and which on a UTC calendar a
// UTC-only input could not reveal. The half-hour offset also catches code that
// assumes whole hours.

const env = serviceEnv('google-calendar');
const OFFSET_MINUTES = 5 * 60 + 30;

interface Ctx {
  calendarId: string;
  summary: string;
  start: Date;
  end: Date;
  eventId?: string;
}

test('createEvent lands the event at the requested instant', { timeout: 90_000, skip: env.skip }, async () => {
  await runToolCheck<Ctx>({
    tool: 'createEvent',
    service: 'google-calendar',
    account: 'sandbox',
    shape: 'zero',
    writes: true,
    setup: async () => ({
      calendarId: sandboxCalendarId(),
      summary: scratchTitle('createEvent-zero'),
      ...scratchEventWindow(),
    }),
    args: ({ calendarId, summary, start, end }) => ({
      calendarId,
      summary,
      startDateTime: isoWithOffset(start, OFFSET_MINUTES),
      endDateTime: isoWithOffset(end, OFFSET_MINUTES),
      sendUpdates: 'none',
    }),
    // Found by listing the window (so it is also proven visible to listEvents),
    // then read in full with getEvent. The ID is stashed on the context for
    // teardown.
    readback: async (c, ctx) => {
      ctx.eventId = await findScratchEventId(c.mcp, ctx);
      if (!ctx.eventId) {
        throw new Error(
          `createEvent reported success but no event titled ${JSON.stringify(ctx.summary)} is listed ` +
            `within a day of ${ctx.start.toISOString()} on calendar ${ctx.calendarId}`,
        );
      }
      return (await c.mcp.callTool('getEvent', { calendarId: ctx.calendarId, eventId: ctx.eventId })).text;
    },
    invariants: ({ summary, eventId, start, end }) => ({
      // Lines from getEvent (src/google-calendar/server.ts).
      includes: [`**Title:** ${summary}`, `**ID:** ${eventId}`, '**Status:** confirmed'],
      excludes: ['undefined'],
      predicate: (body) => {
        const gotStart = body.match(/^\*\*Start:\*\* (\S+)$/m)?.[1];
        const gotEnd = body.match(/^\*\*End:\*\* (\S+)$/m)?.[1];
        if (!gotStart || !gotEnd) return 'getEvent did not render a Start and an End line';
        if (Date.parse(gotStart) !== start.getTime()) {
          return `asked for start ${start.toISOString()}, the stored event starts at ${gotStart}`;
        }
        if (Date.parse(gotEnd) !== end.getTime()) {
          return `asked for end ${end.toISOString()}, the stored event ends at ${gotEnd}`;
        }
        return undefined;
      },
    }),
    // Looks the event up again if readback never got that far -- a failed
    // assertion must not leak it. Nothing listed means createEvent made nothing.
    teardown: async (c, ctx) => {
      if (!ctx.summary) return; // setup never ran
      const eventId = ctx.eventId ?? (await findScratchEventId(c.mcp, ctx));
      if (eventId) await deleteScratchEvent(c.mcp, ctx.calendarId, eventId);
    },
  });
});
