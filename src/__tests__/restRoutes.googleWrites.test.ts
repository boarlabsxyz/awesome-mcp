import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import request from 'supertest';
import { createWebOnlyApp } from '../website/webServer.js';
import { createOrUpdateUser, getUserByGoogleId, UserTokens } from '../userStore.js';
import { createMcpInstance, GoogleTokens } from '../mcpConnectionStore.js';

// The auth-gate suite proves these POST routes exist and reject an
// unauthenticated caller. This file executes the half that gate never reaches:
// the safeParse branch.
//
// It is the regression test for what these endpoints replaced. The ChatGPT-compat
// routes validated with `if (!range || !values)` — presence and nothing else — so
// `values: "a,b"` (a string, not the 2D array the API needs) passed and failed
// upstream as an opaque Google 400, and `attendees: "a@b.com"` reached Google as
// a string. Every case below is a body the old checks accepted.
//
// No upstream mock is needed or wanted: validation runs before the Google call,
// so a 400 here also proves the body never reached the API.

if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: {
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:8080/auth/callback'],
    },
  });
}

const USER_ID = 8802;

const dummyUserTokens: UserTokens = {
  access_token: 'acc',
  refresh_token: 'ref',
  scope: 'email',
  token_type: 'Bearer',
  expiry_date: Date.now() + 3600_000,
};

const dummyGoogleTokens: GoogleTokens = {
  access_token: 'mcp-acc',
  refresh_token: 'mcp-ref',
  scope: 'email',
  token_type: 'Bearer',
  expiry_date: Date.now() + 3600_000,
};

describe('REST data plane: Google Sheets and Calendar write validation', () => {
  const app = createWebOnlyApp();
  let bearer: string;

  before(async () => {
    const created = await createOrUpdateUser(
      { email: 'rest-google-writes@example.com', googleId: 'google-rest-writes', name: 'REST Google Writes' },
      dummyUserTokens,
    );
    bearer = created.apiKey;
    // The file store does not assign the numeric id the connection lookup keys
    // on, so pin one — same trick the other REST suites use.
    const user = await getUserByGoogleId('google-rest-writes');
    if (user) (user as any).id = USER_ID;

    // No `provider` argument: these are Google connections, so createServiceAuth
    // builds the session down its Google OAuth path, which is what gives the
    // handler googleSheets / googleCalendar / googleDrive clients.
    await createMcpInstance(USER_ID, 'google-sheets', 'Test Sheets', dummyGoogleTokens, null);
    await createMcpInstance(USER_ID, 'google-calendar', 'Test Calendar', dummyGoogleTokens, null);
  });

  const auth = () => ({ Authorization: `Bearer ${bearer}` });

  /** Assert a 400 carrying Zod's flattened issues, and name the offending field. */
  async function expectInvalid(path: string, body: unknown, field: string) {
    const res = await request(app).post(path).set(auth()).send(body as object);
    assert.equal(res.status, 400, `expected 400 for ${path}, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, 'Invalid request body');
    assert.ok(res.body.issues, 'expected flattened Zod issues in the response');
    assert.ok(
      res.body.issues.fieldErrors?.[field],
      `expected an issue on "${field}", got ${JSON.stringify(res.body.issues.fieldErrors)}`,
    );
  }

  describe('Sheets', () => {
    it('rejects values sent as a string instead of a 2D array', async () => {
      await expectInvalid('/api/v1/sheets/sheet-123/write', { range: 'A1:B2', values: 'a,b' }, 'values');
    });

    it('rejects a 1D array of values — the shape is rows of cells', async () => {
      await expectInvalid('/api/v1/sheets/sheet-123/write', { range: 'A1:B2', values: ['a', 'b'] }, 'values');
    });

    it('rejects a missing range on write and on append', async () => {
      await expectInvalid('/api/v1/sheets/sheet-123/write', { values: [['a']] }, 'range');
      await expectInvalid('/api/v1/sheets/sheet-123/append', { values: [['a']] }, 'range');
    });

    it('rejects an unknown valueInputOption rather than letting Google decide', async () => {
      await expectInvalid(
        '/api/v1/sheets/sheet-123/append',
        { range: 'A1', values: [['a']], valueInputOption: 'MAGIC' },
        'valueInputOption',
      );
    });

    it('rejects an empty title on create', async () => {
      await expectInvalid('/api/v1/sheets', { title: '' }, 'title');
    });

    it('rejects initialData that is not rows', async () => {
      await expectInvalid('/api/v1/sheets', { title: 'Seeded', initialData: ['a', 'b'] }, 'initialData');
    });

    it('rejects an empty operations list on batchUpdate — an empty batch is not a write', async () => {
      await expectInvalid('/api/v1/sheets/sheet-123/batchUpdate', { operations: [] }, 'operations');
    });

    it('rejects an unknown operation type on batchUpdate', async () => {
      await expectInvalid(
        '/api/v1/sheets/sheet-123/batchUpdate',
        { operations: [{ type: 'notAnOperation' }] },
        'operations',
      );
    });

    it('rejects a clear with no range — it must never be able to mean the whole sheet', async () => {
      await expectInvalid('/api/v1/sheets/sheet-123/ranges/clear', {}, 'range');
    });
  });

  describe('body size', () => {
    // The point of a spreadsheet write on this plane is bulk rows, and the global
    // express.json() limit is 100kb — so without '/api/v1/sheets' in
    // REST_LARGE_BODY_PREFIXES these endpoints would 413 the exact use case they
    // exist for, with an HTML error page. A 400 here proves the 5mb parser ran:
    // the body was parsed and reached validation.
    const bigCell = 'x'.repeat(300_000); // ~300kb, well past the 100kb default

    it('parses a body far past the global 100kb limit on a range write', async () => {
      const res = await request(app)
        .post('/api/v1/sheets/sheet-123/write')
        .set(auth())
        .send({ range: 'A1', values: bigCell } as object);
      assert.equal(res.status, 400, `expected validation, not 413; got ${res.status}`);
      assert.ok(res.body.issues.fieldErrors.values);
    });

    it('parses a large seed body on create', async () => {
      const res = await request(app)
        .post('/api/v1/sheets')
        .set(auth())
        .send({ title: '', initialData: [[bigCell]] } as object);
      assert.equal(res.status, 400, `expected validation, not 413; got ${res.status}`);
      assert.ok(res.body.issues.fieldErrors.title);
    });
  });

  describe('Calendar', () => {
    const validEvent = {
      summary: 'Standup',
      startDateTime: '2026-01-15T10:00:00-05:00',
      endDateTime: '2026-01-15T11:00:00-05:00',
    };

    it('names every missing required field at once', async () => {
      const res = await request(app).post('/api/v1/calendars/primary/events').set(auth()).send({});
      assert.equal(res.status, 400);
      const fields = res.body.issues.fieldErrors;
      assert.ok(fields.summary);
      assert.ok(fields.startDateTime);
      assert.ok(fields.endDateTime);
    });

    it('rejects attendees as a bare string', async () => {
      await expectInvalid('/api/v1/calendars/primary/events', { ...validEvent, attendees: 'a@b.com' }, 'attendees');
    });

    it('rejects a sendUpdates value Google does not accept', async () => {
      await expectInvalid('/api/v1/calendars/primary/events', { ...validEvent, sendUpdates: 'everyone' }, 'sendUpdates');
    });

    it('rejects addGoogleMeet as a string', async () => {
      await expectInvalid('/api/v1/calendars/primary/events', { ...validEvent, addGoogleMeet: 'yes' }, 'addGoogleMeet');
    });

    it('validates the update body too, on the POST and the legacy PATCH alike', async () => {
      await expectInvalid('/api/v1/calendars/primary/events/evt-1', { sendUpdates: 'maybe' }, 'sendUpdates');
      const res = await request(app)
        .patch('/api/v1/calendars/primary/events/evt-1')
        .set(auth())
        .send({ sendUpdates: 'maybe' });
      assert.equal(res.status, 400, 'the legacy PATCH shares the handler, so it shares the validation');
      assert.ok(res.body.issues.fieldErrors.sendUpdates);
    });

    it('validates the cancel body — sendUpdates decides whether attendees are emailed', async () => {
      await expectInvalid('/api/v1/calendars/primary/events/evt-1/cancel', { sendUpdates: 'everyone' }, 'sendUpdates');
    });
  });
});
