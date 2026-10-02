import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { UserError } from 'fastmcp';

// The calendar write path had no tests at all: its two event-building functions
// lived inline in the tool bodies, with a second drifted copy in webServer.ts.
// Now that they are extracted, they can be driven against a stub client — the
// shape driveToolHandlers.test.ts established — and what goes to Google can be
// asserted rather than hoped for.
//
// Tool bodies are captured by patching FastMCP.addTool before importing the
// server, the trick the ClickUp suite uses, so the formatter + error mapping in
// each execute is covered too.

const toolMap = new Map<string, { execute: (...args: any[]) => any; parameters: any }>();
const FastMCPModule = await import('fastmcp');
const origAddTool = FastMCPModule.FastMCP.prototype.addTool;
FastMCPModule.FastMCP.prototype.addTool = function (tool: any) {
  toolMap.set(tool.name, tool);
  return origAddTool.call(this, tool);
};
const calendarModule = await import('../google-calendar/server.js');
FastMCPModule.FastMCP.prototype.addTool = origAddTool;

const {
  createEventSchema,
  updateEventSchema,
  deleteEventSchema,
  performCreateEvent,
  performUpdateEvent,
  projectEvent,
} = calendarModule as any;

const noopLog = { info: () => {}, error: () => {}, warn: () => {} };

function mkErr(code: number, message = 'boom'): any {
  const e: any = new Error(message);
  e.code = code;
  return e;
}

/** A calendar_v3.Calendar-shaped stub: only the four event methods are reached. */
function mkCalendar(overrides: any = {}): any {
  return {
    events: {
      insert: mock.fn(async () => ({ data: { id: 'evt-new', summary: 'Standup', htmlLink: 'https://cal/evt-new' } })),
      get: mock.fn(async () => ({
        data: {
          id: 'evt-1',
          etag: '"abc123"',
          summary: 'Existing',
          description: 'Existing notes',
          location: 'Room 1',
          start: { dateTime: '2026-01-15T10:00:00-05:00', timeZone: 'America/New_York' },
          end: { dateTime: '2026-01-15T11:00:00-05:00', timeZone: 'America/New_York' },
          attendees: [{ email: 'keep@example.com', responseStatus: 'accepted' }],
          // Everything below is what a whitelist-based merge silently deleted on
          // every update. recurrence is the worst of them: losing the RRULE stops
          // the event repeating.
          recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
          reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
          colorId: '5',
          visibility: 'private',
          transparency: 'transparent',
          attachments: [{ fileId: 'file-1', title: 'Agenda' }],
          extendedProperties: { private: { team: 'platform' } },
          guestsCanModify: true,
          guestsCanInviteOthers: false,
          sequence: 3,
        },
      })),
      update: mock.fn(async (params: any) => ({ data: { id: 'evt-1', ...params.requestBody } })),
      delete: mock.fn(async () => ({})),
      ...(overrides.events || {}),
    },
  };
}

const callTool = (name: string, args: any, session: any) =>
  toolMap.get(name)!.execute(args, { session, log: noopLog });

describe('calendar event write ops', () => {
  describe('performCreateEvent', () => {
    it('sends start/end as dateTime with the time zone, and no attendees key when none were given', async () => {
      const calendar = mkCalendar();
      await performCreateEvent(calendar, createEventSchema.parse({
        summary: 'Standup',
        startDateTime: '2026-01-15T10:00:00-05:00',
        endDateTime: '2026-01-15T11:00:00-05:00',
        timeZone: 'America/New_York',
      }));
      const sent = calendar.events.insert.mock.calls[0].arguments[0];
      assert.equal(sent.calendarId, 'primary');
      assert.deepEqual(sent.requestBody.start, { dateTime: '2026-01-15T10:00:00-05:00', timeZone: 'America/New_York' });
      assert.deepEqual(sent.requestBody.end, { dateTime: '2026-01-15T11:00:00-05:00', timeZone: 'America/New_York' });
      assert.equal('attendees' in sent.requestBody, false);
      // conferenceDataVersion must stay undefined without a Meet request, or
      // Google treats the call as a conference mutation.
      assert.equal(sent.conferenceDataVersion, undefined);
    });

    it('maps attendee emails into objects and asks for a Meet only when requested', async () => {
      const calendar = mkCalendar();
      await performCreateEvent(calendar, createEventSchema.parse({
        summary: 'Review',
        startDateTime: '2026-01-15T10:00:00Z',
        endDateTime: '2026-01-15T11:00:00Z',
        attendees: ['a@example.com', 'b@example.com'],
        addGoogleMeet: true,
      }));
      const sent = calendar.events.insert.mock.calls[0].arguments[0];
      assert.deepEqual(sent.requestBody.attendees, [{ email: 'a@example.com' }, { email: 'b@example.com' }]);
      assert.ok(sent.requestBody.conferenceData, 'expected a conference request');
      assert.equal(sent.conferenceDataVersion, 1);
    });

    it('defaults sendUpdates to none, so creating an event does not email anyone', async () => {
      const calendar = mkCalendar();
      await performCreateEvent(calendar, createEventSchema.parse({
        summary: 'Quiet',
        startDateTime: '2026-01-15T10:00:00Z',
        endDateTime: '2026-01-15T11:00:00Z',
      }));
      assert.equal(calendar.events.insert.mock.calls[0].arguments[0].sendUpdates, 'none');
    });
  });

  describe('performUpdateEvent', () => {
    it('preserves every field the caller did not name', async () => {
      const calendar = mkCalendar();
      await performUpdateEvent(calendar, updateEventSchema.parse({ eventId: 'evt-1', summary: 'Renamed' }));
      const sent = calendar.events.update.mock.calls[0].arguments[0].requestBody;
      assert.equal(sent.summary, 'Renamed');
      // events.update REPLACES the resource, so anything dropped here is cleared
      // on the real calendar. This is the assertion that pins the merge.
      assert.equal(sent.description, 'Existing notes');
      assert.equal(sent.location, 'Room 1');
      assert.deepEqual(sent.start, { dateTime: '2026-01-15T10:00:00-05:00', timeZone: 'America/New_York' });
      assert.deepEqual(sent.attendees, [{ email: 'keep@example.com', responseStatus: 'accepted' }]);
    });

    it('preserves the fields a whitelist merge destroyed — recurrence above all', async () => {
      const calendar = mkCalendar();
      await performUpdateEvent(calendar, updateEventSchema.parse({ eventId: 'evt-1', summary: 'Renamed' }));
      const sent = calendar.events.update.mock.calls[0].arguments[0].requestBody;
      // Dropping the RRULE turns a weekly standup into a one-off, from a call
      // that only changed the title.
      assert.deepEqual(sent.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO']);
      assert.deepEqual(sent.reminders, { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] });
      assert.equal(sent.colorId, '5');
      assert.equal(sent.visibility, 'private');
      assert.equal(sent.transparency, 'transparent');
      assert.deepEqual(sent.attachments, [{ fileId: 'file-1', title: 'Agenda' }]);
      assert.deepEqual(sent.extendedProperties, { private: { team: 'platform' } });
      assert.equal(sent.guestsCanModify, true);
      assert.equal(sent.guestsCanInviteOthers, false);
    });

    it('replaces start/end only when new values are given', async () => {
      const calendar = mkCalendar();
      await performUpdateEvent(calendar, updateEventSchema.parse({
        eventId: 'evt-1',
        startDateTime: '2026-02-01T09:00:00Z',
        timeZone: 'UTC',
      }));
      const sent = calendar.events.update.mock.calls[0].arguments[0].requestBody;
      assert.deepEqual(sent.start, { dateTime: '2026-02-01T09:00:00Z', timeZone: 'UTC' });
      assert.deepEqual(sent.end, { dateTime: '2026-01-15T11:00:00-05:00', timeZone: 'America/New_York' });
    });

    it('keeps the event time zone when a new time is given without one', async () => {
      const calendar = mkCalendar();
      await performUpdateEvent(calendar, updateEventSchema.parse({
        eventId: 'evt-1',
        startDateTime: '2026-02-01T09:00:00',
      }));
      const sent = calendar.events.update.mock.calls[0].arguments[0].requestBody;
      // timeZone is optional on the schema, and Google REQUIRES one on a
      // recurring event — dropping it here would break the fixture's RRULE.
      assert.deepEqual(sent.start, { dateTime: '2026-02-01T09:00:00', timeZone: 'America/New_York' });
    });

    it('converts an all-day event to a timed one without sending date and dateTime together', async () => {
      const calendar = mkCalendar({
        events: {
          get: mock.fn(async () => ({
            data: { id: 'evt-allday', start: { date: '2026-03-01' }, end: { date: '2026-03-02' } },
          })),
        },
      });
      await performUpdateEvent(calendar, updateEventSchema.parse({
        eventId: 'evt-allday',
        startDateTime: '2026-03-01T09:00:00Z',
        endDateTime: '2026-03-01T10:00:00Z',
      }));
      const sent = calendar.events.update.mock.calls[0].arguments[0].requestBody;
      // Google rejects a start carrying both keys, which is what spreading the
      // old all-day start over the new one would produce.
      assert.deepEqual(Object.keys(sent.start).sort(), ['dateTime', 'timeZone']);
      assert.equal(sent.start.date, undefined);
      assert.equal(sent.start.dateTime, '2026-03-01T09:00:00Z');
    });

    it('adds a Meet when the event has none', async () => {
      const calendar = mkCalendar();
      const { wantsNewMeet } = await performUpdateEvent(
        calendar,
        updateEventSchema.parse({ eventId: 'evt-1', addGoogleMeet: true }),
      );
      assert.equal(wantsNewMeet, true);
      assert.equal(calendar.events.update.mock.calls[0].arguments[0].conferenceDataVersion, 1);
    });

    it('does not request a second Meet when the event already has a conference', async () => {
      const calendar = mkCalendar({
        events: {
          get: mock.fn(async () => ({
            data: {
              id: 'evt-1',
              start: { dateTime: '2026-01-15T10:00:00Z' },
              end: { dateTime: '2026-01-15T11:00:00Z' },
              conferenceData: { conferenceId: 'already-here' },
            },
          })),
        },
      });
      const { wantsNewMeet } = await performUpdateEvent(
        calendar,
        updateEventSchema.parse({ eventId: 'evt-1', addGoogleMeet: true }),
      );
      assert.equal(wantsNewMeet, false);
      const sent = calendar.events.update.mock.calls[0].arguments[0];
      // Version 1 even though no NEW Meet was asked for: under the default 0
      // Google ignores conferenceData in the body, so carrying the existing
      // conference through a full-resource update would rest on an unstated
      // guarantee. wantsNewMeet stays false — that flag is about whether to warn
      // the caller a fresh link may lag, not about the request version.
      assert.equal(sent.conferenceDataVersion, 1);
      assert.deepEqual(sent.requestBody.conferenceData, { conferenceId: 'already-here' });
    });

    it('sends no conference version when the event has none and none was asked for', async () => {
      const calendar = mkCalendar({
        events: {
          get: mock.fn(async () => ({
            data: { id: 'evt-1', start: { dateTime: '2026-01-15T10:00:00Z' }, end: { dateTime: '2026-01-15T11:00:00Z' } },
          })),
        },
      });
      await performUpdateEvent(calendar, updateEventSchema.parse({ eventId: 'evt-1', summary: 'Renamed' }));
      assert.equal(calendar.events.update.mock.calls[0].arguments[0].conferenceDataVersion, undefined);
    });
  });

  describe('projectEvent', () => {
    it('flattens dateTime or date, and nulls what is absent', () => {
      const out = projectEvent({
        id: 'e1',
        status: 'confirmed',
        start: { date: '2026-03-01' },
        end: { dateTime: '2026-03-02T00:00:00Z' },
      });
      assert.equal(out.id, 'e1');
      assert.equal(out.start, '2026-03-01');
      assert.equal(out.end, '2026-03-02T00:00:00Z');
      assert.equal(out.summary, null);
      assert.equal(out.hangoutLink, null);
      assert.deepEqual(out.attendees, []);
    });

    it('flattens an all-day end and surfaces creator and organizer emails', () => {
      const out: any = projectEvent({
        id: 'e2',
        summary: 'Offsite',
        start: { date: '2026-04-01' },
        end: { date: '2026-04-02' },
        creator: { email: 'organiser@example.com' },
        organizer: { email: 'team@example.com' },
        hangoutLink: 'https://meet.google.com/abc-defg-hij',
      });
      assert.equal(out.end, '2026-04-02');
      assert.equal(out.creator, 'organiser@example.com');
      assert.equal(out.organizer, 'team@example.com');
      assert.equal(out.hangoutLink, 'https://meet.google.com/abc-defg-hij');
    });

    it('defaults a missing attendee responseStatus to needsAction', () => {
      const out: any = projectEvent({ id: 'e1', attendees: [{ email: 'a@b.com' }] });
      assert.deepEqual(out.attendees, [{ email: 'a@b.com', responseStatus: 'needsAction' }]);
    });
  });
});

describe('calendar write tools', () => {
  it('createEvent reports the created event', async () => {
    const calendar = mkCalendar();
    const out = await callTool('createEvent', createEventSchema.parse({
      summary: 'Standup',
      startDateTime: '2026-01-15T10:00:00Z',
      endDateTime: '2026-01-15T11:00:00Z',
    }), { googleCalendar: calendar });
    assert.match(out, /Event created successfully/);
    assert.match(out, /evt-new/);
  });

  it('createEvent turns a 403 into a message about write access', async () => {
    const calendar = mkCalendar({ events: { insert: mock.fn(async () => { throw mkErr(403); }) } });
    await assert.rejects(
      () => callTool('createEvent', createEventSchema.parse({
        summary: 'x', startDateTime: '2026-01-15T10:00:00Z', endDateTime: '2026-01-15T11:00:00Z',
      }), { googleCalendar: calendar }),
      (err: any) => err instanceof UserError && /write access/.test(err.message),
    );
  });

  it('updateEvent reports the updated event', async () => {
    const calendar = mkCalendar();
    const out = await callTool('updateEvent', updateEventSchema.parse({ eventId: 'evt-1', summary: 'Renamed' }), { googleCalendar: calendar });
    assert.match(out, /Event updated successfully/);
  });

  it('updateEvent names the event when Google 404s', async () => {
    const calendar = mkCalendar({ events: { get: mock.fn(async () => { throw mkErr(404); }) } });
    await assert.rejects(
      () => callTool('updateEvent', updateEventSchema.parse({ eventId: 'missing' }), { googleCalendar: calendar }),
      (err: any) => err instanceof UserError && /missing/.test(err.message),
    );
  });

  it('deleteEvent passes sendUpdates through', async () => {
    const calendar = mkCalendar();
    const out = await callTool('deleteEvent', deleteEventSchema.parse({ eventId: 'evt-1', sendUpdates: 'all' }), { googleCalendar: calendar });
    assert.match(out, /deleted successfully/);
    assert.equal(calendar.events.delete.mock.calls[0].arguments[0].sendUpdates, 'all');
  });

  it('every write tool refuses a session with no calendar client', async () => {
    for (const [name, args] of [
      ['createEvent', { summary: 'x', startDateTime: 'a', endDateTime: 'b' }],
      ['updateEvent', { eventId: 'e' }],
      ['deleteEvent', { eventId: 'e' }],
    ] as const) {
      await assert.rejects(
        () => callTool(name, args, {}),
        (err: any) => err instanceof UserError,
        `${name} should refuse an unconnected session`,
      );
    }
  });
});
