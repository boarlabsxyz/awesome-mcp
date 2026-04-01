// src/calendarServer.ts
import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';
import { calendar_v3 } from 'googleapis';

import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';

const calendarServer = new FastMCP<UserSession>({
  name: 'Google Calendar MCP Server',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'google-calendar'),
});

// --- Helper to get Calendar client within tools ---
function getCalendarClient(session?: UserSession): calendar_v3.Calendar {
  if (session?.googleCalendar) return session.googleCalendar;
  throw new UserError("Google Calendar client is not available. Make sure you have granted calendar access.");
}

// === TOOL DEFINITIONS ===

calendarServer.addTool({
  name: 'listCalendars',
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
  description: 'Lists events from a calendar within a specified date range.',
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
        }
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
  description: 'Gets detailed information about a specific calendar event.',
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
          result += `  - ${attendee.email} (${attendee.responseStatus || 'unknown'})\n`;
        });
      }
      if (event.recurrence) {
        result += `\n**Recurrence:** ${event.recurrence.join(', ')}\n`;
      }
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

calendarServer.addTool({
  name: 'createEvent',
  description: 'Creates a new calendar event.',
  parameters: z.object({
    calendarId: z.string().optional().default('primary')
      .describe('The calendar ID. Use "primary" for the user\'s primary calendar.'),
    summary: z.string().describe('The title of the event.'),
    description: z.string().optional().describe('Description or notes for the event.'),
    location: z.string().optional().describe('Geographic location of the event.'),
    startDateTime: z.string().describe('Start time in ISO 8601 format (e.g., "2024-01-15T10:00:00-05:00").'),
    endDateTime: z.string().describe('End time in ISO 8601 format (e.g., "2024-01-15T11:00:00-05:00").'),
    timeZone: z.string().optional().describe('Time zone (e.g., "America/New_York"). Defaults to calendar\'s time zone.'),
    attendees: z.array(z.string()).optional().describe('List of attendee email addresses.'),
    sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional().default('none')
      .describe('Whether to send email notifications to attendees.'),
  }),
  execute: async (args, { log, session }) => {
    const calendar = getCalendarClient(session);
    log.info(`Creating event "${args.summary}" in calendar: ${args.calendarId}`);

    try {
      const eventResource: calendar_v3.Schema$Event = {
        summary: args.summary,
        description: args.description,
        location: args.location,
        start: {
          dateTime: args.startDateTime,
          timeZone: args.timeZone,
        },
        end: {
          dateTime: args.endDateTime,
          timeZone: args.timeZone,
        },
      };

      if (args.attendees && args.attendees.length > 0) {
        eventResource.attendees = args.attendees.map(email => ({ email }));
      }

      const response = await calendar.events.insert({
        calendarId: args.calendarId,
        requestBody: eventResource,
        sendUpdates: args.sendUpdates,
      });

      const event = response.data;
      return `Event created successfully!\n\n` +
        `**Title:** ${event.summary}\n` +
        `**ID:** ${event.id}\n` +
        `**Start:** ${event.start?.dateTime || event.start?.date}\n` +
        `**End:** ${event.end?.dateTime || event.end?.date}\n` +
        `**Link:** ${event.htmlLink}`;
    } catch (error: any) {
      log.error(`Error creating event: ${error.message || error}`);
      if (error.code === 403) throw new UserError("Permission denied. Make sure you have write access to this calendar.");
      throw new UserError(`Failed to create event: ${error.message || 'Unknown error'}`);
    }
  },
});

calendarServer.addTool({
  name: 'updateEvent',
  description: 'Updates an existing calendar event.',
  parameters: z.object({
    calendarId: z.string().optional().default('primary')
      .describe('The calendar ID. Use "primary" for the user\'s primary calendar.'),
    eventId: z.string().describe('The event ID to update.'),
    summary: z.string().optional().describe('New title for the event.'),
    description: z.string().optional().describe('New description for the event.'),
    location: z.string().optional().describe('New location for the event.'),
    startDateTime: z.string().optional().describe('New start time in ISO 8601 format.'),
    endDateTime: z.string().optional().describe('New end time in ISO 8601 format.'),
    timeZone: z.string().optional().describe('Time zone for the start/end times.'),
    sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional().default('none')
      .describe('Whether to send email notifications to attendees.'),
  }),
  execute: async (args, { log, session }) => {
    const calendar = getCalendarClient(session);
    log.info(`Updating event: ${args.eventId} in calendar: ${args.calendarId}`);

    try {
      // First, get the existing event
      const existingResponse = await calendar.events.get({
        calendarId: args.calendarId,
        eventId: args.eventId,
      });

      const existingEvent = existingResponse.data;

      // Build the update payload, preserving existing values
      const eventResource: calendar_v3.Schema$Event = {
        summary: args.summary ?? existingEvent.summary,
        description: args.description ?? existingEvent.description,
        location: args.location ?? existingEvent.location,
        start: args.startDateTime ? {
          dateTime: args.startDateTime,
          timeZone: args.timeZone,
        } : existingEvent.start,
        end: args.endDateTime ? {
          dateTime: args.endDateTime,
          timeZone: args.timeZone,
        } : existingEvent.end,
        attendees: existingEvent.attendees,
      };

      const response = await calendar.events.update({
        calendarId: args.calendarId,
        eventId: args.eventId,
        requestBody: eventResource,
        sendUpdates: args.sendUpdates,
      });

      const event = response.data;
      return `Event updated successfully!\n\n` +
        `**Title:** ${event.summary}\n` +
        `**ID:** ${event.id}\n` +
        `**Start:** ${event.start?.dateTime || event.start?.date}\n` +
        `**End:** ${event.end?.dateTime || event.end?.date}\n` +
        `**Link:** ${event.htmlLink}`;
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
  description: 'Deletes a calendar event.',
  parameters: z.object({
    calendarId: z.string().optional().default('primary')
      .describe('The calendar ID. Use "primary" for the user\'s primary calendar.'),
    eventId: z.string().describe('The event ID to delete.'),
    sendUpdates: z.enum(['all', 'externalOnly', 'none']).optional().default('none')
      .describe('Whether to send email notifications to attendees.'),
  }),
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
