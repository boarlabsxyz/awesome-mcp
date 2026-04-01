// src/google-gmail/toolHandlers.ts
// Extracted tool handler logic for testability.
import { gmail_v1 } from 'googleapis';
import { UserError } from 'fastmcp';
import { createRawEmail, parseEmailHeaders, formatEmailList, extractBody, listAttachments } from './apiHelpers.js';

type LogLike = { info: (msg: string) => void; error: (msg: string) => void };

/** Map of Gmail error codes to user-facing messages. */
type ErrorCodeMap = Record<number, string>;

/**
 * Shared error handler for Gmail API calls.
 * Logs the error, checks for known HTTP status codes, and throws a UserError.
 */
function handleGmailError(error: any, log: LogLike, operation: string, codeMessages: ErrorCodeMap = {}): never {
  log.error(`Error ${operation}: ${error.message || error}`);
  const msg = codeMessages[error.code];
  if (msg) throw new UserError(msg);
  throw new UserError(`Failed to ${operation}: ${error.message || 'Unknown error'}`);
}

export async function handleSendEmail(
  gmail: gmail_v1.Gmail,
  args: { to: string; subject: string; body: string; cc?: string; bcc?: string; isHtml?: boolean },
  log: LogLike
): Promise<string> {
  log.info(`Sending email to: ${args.to}`);
  try {
    const raw = createRawEmail(args.to, args.subject, args.body, {
      cc: args.cc, bcc: args.bcc, isHtml: args.isHtml,
    });
    const response = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    return `Email sent successfully!\n\n**Message ID:** ${response.data.id}\n**Thread ID:** ${response.data.threadId}\n**To:** ${args.to}`;
  } catch (error: any) {
    handleGmailError(error, log, 'sending email', {
      403: "Permission denied. Make sure you have granted Gmail send access.",
    });
  }
}

export async function handleDraftEmail(
  gmail: gmail_v1.Gmail,
  args: { to: string; subject: string; body: string; cc?: string; bcc?: string; isHtml?: boolean },
  log: LogLike
): Promise<string> {
  log.info(`Creating draft email to: ${args.to}`);
  try {
    const raw = createRawEmail(args.to, args.subject, args.body, {
      cc: args.cc, bcc: args.bcc, isHtml: args.isHtml,
    });
    const response = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } });
    return `Draft created successfully!\n\n**Draft ID:** ${response.data.id}\n**Message ID:** ${response.data.message?.id}\n**To:** ${args.to}`;
  } catch (error: any) {
    handleGmailError(error, log, 'creating draft', {
      403: "Permission denied. Make sure you have granted Gmail access.",
    });
  }
}

export async function handleReadEmail(
  gmail: gmail_v1.Gmail,
  args: { messageId: string; format?: string },
  log: LogLike
): Promise<string> {
  log.info(`Reading email: ${args.messageId}`);
  try {
    const response = await gmail.users.messages.get({
      userId: 'me', id: args.messageId, format: args.format as any,
    });
    const msg = response.data;
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
  } catch (error: any) {
    handleGmailError(error, log, 'reading email', {
      404: `Email not found (ID: ${args.messageId}).`,
      403: "Permission denied. Make sure you have granted Gmail read access.",
    });
  }
}

export async function handleSearchEmails(
  gmail: gmail_v1.Gmail,
  args: { query: string; maxResults?: number; pageToken?: string },
  log: LogLike
): Promise<string> {
  log.info(`Searching emails: ${args.query}`);
  try {
    const listResponse = await gmail.users.messages.list({
      userId: 'me', q: args.query, maxResults: args.maxResults, pageToken: args.pageToken,
    });
    const messageIds = listResponse.data.messages || [];
    if (messageIds.length === 0) return 'No emails found matching your search.';

    const validIds = messageIds.map(m => m.id).filter((id): id is string => !!id);
    const messages: gmail_v1.Schema$Message[] = [];
    const BATCH_SIZE = 10;
    for (let i = 0; i < validIds.length; i += BATCH_SIZE) {
      const batch = validIds.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(id => gmail.users.messages.get({
          userId: 'me', id, format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'To', 'Date'],
        }))
      );
      messages.push(...results.map(r => r.data));
    }
    let result = formatEmailList(messages);
    if (listResponse.data.nextPageToken) {
      result += `\n**Next page token:** ${listResponse.data.nextPageToken}`;
    }
    return result;
  } catch (error: any) {
    handleGmailError(error, log, 'searching emails', {
      403: "Permission denied. Make sure you have granted Gmail read access.",
    });
  }
}

export async function handleModifyEmail(
  gmail: gmail_v1.Gmail,
  args: { messageId: string; addLabelIds?: string[]; removeLabelIds?: string[] },
  log: LogLike
): Promise<string> {
  log.info(`Modifying email labels: ${args.messageId}`);
  try {
    const response = await gmail.users.messages.modify({
      userId: 'me', id: args.messageId,
      requestBody: { addLabelIds: args.addLabelIds, removeLabelIds: args.removeLabelIds },
    });
    return `Email labels modified successfully!\n\n**Message ID:** ${response.data.id}\n**Current Labels:** ${response.data.labelIds?.join(', ') || 'none'}`;
  } catch (error: any) {
    handleGmailError(error, log, 'modifying email', {
      404: `Email not found (ID: ${args.messageId}).`,
      403: "Permission denied.",
    });
  }
}

export async function handleDeleteEmail(
  gmail: gmail_v1.Gmail,
  args: { messageId: string },
  log: LogLike
): Promise<string> {
  log.info(`Trashing email: ${args.messageId}`);
  try {
    await gmail.users.messages.trash({ userId: 'me', id: args.messageId });
    return `Email moved to trash (ID: ${args.messageId}).`;
  } catch (error: any) {
    handleGmailError(error, log, 'trashing email', {
      404: `Email not found (ID: ${args.messageId}).`,
      403: "Permission denied.",
    });
  }
}

export async function handleBatchModifyEmails(
  gmail: gmail_v1.Gmail,
  args: { messageIds: string[]; addLabelIds?: string[]; removeLabelIds?: string[] },
  log: LogLike
): Promise<string> {
  log.info(`Batch modifying ${args.messageIds.length} emails`);
  try {
    await gmail.users.messages.batchModify({
      userId: 'me',
      requestBody: { ids: args.messageIds, addLabelIds: args.addLabelIds, removeLabelIds: args.removeLabelIds },
    });
    return `Successfully modified labels on ${args.messageIds.length} email(s).\n` +
      (args.addLabelIds?.length ? `**Added labels:** ${args.addLabelIds.join(', ')}\n` : '') +
      (args.removeLabelIds?.length ? `**Removed labels:** ${args.removeLabelIds.join(', ')}` : '');
  } catch (error: any) {
    handleGmailError(error, log, 'batch modifying emails', { 403: "Permission denied." });
  }
}

export async function handleBatchDeleteEmails(
  gmail: gmail_v1.Gmail,
  args: { messageIds: string[] },
  log: LogLike
): Promise<string> {
  log.info(`Batch trashing ${args.messageIds.length} emails`);
  try {
    const BATCH_SIZE = 10;
    for (let i = 0; i < args.messageIds.length; i += BATCH_SIZE) {
      const batch = args.messageIds.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(id => gmail.users.messages.trash({ userId: 'me', id })));
    }
    return `Successfully moved ${args.messageIds.length} email(s) to trash.`;
  } catch (error: any) {
    handleGmailError(error, log, 'batch trashing emails', { 403: "Permission denied." });
  }
}

export async function handleListLabels(
  gmail: gmail_v1.Gmail,
  log: LogLike
): Promise<string> {
  log.info('Listing Gmail labels');
  try {
    const response = await gmail.users.labels.list({ userId: 'me' });
    const labels = response.data.labels || [];
    if (labels.length === 0) return 'No labels found.';

    let result = `Found ${labels.length} label(s):\n\n`;
    for (const label of labels) {
      if (!label.id) continue;
      try {
        const detail = await gmail.users.labels.get({ userId: 'me', id: label.id });
        const d = detail.data;
        result += `- **${d.name}** (ID: ${d.id})\n`;
        result += `  Type: ${d.type} | Messages: ${d.messagesTotal ?? '?'} | Unread: ${d.messagesUnread ?? '?'}\n`;
      } catch {
        result += `- **${label.name}** (ID: ${label.id})\n`;
      }
    }
    return result;
  } catch (error: any) {
    handleGmailError(error, log, 'listing labels', { 403: "Permission denied." });
  }
}

export async function handleCreateLabel(
  gmail: gmail_v1.Gmail,
  args: { name: string; labelListVisibility?: string; messageListVisibility?: string },
  log: LogLike
): Promise<string> {
  log.info(`Creating label: ${args.name}`);
  try {
    const response = await gmail.users.labels.create({
      userId: 'me',
      requestBody: {
        name: args.name,
        labelListVisibility: args.labelListVisibility,
        messageListVisibility: args.messageListVisibility,
      },
    });
    return `Label created successfully!\n\n**Name:** ${response.data.name}\n**ID:** ${response.data.id}\n**Type:** ${response.data.type}`;
  } catch (error: any) {
    handleGmailError(error, log, 'creating label', {
      409: `Label "${args.name}" already exists.`,
      403: "Permission denied.",
    });
  }
}

export async function handleUpdateLabel(
  gmail: gmail_v1.Gmail,
  args: { labelId: string; name?: string; labelListVisibility?: string; messageListVisibility?: string },
  log: LogLike
): Promise<string> {
  log.info(`Updating label: ${args.labelId}`);
  try {
    const requestBody: gmail_v1.Schema$Label = {};
    if (args.name !== undefined) requestBody.name = args.name;
    if (args.labelListVisibility !== undefined) requestBody.labelListVisibility = args.labelListVisibility;
    if (args.messageListVisibility !== undefined) requestBody.messageListVisibility = args.messageListVisibility;

    const response = await gmail.users.labels.update({ userId: 'me', id: args.labelId, requestBody });
    return `Label updated successfully!\n\n**Name:** ${response.data.name}\n**ID:** ${response.data.id}`;
  } catch (error: any) {
    handleGmailError(error, log, 'updating label', {
      404: `Label not found (ID: ${args.labelId}).`,
      403: "Permission denied. Cannot modify system labels.",
    });
  }
}

export async function handleDeleteLabel(
  gmail: gmail_v1.Gmail,
  args: { labelId: string },
  log: LogLike
): Promise<string> {
  log.info(`Deleting label: ${args.labelId}`);
  const systemLabels = ['INBOX', 'SENT', 'DRAFT', 'TRASH', 'SPAM', 'STARRED', 'UNREAD', 'IMPORTANT',
    'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'];
  if (systemLabels.includes(args.labelId)) {
    throw new UserError(`Cannot delete system label: ${args.labelId}`);
  }
  try {
    await gmail.users.labels.delete({ userId: 'me', id: args.labelId });
    return `Label deleted successfully (ID: ${args.labelId}).`;
  } catch (error: any) {
    handleGmailError(error, log, 'deleting label', {
      404: `Label not found (ID: ${args.labelId}).`,
      403: "Permission denied. Cannot delete system labels.",
    });
  }
}

export async function handleGetOrCreateLabel(
  gmail: gmail_v1.Gmail,
  args: { name: string },
  log: LogLike
): Promise<string> {
  log.info(`Getting or creating label: ${args.name}`);
  try {
    const listResponse = await gmail.users.labels.list({ userId: 'me' });
    const existing = listResponse.data.labels?.find(
      l => l.name?.toLowerCase() === args.name.toLowerCase()
    );
    if (existing) {
      return `Label found!\n\n**Name:** ${existing.name}\n**ID:** ${existing.id}\n**Type:** ${existing.type}`;
    }
    const response = await gmail.users.labels.create({ userId: 'me', requestBody: { name: args.name } });
    return `Label created!\n\n**Name:** ${response.data.name}\n**ID:** ${response.data.id}\n**Type:** ${response.data.type}`;
  } catch (error: any) {
    handleGmailError(error, log, 'getting/creating label', { 403: "Permission denied." });
  }
}

export async function handleGetAttachment(
  gmail: gmail_v1.Gmail,
  args: { messageId: string; attachmentId: string },
  log: LogLike
): Promise<string> {
  log.info(`Getting attachment ${args.attachmentId} from message ${args.messageId}`);
  try {
    const response = await gmail.users.messages.attachments.get({
      userId: 'me', messageId: args.messageId, id: args.attachmentId,
    });
    const data = response.data;
    const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
    if (data.size && data.size > MAX_ATTACHMENT_SIZE) {
      throw new UserError(`Attachment too large (${data.size} bytes). Maximum supported size is ${MAX_ATTACHMENT_SIZE} bytes.`);
    }
    const base64 = data.data ? data.data.replace(/-/g, '+').replace(/_/g, '/') : '';
    return `Attachment retrieved successfully!\n\n**Size:** ${data.size} bytes\n**Data (base64):**\n${base64}`;
  } catch (error: any) {
    if (error instanceof UserError) throw error;
    handleGmailError(error, log, 'getting attachment', {
      404: "Attachment not found.",
      403: "Permission denied.",
    });
  }
}
