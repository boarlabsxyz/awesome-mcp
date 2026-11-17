// src/__tests__/gmailRestRoutes.test.ts
// Drives every descriptor in GMAIL_WRITE_ROUTES against a stubbed client: what
// reaches Gmail, the status, and the answer. A route's success path cannot be
// reached through supertest, because gaxios does not use the global fetch, so
// this is where it is covered; the safeParse branch is in the suite below.
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { GMAIL_WRITE_ROUTES, gmailPassthroughStatus, writeArgs } from '../google-gmail/restRoutes.js';
import type { GmailWriteRoute } from '../google-gmail/restRoutes.js';
import { REST_CATALOG } from '../restCatalog.js';

function mockGmail(overrides: Record<string, any> = {}) {
  return {
    users: {
      messages: {
        send: mock.fn(async () => ({ data: { id: 'm1', threadId: 't1', labelIds: ['SENT'] } })),
        modify: mock.fn(async () => ({ data: { id: 'm1', labelIds: ['STARRED'], snippet: 'x' } })),
        trash: mock.fn(async () => ({})),
        batchModify: mock.fn(async () => ({})),
        ...overrides.messages,
      },
      drafts: {
        create: mock.fn(async () => ({ data: { id: 'd1', message: { id: 'm2' } } })),
      },
      labels: {
        list: mock.fn(async () => ({ data: { labels: [{ id: 'L1', name: 'Work', type: 'user' }] } })),
        create: mock.fn(async () => ({ data: { id: 'L2', name: 'New', type: 'user' } })),
        patch: mock.fn(async () => ({ data: { id: 'L1', name: 'Renamed' } })),
        delete: mock.fn(async () => ({})),
      },
    },
  } as any;
}

function routeFor(tool: string): GmailWriteRoute {
  const route = GMAIL_WRITE_ROUTES.find((r) => r.tool === tool);
  assert.ok(route, `no route for ${tool}`);
  return route;
}

async function drive(tool: string, params: Record<string, string>, body: unknown, gmail = mockGmail()) {
  const route = routeFor(tool);
  const parsed = route.schema.parse(writeArgs(route, { params, body }));
  return { ...(await route.run(gmail, parsed)), gmail };
}

const decode = (raw: string) => Buffer.from(raw, 'base64url').toString();

describe('GMAIL_WRITE_ROUTES', () => {
  it('has one catalog entry per descriptor and none without one', () => {
    const catalogued = REST_CATALOG.filter((e) => e.service === 'gmail' && e.method === 'POST');
    assert.equal(catalogued.length, GMAIL_WRITE_ROUTES.length);
    for (const route of GMAIL_WRITE_ROUTES) {
      const path = route.path.replace(/:([A-Za-z]+)/g, '{$1}');
      assert.ok(catalogued.some((e) => e.path === path && e.mcpToolName === route.tool), route.path);
    }
  });

  it('registers get-or-create ahead of the :labelId route that would swallow it', () => {
    const paths = GMAIL_WRITE_ROUTES.map((r) => r.path);
    assert.ok(paths.indexOf('/api/v1/gmail/labels/get-or-create') < paths.indexOf('/api/v1/gmail/labels/:labelId'));
  });

  it('takes the record from the URL, not a mismatched body key', () => {
    const route = routeFor('deleteLabel');
    assert.deepEqual(writeArgs(route, { params: { labelId: 'path' }, body: { labelId: 'body' } }), { labelId: 'path' });
  });

  it('treats a non-object body as empty', () => {
    const route = routeFor('deleteEmail');
    assert.deepEqual(writeArgs(route, { params: { messageId: 'm' }, body: ['x'] }), { messageId: 'm' });
    assert.deepEqual(writeArgs(route, { params: { messageId: 'm' } }), { messageId: 'm' });
  });
});

describe('send and draft keep the legacy response shape', () => {
  it('sendEmail answers 200 with id and threadId only', async () => {
    const { status, body, gmail } = await drive('sendEmail', {}, { to: 'a@b.c', subject: 'Hi', body: 'x', cc: 'c@d.e' });
    assert.equal(status, 200);
    assert.deepEqual(body, { id: 'm1', threadId: 't1' });
    const raw = decode(gmail.users.messages.send.mock.calls[0].arguments[0].requestBody.raw);
    assert.match(raw, /^To: a@b\.c\r\nSubject: Hi\r\nCc: c@d\.e\r\n/);
  });

  it('draftEmail answers 200 with the legacy id and messageId, plus threadId', async () => {
    const { status, body } = await drive('draftEmail', {}, { to: 'a@b.c', subject: 'Hi', body: 'x' });
    assert.equal(status, 200);
    // threadId is an added key; id and messageId keep their names and values.
    assert.deepEqual(body, { id: 'd1', messageId: 'm2', threadId: null });
  });
});

describe('header fields', () => {
  const route = routeFor('sendEmail');
  const base = { to: 'a@b.c', subject: 'Hi', body: 'x' };

  for (const [field, value] of [
    ['subject', 'Hi\r\nBcc: spy@evil.test'],
    ['subject', 'Hi\nBcc: spy@evil.test'],
    ['to', 'a@b.c\r\nBcc: spy@evil.test'],
    ['cc', 'a@b.c\nX-Injected: 1'],
    ['bcc', 'a@b.c\rX-Injected: 1'],
  ]) {
    it(`refuses a line break in ${field}: ${JSON.stringify(value)}`, () => {
      assert.equal(route.schema.safeParse({ ...base, [field]: value }).success, false);
    });
  }

  it('refuses an empty recipient', () => {
    assert.equal(route.schema.safeParse({ ...base, to: '' }).success, false);
  });

  it('leaves line breaks alone in the body', () => {
    assert.equal(route.schema.safeParse({ ...base, body: 'one\r\ntwo' }).success, true);
  });
});

describe('modify', () => {
  it('modifyEmail answers with the id and the labels now on it', async () => {
    const { status, body } = await drive('modifyEmail', { messageId: 'm1' }, { addLabelIds: ['STARRED'] });
    assert.equal(status, 200);
    assert.deepEqual(body, { id: 'm1', labelIds: ['STARRED'] });
  });

  it('modifyEmail refuses a change that names no label', async () => {
    const { status, gmail } = await drive('modifyEmail', { messageId: 'm1' }, { addLabelIds: [] });
    assert.equal(status, 400);
    assert.equal(gmail.users.messages.modify.mock.calls.length, 0);
  });

  it('batchModifyEmails never claims a confirmed count Gmail did not give', async () => {
    const { status, body, gmail } = await drive('batchModifyEmails', {}, { messageIds: ['a', 'b'], removeLabelIds: ['UNREAD'] });
    assert.equal(status, 200);
    assert.deepEqual(body, { requested: 2, confirmed: null });
    assert.deepEqual(gmail.users.messages.batchModify.mock.calls[0].arguments[0].requestBody, {
      ids: ['a', 'b'], addLabelIds: undefined, removeLabelIds: ['UNREAD'],
    });
  });

  it('batchModifyEmails refuses no messages and no labels', async () => {
    assert.equal((await drive('batchModifyEmails', {}, { messageIds: [], addLabelIds: ['X'] })).status, 400);
    assert.equal((await drive('batchModifyEmails', {}, { messageIds: ['a'] })).status, 400);
  });
});

describe('trash', () => {
  const trashFailingFor = (bad: string[]) => mock.fn(async ({ id }: { id: string }) => {
    if (bad.includes(id)) { const e: any = new Error(`no ${id}`); e.code = 404; throw e; }
    return {};
  });

  it('deleteEmail trashes rather than deleting', async () => {
    const { status, body, gmail } = await drive('deleteEmail', { messageId: 'm1' }, undefined);
    assert.equal(status, 200);
    assert.deepEqual(body, { trashed: true, id: 'm1' });
    assert.equal(gmail.users.messages.trash.mock.calls.length, 1);
  });

  it('batchDeleteEmails reports each outcome on a partial failure', async () => {
    const gmail = mockGmail({ messages: { trash: trashFailingFor(['b']) } });
    const { status, body } = await drive('batchDeleteEmails', {}, { messageIds: ['a', 'b'] }, gmail);
    assert.equal(status, 200);
    assert.deepEqual(body, { requested: 2, trashed: ['a'], failed: [{ id: 'b', error: 'no b' }], notAttempted: [] });
  });

  it('batchDeleteEmails rethrows when nothing went, so the status survives', async () => {
    const gmail = mockGmail({ messages: { trash: trashFailingFor(['a']) } });
    await assert.rejects(() => drive('batchDeleteEmails', {}, { messageIds: ['a'] }, gmail), { code: 404 });
  });

  it('batchDeleteEmails refuses an empty list', async () => {
    assert.equal((await drive('batchDeleteEmails', {}, { messageIds: [] })).status, 400);
  });
});

describe('labels', () => {
  it('createLabel answers 201 with the defaults applied', async () => {
    const { status, body, gmail } = await drive('createLabel', {}, { name: 'New' });
    assert.equal(status, 201);
    assert.deepEqual(body, { id: 'L2', name: 'New', type: 'user' });
    assert.deepEqual(gmail.users.labels.create.mock.calls[0].arguments[0].requestBody, {
      name: 'New', labelListVisibility: 'labelShow', messageListVisibility: 'show',
    });
  });

  it('getOrCreateLabel says it found an existing label, ignoring case', async () => {
    const { status, body, gmail } = await drive('getOrCreateLabel', {}, { name: 'WORK' });
    assert.equal(status, 200);
    assert.equal((body as any).created, false);
    assert.equal(gmail.users.labels.create.mock.calls.length, 0);
  });

  it('getOrCreateLabel answers 201 when it made one', async () => {
    const { status, body } = await drive('getOrCreateLabel', {}, { name: 'Brand new' });
    assert.equal(status, 201);
    assert.equal((body as any).created, true);
  });

  it('updateLabel patches and refuses an empty change', async () => {
    const { status, gmail } = await drive('updateLabel', { labelId: 'L1' }, { name: 'Renamed' });
    assert.equal(status, 200);
    assert.deepEqual(gmail.users.labels.patch.mock.calls[0].arguments[0], { userId: 'me', id: 'L1', requestBody: { name: 'Renamed' } });
    assert.equal((await drive('updateLabel', { labelId: 'L1' }, {})).status, 400);
  });

  it('deleteLabel refuses a system label before calling Gmail', async () => {
    const { status, gmail } = await drive('deleteLabel', { labelId: 'INBOX' }, undefined);
    assert.equal(status, 400);
    assert.equal(gmail.users.labels.delete.mock.calls.length, 0);
  });

  it('deleteLabel deletes a user label', async () => {
    const { status, body } = await drive('deleteLabel', { labelId: 'L1' }, undefined);
    assert.equal(status, 200);
    assert.deepEqual(body, { deleted: true, labelId: 'L1' });
  });
});

describe('gmailPassthroughStatus', () => {
  it('repeats what the caller can act on, wherever the status sits', () => {
    assert.equal(gmailPassthroughStatus({ code: 409 }), 409);
    assert.equal(gmailPassthroughStatus({ response: { status: 400 } }), 400);
    assert.equal(gmailPassthroughStatus({ status: 429 }), 429);
  });

  it('leaves 404, 403, a 401 and a string code to the shared mapper', () => {
    for (const err of [{ code: 404 }, { code: 403 }, { code: 401 }, { code: 'ECONNRESET' }, null]) {
      assert.equal(gmailPassthroughStatus(err), undefined);
    }
  });
});

describe('reply drafts and filters over REST', () => {
  const parent = {
    get: mock.fn(async () => ({ data: { id: 'p1', threadId: 'th-9', payload: { headers: [
      { name: 'Subject', value: 'Quote' }, { name: 'From', value: 'Ann <ann@x.io>' },
      { name: 'Message-ID', value: '<p1@x.io>' }, { name: 'References', value: '<p0@x.io>' },
    ] } } })),
  };

  it('drafts a reply in the original thread and reports threaded from what Gmail stored', async () => {
    const gmail = mockGmail({ messages: parent });
    gmail.users.drafts.create = mock.fn(async () => ({ data: { id: 'd1', message: { id: 'm2', threadId: 'th-9' } } }));
    const { status, body } = await drive('draftEmail', {}, { body: 'Thanks', replyToMessageId: 'p1' }, gmail);
    assert.equal(status, 200);
    assert.deepEqual(body, { id: 'd1', messageId: 'm2', threadId: 'th-9', threaded: true });
    const sent = gmail.users.drafts.create.mock.calls[0].arguments[0].requestBody.message;
    assert.equal(sent.threadId, 'th-9');
    const raw = decode(sent.raw);
    assert.match(raw, /^To: Ann <ann@x\.io>\r\nSubject: Re: Quote\r\n/);
    assert.match(raw, /\r\nIn-Reply-To: <p1@x\.io>\r\nReferences: <p0@x\.io> <p1@x\.io>\r\n/);
  });

  it('refuses a draft with neither to nor replyToMessageId', async () => {
    await assert.rejects(() => drive('draftEmail', {}, { subject: 'Hi', body: 'x' }), /Give "to"/);
  });

  it('creates a filter from the convenience flags, answering 201', async () => {
    const gmail = mockGmail();
    gmail.users.settings = { filters: { create: mock.fn(async (req: any) => ({ data: { id: 'f1', ...req.requestBody } })) } };
    const { status, body } = await drive('createFilter', {}, { from: 'news@x.io', archive: true, markRead: true, addLabelIds: ['L1'] }, gmail);
    assert.equal(status, 201);
    assert.deepEqual((body as any).criteria, { from: 'news@x.io' });
    assert.deepEqual((body as any).action, { addLabelIds: ['L1'], removeLabelIds: ['INBOX', 'UNREAD'] });
  });

  it('answers 403 naming Reconnect when the connection lacks the settings scope', async () => {
    const gmail = mockGmail();
    const scopeErr = Object.assign(new Error('Request had insufficient authentication scopes.'), { code: 403, errors: [{ reason: 'insufficientPermissions' }] });
    gmail.users.settings = { filters: { create: mock.fn(async () => { throw scopeErr; }) } };
    const { status, body } = await drive('createFilter', {}, { from: 'a@x.io', star: true }, gmail);
    assert.equal(status, 403);
    assert.match((body as any).error, /Reconnect Gmail/);
  });

  it('refuses a filter with no criterion or no action', async () => {
    await assert.rejects(() => drive('createFilter', {}, { star: true }), /at least one criterion/);
    await assert.rejects(() => drive('createFilter', {}, { from: 'a@x.io' }), /at least one action/);
  });
});
