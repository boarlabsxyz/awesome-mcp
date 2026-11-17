// Scratch calendar events for the Calendar write checks: a self-dating summary,
// a near-future window, and the lookup + delete that teardown needs.
//
// Events go on E2E_SANDBOX_CAL_ID when it is set and on the sandbox account's
// primary calendar otherwise, mirroring E2E_SANDBOX_FOLDER_ID in docsScratch.ts.
//
// The createEvent check finds its event by listing (which also proves listEvents
// sees it), and keeps the ID from createEvent's own "**ID:** <id>" line for
// teardown, so a failed listing cannot leak the event. The summary is run-scoped
// (`scratchTitle()`), so matching on it finds exactly one event.
//
// `sweepScratchEvents` deletes events leaked by runs that died before teardown;
// `npm run sweep:sandbox` calls it when google-calendar is enabled.

import { explainToolError } from '../accounts.ts';
import type { McpClient } from '../transports/mcpHttp.ts';
import { scratchStamp, sweepCutoff } from './docsScratch.ts';

export function sandboxCalendarId(): string {
  return process.env.E2E_SANDBOX_CAL_ID || 'primary';
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** listEvents' own ceiling. It has no page token, so a full listing may hide more. */
const LIST_MAX = 2500;

/** "N. **<summary>**" then "   ID: <id>" (listEvents, src/google-calendar/server.ts). */
const EVENT_ENTRY = /^\d+\. \*\*(.+?)\*\*\n\s+ID: (\S+)/gm;

/** The ID createEvent prints as "**ID:** <id>", or undefined. */
export function createdEventId(reply: string | undefined): string | undefined {
  return reply?.match(/^\*\*ID:\*\* (\S+)$/m)?.[1];
}

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
 * listEvents returns no page token, so this asks for its maximum and refuses
 * to answer "not there" from a listing that hit it.
 */
export async function findScratchEventId(
  calendar: McpClient,
  { calendarId, summary, start, end }: { calendarId: string; summary: string; start: Date; end: Date },
): Promise<string | undefined> {
  const { text, isError } = await calendar.callTool('listEvents', {
    calendarId,
    timeMin: new Date(start.getTime() - 24 * HOUR).toISOString(),
    timeMax: new Date(end.getTime() + 24 * HOUR).toISOString(),
    maxResults: LIST_MAX,
  });
  if (isError) throw new Error(explainToolError('sandbox', 'listEvents', text));

  const entries = [...text.matchAll(EVENT_ENTRY)];
  for (const [, title, id] of entries) {
    if (title === summary) return id;
  }
  if (entries.length >= LIST_MAX) {
    throw new Error(
      `listEvents returned its maximum of ${LIST_MAX} events around ${start.toISOString()} on ${calendarId} ` +
        `without ${JSON.stringify(summary)}, so its absence proves nothing. Run npm run sweep:sandbox.`,
    );
  }
  return undefined;
}

/** sendUpdates 'none' so a scratch event never emails anyone. */
export async function deleteScratchEvent(calendar: McpClient, calendarId: string, eventId: string): Promise<void> {
  const { text, isError } = await calendar.callTool('deleteEvent', { calendarId, eventId, sendUpdates: 'none' });
  if (isError) throw new Error(explainToolError('sandbox', `deleteEvent(${eventId})`, text));
}

/**
 * Delete scratch events leaked by runs that died before teardown: any event
 * whose summary carries an `e2e-<epochMs>-` stamp older than the cutoff.
 *
 * Scratch events start a day after they are made (`scratchEventWindow`), so the
 * listing runs from `lookbackDays` ago to two days ahead. Matching is on the
 * summary, not listEvents' `query`, whose word matching on the hyphenated title
 * is unverified -- a sweep that silently matched nothing would look like a
 * clean calendar.
 */
export async function sweepScratchEvents(
  calendar: McpClient,
  { calendarId = sandboxCalendarId(), maxAgeHours = 24, dryRun = false, lookbackDays = 90 }:
    { calendarId?: string; maxAgeHours?: number; dryRun?: boolean; lookbackDays?: number } = {},
): Promise<{ deleted: string[]; kept: number; capped: boolean }> {
  const cutoff = sweepCutoff(maxAgeHours);
  const now = Date.now();
  const { text, isError } = await calendar.callTool('listEvents', {
    calendarId,
    timeMin: new Date(now - lookbackDays * DAY).toISOString(),
    timeMax: new Date(now + 2 * DAY).toISOString(),
    maxResults: LIST_MAX,
  });
  if (isError) throw new Error(explainToolError('sandbox', 'listEvents', text));

  const entries = [...text.matchAll(EVENT_ENTRY)];
  const deleted: string[] = [];
  let kept = 0;
  for (const [, title, id] of entries) {
    const stamp = scratchStamp(title);
    if (stamp === undefined || stamp >= cutoff) {
      kept++;
      continue;
    }
    if (!dryRun) await deleteScratchEvent(calendar, calendarId, id);
    deleted.push(`${title} (${id})`);
  }
  return { deleted, kept, capped: entries.length >= LIST_MAX };
}
