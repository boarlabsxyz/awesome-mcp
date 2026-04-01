// src/google-gmail/server.ts
import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';
import { gmail_v1 } from 'googleapis';

import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';

// Tool handlers
import {
  handleSendEmail, handleDraftEmail, handleReadEmail, handleSearchEmails,
  handleModifyEmail, handleDeleteEmail, handleBatchModifyEmails, handleBatchDeleteEmails,
  handleListLabels, handleCreateLabel, handleUpdateLabel, handleDeleteLabel,
  handleGetOrCreateLabel, handleGetAttachment,
} from './toolHandlers.js';

const gmailServer = new FastMCP<UserSession>({
  name: 'Gmail MCP Server',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'google-gmail'),
});

// --- Helper to get Gmail client within tools ---
function getGmailClient(session?: UserSession): gmail_v1.Gmail {
  if (session?.googleGmail) return session.googleGmail;
  throw new UserError("Google Gmail client is not available. Make sure you have granted Gmail access.");
}

// === EMAIL OPERATIONS ===

gmailServer.addTool({
  name: 'sendEmail',
  description: 'Send an email message.',
  parameters: z.object({
    to: z.string().describe('Recipient email address(es), comma-separated for multiple.'),
    subject: z.string().describe('Email subject line.'),
    body: z.string().describe('Email body content.'),
    cc: z.string().optional().describe('CC recipients, comma-separated.'),
    bcc: z.string().optional().describe('BCC recipients, comma-separated.'),
    isHtml: z.boolean().optional().default(false).describe('Whether the body is HTML content.'),
  }),
  execute: async (args, { log, session }) => handleSendEmail(getGmailClient(session), args, log),
});

gmailServer.addTool({
  name: 'draftEmail',
  description: 'Create a draft email without sending it.',
  parameters: z.object({
    to: z.string().describe('Recipient email address(es), comma-separated for multiple.'),
    subject: z.string().describe('Email subject line.'),
    body: z.string().describe('Email body content.'),
    cc: z.string().optional().describe('CC recipients, comma-separated.'),
    bcc: z.string().optional().describe('BCC recipients, comma-separated.'),
    isHtml: z.boolean().optional().default(false).describe('Whether the body is HTML content.'),
  }),
  execute: async (args, { log, session }) => handleDraftEmail(getGmailClient(session), args, log),
});

gmailServer.addTool({
  name: 'readEmail',
  description: 'Read the full content of an email by its message ID.',
  parameters: z.object({
    messageId: z.string().describe('The Gmail message ID to read.'),
    format: z.enum(['full', 'metadata', 'minimal']).optional().default('full')
      .describe('The format to return the message in.'),
  }),
  execute: async (args, { log, session }) => handleReadEmail(getGmailClient(session), args, log),
});

gmailServer.addTool({
  name: 'searchEmails',
  description: 'Search emails using Gmail query syntax (e.g., "from:user@example.com", "subject:hello", "is:unread", "newer_than:2d").',
  parameters: z.object({
    query: z.string().describe('Gmail search query string.'),
    maxResults: z.number().min(1).max(50).optional().default(10).describe('Maximum number of results to return (1-50).'),
    pageToken: z.string().optional().describe('Page token for pagination.'),
  }),
  execute: async (args, { log, session }) => handleSearchEmails(getGmailClient(session), args, log),
});

gmailServer.addTool({
  name: 'modifyEmail',
  description: 'Modify labels on a single email message (add or remove labels).',
  parameters: z.object({
    messageId: z.string().describe('The Gmail message ID to modify.'),
    addLabelIds: z.array(z.string()).optional().describe('Label IDs to add to the message.'),
    removeLabelIds: z.array(z.string()).optional().describe('Label IDs to remove from the message.'),
  }),
  execute: async (args, { log, session }) => handleModifyEmail(getGmailClient(session), args, log),
});

gmailServer.addTool({
  name: 'deleteEmail',
  description: 'Move an email message to the trash.',
  parameters: z.object({
    messageId: z.string().describe('The Gmail message ID to trash.'),
  }),
  execute: async (args, { log, session }) => handleDeleteEmail(getGmailClient(session), args, log),
});

// === BATCH OPERATIONS ===

gmailServer.addTool({
  name: 'batchModifyEmails',
  description: 'Modify labels on multiple email messages at once.',
  parameters: z.object({
    messageIds: z.array(z.string()).max(1000).describe('Array of Gmail message IDs to modify (max 1000).'),
    addLabelIds: z.array(z.string()).optional().describe('Label IDs to add to all messages.'),
    removeLabelIds: z.array(z.string()).optional().describe('Label IDs to remove from all messages.'),
  }),
  execute: async (args, { log, session }) => handleBatchModifyEmails(getGmailClient(session), args, log),
});

gmailServer.addTool({
  name: 'batchDeleteEmails',
  description: 'Move multiple email messages to the trash.',
  parameters: z.object({
    messageIds: z.array(z.string()).max(1000).describe('Array of Gmail message IDs to trash (max 1000).'),
  }),
  execute: async (args, { log, session }) => handleBatchDeleteEmails(getGmailClient(session), args, log),
});

// === LABEL MANAGEMENT ===

gmailServer.addTool({
  name: 'listLabels',
  description: 'List all Gmail labels with their message and thread counts.',
  parameters: z.object({}),
  execute: async (_args, { log, session }) => handleListLabels(getGmailClient(session), log),
});

gmailServer.addTool({
  name: 'createLabel',
  description: 'Create a new Gmail label.',
  parameters: z.object({
    name: z.string().describe('The display name for the new label.'),
    labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional()
      .default('labelShow').describe('Whether the label is shown in the label list.'),
    messageListVisibility: z.enum(['show', 'hide']).optional()
      .default('show').describe('Whether messages with this label are shown in the message list.'),
  }),
  execute: async (args, { log, session }) => handleCreateLabel(getGmailClient(session), args, log),
});

gmailServer.addTool({
  name: 'updateLabel',
  description: 'Update an existing Gmail label name or visibility settings.',
  parameters: z.object({
    labelId: z.string().describe('The label ID to update.'),
    name: z.string().optional().describe('New display name for the label.'),
    labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional()
      .describe('Whether the label is shown in the label list.'),
    messageListVisibility: z.enum(['show', 'hide']).optional()
      .describe('Whether messages with this label are shown in the message list.'),
  }),
  execute: async (args, { log, session }) => handleUpdateLabel(getGmailClient(session), args, log),
});

gmailServer.addTool({
  name: 'deleteLabel',
  description: 'Delete a Gmail label. System labels (INBOX, SENT, etc.) cannot be deleted.',
  parameters: z.object({
    labelId: z.string().describe('The label ID to delete.'),
  }),
  execute: async (args, { log, session }) => handleDeleteLabel(getGmailClient(session), args, log),
});

gmailServer.addTool({
  name: 'getOrCreateLabel',
  description: 'Get a label by name, creating it if it does not exist. Returns the label ID.',
  parameters: z.object({
    name: z.string().describe('The label name to find or create.'),
  }),
  execute: async (args, { log, session }) => handleGetOrCreateLabel(getGmailClient(session), args, log),
});

// === ATTACHMENT ===

gmailServer.addTool({
  name: 'getAttachment',
  description: 'Download an email attachment. Returns the content as base64-encoded data.',
  parameters: z.object({
    messageId: z.string().describe('The Gmail message ID containing the attachment.'),
    attachmentId: z.string().describe('The attachment ID to download.'),
  }),
  execute: async (args, { log, session }) => handleGetAttachment(getGmailClient(session), args, log),
});

export { gmailServer };
