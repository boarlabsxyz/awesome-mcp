// src/google-gmail/apiHelpers.ts
import { gmail_v1 } from 'googleapis';

/**
 * Build an RFC 2822 MIME message and return it as a base64url-encoded string
 * suitable for the Gmail API `raw` field.
 */
export function createRawEmail(
  to: string,
  subject: string,
  body: string,
  options?: { cc?: string; bcc?: string; isHtml?: boolean }
): string {
  const boundary = `boundary_${Date.now()}`;
  const contentType = options?.isHtml ? 'text/html' : 'text/plain';

  const lines: string[] = [
    `To: ${to}`,
    `Subject: ${subject}`,
  ];

  if (options?.cc) lines.push(`Cc: ${options.cc}`);
  if (options?.bcc) lines.push(`Bcc: ${options.bcc}`);

  lines.push(`MIME-Version: 1.0`);
  lines.push(`Content-Type: ${contentType}; charset="UTF-8"`);
  lines.push('');
  lines.push(body);

  const raw = lines.join('\r\n');
  return Buffer.from(raw).toString('base64url');
}

/**
 * Extract common headers from a Gmail message header array.
 */
export function parseEmailHeaders(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined
): { subject: string; from: string; to: string; date: string } {
  const get = (name: string) =>
    headers?.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

  return {
    subject: get('Subject'),
    from: get('From'),
    to: get('To'),
    date: get('Date'),
  };
}

/**
 * Format a list of Gmail messages for display.
 */
export function formatEmailList(
  messages: gmail_v1.Schema$Message[]
): string {
  if (messages.length === 0) return 'No emails found.';

  let result = `Found ${messages.length} email(s):\n\n`;
  messages.forEach((msg, index) => {
    const headers = parseEmailHeaders(msg.payload?.headers);
    result += `${index + 1}. **${headers.subject || '(No subject)'}**\n`;
    result += `   ID: ${msg.id}\n`;
    result += `   From: ${headers.from}\n`;
    result += `   Date: ${headers.date}\n`;
    result += `   Snippet: ${msg.snippet || ''}\n\n`;
  });

  return result;
}

/**
 * Basic email validation.
 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
