import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderEmail } from '../google-gmail/apiHelpers.js';

describe('gmail renderEmail', () => {
  it('renders the minimal header set', () => {
    const out = renderEmail({
      id: 'm1',
      threadId: 't1',
      labelIds: ['INBOX'],
      payload: {
        headers: [
          { name: 'Subject', value: 'Hello' },
          { name: 'From', value: 'a@x.com' },
          { name: 'To', value: 'b@y.com' },
          { name: 'Date', value: 'Mon, 1 Jan 2026' },
        ],
      },
    });
    assert.ok(out.includes('Subject:** Hello'));
    assert.ok(out.includes('From:** a@x.com'));
    assert.ok(out.includes('To:** b@y.com'));
    assert.ok(out.includes('Date:** Mon, 1 Jan 2026'));
    assert.ok(out.includes('Message ID:** m1'));
    assert.ok(out.includes('Thread ID:** t1'));
    assert.ok(out.includes('Labels:** INBOX'));
  });

  it('falls back to "(No subject)" when Subject header is missing', () => {
    const out = renderEmail({
      id: 'm2',
      payload: { headers: [{ name: 'From', value: 'a@x.com' }] },
    });
    assert.ok(out.includes('(No subject)'));
  });

  it('includes the body when present', () => {
    const out = renderEmail({
      id: 'm3',
      payload: {
        headers: [{ name: 'Subject', value: 's' }],
        body: {
          data: Buffer.from('hello body').toString('base64url'),
          size: 10,
        },
        mimeType: 'text/plain',
      },
    });
    assert.ok(out.includes('Body:'));
    assert.ok(out.includes('hello body'));
  });

  it('lists attachments with their metadata', () => {
    const out = renderEmail({
      id: 'm4',
      payload: {
        headers: [{ name: 'Subject', value: 's' }],
        parts: [
          {
            filename: 'doc.pdf',
            mimeType: 'application/pdf',
            body: { attachmentId: 'a-1', size: 1024 },
          },
        ],
      },
    });
    assert.ok(out.includes('Attachments:'));
    assert.ok(out.includes('doc.pdf'));
    assert.ok(out.includes('application/pdf'));
    assert.ok(out.includes('1024 bytes'));
    assert.ok(out.includes('ID: a-1'));
  });

  it('omits "Labels:** none" path when labelIds is absent', () => {
    const out = renderEmail({
      id: 'm5',
      payload: { headers: [{ name: 'Subject', value: 's' }] },
    });
    assert.ok(out.includes('Labels:** none'));
  });
});
