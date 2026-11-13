// Scratch calendar events for the Calendar write checks: a self-dating summary,
// a near-future window, and the lookup + delete that teardown needs.
//
// Events go on E2E_SANDBOX_CAL_ID when it is set and on the sandbox account's
// primary calendar otherwise, mirroring E2E_SANDBOX_FOLDER_ID in docsScratch.ts.
//
// The event ID is found by listing, not parsed out of createEvent's reply:
// runToolCheck hands readback and teardown only the setup context, never the
// tool's own reply, so the "**ID:** <id>" line createEvent prints
// (src/google-calendar/server.ts, createEvent) is out of reach. The summary is
// run-scoped (`scratchTitle()`), so matching on it finds exactly one event.
//
// NOT SWEPT. `sweepScratch` lists Google Docs only, so an event leaked by a run
// that died before teardown stays on the sandbox calendar. The zero-state
// listEvents check reads a window years in the past, so a leak cannot turn it
// red, but it does accumulate.

import { explainToolError } from '../accounts.ts';
import type { McpClient } from '../transports/mcpHttp.ts';

export function sandboxCalendarId(): string {
  return process.env.E2E_SANDBOX_CAL_ID || 'primary';
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * A 30-minute slot starting a day from now, on a whole minute.
 *
 * Near-future rather than "now" so the event is never in progress or already
 * over while the check reads it back.
 */
export function scratchEventWindow(startedAt = Date.now()): { start: Date; end: Date } {
  const start = new Date(Math.floor((startedAt + 24 * HOUR) / MINUTE) * MINUTE);
  return { start, end: new Date(start.getTime() + 30 * MINUTE) };
}

/**
 * ISO 8601 with an explicit numeric offset, e.g. `2026-11-07T15:30:00+05:30`.
 *
 * `toISOString()` only ever writes `Z`. A check that always sends UTC cannot
 * tell a correct round-trip from a tool that drops the offset and lets Google
 * read the wall-clock time in the calendar's zone -- for a UTC calendar the two
 * are the same instant.
 */
export function isoWithOffset(instant: Date, offsetMinutes: number): string {
  const local = new Date(instant.getTime() + offsetMinutes * MINUTE);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${local.toISOString().slice(0, 19)}${sign}${hh}:${mm}`;
}

/**
 * The ID of the event titled exactly `summary` within a day either side of the
 * window, or undefined.
 *
 * The margin is wide on purpose: an event created at the wrong instant -- a
 * time-zone bug, which is what the createEvent check is looking for -- must
 * still be found, or the check fails for the wrong reason and the event leaks.
 *
 * Entries render as "N. **<summary>**" then "   ID: <id>" (listEvents,
 * src/google-calendar/server.ts).
 */
export async function findScratchEventId(
  calendar: McpClient,
  { calendarId, summary, start, end }: { calendarId: string; summary: string; start: Date; end: Date },
): Promise<string | undefined> {
  const { text, isError } = await calendar.callTool('listEvents', {
    calendarId,
    timeMin: new Date(start.getTime() - 24 * HOUR).toISOString(),
    timeMax: new Date(end.getTime() + 24 * HOUR).toISOString(),
    maxResults: 250,
  });
  if (isError) throw new Error(explainToolError('sandbox', 'listEvents', text));

  for (const [, title, id] of text.matchAll(/^\d+\. \*\*(.+?)\*\*\n\s+ID: (\S+)/gm)) {
    if (title === summary) return id;
  }
  return undefined;
}

/** sendUpdates 'none' so a scratch event never emails anyone. */
export async function deleteScratchEvent(calendar: McpClient, calendarId: string, eventId: string): Promise<void> {
  const { text, isError } = await calendar.callTool('deleteEvent', { calendarId, eventId, sendUpdates: 'none' });
  if (isError) throw new Error(explainToolError('sandbox', `deleteEvent(${eventId})`, text));
}
