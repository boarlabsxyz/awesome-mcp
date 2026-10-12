// src/calendarServer.ts
import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';
import { calendar_v3 } from 'googleapis';

import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import { registerMintRestBearerForCurl } from '../sharedTools/mintRestBearerForCurl.js';
import { registerListRestEndpoints } from '../sharedTools/listRestEndpoints.js';
import {
  buildMeetConferenceData,
  formatConferenceCompact,
  formatConferenceDetail,
  formatMeetPendingHint,
  hasExistingConference,
} from './conferenceFormatter.js';

const calendarServer = new FastMCP<UserSession>({
  name: 'Google Calendar MCP Server',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'google-calendar'),
});

registerMintRestBearerForCurl(calendarServer);
registerListRestEndpoints(calendarServer);

// --- Helper to get Calendar client within tools ---
function getCalendarClient(session?: UserSession): calendar_v3.Calendar {
  if (session?.googleCalendar) return session.googleCalendar;
  throw new UserError("Google Calendar client is not available. Make sure you have granted calendar access.");
}

// === TOOL DEFINITIONS ===

calendarServer.addTool({
  name: 'listCalendars',
  annotations: { readOnlyHint: true },
  description: 'Lists all calendars accessible to the user.',
  parameters: z.object({
    showHidden: z.boolean().optional().default(false)
      .describe('Whether to show hidden calendars as well.'),
  }),
  execute: async (args, { log, session }) => {
    const calendar = getCalendarClient(session);
    log.info('Listing calendars');

    try {
      const response = await calendar.calendarList.list({
        showHidden: args.showHidden,
      });

      const calendars = response.data.items || [];
      if (calendars.length === 0) {
        return 'No calendars found.';
      }

      let result = `Found ${calendars.length} calendar(s):\n\n`;
      calendars.forEach((cal, index) => {
        result += `${index + 1}. **${cal.summary}**\n`;
        result += `   ID: ${cal.id}\n`;
        result += `   Access Role: ${cal.accessRole}\n`;
        if (cal.description) {
          result += `   Description: ${cal.description}\n`;
        }
        result += `   Primary: ${cal.primary ? 'Yes' : 'No'}\n\n`;
      });

      return result;
    } catch (error: any) {
      log.error(`Error listing calendars: ${error.message || error}`);
      if (error.code === 403) throw new UserError("Permission denied. Make sure you have granted calendar access.");
      throw new UserError(`Failed to list calendars: ${error.message || 'Unknown error'}`);
    }
  },
});

calendarServer.addTool({
  name: 'listEvents',
  annotations: { readOnlyHint: true },
  description: 'Lists events from a calendar within a specified date range. Each event with guests also reports YOUR OWN invitation response ("My response"), including needsAction when you have not answered — so invitations needing a reply can be found from one call instead of a getEvent per event. Answer them with updateEvent myResponseStatus.',
  parameters: z.object({
    calendarId: z.string().optional().default('primary')
      .describe('The calendar ID. Use "primary" for the user\'s primary calendar.'),
    timeMin: z.string().optional()
      .describe('Start of the time range (ISO 8601 format, e.g., "2024-01-01T00:00:00Z"). Defaults to now.'),
    timeMax: z.string().optional()
      .describe('End of the time range (ISO 8601 format, e.g., "2024-12-31T23:59:59Z"). Defaults to 30 days from now.'),
    maxResults: z.number().optional().default(50)
      .describe('Maximum number of events to return (1-2500).'),
    query: z.string().optional()
      .describe('Free text search terms to find events that match.'),
    singleEvents: z.boolean().optional().default(true)
      .describe('Whether to expand recurring events into instances.'),
  }),
  execute: async (args, { log, session }) => {
    const calendar = getCalendarClient(session);
    log.info(`Listing events from calendar: ${args.calendarId}`);

    try {
      const now = new Date();
      const thirtyDaysLater = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      const response = await calendar.events.list({
        calendarId: args.calendarId,
        timeMin: args.timeMin || now.toISOString(),
        timeMax: args.timeMax || thirtyDaysLater.toISOString(),
        maxResults: Math.min(args.maxResults || 50, 2500),
        singleEvents: args.singleEvents,
        orderBy: args.singleEvents ? 'startTime' : undefined,
        q: args.query,
      });

      const events = response.data.items || [];
      if (events.length === 0) {
        return 'No events found in the specified time range.';
      }

      let result = `Found ${events.length} event(s):\n\n`;
      events.forEach((event, index) => {
        const start = event.start?.dateTime || event.start?.date || 'Unknown';
        const end = event.end?.dateTime || event.end?.date || 'Unknown';

        result += `${index + 1}. **${event.summary || '(No title)'}**\n`;
        result += `   ID: ${event.id}\n`;
        result += `   Start: ${start}\n`;
        result += `   End: ${end}\n`;
        if (event.location) {
          result += `   Location: ${event.location}\n`;
        }
        if (event.description) {
          const shortDesc = event.description.length > 100
            ? event.description.substring(0, 100) + '...'
            : event.description;
          result += `   Description: ${shortDesc}\n`;
        }
        if (event.attendees && event.attendees.length > 0) {
          result += `   Attendees: ${event.attendees.map(a => a.email).join(', ')}\n`;
          // The caller's OWN answer, on the list rows — not only in getEvent.
          // Without it, finding which invitations still need replying to meant a
          // getEvent per event, and the one field that decides that was the one
          // field a list could not show.
          const mine = describeSelfResponse(event);
          if (mine) result += `   My response: ${mine}\n`;
        }
        result += formatConferenceCompact(event);
        result += `   Status: ${event.status}\n\n`;
      });

      return result;
    } catch (error: any) {
      log.error(`Error listing events: ${error.message || error}`);
      if (error.code === 404) throw new UserError(`Calendar not found (ID: ${args.calendarId}).`);
      if (error.code === 403) throw new UserError("Permission denied for this calendar.");
      throw new UserError(`Failed to list events: ${error.message || 'Unknown error'}`);
    }
  },
});

calendarServer.addTool({
  name: 'getEvent',
  annotations: { readOnlyHint: true },
  description: 'Gets detailed information about a specific calendar event, including every attendee\'s response and which attendee is you. Use updateEvent with myResponseStatus to answer the invitation.',
  parameters: z.object({
    calendarId: z.string().optional().default('primary')
      .describe('The calendar ID. Use "primary" for the user\'s primary calendar.'),
    eventId: z.string().describe('The event ID to retrieve.'),
  }),
  execute: async (args, { log, session }) => {
    const calendar = getCalendarClient(session);
    log.info(`Getting event: ${args.eventId} from calendar: ${args.calendarId}`);

    try {
      const response = await calendar.events.get({
        calendarId: args.calendarId,
        eventId: args.eventId,
      });

      const event = response.data;
      const start = event.start?.dateTime || event.start?.date || 'Unknown';
      const end = event.end?.dateTime || event.end?.date || 'Unknown';

      let result = `**Event Details:**\n\n`;
      result += `**Title:** ${event.summary || '(No title)'}\n`;
      result += `**ID:** ${event.id}\n`;
      result += `**Status:** ${event.status}\n`;
      result += `**Start:** ${start}\n`;
      result += `**End:** ${end}\n`;

      if (event.location) {
        result += `**Location:** ${event.location}\n`;
      }
      if (event.description) {
        result += `**Description:** ${event.description}\n`;
      }
      if (event.creator) {
        result += `**Creator:** ${event.creator.email}\n`;
      }
      if (event.organizer) {
        result += `**Organizer:** ${event.organizer.email}\n`;
      }
      if (event.attendees && event.attendees.length > 0) {
        result += `\n**Attendees:**\n`;
        event.attendees.forEach(attendee => {
          // Mark the caller's own row. The list already carried every response
          // status but never said which one was yours, so answering an
          // invitation meant guessing by email — wrong whenever the account is
          // invited through an alias or a group.
          const you = attendee.self === true ? ' — you' : '';
          result += `  - ${attendee.email} (${attendee.responseStatus || 'unknown'})${you}\n`;
        });
        const mine = describeSelfResponse(event);
        if (mine) {
          result += `\n**Your response:** ${mine}\n`;
          result += '  Change it with updateEvent myResponseStatus (accepted / tentative / declined).\n';
        }
      }
      if (event.recurrence) {
        result += `\n**Recurrence:** ${event.recurrence.join(', ')}\n`;
      }
      result += formatConferenceDetail(event);
      if (event.htmlLink) {
        result += `\n**Link:** ${event.htmlLink}\n`;
      }

      return result;
    } catch (error: any) {
      log.error(`Error getting event: ${error.message || error}`);
      if (error.code === 404) throw new UserError(`Event not found (ID: ${args.eventId}).`);
      if (error.code === 403) throw new UserError("Permission denied for this event.");
      throw new UserError(`Failed to get event: ${error.message || 'Unknown error'}`);
    }
  },
});

// Parameter schemas for the two event writes, lifted out of their addTool calls
// and exported.
//
// They are the single validation contract for BOTH surfaces: the MCP tools take
// them as `parameters`, and the REST routes
// (POST /api/v1/calendars/{calendarId}/events and .../events/{eventId})
// safeParse `req.body` with them. REST has no FastMCP Zod pass in front of it,
// so before this the routes hand-rolled `if (!summary)` presence checks that
// drifted from the tools and never checked a single type -- `attendees: "a@b.com"`
// reached the Google API as a string.
//
// `sendUpdates` defaulting to 'none' is the load-bearing default here: it is
// what stops a curl silently emailing every attendee on a calendar.
export const createEventSchema = z.object({
  calendarId: z.string().optional().default('primary')
    .describe('The calendar ID. Use "primary" for the user\'s primary calendar.'),
  summary: z.string().describe('The title of the event.'),
  description: z.string().optional().describe('Description or notes for the event.'),
  location: z.string().optional().describe('Geographic location of the event.'),
  startDateTime: z.string().describe('Start time in ISO 8601 format (e.g., "2024-01-15T10:00:00-05:00").'),
  endDateTime: z.string().describe('End time in ISO 8601 format (e.g., "2024-01-15T11:00:00-05:00").'),
  timeZone: z.string().optional().describe('Time zone (e.g., "America/New_York"). Defaults to calendar\'s time zone.'),
  attendees: z.array(z.string()).optional().describe('List of attendee email addresses.'),
  addGoogleMeet: z.boolean().optional().default(false)
    .describe('If true, generate a Google Meet video conference for this event. The Meet link is returned in the response and attached to the calendar invite.'),
  sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional().default('none')
    .describe('Whether to send email notifications to attendees. Default "none" — attendees are NOT notified unless you pass "all" or "externalOnly".'),
});

export const updateEventSchema = z.object({
  calendarId: z.string().optional().default('primary')
    .describe('The calendar ID. Use "primary" for the user\'s primary calendar.'),
  eventId: z.string().describe('The event ID to update.'),
  summary: z.string().optional().describe('New title for the event.'),
  description: z.string().optional().describe('New description for the event.'),
  location: z.string().optional().describe('New location for the event.'),
  startDateTime: z.string().optional().describe('New start time in ISO 8601 format.'),
  endDateTime: z.string().optional().describe('New end time in ISO 8601 format.'),
  timeZone: z.string().optional().describe('Time zone for the start/end times.'),
  addGoogleMeet: z.boolean().optional().default(false)
    .describe('If true, generate a Google Meet video conference for this event. Ignored if the event already has a conference. The Meet link is returned in the response.'),
  // RSVP. Only three of Google's four responseStatus values are offered:
  // `needsAction` is the absence of an answer, not an answer, and writing it
  // back would be a way to un-answer an invitation nobody has asked for.
  myResponseStatus: z.enum(['accepted', 'tentative', 'declined']).optional()
    .describe(
      'Answer an invitation: set YOUR OWN attendee response on this event. Only your own entry is touched — '
      + 'other attendees\' responses are preserved. Fails if you are not an attendee (an organizer is often not '
      + 'one, and nothing is added to the guest list on your behalf). With the default sendUpdates "none" the '
      + 'organizer is NOT emailed about your answer, so pass sendUpdates "all" if they should be told.',
    ),
  sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional().default('none')
    .describe('Whether to send email notifications to attendees. Default "none" — attendees are NOT notified unless you pass "all" or "externalOnly". For an RSVP (myResponseStatus) this is what decides whether the organizer learns your answer.'),
});

// Destructive (destructiveHint on the tool), and the REST sibling is a POST to
// an explicit /cancel path rather than a DELETE: the catalog's method union is
// GET or POST, and an explicit verb reads as deliberate at the call site. The
// legacy uncatalogued DELETE on the event path stays for ChatGPT compat.
export const deleteEventSchema = z.object({
  calendarId: z.string().optional().default('primary')
    .describe('The calendar ID. Use "primary" for the user\'s primary calendar.'),
  eventId: z.string().describe('The event ID to delete.'),
  sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional().default('none')
    .describe('Whether to send email notifications to attendees. Default "none" — attendees are NOT notified unless you pass "all" or "externalOnly".'),
});

export type CreateEventArgs = z.infer<typeof createEventSchema>;
export type UpdateEventArgs = z.infer<typeof updateEventSchema>;

/**
 * Insert an event. Returns Google's created event, unformatted.
 *
 * The half of createEvent that decides what the answer IS, so the MCP tool and
 * the REST route cannot build a different request body from the same arguments
 * -- the duplicated `eventResource` literal in webServer.ts is what let the two
 * drift (the REST copy forgot Meet handling existed for a while).
 */
export async function performCreateEvent(
  calendar: calendar_v3.Calendar,
  args: CreateEventArgs,
): Promise<calendar_v3.Schema$Event> {
  const eventResource: calendar_v3.Schema$Event = {
    summary: args.summary,
    description: args.description,
    location: args.location,
    start: { dateTime: args.startDateTime, timeZone: args.timeZone },
    end: { dateTime: args.endDateTime, timeZone: args.timeZone },
  };
  if (args.attendees && args.attendees.length > 0) {
    eventResource.attendees = args.attendees.map(email => ({ email }));
  }
  if (args.addGoogleMeet) {
    eventResource.conferenceData = buildMeetConferenceData();
  }
  const response = await calendar.events.insert({
    calendarId: args.calendarId,
    requestBody: eventResource,
    sendUpdates: args.sendUpdates,
    conferenceDataVersion: args.addGoogleMeet ? 1 : undefined,
  });
  return response.data;
}

/**
 * The authenticated user's own entry in an event's guest list, if they have one.
 *
 * Google marks it with `self: true` — that flag, not an email comparison, is the
 * only reliable test: the connected account may be reached through an alias or a
 * group, in which case the attendee email does not match the account's primary
 * address and a comparison would silently find nobody. Reading the response off
 * the wrong entry would report a colleague's answer as the user's own.
 *
 * Returns undefined when the user is not an attendee. That is a real and common
 * state, not an error here: an organizer frequently does not appear in
 * `attendees` at all, and an event on one's own calendar with no guests has no
 * attendee list whatsoever.
 */
export function findSelfAttendee(
  event: calendar_v3.Schema$Event,
): calendar_v3.Schema$EventAttendee | undefined {
  return (event.attendees || []).find((a) => a.self === true);
}

/**
 * How the caller's own invitation currently stands, for rendering.
 *
 * `needsAction` is reported as the explicit "no answer yet" it is, because that
 * is precisely the state a planner is looking for when it hunts for invitations
 * to answer — leaving it blank would hide the actionable rows.
 */
export function describeSelfResponse(event: calendar_v3.Schema$Event): string | null {
  const self = findSelfAttendee(event);
  if (!self) return null;
  const status = self.responseStatus || 'needsAction';
  return status === 'needsAction' ? 'needsAction (not answered yet)' : status;
}

/**
 * Whether an update asks for anything beyond answering the invitation.
 *
 * `addGoogleMeet` and `sendUpdates` both carry Zod defaults, so they are always
 * present and cannot be tested for presence: only a *truthy* Meet request is an
 * edit, and `sendUpdates` is delivery, not content. `timeZone` counts as an edit
 * even though it does nothing without a start or end, so that the branch taken
 * is predictable from the arguments rather than from which combination happens
 * to be a no-op.
 */
function hasNonRsvpEdits(args: UpdateEventArgs): boolean {
  return args.summary !== undefined
    || args.description !== undefined
    || args.location !== undefined
    || args.startDateTime !== undefined
    || args.endDateTime !== undefined
    || args.timeZone !== undefined
    || Boolean(args.addGoogleMeet);
}

/**
 * Read-modify-write an event, preserving every field the caller did not name.
 *
 * `events.update` REPLACES the resource, so any field absent from the body is
 * DELETED on the real calendar. This started from a whitelist — summary,
 * description, location, start, end, attendees, conferenceData — which silently
 * destroyed everything else on every single update: `recurrence` (so a title
 * change stopped a recurring event from repeating), `reminders`, `colorId`,
 * `visibility`, `transparency`, `attachments`, `extendedProperties` and the
 * `guestsCan*` settings. Hence the spread: start from the whole event as Google
 * returned it, then override only what the caller supplied. Google ignores the
 * output-only fields that come along for the ride (`etag`, `kind`, `created`,
 * `htmlLink`, …), which is why the documented read-modify-write pattern does
 * exactly this.
 *
 * Returns `wantsNewMeet` alongside the event because only this function knows
 * whether a Meet was created on THIS call, which is what decides whether the
 * caller should be told the link may take a moment to appear.
 *
 * Not conditioned on the event's ETag: a concurrent writer's change can still be
 * overwritten between the read and the write. Adding `If-Match` would turn that
 * into a 412 the MCP tools and the two REST routes would all have to surface, so
 * it is a deliberate follow-up rather than a silent behaviour change here.
 *
 * An RSVP (`myResponseStatus`) rides the same read-modify-write, which is what
 * makes it safe: Google has no endpoint for "set my response", so answering an
 * invitation means writing the guest list back — and a body carrying a partial
 * `attendees` array REPLACES the whole list, uninviting everyone absent from it.
 * The caller's own entry is replaced inside the array the read returned, so
 * every other guest and their answers survive untouched.
 *
 * An RSVP *on its own* is sent as an `events.patch` carrying only that array,
 * NOT as the full-resource update. The reason is whose event it is: the common
 * case for answering an invitation is a meeting somebody else organised, where
 * this account is merely an attendee and `guestsCanModify` is false — and a
 * full-resource write there hands Google back `summary`, `start`, `recurrence`
 * and the rest of the organiser's fields, which it may refuse. That refusal
 * would be a 403 reported as "make sure you have write access", i.e. the
 * feature failing opaquely in precisely its main use case. A patch touching
 * only the guest list asks for nothing an attendee is not entitled to change.
 * A call that *also* edits other fields keeps the full update: such a caller is
 * editing the event regardless, so it needs the merge semantics.
 */
export async function performUpdateEvent(
  calendar: calendar_v3.Calendar,
  args: UpdateEventArgs,
): Promise<{ event: calendar_v3.Schema$Event; wantsNewMeet: boolean }> {
  const existingResponse = await calendar.events.get({
    calendarId: args.calendarId,
    eventId: args.eventId,
  });
  const existingEvent = existingResponse.data;

  const eventResource: calendar_v3.Schema$Event = {
    ...existingEvent,
    summary: args.summary ?? existingEvent.summary,
    description: args.description ?? existingEvent.description,
    location: args.location ?? existingEvent.location,
    // A replacement start/end is built fresh rather than spread over the old
    // one: an all-day event carries `date`, and `date` + `dateTime` together is
    // rejected by Google. The time zone falls back to the event's own, because
    // dropping it breaks a recurring event, which Google requires to carry one.
    start: args.startDateTime
      ? { dateTime: args.startDateTime, timeZone: args.timeZone ?? existingEvent.start?.timeZone ?? undefined }
      : existingEvent.start,
    end: args.endDateTime
      ? { dateTime: args.endDateTime, timeZone: args.timeZone ?? existingEvent.end?.timeZone ?? undefined }
      : existingEvent.end,
  };

  // RSVP. Refused rather than guessed at when the user is not on the guest list:
  // adding themselves would be inviting themselves to someone else's meeting,
  // which is a different act from answering an invitation, and Google would
  // accept it silently.
  if (args.myResponseStatus) {
    const self = findSelfAttendee(existingEvent);
    if (!self) {
      throw new UserError(
        `Cannot set your response on event ${args.eventId}: this account is not in its guest list, so there is no `
        + 'invitation to answer. Google marks the caller\'s own entry with `self: true` and this event has none — '
        + 'which is normal when you are the organizer, or when the event has no guests at all. Nothing was changed, '
        + 'and you were deliberately not added as an attendee (that would be inviting yourself, not replying).',
      );
    }
    // Rebuilt by identity, not by index: the array is the one Google just
    // returned, so mapping it preserves every other guest's response exactly.
    const answered = (existingEvent.attendees || []).map((a) =>
      a.self === true ? { ...a, responseStatus: args.myResponseStatus } : a,
    );
    eventResource.attendees = answered;

    // RSVP only: patch just the guest list. See the note above on why the
    // full-resource update is the wrong shape for someone else's meeting.
    if (!hasNonRsvpEdits(args)) {
      const patched = await calendar.events.patch({
        calendarId: args.calendarId,
        eventId: args.eventId,
        requestBody: { attendees: answered },
        sendUpdates: args.sendUpdates,
      });
      return { event: patched.data, wantsNewMeet: false };
    }
  }

  const wantsNewMeet = Boolean(args.addGoogleMeet) && !hasExistingConference(existingEvent);
  if (wantsNewMeet) {
    eventResource.conferenceData = buildMeetConferenceData();
  }

  // Version 1 whenever conference data rides in the body — newly requested OR
  // carried over from the existing event. Under the default version 0 Google
  // IGNORES `conferenceData`, so preserving an existing Meet across a
  // full-resource update would be resting on an unstated guarantee.
  const conferenceDataVersion = eventResource.conferenceData ? 1 : undefined;

  const response = await calendar.events.update({
    calendarId: args.calendarId,
    eventId: args.eventId,
    requestBody: eventResource,
    sendUpdates: args.sendUpdates,
    conferenceDataVersion,
  });
  return { event: response.data, wantsNewMeet };
}

/**
 * The JSON an event write returns over REST.
 *
 * A projection rather than Google's raw payload, because this shape is already
 * the published contract of the three ChatGPT-compat routes and clients parse
 * it. Defined here so the create, update and legacy PATCH routes cannot answer
 * the same resource three slightly different ways -- they each had their own
 * copy of this literal.
 */
export function projectEvent(event: calendar_v3.Schema$Event): Record<string, unknown> {
  return {
    id: event.id,
    summary: event.summary || null,
    description: event.description || null,
    location: event.location || null,
    start: event.start?.dateTime || event.start?.date || null,
    end: event.end?.dateTime || event.end?.date || null,
    status: event.status,
    htmlLink: event.htmlLink || null,
    hangoutLink: event.hangoutLink || null,
    conferenceData: event.conferenceData || null,
    creator: event.creator?.email || null,
    organizer: event.organizer?.email || null,
    attendees: (event.attendees || []).map((a) => ({
      email: a.email,
      responseStatus: a.responseStatus || 'needsAction',
      // Which entry is the caller's own. Without this a REST client cannot tell
      // its own row from a namesake's, and matching on email is wrong when the
      // account is invited through an alias or a group.
      self: a.self === true,
    })),
    // Hoisted so the caller's own answer is readable without scanning the list;
    // null when this account is not a guest. `myResponseStatus` on the update
    // route is what changes it.
    myResponseStatus: findSelfAttendee(event)?.responseStatus || null,
  };
}

calendarServer.addTool({
  name: 'createEvent',
  annotations: { readOnlyHint: false },
  description: 'Creates a new calendar event.',
  parameters: createEventSchema,
  execute: async (args, { log, session }) => {
    const calendar = getCalendarClient(session);
    log.info(`Creating event "${args.summary}" in calendar: ${args.calendarId}${args.addGoogleMeet ? ' (with Google Meet)' : ''}`);

    try {
      const event = await performCreateEvent(calendar, args);
      let result = `Event created successfully!\n\n` +
        `**Title:** ${event.summary}\n` +
        `**ID:** ${event.id}\n` +
        `**Start:** ${event.start?.dateTime || event.start?.date}\n` +
        `**End:** ${event.end?.dateTime || event.end?.date}\n` +
        `**Link:** ${event.htmlLink}`;
      result += formatConferenceDetail(event);
      result += formatMeetPendingHint(args.addGoogleMeet, event);
      return result;
    } catch (error: any) {
      log.error(`Error creating event: ${error.message || error}`);
      if (error.code === 403) throw new UserError("Permission denied. Make sure you have write access to this calendar.");
      throw new UserError(`Failed to create event: ${error.message || 'Unknown error'}`);
    }
  },
});

calendarServer.addTool({
  name: 'updateEvent',
  annotations: { readOnlyHint: false },
  description: 'Updates an existing calendar event. Only the fields you pass are changed; everything else on the event is preserved. Also ANSWERS AN INVITATION: pass myResponseStatus ("accepted", "tentative" or "declined") to set your own attendee response without touching anyone else\'s. Note that with the default sendUpdates "none" the organizer is not emailed about your answer — pass sendUpdates "all" if they should be.',
  parameters: updateEventSchema,
  execute: async (args, { log, session }) => {
    const calendar = getCalendarClient(session);
    log.info(`Updating event: ${args.eventId} in calendar: ${args.calendarId}${args.addGoogleMeet ? ' (adding Google Meet)' : ''}`);

    try {
      const { event, wantsNewMeet } = await performUpdateEvent(calendar, args);
      let result = `Event updated successfully!\n\n` +
        `**Title:** ${event.summary}\n` +
        `**ID:** ${event.id}\n` +
        `**Start:** ${event.start?.dateTime || event.start?.date}\n` +
        `**End:** ${event.end?.dateTime || event.end?.date}\n` +
        `**Link:** ${event.htmlLink}`;
      result += formatConferenceDetail(event);
      result += formatMeetPendingHint(wantsNewMeet, event);
      // RSVP confirmation, read back off the event Google returned rather than
      // echoing what was asked. events.update answers with the stored resource,
      // so this is the authoritative value — and a response Google declined to
      // record would otherwise read as a successful reply.
      if (args.myResponseStatus) {
        const stored = findSelfAttendee(event)?.responseStatus;
        result += stored === args.myResponseStatus
          ? `\n\n**Your response:** ${stored} — confirmed by Google.`
          : `\n\n⚠ Your response was NOT recorded as requested: asked for `
            + `"${args.myResponseStatus}", Google reports ${JSON.stringify(stored ?? null)}.`;
        if (args.sendUpdates === 'none') {
          result += `\n  The organizer was not emailed (sendUpdates "none"); pass sendUpdates "all" to notify them.`;
        }
      }
      return result;
    } catch (error: any) {
      log.error(`Error updating event: ${error.message || error}`);
      if (error.code === 404) throw new UserError(`Event not found (ID: ${args.eventId}).`);
      if (error.code === 403) throw new UserError("Permission denied. Make sure you have write access to this event.");
      throw new UserError(`Failed to update event: ${error.message || 'Unknown error'}`);
    }
  },
});

calendarServer.addTool({
  name: 'deleteEvent',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Deletes a calendar event.',
  parameters: deleteEventSchema,
  execute: async (args, { log, session }) => {
    const calendar = getCalendarClient(session);
    log.info(`Deleting event: ${args.eventId} from calendar: ${args.calendarId}`);

    try {
      await calendar.events.delete({
        calendarId: args.calendarId,
        eventId: args.eventId,
        sendUpdates: args.sendUpdates,
      });

      return `Event deleted successfully (ID: ${args.eventId}).`;
    } catch (error: any) {
      log.error(`Error deleting event: ${error.message || error}`);
      if (error.code === 404) throw new UserError(`Event not found (ID: ${args.eventId}).`);
      if (error.code === 403) throw new UserError("Permission denied. Make sure you have write access to this event.");
      throw new UserError(`Failed to delete event: ${error.message || 'Unknown error'}`);
    }
  },
});

export { calendarServer };
