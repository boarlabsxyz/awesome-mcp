// src/google-gmail/server.ts
import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';
import { gmail_v1 } from 'googleapis';
import http from 'http';

// Multi-user imports
import { UserSession, createUserSession, createUserSessionFromConnection } from '../userSession.js';
import { loadUsers, getUserByApiKey } from '../userStore.js';
import { loadClientCredentials } from '../auth.js';
import { getMcpConnection, getMcpConnectionByInstanceId } from '../mcpConnectionStore.js';
import { getMcpCatalog } from '../mcpCatalogStore.js';

// Helpers
import { createRawEmail, parseEmailHeaders, formatEmailList } from './apiHelpers.js';

const MCP_SLUG = process.env.MCP_SLUG || 'google-gmail';

const gmailServer = new FastMCP<UserSession>({
  name: 'Gmail MCP Server',
  version: '1.0.0',
  authenticate: async (request: http.IncomingMessage | undefined) => {
    // In stdio mode, request is undefined — no per-user auth needed
    if (!request) return undefined as unknown as UserSession;

    // Extract API key from Authorization header or query param
    const authHeader = request.headers['authorization'];
    let rawToken: string | undefined;

    if (authHeader?.startsWith('Bearer ')) {
      rawToken = authHeader.slice(7);
    }

    const url = new URL(request.url || '', 'http://localhost');

    if (!rawToken) {
      rawToken = url.searchParams.get('apiKey') || undefined;
    }

    if (!rawToken) {
      throw new Response(null, { status: 401, statusText: 'Missing API key. Provide Authorization: Bearer <key> header.' } as any);
    }

    // Support compound token format: "apiKey.instanceId"
    let apiKey: string;
    let instanceId: string | undefined;

    await loadUsers();

    const dotIndex = rawToken.lastIndexOf('.');
    if (dotIndex > 0) {
      const possibleApiKey = rawToken.substring(0, dotIndex);
      const possibleInstanceId = rawToken.substring(dotIndex + 1);
      const possibleUser = await getUserByApiKey(possibleApiKey);
      if (possibleUser) {
        apiKey = possibleApiKey;
        instanceId = possibleInstanceId;
      } else {
        apiKey = rawToken;
      }
    } else {
      apiKey = rawToken;
    }

    if (!instanceId) {
      instanceId = url.searchParams.get('instanceId') || undefined;
    }

    const user = await getUserByApiKey(apiKey);
    if (!user) {
      throw new Response(null, { status: 401, statusText: 'Invalid API key.' } as any);
    }

    if (!user.id) {
      throw new Response(null, { status: 403, statusText: 'User ID not found. Please re-register.' } as any);
    }

    if (instanceId) {
      const connection = await getMcpConnectionByInstanceId(instanceId);
      if (!connection) {
        throw new Response(null, { status: 404, statusText: `Instance not found: ${instanceId}` } as any);
      }
      if (connection.userId !== user.id) {
        throw new Response(null, { status: 403, statusText: 'You do not have access to this instance.' } as any);
      }

      const mcp = await getMcpCatalog(connection.mcpSlug);
      const { client_id, client_secret } = mcp?.googleClientId && mcp?.googleClientSecret
        ? { client_id: mcp.googleClientId, client_secret: mcp.googleClientSecret }
        : await loadClientCredentials();

      return createUserSessionFromConnection(user, connection, client_id, client_secret);
    }

    // Legacy flow (no instanceId): Always prefer MCP connection tokens
    const connection = await getMcpConnection(user.id, MCP_SLUG);
    if (connection) {
      const mcp = await getMcpCatalog(MCP_SLUG);
      const { client_id, client_secret } = mcp?.googleClientId && mcp?.googleClientSecret
        ? { client_id: mcp.googleClientId, client_secret: mcp.googleClientSecret }
        : await loadClientCredentials();
      return createUserSessionFromConnection(user, connection, client_id, client_secret);
    }

    // Fall back to user's global tokens
    if (user.tokens && user.tokens.refresh_token) {
      const { client_id, client_secret } = await loadClientCredentials();
      return createUserSession(user, client_id, client_secret);
    }

    throw new Response(null, {
      status: 403,
      statusText: `MCP not connected. Visit the dashboard to connect ${MCP_SLUG}.`
    } as any);
  },
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
  execute: async (args, { log, session }) => {
    const gmail = getGmailClient(session);
    log.info(`Sending email to: ${args.to}`);

    try {
      const raw = createRawEmail(args.to, args.subject, args.body, {
        cc: args.cc,
        bcc: args.bcc,
        isHtml: args.isHtml,
      });

      const response = await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw },
      });

      return `Email sent successfully!\n\n` +
        `**Message ID:** ${response.data.id}\n` +
        `**Thread ID:** ${response.data.threadId}\n` +
        `**To:** ${args.to}`;
    } catch (error: any) {
      log.error(`Error sending email: ${error.message || error}`);
      if (error.code === 403) throw new UserError("Permission denied. Make sure you have granted Gmail send access.");
      throw new UserError(`Failed to send email: ${error.message || 'Unknown error'}`);
    }
  },
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
  execute: async (args, { log, session }) => {
    const gmail = getGmailClient(session);
    log.info(`Creating draft email to: ${args.to}`);

    try {
      const raw = createRawEmail(args.to, args.subject, args.body, {
        cc: args.cc,
        bcc: args.bcc,
        isHtml: args.isHtml,
      });

      const response = await gmail.users.drafts.create({
        userId: 'me',
        requestBody: {
          message: { raw },
        },
      });

      return `Draft created successfully!\n\n` +
        `**Draft ID:** ${response.data.id}\n` +
        `**Message ID:** ${response.data.message?.id}\n` +
        `**To:** ${args.to}`;
    } catch (error: any) {
      log.error(`Error creating draft: ${error.message || error}`);
      if (error.code === 403) throw new UserError("Permission denied. Make sure you have granted Gmail access.");
      throw new UserError(`Failed to create draft: ${error.message || 'Unknown error'}`);
    }
  },
});

gmailServer.addTool({
  name: 'readEmail',
  description: 'Read the full content of an email by its message ID.',
  parameters: z.object({
    messageId: z.string().describe('The Gmail message ID to read.'),
    format: z.enum(['full', 'metadata', 'minimal']).optional().default('full')
      .describe('The format to return the message in.'),
  }),
  execute: async (args, { log, session }) => {
    const gmail = getGmailClient(session);
    log.info(`Reading email: ${args.messageId}`);

    try {
      const response = await gmail.users.messages.get({
        userId: 'me',
        id: args.messageId,
        format: args.format,
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

      // Extract body
      const body = extractBody(msg.payload);
      if (body) {
        result += `\n**Body:**\n\n${body}`;
      }

      // List attachments
      const attachments = listAttachments(msg.payload);
      if (attachments.length > 0) {
        result += `\n\n**Attachments:**\n`;
        attachments.forEach((att, i) => {
          result += `${i + 1}. ${att.filename} (${att.mimeType}, ${att.size} bytes, ID: ${att.attachmentId})\n`;
        });
      }

      return result;
    } catch (error: any) {
      log.error(`Error reading email: ${error.message || error}`);
      if (error.code === 404) throw new UserError(`Email not found (ID: ${args.messageId}).`);
      if (error.code === 403) throw new UserError("Permission denied. Make sure you have granted Gmail read access.");
      throw new UserError(`Failed to read email: ${error.message || 'Unknown error'}`);
    }
  },
});

gmailServer.addTool({
  name: 'searchEmails',
  description: 'Search emails using Gmail query syntax (e.g., "from:user@example.com", "subject:hello", "is:unread", "newer_than:2d").',
  parameters: z.object({
    query: z.string().describe('Gmail search query string.'),
    maxResults: z.number().optional().default(10).describe('Maximum number of results to return (1-500).'),
    pageToken: z.string().optional().describe('Page token for pagination.'),
  }),
  execute: async (args, { log, session }) => {
    const gmail = getGmailClient(session);
    log.info(`Searching emails: ${args.query}`);

    try {
      const listResponse = await gmail.users.messages.list({
        userId: 'me',
        q: args.query,
        maxResults: Math.min(args.maxResults || 10, 500),
        pageToken: args.pageToken,
      });

      const messageIds = listResponse.data.messages || [];
      if (messageIds.length === 0) {
        return 'No emails found matching your search.';
      }

      // Fetch metadata for each message
      const messages: gmail_v1.Schema$Message[] = [];
      for (const { id } of messageIds) {
        if (!id) continue;
        const msg = await gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'To', 'Date'],
        });
        messages.push(msg.data);
      }

      let result = formatEmailList(messages);

      if (listResponse.data.nextPageToken) {
        result += `\n**Next page token:** ${listResponse.data.nextPageToken}`;
      }

      return result;
    } catch (error: any) {
      log.error(`Error searching emails: ${error.message || error}`);
      if (error.code === 403) throw new UserError("Permission denied. Make sure you have granted Gmail read access.");
      throw new UserError(`Failed to search emails: ${error.message || 'Unknown error'}`);
    }
  },
});

gmailServer.addTool({
  name: 'modifyEmail',
  description: 'Modify labels on a single email message (add or remove labels).',
  parameters: z.object({
    messageId: z.string().describe('The Gmail message ID to modify.'),
    addLabelIds: z.array(z.string()).optional().describe('Label IDs to add to the message.'),
    removeLabelIds: z.array(z.string()).optional().describe('Label IDs to remove from the message.'),
  }),
  execute: async (args, { log, session }) => {
    const gmail = getGmailClient(session);
    log.info(`Modifying email labels: ${args.messageId}`);

    try {
      const response = await gmail.users.messages.modify({
        userId: 'me',
        id: args.messageId,
        requestBody: {
          addLabelIds: args.addLabelIds,
          removeLabelIds: args.removeLabelIds,
        },
      });

      return `Email labels modified successfully!\n\n` +
        `**Message ID:** ${response.data.id}\n` +
        `**Current Labels:** ${response.data.labelIds?.join(', ') || 'none'}`;
    } catch (error: any) {
      log.error(`Error modifying email: ${error.message || error}`);
      if (error.code === 404) throw new UserError(`Email not found (ID: ${args.messageId}).`);
      if (error.code === 403) throw new UserError("Permission denied.");
      throw new UserError(`Failed to modify email: ${error.message || 'Unknown error'}`);
    }
  },
});

gmailServer.addTool({
  name: 'deleteEmail',
  description: 'Permanently delete an email message. This cannot be undone.',
  parameters: z.object({
    messageId: z.string().describe('The Gmail message ID to permanently delete.'),
  }),
  execute: async (args, { log, session }) => {
    const gmail = getGmailClient(session);
    log.info(`Deleting email: ${args.messageId}`);

    try {
      await gmail.users.messages.delete({
        userId: 'me',
        id: args.messageId,
      });

      return `Email permanently deleted (ID: ${args.messageId}).`;
    } catch (error: any) {
      log.error(`Error deleting email: ${error.message || error}`);
      if (error.code === 404) throw new UserError(`Email not found (ID: ${args.messageId}).`);
      if (error.code === 403) throw new UserError("Permission denied.");
      throw new UserError(`Failed to delete email: ${error.message || 'Unknown error'}`);
    }
  },
});

// === BATCH OPERATIONS ===

gmailServer.addTool({
  name: 'batchModifyEmails',
  description: 'Modify labels on multiple email messages at once.',
  parameters: z.object({
    messageIds: z.array(z.string()).describe('Array of Gmail message IDs to modify.'),
    addLabelIds: z.array(z.string()).optional().describe('Label IDs to add to all messages.'),
    removeLabelIds: z.array(z.string()).optional().describe('Label IDs to remove from all messages.'),
  }),
  execute: async (args, { log, session }) => {
    const gmail = getGmailClient(session);
    log.info(`Batch modifying ${args.messageIds.length} emails`);

    try {
      await gmail.users.messages.batchModify({
        userId: 'me',
        requestBody: {
          ids: args.messageIds,
          addLabelIds: args.addLabelIds,
          removeLabelIds: args.removeLabelIds,
        },
      });

      return `Successfully modified labels on ${args.messageIds.length} email(s).\n` +
        (args.addLabelIds?.length ? `**Added labels:** ${args.addLabelIds.join(', ')}\n` : '') +
        (args.removeLabelIds?.length ? `**Removed labels:** ${args.removeLabelIds.join(', ')}` : '');
    } catch (error: any) {
      log.error(`Error batch modifying emails: ${error.message || error}`);
      if (error.code === 403) throw new UserError("Permission denied.");
      throw new UserError(`Failed to batch modify emails: ${error.message || 'Unknown error'}`);
    }
  },
});

gmailServer.addTool({
  name: 'batchDeleteEmails',
  description: 'Permanently delete multiple email messages at once. This cannot be undone.',
  parameters: z.object({
    messageIds: z.array(z.string()).describe('Array of Gmail message IDs to permanently delete.'),
  }),
  execute: async (args, { log, session }) => {
    const gmail = getGmailClient(session);
    log.info(`Batch deleting ${args.messageIds.length} emails`);

    try {
      await gmail.users.messages.batchDelete({
        userId: 'me',
        requestBody: {
          ids: args.messageIds,
        },
      });

      return `Successfully deleted ${args.messageIds.length} email(s) permanently.`;
    } catch (error: any) {
      log.error(`Error batch deleting emails: ${error.message || error}`);
      if (error.code === 403) throw new UserError("Permission denied.");
      throw new UserError(`Failed to batch delete emails: ${error.message || 'Unknown error'}`);
    }
  },
});

// === LABEL MANAGEMENT ===

gmailServer.addTool({
  name: 'listLabels',
  description: 'List all Gmail labels with their message and thread counts.',
  parameters: z.object({}),
  execute: async (_args, { log, session }) => {
    const gmail = getGmailClient(session);
    log.info('Listing Gmail labels');

    try {
      const response = await gmail.users.labels.list({ userId: 'me' });
      const labels = response.data.labels || [];

      if (labels.length === 0) return 'No labels found.';

      // Fetch details for each label to get counts
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
      log.error(`Error listing labels: ${error.message || error}`);
      if (error.code === 403) throw new UserError("Permission denied.");
      throw new UserError(`Failed to list labels: ${error.message || 'Unknown error'}`);
    }
  },
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
  execute: async (args, { log, session }) => {
    const gmail = getGmailClient(session);
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

      return `Label created successfully!\n\n` +
        `**Name:** ${response.data.name}\n` +
        `**ID:** ${response.data.id}\n` +
        `**Type:** ${response.data.type}`;
    } catch (error: any) {
      log.error(`Error creating label: ${error.message || error}`);
      if (error.code === 409) throw new UserError(`Label "${args.name}" already exists.`);
      if (error.code === 403) throw new UserError("Permission denied.");
      throw new UserError(`Failed to create label: ${error.message || 'Unknown error'}`);
    }
  },
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
  execute: async (args, { log, session }) => {
    const gmail = getGmailClient(session);
    log.info(`Updating label: ${args.labelId}`);

    try {
      const requestBody: gmail_v1.Schema$Label = {};
      if (args.name !== undefined) requestBody.name = args.name;
      if (args.labelListVisibility !== undefined) requestBody.labelListVisibility = args.labelListVisibility;
      if (args.messageListVisibility !== undefined) requestBody.messageListVisibility = args.messageListVisibility;

      const response = await gmail.users.labels.update({
        userId: 'me',
        id: args.labelId,
        requestBody,
      });

      return `Label updated successfully!\n\n` +
        `**Name:** ${response.data.name}\n` +
        `**ID:** ${response.data.id}`;
    } catch (error: any) {
      log.error(`Error updating label: ${error.message || error}`);
      if (error.code === 404) throw new UserError(`Label not found (ID: ${args.labelId}).`);
      if (error.code === 403) throw new UserError("Permission denied. Cannot modify system labels.");
      throw new UserError(`Failed to update label: ${error.message || 'Unknown error'}`);
    }
  },
});

gmailServer.addTool({
  name: 'deleteLabel',
  description: 'Delete a Gmail label. System labels (INBOX, SENT, etc.) cannot be deleted.',
  parameters: z.object({
    labelId: z.string().describe('The label ID to delete.'),
  }),
  execute: async (args, { log, session }) => {
    const gmail = getGmailClient(session);
    log.info(`Deleting label: ${args.labelId}`);

    // Protect system labels
    const systemLabels = ['INBOX', 'SENT', 'DRAFT', 'TRASH', 'SPAM', 'STARRED', 'UNREAD', 'IMPORTANT',
      'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'];
    if (systemLabels.includes(args.labelId)) {
      throw new UserError(`Cannot delete system label: ${args.labelId}`);
    }

    try {
      await gmail.users.labels.delete({
        userId: 'me',
        id: args.labelId,
      });

      return `Label deleted successfully (ID: ${args.labelId}).`;
    } catch (error: any) {
      log.error(`Error deleting label: ${error.message || error}`);
      if (error.code === 404) throw new UserError(`Label not found (ID: ${args.labelId}).`);
      if (error.code === 403) throw new UserError("Permission denied. Cannot delete system labels.");
      throw new UserError(`Failed to delete label: ${error.message || 'Unknown error'}`);
    }
  },
});

gmailServer.addTool({
  name: 'getOrCreateLabel',
  description: 'Get a label by name, creating it if it does not exist. Returns the label ID.',
  parameters: z.object({
    name: z.string().describe('The label name to find or create.'),
  }),
  execute: async (args, { log, session }) => {
    const gmail = getGmailClient(session);
    log.info(`Getting or creating label: ${args.name}`);

    try {
      // First, list all labels and search by name
      const listResponse = await gmail.users.labels.list({ userId: 'me' });
      const existing = listResponse.data.labels?.find(
        l => l.name?.toLowerCase() === args.name.toLowerCase()
      );

      if (existing) {
        return `Label found!\n\n` +
          `**Name:** ${existing.name}\n` +
          `**ID:** ${existing.id}\n` +
          `**Type:** ${existing.type}`;
      }

      // Create new label
      const response = await gmail.users.labels.create({
        userId: 'me',
        requestBody: { name: args.name },
      });

      return `Label created!\n\n` +
        `**Name:** ${response.data.name}\n` +
        `**ID:** ${response.data.id}\n` +
        `**Type:** ${response.data.type}`;
    } catch (error: any) {
      log.error(`Error getting/creating label: ${error.message || error}`);
      if (error.code === 403) throw new UserError("Permission denied.");
      throw new UserError(`Failed to get or create label: ${error.message || 'Unknown error'}`);
    }
  },
});

// === ATTACHMENT ===

gmailServer.addTool({
  name: 'getAttachment',
  description: 'Download an email attachment. Returns the content as base64-encoded data.',
  parameters: z.object({
    messageId: z.string().describe('The Gmail message ID containing the attachment.'),
    attachmentId: z.string().describe('The attachment ID to download.'),
  }),
  execute: async (args, { log, session }) => {
    const gmail = getGmailClient(session);
    log.info(`Getting attachment ${args.attachmentId} from message ${args.messageId}`);

    try {
      const response = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId: args.messageId,
        id: args.attachmentId,
      });

      const data = response.data;
      return `Attachment retrieved successfully!\n\n` +
        `**Size:** ${data.size} bytes\n` +
        `**Data (base64):**\n${data.data}`;
    } catch (error: any) {
      log.error(`Error getting attachment: ${error.message || error}`);
      if (error.code === 404) throw new UserError("Attachment not found.");
      if (error.code === 403) throw new UserError("Permission denied.");
      throw new UserError(`Failed to get attachment: ${error.message || 'Unknown error'}`);
    }
  },
});

// === HELPER FUNCTIONS ===

/**
 * Extract the body text from a Gmail message payload.
 */
function extractBody(payload?: gmail_v1.Schema$MessagePart): string {
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
function listAttachments(
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

export { gmailServer };
