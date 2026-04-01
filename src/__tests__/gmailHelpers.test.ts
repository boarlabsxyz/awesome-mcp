import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRawEmail, parseEmailHeaders, formatEmailList, extractBody, listAttachments } from '../google-gmail/apiHelpers.js';

// === apiHelpers tests ===

describe('createRawEmail', () => {
  it('builds a basic plain text email', () => {
    const raw = createRawEmail('bob@example.com', 'Hello', 'Body text');
    const decoded = Buffer.from(raw, 'base64url').toString('utf-8');
    assert.ok(decoded.includes('To: bob@example.com'));
    assert.ok(decoded.includes('Subject: Hello'));
    assert.ok(decoded.includes('Content-Type: text/plain; charset="UTF-8"'));
    assert.ok(decoded.includes('MIME-Version: 1.0'));
    assert.ok(decoded.includes('Body text'));
  });

  it('builds an HTML email when isHtml is true', () => {
    const raw = createRawEmail('bob@example.com', 'Hi', '<b>Bold</b>', { isHtml: true });
    const decoded = Buffer.from(raw, 'base64url').toString('utf-8');
    assert.ok(decoded.includes('Content-Type: text/html; charset="UTF-8"'));
    assert.ok(decoded.includes('<b>Bold</b>'));
  });

  it('includes CC and BCC headers when provided', () => {
    const raw = createRawEmail('to@x.com', 'Sub', 'Body', {
      cc: 'cc@x.com',
      bcc: 'bcc@x.com',
    });
    const decoded = Buffer.from(raw, 'base64url').toString('utf-8');
    assert.ok(decoded.includes('Cc: cc@x.com'));
    assert.ok(decoded.includes('Bcc: bcc@x.com'));
  });

  it('omits CC and BCC when not provided', () => {
    const raw = createRawEmail('to@x.com', 'Sub', 'Body');
    const decoded = Buffer.from(raw, 'base64url').toString('utf-8');
    assert.ok(!decoded.includes('Cc:'));
    assert.ok(!decoded.includes('Bcc:'));
  });

  it('returns a valid base64url string', () => {
    const raw = createRawEmail('a@b.com', 'Test', 'Hi');
    // base64url should not contain + or /
    assert.ok(!raw.includes('+'));
    assert.ok(!raw.includes('/'));
  });
});

describe('parseEmailHeaders', () => {
  it('extracts Subject, From, To, Date', () => {
    const headers = [
      { name: 'Subject', value: 'Test Subject' },
      { name: 'From', value: 'alice@example.com' },
      { name: 'To', value: 'bob@example.com' },
      { name: 'Date', value: 'Mon, 1 Jan 2024 00:00:00 +0000' },
    ];
    const result = parseEmailHeaders(headers);
    assert.equal(result.subject, 'Test Subject');
    assert.equal(result.from, 'alice@example.com');
    assert.equal(result.to, 'bob@example.com');
    assert.equal(result.date, 'Mon, 1 Jan 2024 00:00:00 +0000');
  });

  it('is case-insensitive for header names', () => {
    const headers = [
      { name: 'subject', value: 'Lower Case' },
      { name: 'FROM', value: 'upper@example.com' },
    ];
    const result = parseEmailHeaders(headers);
    assert.equal(result.subject, 'Lower Case');
    assert.equal(result.from, 'upper@example.com');
  });

  it('returns empty strings for missing headers', () => {
    const result = parseEmailHeaders([]);
    assert.equal(result.subject, '');
    assert.equal(result.from, '');
    assert.equal(result.to, '');
    assert.equal(result.date, '');
  });

  it('returns empty strings for undefined input', () => {
    const result = parseEmailHeaders(undefined);
    assert.equal(result.subject, '');
    assert.equal(result.from, '');
  });
});

describe('formatEmailList', () => {
  it('returns "No emails found." for empty array', () => {
    assert.equal(formatEmailList([]), 'No emails found.');
  });

  it('formats a single message', () => {
    const messages = [{
      id: 'msg1',
      snippet: 'Preview text',
      payload: {
        headers: [
          { name: 'Subject', value: 'Hello' },
          { name: 'From', value: 'alice@x.com' },
          { name: 'Date', value: '2024-01-01' },
        ],
      },
    }];
    const result = formatEmailList(messages as any);
    assert.ok(result.includes('Found 1 email(s)'));
    assert.ok(result.includes('**Hello**'));
    assert.ok(result.includes('msg1'));
    assert.ok(result.includes('alice@x.com'));
    assert.ok(result.includes('Preview text'));
  });

  it('formats multiple messages with numbered list', () => {
    const messages = [
      { id: 'a', snippet: '', payload: { headers: [{ name: 'Subject', value: 'First' }] } },
      { id: 'b', snippet: '', payload: { headers: [{ name: 'Subject', value: 'Second' }] } },
    ];
    const result = formatEmailList(messages as any);
    assert.ok(result.includes('Found 2 email(s)'));
    assert.ok(result.includes('1. **First**'));
    assert.ok(result.includes('2. **Second**'));
  });

  it('shows (No subject) when subject header is missing', () => {
    const messages = [{ id: 'x', snippet: '', payload: { headers: [] } }];
    const result = formatEmailList(messages as any);
    assert.ok(result.includes('(No subject)'));
  });
});

// === server.ts helper tests ===

describe('extractBody', () => {
  it('returns empty string for undefined payload', () => {
    assert.equal(extractBody(undefined), '');
  });

  it('returns empty string for payload with no body data or parts', () => {
    assert.equal(extractBody({}), '');
  });

  it('decodes body data from simple message', () => {
    const data = Buffer.from('Hello world').toString('base64url');
    const result = extractBody({ body: { data } });
    assert.equal(result, 'Hello world');
  });

  it('prefers text/plain in multipart message', () => {
    const plainData = Buffer.from('Plain text').toString('base64url');
    const htmlData = Buffer.from('<b>HTML</b>').toString('base64url');
    const payload = {
      parts: [
        { mimeType: 'text/html', body: { data: htmlData } },
        { mimeType: 'text/plain', body: { data: plainData } },
      ],
    };
    assert.equal(extractBody(payload), 'Plain text');
  });

  it('falls back to text/html when no text/plain', () => {
    const htmlData = Buffer.from('<p>HTML only</p>').toString('base64url');
    const payload = {
      parts: [
        { mimeType: 'text/html', body: { data: htmlData } },
      ],
    };
    assert.equal(extractBody(payload), '<p>HTML only</p>');
  });

  it('recurses into nested multipart', () => {
    const plainData = Buffer.from('Nested plain').toString('base64url');
    const payload = {
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: plainData } },
          ],
        },
      ],
    };
    assert.equal(extractBody(payload), 'Nested plain');
  });

  it('returns empty string when parts have no body data', () => {
    const payload = {
      parts: [
        { mimeType: 'text/plain', body: {} },
        { mimeType: 'text/html', body: {} },
      ],
    };
    assert.equal(extractBody(payload), '');
  });
});

describe('listAttachments', () => {
  it('returns empty array for undefined payload', () => {
    assert.deepEqual(listAttachments(undefined), []);
  });

  it('returns empty array for payload without attachments', () => {
    const payload = {
      body: { data: 'abc' },
    };
    assert.deepEqual(listAttachments(payload), []);
  });

  it('finds a single attachment', () => {
    const payload = {
      parts: [
        {
          filename: 'file.pdf',
          mimeType: 'application/pdf',
          body: { attachmentId: 'att1', size: 1234 },
        },
      ],
    };
    const result = listAttachments(payload);
    assert.equal(result.length, 1);
    assert.equal(result[0].filename, 'file.pdf');
    assert.equal(result[0].mimeType, 'application/pdf');
    assert.equal(result[0].size, 1234);
    assert.equal(result[0].attachmentId, 'att1');
  });

  it('finds nested attachments in multipart', () => {
    const payload = {
      parts: [
        { mimeType: 'text/plain', body: { data: 'text' } },
        {
          mimeType: 'multipart/mixed',
          parts: [
            {
              filename: 'image.png',
              mimeType: 'image/png',
              body: { attachmentId: 'att2', size: 5678 },
            },
          ],
        },
      ],
    };
    const result = listAttachments(payload);
    assert.equal(result.length, 1);
    assert.equal(result[0].filename, 'image.png');
  });

  it('defaults mimeType to application/octet-stream', () => {
    const payload = {
      parts: [
        {
          filename: 'unknown.bin',
          body: { attachmentId: 'att3', size: 100 },
        },
      ],
    };
    const result = listAttachments(payload as any);
    assert.equal(result[0].mimeType, 'application/octet-stream');
  });

  it('defaults size to 0 when missing', () => {
    const payload = {
      parts: [
        {
          filename: 'nosize.txt',
          mimeType: 'text/plain',
          body: { attachmentId: 'att4' },
        },
      ],
    };
    const result = listAttachments(payload as any);
    assert.equal(result[0].size, 0);
  });

  it('skips parts without filename or attachmentId', () => {
    const payload = {
      parts: [
        { mimeType: 'text/plain', body: { data: 'text' } },
        { filename: '', body: { attachmentId: 'att5' } },
        { filename: 'real.txt', mimeType: 'text/plain', body: { attachmentId: 'att6', size: 10 } },
      ],
    };
    const result = listAttachments(payload as any);
    assert.equal(result.length, 1);
    assert.equal(result[0].filename, 'real.txt');
  });
});
