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
  findSelfAttendee,
  describeSelfResponse,
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
      patch: mock.fn(async (params: any) => ({ data: { id: 'evt-1', ...params.requestBody } })),
      delete: mock.fn(async () => ({})),
      ...(overrides.events || {}),
    },
  };
}

/**
 * An event the caller is actually invited to: their own row is marked
 * `self: true` and carries a DIFFERENT email from the others, which is what
 * makes an email-matching implementation fail these tests.
 */
function mkInvitedCalendar(selfStatus = 'needsAction', storedAfterUpdate?: string) {
  const attendees = [
    { email: 'organizer@example.com', responseStatus: 'accepted' },
    { email: 'me-alias@example.com', responseStatus: selfStatus, self: true },
    { email: 'other@example.com', responseStatus: 'declined' },
  ];
  return mkCalendar({
    events: {
      get: mock.fn(async () => ({
        data: {
          id: 'evt-1',
          summary: 'Invited',
          start: { dateTime: '2026-01-15T10:00:00Z' },
          end: { dateTime: '2026-01-15T11:00:00Z' },
          attendees,
          recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
        },
      })),
      update: mock.fn(async (params: any) => ({
        data: {
          id: 'evt-1',
          ...params.requestBody,
          // Lets a test simulate Google storing something other than what was
          // asked for, which must not be reported as a successful reply.
          ...(storedAfterUpdate
            ? {
              attendees: (params.requestBody.attendees || []).map((a: any) =>
                a.self ? { ...a, responseStatus: storedAfterUpdate } : a),
            }
            : {}),
        },
      })),
      patch: mock.fn(async (params: any) => ({
        data: {
          id: 'evt-1',
          summary: 'Invited',
          ...params.requestBody,
          ...(storedAfterUpdate
            ? {
              attendees: (params.requestBody.attendees || []).map((a: any) =>
                a.self ? { ...a, responseStatus: storedAfterUpdate } : a),
            }
            : {}),
        },
      })),
    },
  });
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
      // `self` is additive: this projection is the published contract of the
      // ChatGPT-compat event routes, so keys may be ADDED (clients ignore what
      // they do not read) but never renamed or removed. An attendee Google does
      // not mark is not the caller, so the default is false rather than absent.
      assert.deepEqual(out.attendees, [{ email: 'a@b.com', responseStatus: 'needsAction', self: false }]);
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

describe('answering an invitation (myResponseStatus)', () => {
  it('sets only the caller own response and leaves every other guest untouched', async () => {
    const calendar = mkInvitedCalendar('needsAction');
    await performUpdateEvent(calendar, updateEventSchema.parse({
      eventId: 'evt-1', myResponseStatus: 'accepted',
    }));
    const sent = calendar.events.patch.mock.calls[0].arguments[0].requestBody;
    // Google has no "set my response" endpoint, so answering means writing the
    // whole guest list back — and a partial attendees array UNINVITES everyone
    // absent from it. This is the assertion that pins that.
    assert.equal(sent.attendees.length, 3);
    assert.deepEqual(
      sent.attendees.map((a: any) => [a.email, a.responseStatus]),
      [
        ['organizer@example.com', 'accepted'],
        ['me-alias@example.com', 'accepted'],
        ['other@example.com', 'declined'],
      ],
    );
    // An RSVP-only call patches ONLY the guest list: handing an organiser's
    // fields back on someone else's meeting is what risks a 403 when
    // guestsCanModify is false, so their absence here is the point.
    assert.deepEqual(Object.keys(sent), ['attendees']);
    assert.equal(calendar.events.update.mock.calls.length, 0, 'an RSVP must not send a full-resource update');
  });

  it('identifies the caller by self, not by matching an email', async () => {
    // The self row's address differs from every other attendee's and from any
    // plausible account address: an implementation comparing emails would find
    // nobody here and silently change nothing.
    const calendar = mkInvitedCalendar('needsAction');
    await performUpdateEvent(calendar, updateEventSchema.parse({
      eventId: 'evt-1', myResponseStatus: 'declined',
    }));
    const sent = calendar.events.patch.mock.calls[0].arguments[0].requestBody;
    const self = sent.attendees.find((a: any) => a.self === true);
    assert.equal(self.responseStatus, 'declined');
    assert.equal(self.email, 'me-alias@example.com');
  });

  for (const status of ['accepted', 'tentative', 'declined'] as const) {
    it(`writes ${status} through`, async () => {
      const calendar = mkInvitedCalendar('needsAction');
      await performUpdateEvent(calendar, updateEventSchema.parse({ eventId: 'evt-1', myResponseStatus: status }));
      const sent = calendar.events.patch.mock.calls[0].arguments[0].requestBody;
      assert.equal(sent.attendees.find((a: any) => a.self).responseStatus, status);
    });
  }

  it('refuses when the caller is not a guest, and adds nobody', async () => {
    // mkCalendar's event has one attendee and no self row — the organizer case.
    const calendar = mkCalendar();
    await assert.rejects(
      () => performUpdateEvent(calendar, updateEventSchema.parse({
        eventId: 'evt-1', myResponseStatus: 'accepted',
      })),
      (err: any) => /not in its guest list/.test(err.message),
    );
    // Inviting yourself is a different act from replying, so nothing is written.
    assert.equal(calendar.events.update.mock.calls.length, 0);
    assert.equal(calendar.events.patch.mock.calls.length, 0);
  });

  it('uses the full merge when the RSVP rides along with another edit', async () => {
    const calendar = mkInvitedCalendar('needsAction');
    await performUpdateEvent(calendar, updateEventSchema.parse({
      eventId: 'evt-1', myResponseStatus: 'accepted', summary: 'Renamed',
    }));
    // Such a caller is editing the event anyway, so it needs the merge
    // semantics — and the answered guest list has to ride along with it.
    assert.equal(calendar.events.patch.mock.calls.length, 0);
    const sent = calendar.events.update.mock.calls[0].arguments[0].requestBody;
    assert.equal(sent.summary, 'Renamed');
    assert.equal(sent.attendees.find((a: any) => a.self).responseStatus, 'accepted');
    assert.deepEqual(sent.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO']);
  });

  it('leaves the guest list alone when no response was requested', async () => {
    const calendar = mkInvitedCalendar('needsAction');
    await performUpdateEvent(calendar, updateEventSchema.parse({ eventId: 'evt-1', summary: 'Renamed' }));
    const sent = calendar.events.update.mock.calls[0].arguments[0].requestBody;
    assert.equal(sent.attendees.find((a: any) => a.self).responseStatus, 'needsAction');
  });

  it('defaults to not emailing the organizer', async () => {
    const calendar = mkInvitedCalendar('needsAction');
    await performUpdateEvent(calendar, updateEventSchema.parse({ eventId: 'evt-1', myResponseStatus: 'accepted' }));
    assert.equal(calendar.events.patch.mock.calls[0].arguments[0].sendUpdates, 'none');
  });
});

describe('self-attendee helpers', () => {
  it('finds the self row and reports needsAction as an explicit non-answer', () => {
    const event: any = {
      attendees: [
        { email: 'a@example.com', responseStatus: 'accepted' },
        { email: 'me@example.com', responseStatus: 'needsAction', self: true },
      ],
    };
    assert.equal(findSelfAttendee(event)?.email, 'me@example.com');
    // A planner hunting for invitations to answer is looking for exactly this
    // state, so it must render rather than read as "nothing to see".
    assert.match(describeSelfResponse(event)!, /needsAction/);
  });

  it('returns null when the caller is not a guest', () => {
    assert.equal(describeSelfResponse({ attendees: [{ email: 'a@example.com' }] } as any), null);
    assert.equal(describeSelfResponse({} as any), null);
    assert.equal(findSelfAttendee({} as any), undefined);
  });

  it('projects self and the hoisted myResponseStatus for REST clients', () => {
    const projected: any = projectEvent({
      id: 'evt-1',
      attendees: [
        { email: 'a@example.com', responseStatus: 'accepted' },
        { email: 'me@example.com', responseStatus: 'tentative', self: true },
      ],
    } as any);
    assert.equal(projected.myResponseStatus, 'tentative');
    assert.deepEqual(projected.attendees.map((a: any) => a.self), [false, true]);
  });

  it('projects myResponseStatus as null when the caller is not a guest', () => {
    const projected: any = projectEvent({ id: 'evt-1', attendees: [{ email: 'a@example.com' }] } as any);
    assert.equal(projected.myResponseStatus, null);
  });
});
