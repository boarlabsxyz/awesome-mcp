import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
  handleSendEmail, handleDraftEmail, handleReadEmail, handleSearchEmails,
  handleModifyEmail, handleDeleteEmail, handleBatchModifyEmails, handleBatchDeleteEmails,
  handleListLabels, handleCreateLabel, handleUpdateLabel, handleDeleteLabel,
  handleGetOrCreateLabel, handleGetAttachment,
} from '../google-gmail/toolHandlers.js';

const noopLog = { info: () => {}, error: () => {} };

function mockGmail(overrides: any = {}) {
  return {
    users: {
      messages: {
        send: mock.fn(async () => ({ data: { id: 'msg1', threadId: 'thread1' } })),
        get: mock.fn(async () => ({
          data: {
            id: 'msg1', threadId: 'thread1', labelIds: ['INBOX'],
            payload: { headers: [{ name: 'Subject', value: 'Test' }, { name: 'From', value: 'a@b.com' }, { name: 'To', value: 'c@d.com' }, { name: 'Date', value: '2024-01-01' }] },
            snippet: 'Preview',
          },
        })),
        list: mock.fn(async () => ({ data: { messages: [{ id: 'msg1' }] } })),
        modify: mock.fn(async () => ({ data: { id: 'msg1', labelIds: ['INBOX', 'STARRED'] } })),
        trash: mock.fn(async () => ({})),
        batchModify: mock.fn(async () => ({})),
        attachments: {
          get: mock.fn(async () => ({ data: { size: 100, data: 'SGVsbG8' } })),
        },
        ...overrides.messages,
      },
      drafts: {
        create: mock.fn(async () => ({ data: { id: 'draft1', message: { id: 'msg2' } } })),
        ...overrides.drafts,
      },
      labels: {
        list: mock.fn(async () => ({ data: { labels: [{ id: 'L1', name: 'MyLabel', type: 'user' }] } })),
        get: mock.fn(async () => ({ data: { id: 'L1', name: 'MyLabel', type: 'user', messagesTotal: 5, messagesUnread: 2 } })),
        create: mock.fn(async () => ({ data: { id: 'L2', name: 'NewLabel', type: 'user' } })),
        update: mock.fn(async () => ({ data: { id: 'L1', name: 'Updated' } })),
        delete: mock.fn(async () => ({})),
        ...overrides.labels,
      },
    },
  } as any;
}

// === Email Operations ===

describe('handleSendEmail', () => {
  it('sends email and returns success message', async () => {
    const gmail = mockGmail();
    const result = await handleSendEmail(gmail, { to: 'bob@x.com', subject: 'Hi', body: 'Hello' }, noopLog);
    assert.ok(result.includes('Email sent successfully'));
    assert.ok(result.includes('msg1'));
    assert.ok(result.includes('bob@x.com'));
    assert.equal(gmail.users.messages.send.mock.calls.length, 1);
  });

  it('throws UserError on 403', async () => {
    const gmail = mockGmail({ messages: { send: mock.fn(async () => { const e: any = new Error('Forbidden'); e.code = 403; throw e; }) } });
    await assert.rejects(() => handleSendEmail(gmail, { to: 'x@y.com', subject: 'S', body: 'B' }, noopLog), { message: /Permission denied/ });
  });
});

describe('handleDraftEmail', () => {
  it('creates draft and returns success', async () => {
    const gmail = mockGmail();
    const result = await handleDraftEmail(gmail, { to: 'bob@x.com', subject: 'Draft', body: 'Content' }, noopLog);
    assert.ok(result.includes('Draft created'));
    assert.ok(result.includes('draft1'));
  });

  it('throws UserError on 403', async () => {
    const gmail = mockGmail({ drafts: { create: mock.fn(async () => { const e: any = new Error('Forbidden'); e.code = 403; throw e; }) } });
    await assert.rejects(() => handleDraftEmail(gmail, { to: 'x@y.com', subject: 'S', body: 'B' }, noopLog), { message: /Permission denied/ });
  });
});

describe('handleReadEmail', () => {
  it('reads email and returns formatted output', async () => {
    const gmail = mockGmail();
    const result = await handleReadEmail(gmail, { messageId: 'msg1' }, noopLog);
    assert.ok(result.includes('**Subject:** Test'));
    assert.ok(result.includes('**From:** a@b.com'));
    assert.ok(result.includes('**Message ID:** msg1'));
  });

  it('throws UserError on 404', async () => {
    const gmail = mockGmail({ messages: { get: mock.fn(async () => { const e: any = new Error('Not found'); e.code = 404; throw e; }) } });
    await assert.rejects(() => handleReadEmail(gmail, { messageId: 'bad' }, noopLog), { message: /Email not found/ });
  });
});

describe('handleSearchEmails', () => {
  it('returns formatted list of search results', async () => {
    const gmail = mockGmail();
    const result = await handleSearchEmails(gmail, { query: 'is:unread' }, noopLog);
    assert.ok(result.includes('Found 1 email'));
  });

  it('returns no results message when empty', async () => {
    const gmail = mockGmail({ messages: { list: mock.fn(async () => ({ data: { messages: [] } })) } });
    const result = await handleSearchEmails(gmail, { query: 'nothing' }, noopLog);
    assert.equal(result, 'No emails found matching your search.');
  });

  it('includes next page token when present', async () => {
    const gmail = mockGmail({
      messages: {
        list: mock.fn(async () => ({ data: { messages: [{ id: 'msg1' }], nextPageToken: 'token123' } })),
        get: mock.fn(async () => ({
          data: { id: 'msg1', payload: { headers: [{ name: 'Subject', value: 'Test' }] }, snippet: '' },
        })),
      },
    });
    const result = await handleSearchEmails(gmail, { query: 'test' }, noopLog);
    assert.ok(result.includes('token123'));
  });
});

describe('handleModifyEmail', () => {
  it('modifies labels and returns result', async () => {
    const gmail = mockGmail();
    const result = await handleModifyEmail(gmail, { messageId: 'msg1', addLabelIds: ['STARRED'] }, noopLog);
    assert.ok(result.includes('labels modified'));
    assert.ok(result.includes('STARRED'));
  });

  it('throws UserError on 404', async () => {
    const gmail = mockGmail({ messages: { modify: mock.fn(async () => { const e: any = new Error('Not found'); e.code = 404; throw e; }) } });
    await assert.rejects(() => handleModifyEmail(gmail, { messageId: 'bad' }, noopLog), { message: /Email not found/ });
  });
});

describe('handleDeleteEmail', () => {
  it('trashes email and returns success', async () => {
    const gmail = mockGmail();
    const result = await handleDeleteEmail(gmail, { messageId: 'msg1' }, noopLog);
    assert.ok(result.includes('moved to trash'));
    assert.equal(gmail.users.messages.trash.mock.calls.length, 1);
  });

  it('throws UserError on 404', async () => {
    const gmail = mockGmail({ messages: { trash: mock.fn(async () => { const e: any = new Error('Not found'); e.code = 404; throw e; }) } });
    await assert.rejects(() => handleDeleteEmail(gmail, { messageId: 'bad' }, noopLog), { message: /Email not found/ });
  });
});

// === Batch Operations ===

describe('handleBatchModifyEmails', () => {
  it('batch modifies and returns result', async () => {
    const gmail = mockGmail();
    const result = await handleBatchModifyEmails(gmail, { messageIds: ['a', 'b'], addLabelIds: ['STARRED'] }, noopLog);
    assert.ok(result.includes('2 email(s)'));
    assert.ok(result.includes('STARRED'));
  });

  it('throws UserError on 403', async () => {
    const gmail = mockGmail({ messages: { batchModify: mock.fn(async () => { const e: any = new Error('Forbidden'); e.code = 403; throw e; }) } });
    await assert.rejects(() => handleBatchModifyEmails(gmail, { messageIds: ['a'] }, noopLog), { message: /Permission denied/ });
  });
});

describe('handleBatchDeleteEmails', () => {
  it('batch trashes and returns result', async () => {
    const gmail = mockGmail();
    const result = await handleBatchDeleteEmails(gmail, { messageIds: ['a', 'b', 'c'] }, noopLog);
    assert.ok(result.includes('3 email(s)'));
    assert.equal(gmail.users.messages.trash.mock.calls.length, 3);
  });
});

// === Label Management ===

describe('handleListLabels', () => {
  it('lists labels with details', async () => {
    const gmail = mockGmail();
    const result = await handleListLabels(gmail, noopLog);
    assert.ok(result.includes('1 label(s)'));
    assert.ok(result.includes('MyLabel'));
    assert.ok(result.includes('Messages: 5'));
  });

  it('returns no labels message', async () => {
    const gmail = mockGmail({ labels: { list: mock.fn(async () => ({ data: { labels: [] } })) } });
    const result = await handleListLabels(gmail, noopLog);
    assert.equal(result, 'No labels found.');
  });

  it('falls back gracefully when label.get fails', async () => {
    const gmail = mockGmail({
      labels: {
        list: mock.fn(async () => ({ data: { labels: [{ id: 'L1', name: 'Fallback' }] } })),
        get: mock.fn(async () => { throw new Error('fail'); }),
      },
    });
    const result = await handleListLabels(gmail, noopLog);
    assert.ok(result.includes('Fallback'));
  });
});

describe('handleCreateLabel', () => {
  it('creates label and returns details', async () => {
    const gmail = mockGmail();
    const result = await handleCreateLabel(gmail, { name: 'NewLabel' }, noopLog);
    assert.ok(result.includes('Label created'));
    assert.ok(result.includes('NewLabel'));
  });

  it('throws UserError on 409 conflict', async () => {
    const gmail = mockGmail({ labels: { create: mock.fn(async () => { const e: any = new Error('Conflict'); e.code = 409; throw e; }) } });
    await assert.rejects(() => handleCreateLabel(gmail, { name: 'Dup' }, noopLog), { message: /already exists/ });
  });
});

describe('handleUpdateLabel', () => {
  it('updates label and returns details', async () => {
    const gmail = mockGmail();
    const result = await handleUpdateLabel(gmail, { labelId: 'L1', name: 'Updated' }, noopLog);
    assert.ok(result.includes('Label updated'));
    assert.ok(result.includes('Updated'));
  });

  it('throws UserError on 404', async () => {
    const gmail = mockGmail({ labels: { update: mock.fn(async () => { const e: any = new Error('Not found'); e.code = 404; throw e; }) } });
    await assert.rejects(() => handleUpdateLabel(gmail, { labelId: 'bad' }, noopLog), { message: /Label not found/ });
  });
});

describe('handleDeleteLabel', () => {
  it('deletes label and returns success', async () => {
    const gmail = mockGmail();
    const result = await handleDeleteLabel(gmail, { labelId: 'L1' }, noopLog);
    assert.ok(result.includes('Label deleted'));
  });

  it('blocks system label deletion', async () => {
    const gmail = mockGmail();
    await assert.rejects(() => handleDeleteLabel(gmail, { labelId: 'INBOX' }, noopLog), { message: /Cannot delete system label/ });
  });

  it('blocks all system labels', async () => {
    const gmail = mockGmail();
    for (const label of ['SENT', 'DRAFT', 'TRASH', 'SPAM', 'STARRED', 'UNREAD', 'IMPORTANT']) {
      await assert.rejects(() => handleDeleteLabel(gmail, { labelId: label }, noopLog), { message: /Cannot delete system label/ });
    }
  });

  it('throws UserError on 404', async () => {
    const gmail = mockGmail({ labels: { delete: mock.fn(async () => { const e: any = new Error('Not found'); e.code = 404; throw e; }) } });
    await assert.rejects(() => handleDeleteLabel(gmail, { labelId: 'bad' }, noopLog), { message: /Label not found/ });
  });
});

describe('handleGetOrCreateLabel', () => {
  it('finds existing label', async () => {
    const gmail = mockGmail();
    const result = await handleGetOrCreateLabel(gmail, { name: 'MyLabel' }, noopLog);
    assert.ok(result.includes('Label found'));
    assert.ok(result.includes('MyLabel'));
    assert.equal(gmail.users.labels.create.mock.calls.length, 0);
  });

  it('creates label when not found', async () => {
    const gmail = mockGmail({
      labels: {
        list: mock.fn(async () => ({ data: { labels: [] } })),
        create: mock.fn(async () => ({ data: { id: 'L3', name: 'Brand New', type: 'user' } })),
      },
    });
    const result = await handleGetOrCreateLabel(gmail, { name: 'Brand New' }, noopLog);
    assert.ok(result.includes('Label created'));
    assert.ok(result.includes('Brand New'));
  });

  it('is case-insensitive', async () => {
    const gmail = mockGmail();
    const result = await handleGetOrCreateLabel(gmail, { name: 'mylabel' }, noopLog);
    assert.ok(result.includes('Label found'));
  });
});

// === Attachment ===

describe('handleGetAttachment', () => {
  it('retrieves attachment and converts base64url to base64', async () => {
    const gmail = mockGmail({
      messages: {
        attachments: {
          get: mock.fn(async () => ({ data: { size: 50, data: 'abc-def_ghi' } })),
        },
      },
    });
    const result = await handleGetAttachment(gmail, { messageId: 'msg1', attachmentId: 'att1' }, noopLog);
    assert.ok(result.includes('Attachment retrieved'));
    assert.ok(result.includes('abc+def/ghi'));
    assert.ok(!result.includes('abc-def_ghi'));
  });

  it('rejects attachments over 10MB', async () => {
    const gmail = mockGmail({
      messages: {
        attachments: {
          get: mock.fn(async () => ({ data: { size: 11 * 1024 * 1024, data: 'x' } })),
        },
      },
    });
    await assert.rejects(
      () => handleGetAttachment(gmail, { messageId: 'msg1', attachmentId: 'att1' }, noopLog),
      { message: /too large/ }
    );
  });

  it('throws UserError on 404', async () => {
    const gmail = mockGmail({
      messages: {
        attachments: {
          get: mock.fn(async () => { const e: any = new Error('Not found'); e.code = 404; throw e; }),
        },
      },
    });
    await assert.rejects(
      () => handleGetAttachment(gmail, { messageId: 'msg1', attachmentId: 'bad' }, noopLog),
      { message: /Attachment not found/ }
    );
  });

  it('returns empty base64 when data is null', async () => {
    const gmail = mockGmail({
      messages: {
        attachments: {
          get: mock.fn(async () => ({ data: { size: 0, data: null } })),
        },
      },
    });
    const result = await handleGetAttachment(gmail, { messageId: 'msg1', attachmentId: 'att1' }, noopLog);
    assert.ok(result.includes('**Data (base64):**\n'));
  });
});
