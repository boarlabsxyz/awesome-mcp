// Setup/teardown for the Google Calendar write smoke.
//
// Scoped to a dedicated scratch calendar (E2E_CALENDAR_SCRATCH_ID) in the write
// account, so cleanup can wipe the whole calendar without risking a real one —
// the Calendar equivalent of e2e-scratch/. Events still carry the `[e2e]`
// prefix so an orphan is recognizable if it ever ends up on the wrong calendar.
//
// Events are created in the near future rather than "now" so a slow run can't
// have its event roll into the past mid-test and drop out of a listEvents
// window.

import { getWriteAccountClients } from './googleClient.ts';
import { scratchName, isScratchName, required } from './scratchNaming.ts';

const SCRATCH_CALENDAR_ENV = 'E2E_CALENDAR_SCRATCH_ID';
const DOC = 'e2e/fixtures/write-google.md';

export function scratchCalendarId(): string {
  return required(SCRATCH_CALENDAR_ENV, DOC);
}

export interface ScratchEventWindow {
  startIso: string;
  endIso: string;
}

/** A one-hour window starting `hoursFromNow` out, on the hour. */
export function eventWindow(hoursFromNow = 24): ScratchEventWindow {
  const start = new Date(Date.now() + hoursFromNow * 3_600_000);
  start.setMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 3_600_000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

export async function createScratchEvent(
  label: string,
  window: ScratchEventWindow = eventWindow(),
): Promise<string> {
  const { calendar } = getWriteAccountClients();

  const created = await calendar.events.insert({
    calendarId: scratchCalendarId(),
    requestBody: {
      summary: scratchName(label),
      start: { dateTime: window.startIso },
      end: { dateTime: window.endIso },
    },
  });
  const eventId = created.data.id;
  if (!eventId) throw new Error('calendar.events.insert returned no event id');
  return eventId;
}

/** Summaries of events on the scratch calendar overlapping the given window. */
export async function listEventSummaries(window: ScratchEventWindow): Promise<string[]> {
  const { calendar } = getWriteAccountClients();
  const res = await calendar.events.list({
    calendarId: scratchCalendarId(),
    timeMin: window.startIso,
    timeMax: window.endIso,
    singleEvents: true,
    maxResults: 250,
  });
  return (res.data.items ?? []).map((e) => e.summary ?? '');
}

export async function deleteEvent(eventId: string): Promise<void> {
  const { calendar } = getWriteAccountClients();
  await calendar.events.delete({ calendarId: scratchCalendarId(), eventId });
}

/**
 * Safety net — delete every `[e2e]`-prefixed event on the scratch calendar.
 * Mirrors cleanupScratchFolder(): scoped by container (the scratch calendar)
 * AND filtered by prefix, so a mis-set env var can't wipe a real calendar.
 */
export async function cleanupScratchCalendar(): Promise<void> {
  const { calendar } = getWriteAccountClients();
  const calendarId = scratchCalendarId();

  let pageToken: string | undefined;
  do {
    const res = await calendar.events.list({
      calendarId,
      singleEvents: true,
      maxResults: 250,
      pageToken,
    });
    for (const event of res.data.items ?? []) {
      if (event.id && isScratchName(event.summary)) {
        await calendar.events.delete({ calendarId, eventId: event.id });
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
}
