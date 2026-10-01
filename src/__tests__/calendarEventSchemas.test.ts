import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createEventSchema, updateEventSchema } from '../google-calendar/server.js';

// These schemas back BOTH the createEvent/updateEvent MCP tools and the
// POST /api/v1/calendars/... REST routes (which safeParse req.body with them).
// Testing them directly is what pins the shared validation contract: the REST
// layer has no FastMCP Zod pass in front of it, so a regression here would let
// a malformed curl body through to the Google API.
describe('createEventSchema', () => {
  const valid = {
    summary: 'Standup',
    startDateTime: '2026-01-15T10:00:00-05:00',
    endDateTime: '2026-01-15T11:00:00-05:00',
  };

  it('accepts the minimum body and defaults calendarId/addGoogleMeet/sendUpdates', () => {
    const r = createEventSchema.safeParse(valid);
    assert.equal(r.success, true);
    assert.equal(r.data!.calendarId, 'primary');
    assert.equal(r.data!.addGoogleMeet, false);
    // Default "none" is load-bearing: it is what stops a REST caller silently
    // emailing every attendee.
    assert.equal(r.data!.sendUpdates, 'none');
  });

  it('rejects a body missing the required fields, naming each one', () => {
    const r = createEventSchema.safeParse({});
    assert.equal(r.success, false);
    const fields = r.error!.flatten().fieldErrors;
    assert.ok(fields.summary, 'expected an issue on summary');
    assert.ok(fields.startDateTime, 'expected an issue on startDateTime');
    assert.ok(fields.endDateTime, 'expected an issue on endDateTime');
  });

  it('rejects wrong-typed fields the old hand-rolled presence checks let through', () => {
    assert.equal(createEventSchema.safeParse({ ...valid, attendees: 'a@b.com' }).success, false);
    assert.equal(createEventSchema.safeParse({ ...valid, attendees: [1, 2] }).success, false);
    assert.equal(createEventSchema.safeParse({ ...valid, sendUpdates: 'everyone' }).success, false);
    assert.equal(createEventSchema.safeParse({ ...valid, addGoogleMeet: 'yes' }).success, false);
  });

  it('accepts a full body', () => {
    const r = createEventSchema.safeParse({
      ...valid,
      calendarId: 'team@group.calendar.google.com',
      description: 'Daily sync',
      location: 'Room 1',
      timeZone: 'America/New_York',
      attendees: ['a@b.com', 'c@d.com'],
      addGoogleMeet: true,
      sendUpdates: 'all',
    });
    assert.equal(r.success, true);
    assert.deepEqual(r.data!.attendees, ['a@b.com', 'c@d.com']);
  });
});

describe('updateEventSchema', () => {
  it('requires eventId', () => {
    const r = updateEventSchema.safeParse({ summary: 'New title' });
    assert.equal(r.success, false);
    assert.ok(r.error!.flatten().fieldErrors.eventId);
  });

  it('accepts an eventId alone — every content field is optional (merge semantics)', () => {
    const r = updateEventSchema.safeParse({ eventId: 'evt-123' });
    assert.equal(r.success, true);
    assert.equal(r.data!.calendarId, 'primary');
    assert.equal(r.data!.sendUpdates, 'none');
  });

  it('rejects an invalid sendUpdates value', () => {
    assert.equal(updateEventSchema.safeParse({ eventId: 'evt-123', sendUpdates: 'maybe' }).success, false);
  });
});
