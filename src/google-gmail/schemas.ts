// src/google-gmail/schemas.ts
// Zod parameter schemas for the Gmail write tools. Separate from server.ts so
// the REST routes validate with exactly what the MCP tools validate, without
// importing a module that constructs a FastMCP server.

import { z } from 'zod';

/**
 * A value that goes into a raw RFC 5322 header. A line break would end the
 * header and start one of the caller's choosing, so a subject piped in from
 * somewhere untrusted could add a hidden Bcc.
 */
const headerValue = (description: string) =>
  z.string().regex(/^[^\r\n]*$/, 'Must be a single line.').describe(description);

const emailFields = {
  to: z.string().regex(/^[^\r\n]+$/, 'Must be a single, non-empty line.').describe('Recipient email address(es), comma-separated for multiple.'),
  subject: headerValue('Email subject line.'),
  body: z.string().describe('Email body content.'),
  cc: headerValue('CC recipients, comma-separated.').optional(),
  bcc: headerValue('BCC recipients, comma-separated.').optional(),
  isHtml: z.boolean().optional().default(false).describe('Whether the body is HTML content.'),
};

const labelListVisibility = z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']);
const messageListVisibility = z.enum(['show', 'hide']);

export const sendEmailSchema = z.object(emailFields);

// A reply draft takes `to` and `subject` from the original when they are left
// out, so both are optional here; a draft that is not a reply still needs
// them, which the op refuses by name (a Zod refine would surface as a bare
// InvalidParams).
export const draftEmailSchema = z.object({
  ...emailFields,
  to: emailFields.to.optional(),
  subject: emailFields.subject.optional(),
  replyToMessageId: z.string().min(1).optional()
    .describe('Make the draft a reply in that message\'s conversation: same thread, In-Reply-To/References set, "Re:" subject and the sender as recipient unless to/subject are given.'),
});

// === Filters ===
//
// gmail.settings.basic, a scope connections made before it was added do not
// hold: they get a 403 that names Reconnect.

export const createFilterSchema = z.object({
  from: headerValue('Match mail from this sender (address or name).').optional(),
  to: headerValue('Match mail to this recipient.').optional(),
  subject: headerValue('Match mail whose subject contains this.').optional(),
  query: z.string().optional().describe('Match mail that a Gmail search query matches, e.g. "invoice has:attachment".'),
  negatedQuery: z.string().optional().describe('Exclude mail that this Gmail search query matches.'),
  hasAttachment: z.boolean().optional().describe('Only mail with attachments.'),
  addLabelIds: z.array(z.string()).optional().describe('Label IDs to apply (getOrCreateLabel gives an ID for a name).'),
  removeLabelIds: z.array(z.string()).optional().describe('Label IDs to remove, e.g. INBOX (skip the inbox) or UNREAD (mark read).'),
  archive: z.boolean().optional().describe('Skip the inbox (same as removing INBOX).'),
  markRead: z.boolean().optional().describe('Mark as read (same as removing UNREAD).'),
  star: z.boolean().optional().describe('Star it (same as adding STARRED).'),
  neverSpam: z.boolean().optional().describe('Never send it to Spam (same as removing SPAM).'),
});

export const getFilterSchema = z.object({
  filterId: z.string().describe('The filter ID, from listFilters.'),
});

export const modifyEmailSchema = z.object({
  messageId: z.string().describe('The Gmail message ID to modify.'),
  addLabelIds: z.array(z.string()).optional().describe('Label IDs to add to the message.'),
  removeLabelIds: z.array(z.string()).optional().describe('Label IDs to remove from the message.'),
});

export const deleteEmailSchema = z.object({
  messageId: z.string().describe('The Gmail message ID to trash.'),
});

export const batchModifyEmailsSchema = z.object({
  messageIds: z.array(z.string()).max(1000).describe('Array of Gmail message IDs to modify (max 1000).'),
  addLabelIds: z.array(z.string()).optional().describe('Label IDs to add to all messages.'),
  removeLabelIds: z.array(z.string()).optional().describe('Label IDs to remove from all messages.'),
});

export const batchDeleteEmailsSchema = z.object({
  messageIds: z.array(z.string()).max(1000).describe('Array of Gmail message IDs to trash (max 1000).'),
});

export const createLabelSchema = z.object({
  name: z.string().describe('The display name for the new label.'),
  labelListVisibility: labelListVisibility.optional().default('labelShow').describe('Whether the label is shown in the label list.'),
  messageListVisibility: messageListVisibility.optional().default('show').describe('Whether messages with this label are shown in the message list.'),
});

export const updateLabelSchema = z.object({
  labelId: z.string().describe('The label ID to update.'),
  name: z.string().optional().describe('New display name for the label.'),
  labelListVisibility: labelListVisibility.optional().describe('Whether the label is shown in the label list.'),
  messageListVisibility: messageListVisibility.optional().describe('Whether messages with this label are shown in the message list.'),
});

export const deleteLabelSchema = z.object({
  labelId: z.string().describe('The label ID to delete.'),
});

export const getOrCreateLabelSchema = z.object({
  name: z.string().describe('The label name to find or create.'),
});
