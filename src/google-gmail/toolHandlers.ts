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

type DraftArgs = Omit<EmailArgs, 'to' | 'subject'> & { to?: string; subject?: string; replyToMessageId?: string };

/** What a reply needs from the message it answers. */
async function replyContext(gmail: gmail_v1.Gmail, messageId: string) {
  const parent = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'metadata',
    metadataHeaders: ['Subject', 'From', 'Reply-To', 'Message-ID', 'References'],
  });
  const header = (name: string) =>
    parent.data.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
  const messageIdHeader = header('Message-ID');
  if (!parent.data.threadId || !messageIdHeader) {
    throw new UserError(`Message ${messageId} has no thread or Message-ID header, so a reply cannot be attached to it.`);
  }
  const subject = header('Subject');
  return {
    threadId: parent.data.threadId,
    inReplyTo: messageIdHeader,
    // RFC 5322: the parent's References, then the parent's own Message-ID.
    references: [header('References'), messageIdHeader].filter(Boolean).join(' '),
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    replyTo: header('Reply-To') || header('From'),
  };
}

/**
 * Create a draft, optionally as a reply in an existing conversation. Throws
 * Gmail's own error, so a REST route keeps the status. `threaded` is read from
 * the draft Gmail stored, not assumed from the request.
 */
export async function performDraftEmail(
  gmail: gmail_v1.Gmail,
  args: DraftArgs,
): Promise<gmail_v1.Schema$Draft & { threaded?: boolean }> {
  const reply = args.replyToMessageId ? await replyContext(gmail, args.replyToMessageId) : undefined;
  const to = args.to ?? reply?.replyTo;
  const subject = args.subject ?? reply?.subject;
  if (!to) throw new UserError('Give "to", or replyToMessageId so the recipient can be taken from the original message.');
  if (subject === undefined) throw new UserError('Give "subject", or replyToMessageId so it can be taken from the original message.');

  const raw = createRawEmail(to, subject, args.body, {
    cc: args.cc, bcc: args.bcc, isHtml: args.isHtml,
    ...(reply ? { inReplyTo: reply.inReplyTo, references: reply.references } : {}),
  });
  const response = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw, ...(reply ? { threadId: reply.threadId } : {}) } },
  });
  if (!reply) return response.data;
  return { ...response.data, threaded: response.data.message?.threadId === reply.threadId };
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
  args: DraftArgs,
  log: LogLike
): Promise<string> {
  log.info(`Creating draft email to: ${args.to ?? `reply to ${args.replyToMessageId}`}`);
  try {
    const draft = await performDraftEmail(gmail, args);
    let result = `Draft created successfully!\n\n**Draft ID:** ${draft.id}\n**Message ID:** ${draft.message?.id}\n**To:** ${args.to ?? '(the original sender)'}`;
    if (args.replyToMessageId) {
      result += draft.threaded
        ? `\n**Reply in thread:** ${draft.message?.threadId}`
        : `\n**Warning:** Gmail did not put the draft in the original conversation (thread ${draft.message?.threadId ?? 'unknown'}).`;
    }
    return result;
  } catch (error: any) {
    if (error instanceof UserError) throw error;
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

// === Filters ===

export const FILTER_SCOPE = 'https://www.googleapis.com/auth/gmail.settings.basic';

type FilterArgs = {
  from?: string; to?: string; subject?: string; query?: string; negatedQuery?: string; hasAttachment?: boolean;
  addLabelIds?: string[]; removeLabelIds?: string[]; archive?: boolean; markRead?: boolean; star?: boolean; neverSpam?: boolean;
};

/** The filter Gmail would store, or a refusal naming what is missing. Pure. */
export function buildFilter(args: FilterArgs): gmail_v1.Schema$Filter {
  const criteria: gmail_v1.Schema$FilterCriteria = {};
  if (args.from) criteria.from = args.from;
  if (args.to) criteria.to = args.to;
  if (args.subject) criteria.subject = args.subject;
  if (args.query) criteria.query = args.query;
  if (args.negatedQuery) criteria.negatedQuery = args.negatedQuery;
  if (args.hasAttachment !== undefined) criteria.hasAttachment = args.hasAttachment;

  const add = new Set(args.addLabelIds ?? []);
  const remove = new Set(args.removeLabelIds ?? []);
  if (args.archive) remove.add('INBOX');
  if (args.markRead) remove.add('UNREAD');
  if (args.star) add.add('STARRED');
  if (args.neverSpam) remove.add('SPAM');

  if (Object.keys(criteria).length === 0) {
    throw new UserError('A filter needs at least one criterion: from, to, subject, query, negatedQuery or hasAttachment.');
  }
  if (add.size === 0 && remove.size === 0) {
    throw new UserError('A filter needs at least one action: addLabelIds, removeLabelIds, archive, markRead, star or neverSpam.');
  }
  const action: gmail_v1.Schema$FilterAction = {};
  if (add.size) action.addLabelIds = [...add];
  if (remove.size) action.removeLabelIds = [...remove];
  return { criteria, action };
}

/** A 403 from the settings API on a connection made before the scope existed. */
export function isMissingFilterScope(error: any): boolean {
  const reason = error?.errors?.[0]?.reason ?? error?.response?.data?.error?.errors?.[0]?.reason;
  const message = String(error?.response?.data?.error?.message ?? error?.message ?? '');
  return error?.code === 403 && (reason === 'insufficientPermissions' || /insufficient.*scope/i.test(message));
}

export const RECONNECT_FOR_FILTERS = `This Gmail connection was made before filter access was added. Reconnect Gmail from the `
  + `dashboard to grant ${FILTER_SCOPE}, then retry.`;

export async function performCreateFilter(gmail: gmail_v1.Gmail, args: FilterArgs): Promise<gmail_v1.Schema$Filter> {
  const requestBody = buildFilter(args); // refuse an incomplete filter before any call
  const response = await gmail.users.settings.filters.create({ userId: 'me', requestBody });
  return response.data;
}

export async function performListFilters(gmail: gmail_v1.Gmail): Promise<gmail_v1.Schema$Filter[]> {
  const response = await gmail.users.settings.filters.list({ userId: 'me' });
  return response.data.filter ?? [];
}

export async function performGetFilter(gmail: gmail_v1.Gmail, filterId: string): Promise<gmail_v1.Schema$Filter> {
  const response = await gmail.users.settings.filters.get({ userId: 'me', id: filterId });
  return response.data;
}

function describeFilter(filter: gmail_v1.Schema$Filter): string {
  const c = filter.criteria ?? {};
  const a = filter.action ?? {};
  const when = Object.entries(c).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
  const then = [
    ...(a.addLabelIds?.length ? [`add ${a.addLabelIds.join(', ')}`] : []),
    ...(a.removeLabelIds?.length ? [`remove ${a.removeLabelIds.join(', ')}`] : []),
    ...(a.forward ? [`forward to ${a.forward}`] : []),
  ].join('; ');
  return `**${filter.id}** — when ${when || '(no criteria)'} → ${then || '(no action)'}`;
}

function filterError(error: any, log: LogLike, operation: string): never {
  if (error instanceof UserError) throw error;
  if (isMissingFilterScope(error)) throw new UserError(RECONNECT_FOR_FILTERS);
  handleGmailError(error, log, operation, { 404: 'Filter not found.' });
}

export async function handleCreateFilter(gmail: gmail_v1.Gmail, args: FilterArgs, log: LogLike): Promise<string> {
  log.info('Creating Gmail filter');
  try {
    const filter = await performCreateFilter(gmail, args);
    return `Filter created. It applies to mail arriving from now on, not to existing mail.\n${describeFilter(filter)}`;
  } catch (error: any) {
    filterError(error, log, 'creating filter');
  }
}

export async function handleListFilters(gmail: gmail_v1.Gmail, log: LogLike): Promise<string> {
  log.info('Listing Gmail filters');
  try {
    const filters = await performListFilters(gmail);
    if (filters.length === 0) return 'No filters are set up on this account.';
    return `${filters.length} filter(s):\n${filters.map(describeFilter).join('\n')}`;
  } catch (error: any) {
    filterError(error, log, 'listing filters');
  }
}

export async function handleGetFilter(gmail: gmail_v1.Gmail, args: { filterId: string }, log: LogLike): Promise<string> {
  log.info(`Getting Gmail filter ${args.filterId}`);
  try {
    return describeFilter(await performGetFilter(gmail, args.filterId));
  } catch (error: any) {
    filterError(error, log, 'getting filter');
  }
}
