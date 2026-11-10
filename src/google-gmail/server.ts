// src/google-gmail/server.ts
import { FastMCP, UserError } from 'fastmcp';
import { instrumentServer } from '../usage/instrumentServer.js';
import { z } from 'zod';
import { gmail_v1 } from 'googleapis';

import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';

import {
  sendEmailSchema, draftEmailSchema, modifyEmailSchema, deleteEmailSchema,
  batchModifyEmailsSchema, batchDeleteEmailsSchema, createLabelSchema, updateLabelSchema,
  deleteLabelSchema, getOrCreateLabelSchema, createFilterSchema, getFilterSchema,
} from './schemas.js';

// Tool handlers
import {
  handleSendEmail, handleDraftEmail, handleReadEmail, handleSearchEmails,
  handleModifyEmail, handleDeleteEmail, handleBatchModifyEmails, handleBatchDeleteEmails,
  handleListLabels, handleCreateLabel, handleUpdateLabel, handleDeleteLabel,
  handleGetOrCreateLabel, handleGetAttachment, handleCreateFilter, handleListFilters, handleGetFilter, handleDeleteFilter,
} from './toolHandlers.js';
import { registerMintRestBearerForCurl } from '../sharedTools/mintRestBearerForCurl.js';
import { registerListRestEndpoints } from '../sharedTools/listRestEndpoints.js';

const gmailServer = instrumentServer(new FastMCP<UserSession>({
  name: 'Gmail MCP Server',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'google-gmail'),
}), 'google-gmail');

registerMintRestBearerForCurl(gmailServer);
registerListRestEndpoints(gmailServer);

// --- Helper to get Gmail client within tools ---
function getGmailClient(session?: UserSession): gmail_v1.Gmail {
  if (session?.googleGmail) return session.googleGmail;
  throw new UserError("Google Gmail client is not available. Make sure you have granted Gmail access.");
}

// === EMAIL OPERATIONS ===

gmailServer.addTool({
  name: 'sendEmail',
  annotations: { readOnlyHint: false },
  description: 'Send an email message.',
  parameters: sendEmailSchema,
  execute: async (args, { log, session }) => handleSendEmail(getGmailClient(session), args, log),
});

gmailServer.addTool({
  name: 'draftEmail',
  annotations: { readOnlyHint: false },
  description: 'Create a draft email without sending it. Set replyToMessageId to draft a reply inside that conversation.',
  parameters: draftEmailSchema,
  execute: async (args, { log, session }) => handleDraftEmail(getGmailClient(session), args, log),
});

gmailServer.addTool({
  name: 'readEmail',
  annotations: { readOnlyHint: true },
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
  annotations: { readOnlyHint: true },
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
  annotations: { readOnlyHint: false },
  description: 'Modify labels on a single email message (add or remove labels). For more than one message, prefer batchModifyEmails.',
  parameters: modifyEmailSchema,
  execute: async (args, { log, session }) => handleModifyEmail(getGmailClient(session), args, log),
});

gmailServer.addTool({
  name: 'deleteEmail',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Move an email message to the trash.',
  parameters: deleteEmailSchema,
  execute: async (args, { log, session }) => handleDeleteEmail(getGmailClient(session), args, log),
});

// === BATCH OPERATIONS ===

gmailServer.addTool({
  name: 'batchModifyEmails',
  annotations: { readOnlyHint: false },
  description: 'Modify labels on multiple email messages at once (single atomic request). For a single message, modifyEmail is simpler. Limit: 1000 message IDs per call.',
  parameters: batchModifyEmailsSchema,
  execute: async (args, { log, session }) => handleBatchModifyEmails(getGmailClient(session), args, log),
});

gmailServer.addTool({
  name: 'batchDeleteEmails',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Move multiple email messages to the trash.',
  parameters: batchDeleteEmailsSchema,
  execute: async (args, { log, session }) => handleBatchDeleteEmails(getGmailClient(session), args, log),
});

// === LABEL MANAGEMENT ===

gmailServer.addTool({
  name: 'listLabels',
  annotations: { readOnlyHint: true },
  description: 'List all Gmail labels with their message and thread counts.',
  parameters: z.object({}),
  execute: async (_args, { log, session }) => handleListLabels(getGmailClient(session), log),
});

gmailServer.addTool({
  name: 'createLabel',
  annotations: { readOnlyHint: false },
  description: 'Create a new Gmail label.',
  parameters: createLabelSchema,
  execute: async (args, { log, session }) => handleCreateLabel(getGmailClient(session), args, log),
});

gmailServer.addTool({
  name: 'updateLabel',
  annotations: { readOnlyHint: false },
  description: 'Update an existing Gmail label name or visibility settings.',
  parameters: updateLabelSchema,
  execute: async (args, { log, session }) => handleUpdateLabel(getGmailClient(session), args, log),
});

gmailServer.addTool({
  name: 'deleteLabel',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Delete a Gmail label. System labels (INBOX, SENT, etc.) cannot be deleted.',
  parameters: deleteLabelSchema,
  execute: async (args, { log, session }) => handleDeleteLabel(getGmailClient(session), args, log),
});

gmailServer.addTool({
  name: 'getOrCreateLabel',
  annotations: { readOnlyHint: false },
  description: 'Get a label by name, creating it if it does not exist. Returns the label ID.',
  parameters: getOrCreateLabelSchema,
  execute: async (args, { log, session }) => handleGetOrCreateLabel(getGmailClient(session), args, log),
});

// === ATTACHMENT ===

gmailServer.addTool({
  name: 'getAttachment',
  annotations: { readOnlyHint: true },
  description: 'Download an email attachment. Returns the content as base64-encoded data.',
  parameters: z.object({
    messageId: z.string().describe('The Gmail message ID containing the attachment.'),
    attachmentId: z.string().describe('The attachment ID to download.'),
  }),
  execute: async (args, { log, session }) => handleGetAttachment(getGmailClient(session), args, log),
});

// === FILTERS ===

gmailServer.addTool({
  name: 'createFilter',
  annotations: { readOnlyHint: false },
  description: 'Creates a Gmail filter for incoming mail: match by sender, recipient, subject or search query; label, archive, mark read or star. Undo with deleteFilter.',
  parameters: createFilterSchema,
  execute: async (args, { log, session }) => handleCreateFilter(getGmailClient(session), args, log),
});

gmailServer.addTool({
  name: 'listFilters',
  annotations: { readOnlyHint: true },
  description: 'Lists the Gmail filters on this account with their criteria and actions.',
  parameters: z.object({}),
  execute: async (_args, { log, session }) => handleListFilters(getGmailClient(session), log),
});

// MCP-only, like the other deletes without REST sign-off: it is the undo for
// createFilter, which can archive or mark read mail from a sender.
gmailServer.addTool({
  name: 'deleteFilter',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Deletes a Gmail filter so it stops applying to new mail. Mail it already changed is not restored.',
  parameters: getFilterSchema,
  execute: async (args, { log, session }) => handleDeleteFilter(getGmailClient(session), args, log),
});

gmailServer.addTool({
  name: 'getFilter',
  annotations: { readOnlyHint: true },
  description: 'Gets one Gmail filter by ID.',
  parameters: getFilterSchema,
  execute: async (args, { log, session }) => handleGetFilter(getGmailClient(session), args, log),
});

export { gmailServer };
