# Google Calendar — notes for Claude

## Rules and limitations

### REST writes
- **Validate with `createEventSchema`, `updateEventSchema`, `deleteEventSchema`**; ops `performCreateEvent`/`performUpdateEvent`/`projectEvent` live here so webServer holds no second copy. Legacy `POST /api/v1/calendars/{id}/events` is unchanged (`openapiOperationId: createEvent`).
- **`performUpdateEvent` pre-reads with `events.get`** — `events.update` replaces the resource, so omitted fields would be cleared.
- **Update is a POST on the event path** (`updateCalendarEvent`; catalog is `GET | POST`), sharing a handler with the legacy PATCH.
- **`deleteEvent` is destructive, exposed with sign-off** as `POST .../events/{eventId}/cancel`.
- **`projectEvent` is a published contract** — keys may be added, never renamed or removed.

### RSVP (`myResponseStatus`)
- **No "set my response" endpoint; a partial `attendees` array replaces the list** — swap only the caller's row in the array `events.get` returned.
- **RSVP alone is an `events.patch` of `attendees` only** — a full update may 403 for a non-organiser. Reasoned, not verified live. Combined with other edits it uses the merge.
- **Find the caller by `self: true`, never by email** (aliases/groups). No `self` row → refuse, nothing written (adding it would self-invite).
- **Offer three values** — not `needsAction` (an un-answer).
- **Confirm from the event Google returned**, not the request.
- **`sendUpdates` defaults to `none`** — the organiser isn't told; description and response say so.
- `listEvents` renders `My response:` (incl. `needsAction (not answered yet)`); `getEvent` marks `— you`.
- **No ETag** — a concurrent write between read and write can be overwritten.

## Source Files

| File | Contains |
|------|----------|
| `src/google-calendar/server.ts` | Tool definitions; exported write schemas and ops |
