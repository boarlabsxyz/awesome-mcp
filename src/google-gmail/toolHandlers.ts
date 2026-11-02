// src/google-gmail/toolHandlers.ts
// Extracted tool handler logic for testability.
import { gmail_v1 } from 'googleapis';
import { UserError } from 'fastmcp';
import { createRawEmail, formatEmailList, renderEmail } from './apiHelpers.js';

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

type EmailArgs = { to: string; subject: string; body: string; cc?: string; bcc?: string; isHtml?: boolean };

/** Send a message. Throws Gmail's own error, so a REST route keeps the status. */
export async function performSendEmail(gmail: gmail_v1.Gmail, args: EmailArgs): Promise<gmail_v1.Schema$Message> {
  const raw = createRawEmail(args.to, args.subject, args.body, {
    cc: args.cc, bcc: args.bcc, isHtml: args.isHtml,
  });
  const response = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return response.data;
}

/** Create a draft. Throws Gmail's own error, so a REST route keeps the status. */
export async function performDraftEmail(gmail: gmail_v1.Gmail, args: EmailArgs): Promise<gmail_v1.Schema$Draft> {
  const raw = createRawEmail(args.to, args.subject, args.body, {
    cc: args.cc, bcc: args.bcc, isHtml: args.isHtml,
  });
  const response = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } });
  return response.data;
}

export async function handleSendEmail(
  gmail: gmail_v1.Gmail,
  args: EmailArgs,
  log: LogLike
): Promise<string> {
  log.info(`Sending email to: ${args.to}`);
  try {
    const sent = await performSendEmail(gmail, args);
    return `Email sent successfully!\n\n**Message ID:** ${sent.id}\n**Thread ID:** ${sent.threadId}\n**To:** ${args.to}`;
  } catch (error: any) {
    handleGmailError(error, log, 'sending email', {
      403: "Permission denied. Make sure you have granted Gmail send access.",
    });
  }
}

export async function handleDraftEmail(
  gmail: gmail_v1.Gmail,
  args: EmailArgs,
  log: LogLike
): Promise<string> {
  log.info(`Creating draft email to: ${args.to}`);
  try {
    const draft = await performDraftEmail(gmail, args);
    return `Draft created successfully!\n\n**Draft ID:** ${draft.id}\n**Message ID:** ${draft.message?.id}\n**To:** ${args.to}`;
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
    return renderEmail(response.data);
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

/** Change one message's labels. Throws Gmail's own error. */
export async function performModifyEmail(
  gmail: gmail_v1.Gmail,
  args: { messageId: string; addLabelIds?: string[]; removeLabelIds?: string[] },
): Promise<gmail_v1.Schema$Message> {
  const response = await gmail.users.messages.modify({
    userId: 'me', id: args.messageId,
    requestBody: { addLabelIds: args.addLabelIds, removeLabelIds: args.removeLabelIds },
  });
  return response.data;
}

export async function handleModifyEmail(
  gmail: gmail_v1.Gmail,
  args: { messageId: string; addLabelIds?: string[]; removeLabelIds?: string[] },
  log: LogLike
): Promise<string> {
  log.info(`Modifying email labels: ${args.messageId}`);
  try {
    const message = await performModifyEmail(gmail, args);
    return `Email labels modified successfully!\n\n**Message ID:** ${message.id}\n**Current Labels:** ${message.labelIds?.join(', ') || 'none'}`;
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

/** Change labels on many messages in one request. Gmail answers 204 with no per-message result. */
export async function performBatchModifyEmails(
  gmail: gmail_v1.Gmail,
  args: { messageIds: string[]; addLabelIds?: string[]; removeLabelIds?: string[] },
): Promise<void> {
  await gmail.users.messages.batchModify({
    userId: 'me',
    requestBody: { ids: args.messageIds, addLabelIds: args.addLabelIds, removeLabelIds: args.removeLabelIds },
  });
}

export async function handleBatchModifyEmails(
  gmail: gmail_v1.Gmail,
  args: { messageIds: string[]; addLabelIds?: string[]; removeLabelIds?: string[] },
  log: LogLike
): Promise<string> {
  log.info(`Batch modifying ${args.messageIds.length} emails`);
  try {
    await performBatchModifyEmails(gmail, args);
    return `Successfully modified labels on ${args.messageIds.length} email(s).\n` +
      (args.addLabelIds?.length ? `**Added labels:** ${args.addLabelIds.join(', ')}\n` : '') +
      (args.removeLabelIds?.length ? `**Removed labels:** ${args.removeLabelIds.join(', ')}` : '');
  } catch (error: any) {
    handleGmailError(error, log, 'batch modifying emails', { 403: "Permission denied." });
  }
}

const TRASH_BATCH_SIZE = 10;

export interface BatchTrashResult {
  trashed: string[];
  failed: Array<{ id: string; error: any }>;
  /** Left untouched: a whole batch failed, so the rest would have too. */
  notAttempted: string[];
}

/**
 * Trash messages a batch at a time. There is no batch endpoint for this, so a
 * failure part way leaves some messages trashed; the result says exactly which,
 * rather than one error hiding the ones that went.
 */
export async function performBatchTrashEmails(gmail: gmail_v1.Gmail, messageIds: string[]): Promise<BatchTrashResult> {
  const result: BatchTrashResult = { trashed: [], failed: [], notAttempted: [] };
  for (let i = 0; i < messageIds.length; i += TRASH_BATCH_SIZE) {
    const batch = messageIds.slice(i, i + TRASH_BATCH_SIZE);
    const settled = await Promise.allSettled(batch.map(id => gmail.users.messages.trash({ userId: 'me', id })));
    settled.forEach((outcome, n) => {
      if (outcome.status === 'fulfilled') result.trashed.push(batch[n]);
      else result.failed.push({ id: batch[n], error: outcome.reason });
    });
    if (settled.every(outcome => outcome.status === 'rejected')) {
      result.notAttempted = messageIds.slice(i + TRASH_BATCH_SIZE);
      break;
    }
  }
  return result;
}

export async function handleBatchDeleteEmails(
  gmail: gmail_v1.Gmail,
  args: { messageIds: string[] },
  log: LogLike
): Promise<string> {
  log.info(`Batch trashing ${args.messageIds.length} emails`);
  const { trashed, failed, notAttempted } = await performBatchTrashEmails(gmail, args.messageIds);
  if (failed.length === 0) return `Successfully moved ${trashed.length} email(s) to trash.`;
  if (trashed.length === 0) {
    handleGmailError(failed[0].error, log, 'batch trashing emails', { 403: "Permission denied." });
  }
  log.error(`Batch trash partly failed: ${failed.length} failed, ${notAttempted.length} not attempted`);
  throw new UserError(
    `Moved ${trashed.length} of ${args.messageIds.length} email(s) to trash. `
    + `Failed: ${failed.map(f => f.id).join(', ')}.`
    + (notAttempted.length ? ` Not attempted: ${notAttempted.length}.` : ''),
  );
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

/** Create a label. Throws Gmail's own error, so 409 for a duplicate name survives. */
export async function performCreateLabel(
  gmail: gmail_v1.Gmail,
  args: { name: string; labelListVisibility?: string; messageListVisibility?: string },
): Promise<gmail_v1.Schema$Label> {
  const response = await gmail.users.labels.create({
    userId: 'me',
    requestBody: {
      name: args.name,
      labelListVisibility: args.labelListVisibility,
      messageListVisibility: args.messageListVisibility,
    },
  });
  return response.data;
}

export async function handleCreateLabel(
  gmail: gmail_v1.Gmail,
  args: { name: string; labelListVisibility?: string; messageListVisibility?: string },
  log: LogLike
): Promise<string> {
  log.info(`Creating label: ${args.name}`);
  try {
    const label = await performCreateLabel(gmail, args);
    return `Label created successfully!\n\n**Name:** ${label.name}\n**ID:** ${label.id}\n**Type:** ${label.type}`;
  } catch (error: any) {
    handleGmailError(error, log, 'creating label', {
      409: `Label "${args.name}" already exists.`,
      403: "Permission denied.",
    });
  }
}

/** The label fields a caller named; omitted ones must stay out of the request. */
export function labelChanges(
  args: { name?: string; labelListVisibility?: string; messageListVisibility?: string },
): gmail_v1.Schema$Label {
  const requestBody: gmail_v1.Schema$Label = {};
  if (args.name !== undefined) requestBody.name = args.name;
  if (args.labelListVisibility !== undefined) requestBody.labelListVisibility = args.labelListVisibility;
  if (args.messageListVisibility !== undefined) requestBody.messageListVisibility = args.messageListVisibility;
  return requestBody;
}

/** labels.patch, not labels.update: update is a full replacement and these are partial. */
export async function performUpdateLabel(
  gmail: gmail_v1.Gmail,
  args: { labelId: string; name?: string; labelListVisibility?: string; messageListVisibility?: string },
): Promise<gmail_v1.Schema$Label> {
  const response = await gmail.users.labels.patch({ userId: 'me', id: args.labelId, requestBody: labelChanges(args) });
  return response.data;
}

export async function handleUpdateLabel(
  gmail: gmail_v1.Gmail,
  args: { labelId: string; name?: string; labelListVisibility?: string; messageListVisibility?: string },
  log: LogLike
): Promise<string> {
  log.info(`Updating label: ${args.labelId}`);
  try {
    const label = await performUpdateLabel(gmail, args);
    return `Label updated successfully!\n\n**Name:** ${label.name}\n**ID:** ${label.id}`;
  } catch (error: any) {
    handleGmailError(error, log, 'updating label', {
      404: `Label not found (ID: ${args.labelId}).`,
      403: "Permission denied. Cannot modify system labels.",
    });
  }
}

const SYSTEM_LABELS = ['INBOX', 'SENT', 'DRAFT', 'TRASH', 'SPAM', 'STARRED', 'UNREAD', 'IMPORTANT',
  'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'];

export const isSystemLabel = (labelId: string): boolean => SYSTEM_LABELS.includes(labelId);

export async function handleDeleteLabel(
  gmail: gmail_v1.Gmail,
  args: { labelId: string },
  log: LogLike
): Promise<string> {
  log.info(`Deleting label: ${args.labelId}`);
  if (isSystemLabel(args.labelId)) {
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

/** Find a label by name, case-insensitively, or create it; `created` says which happened. */
export async function performGetOrCreateLabel(
  gmail: gmail_v1.Gmail,
  args: { name: string },
): Promise<{ label: gmail_v1.Schema$Label; created: boolean }> {
  const listResponse = await gmail.users.labels.list({ userId: 'me' });
  const existing = listResponse.data.labels?.find(
    l => l.name?.toLowerCase() === args.name.toLowerCase()
  );
  if (existing) return { label: existing, created: false };
  const response = await gmail.users.labels.create({ userId: 'me', requestBody: { name: args.name } });
  return { label: response.data, created: true };
}

export async function handleGetOrCreateLabel(
  gmail: gmail_v1.Gmail,
  args: { name: string },
  log: LogLike
): Promise<string> {
  log.info(`Getting or creating label: ${args.name}`);
  try {
    const { label, created } = await performGetOrCreateLabel(gmail, args);
    return `Label ${created ? 'created' : 'found'}!\n\n**Name:** ${label.name}\n**ID:** ${label.id}\n**Type:** ${label.type}`;
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
