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
  options?: { cc?: string; bcc?: string; isHtml?: boolean; inReplyTo?: string; references?: string }
): string {
  const contentType = options?.isHtml ? 'text/html' : 'text/plain';

  // The schemas refuse line breaks in caller-supplied values; this also covers
  // values that arrive another way (a reply's copied recipient or subject).
  const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ');
  const lines: string[] = [
    `To: ${oneLine(to)}`,
    `Subject: ${oneLine(subject)}`,
  ];

  if (options?.cc) lines.push(`Cc: ${options.cc}`);
  if (options?.bcc) lines.push(`Bcc: ${options.bcc}`);
  // Threading headers are copied from another message, so line breaks are
  // stripped: a crafted Message-ID must not be able to add a header.
  if (options?.inReplyTo) lines.push(`In-Reply-To: ${options.inReplyTo.replace(/[\r\n]+/g, ' ')}`);
  if (options?.references) lines.push(`References: ${options.references.replace(/[\r\n]+/g, ' ')}`);

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
 * Extract the body text from a Gmail message payload.
 */
export function extractBody(payload?: gmail_v1.Schema$MessagePart): string {
  if (!payload) return '';

  // Simple message with body data
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }

  // Multipart message — prefer text/plain, fall back to text/html
  if (payload.parts) {
    const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
    if (textPart?.body?.data) {
      return Buffer.from(textPart.body.data, 'base64url').toString('utf-8');
    }

    const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) {
      return Buffer.from(htmlPart.body.data, 'base64url').toString('utf-8');
    }

    // Recurse into nested multipart
    for (const part of payload.parts) {
      const body = extractBody(part);
      if (body) return body;
    }
  }

  return '';
}

/**
 * List attachments in a Gmail message payload.
 */
export function listAttachments(
  payload?: gmail_v1.Schema$MessagePart
): { filename: string; mimeType: string; size: number; attachmentId: string }[] {
  const attachments: { filename: string; mimeType: string; size: number; attachmentId: string }[] = [];

  function walk(part?: gmail_v1.Schema$MessagePart) {
    if (!part) return;
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType || 'application/octet-stream',
        size: part.body.size || 0,
        attachmentId: part.body.attachmentId,
      });
    }
    if (part.parts) {
      part.parts.forEach(walk);
    }
  }

  walk(payload);
  return attachments;
}

/**
 * Render an email message as the markdown-style text the readEmail MCP tool
 * emits. Extracted from handleReadEmail so the REST data plane can serve
 * the same text representation when callers request Accept: text/plain.
 */
export function renderEmail(msg: gmail_v1.Schema$Message): string {
  const headers = parseEmailHeaders(msg.payload?.headers);
  let result = `**Email Details:**\n\n`;
  result += `**Subject:** ${headers.subject || '(No subject)'}\n`;
  result += `**From:** ${headers.from}\n`;
  result += `**To:** ${headers.to}\n`;
  result += `**Date:** ${headers.date}\n`;
  result += `**Message ID:** ${msg.id}\n`;
  result += `**Thread ID:** ${msg.threadId}\n`;
  result += `**Labels:** ${msg.labelIds?.join(', ') || 'none'}\n`;

  const body = extractBody(msg.payload);
  if (body) result += `\n**Body:**\n\n${body}`;
  const attachments = listAttachments(msg.payload);
  if (attachments.length > 0) {
    result += `\n\n**Attachments:**\n`;
    attachments.forEach((att, i) => {
      result += `${i + 1}. ${att.filename} (${att.mimeType}, ${att.size} bytes, ID: ${att.attachmentId})\n`;
    });
  }
  return result;
}