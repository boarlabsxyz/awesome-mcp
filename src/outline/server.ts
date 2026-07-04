// src/outline/server.ts
// Adapted from https://github.com/Vortiago/mcp-outline@e699cd5d16a983c7bcb4e67c3cf213608df7eeac
// (tool names, params, and behavior mirror the reference; response shapes are
// translated to plain text per this repo's tool-pattern conventions.)
import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';

import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import {
  OutlineClient,
  formatCollections,
  formatCollectionStructure,
  formatComment,
  formatComments,
  formatDocumentsList,
  formatFileOperation,
  formatSearchResults,
  formatAttachmentList,
  parseAttachmentIds,
} from './apiHelpers.js';

export const outlineServer = new FastMCP<UserSession>({
  name: 'Outline Wiki MCP',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'outline'),
});

function getOutlineClient(session?: UserSession): OutlineClient {
  if (!session?.outlineAccessToken) {
    throw new UserError('Outline not connected. Visit the dashboard to connect your Outline account.');
  }
  return new OutlineClient(session.outlineAccessToken);
}

function mapError(prefix: string, error: any, log: { error: (m: string) => void }): never {
  log.error(`${prefix}: ${error?.message ?? error}`);
  if (error?.status === 401 || error?.status === 403) {
    throw new UserError(`${prefix}: not authorized. Check that your Outline token has access.`);
  }
  if (error?.status === 404) {
    throw new UserError(`${prefix}: not found.`);
  }
  throw new UserError(`${prefix}: ${error?.message ?? 'Unknown error'}`);
}

// === Documents: reading ===

outlineServer.addTool({
  name: 'getDocument',
  annotations: { readOnlyHint: true },
  description: 'Retrieves an Outline document by ID and returns its title and markdown content.',
  parameters: z.object({
    documentId: z.string().describe('The Outline document ID (from documents.info).'),
  }),
  execute: async (args, { log, session }) => {
    const client = getOutlineClient(session);
    log.info(`Reading Outline document ${args.documentId}`);
    try {
      const doc = await client.getDocument(args.documentId);
      if (!doc) throw new UserError('Document not found.');
      const parts = [`# ${doc.title ?? 'Untitled'}`, ''];
      if (doc.text) parts.push(doc.text);
      if (doc.url) parts.push('', `URL: ${doc.url}`);
      return parts.join('\n');
    } catch (error: any) {
      mapError('Failed to read document', error, log);
    }
  },
});

outlineServer.addTool({
  name: 'exportDocument',
  annotations: { readOnlyHint: true },
  description: 'Exports an Outline document as plain markdown text.',
  parameters: z.object({
    documentId: z.string().describe('The document ID to export.'),
  }),
  execute: async (args, { log, session }) => {
    const client = getOutlineClient(session);
    log.info(`Exporting Outline document ${args.documentId}`);
    try {
      return await client.exportDocument(args.documentId);
    } catch (error: any) {
      mapError('Failed to export document', error, log);
    }
  },
});

// === Documents: search / list ===

outlineServer.addTool({
  name: 'searchDocuments',
  annotations: { readOnlyHint: true },
  description: 'Full-text search across Outline documents. Supports collection filter and status filter (draft/archived/published).',
  parameters: z.object({
    query: z.string().describe('Search terms (e.g., "vacation policy").'),
    collectionId: z.string().optional().describe('Limit search to a single collection.'),
    limit: z.number().int().min(1).max(100).optional().default(25).describe('Max results (default 25, max 100).'),
    offset: z.number().int().min(0).optional().default(0).describe('Skip N results for pagination.'),
    statusFilter: z
      .array(z.enum(['draft', 'archived', 'published']))
      .optional()
      .describe('Which statuses to include (default: published).'),
  }),
  execute: async (args, { log, session }) => {
    const client = getOutlineClient(session);
    log.info(`Searching Outline for "${args.query}"`);
    try {
      const { data, pagination } = await client.searchDocuments({
        query: args.query,
        collectionId: args.collectionId,
        limit: args.limit,
        offset: args.offset,
        statusFilter: args.statusFilter,
      });
      return formatSearchResults(data, pagination);
    } catch (error: any) {
      mapError('Failed to search documents', error, log);
    }
  },
});

outlineServer.addTool({
  name: 'getDocumentIdFromTitle',
  annotations: { readOnlyHint: true },
  description: 'Find an Outline document ID by title. Prefers exact matches, falls back to best partial match.',
  parameters: z.object({
    query: z.string().describe('Title (exact or partial).'),
    collectionId: z.string().optional().describe('Restrict search to a single collection.'),
  }),
  execute: async (args, { log, session }) => {
    const client = getOutlineClient(session);
    log.info(`Looking up Outline document by title "${args.query}"`);
    try {
      const { data: results } = await client.searchDocuments({
        query: args.query,
        collectionId: args.collectionId,
      });
      if (results.length === 0) return `No documents found matching '${args.query}'`;
      const needle = args.query.toLowerCase();
      const exact = results.find(r => (r.document?.title ?? '').toLowerCase() === needle);
      const pick = exact ?? results[0];
      const doc = pick.document;
      const label = exact ? 'Document ID' : 'Best match - Document ID';
      return `${label}: ${doc?.id ?? 'unknown'} (Title: ${doc?.title ?? 'Untitled'})`;
    } catch (error: any) {
      mapError('Failed to look up document', error, log);
    }
  },
});

outlineServer.addTool({
  name: 'listRecentlyUpdatedDocuments',
  annotations: { readOnlyHint: true },
  description: 'Lists Outline documents ordered by most recent change (newest first). Coarse time window: day/week/month/year.',
  parameters: z.object({
    dateFilter: z.enum(['day', 'week', 'month', 'year']).optional().default('week').describe('Time window on last-modified (default: week).'),
    collectionId: z.string().optional().describe('Restrict to a single collection.'),
    statusFilter: z.array(z.enum(['draft', 'archived', 'published'])).optional().describe('Statuses to include (default: published).'),
    limit: z.number().int().min(1).max(100).optional().default(25).describe('Max documents (default 25).'),
    offset: z.number().int().min(0).optional().default(0).describe('Skip N results for pagination.'),
  }),
  execute: async (args, { log, session }) => {
    const client = getOutlineClient(session);
    log.info(`Listing recently updated Outline documents (dateFilter=${args.dateFilter})`);
    try {
      const { data: results } = await client.searchDocuments({
        query: '',
        collectionId: args.collectionId,
        limit: args.limit,
        offset: args.offset,
        statusFilter: args.statusFilter,
        sort: 'updatedAt',
        direction: 'DESC',
        dateFilter: args.dateFilter,
      });
      const docs = results.map(r => r.document ?? { id: '' });
      return formatDocumentsList(docs, 'Recently Updated Documents');
    } catch (error: any) {
      mapError('Failed to list recently updated documents', error, log);
    }
  },
});

outlineServer.addTool({
  name: 'getDocumentBacklinks',
  annotations: { readOnlyHint: true },
  description: 'Lists all Outline documents that link to a given document.',
  parameters: z.object({
    documentId: z.string().describe('The document ID to find backlinks for.'),
  }),
  execute: async (args, { log, session }) => {
    const client = getOutlineClient(session);
    log.info(`Fetching backlinks for Outline document ${args.documentId}`);
    try {
      const docs = await client.listDocuments({ backlinkDocumentId: args.documentId });
      if (docs.length === 0) return 'No documents link to this document.';
      return formatDocumentsList(docs, 'Documents Linking to This Document');
    } catch (error: any) {
      mapError('Failed to fetch backlinks', error, log);
    }
  },
});

outlineServer.addTool({
  name: 'listArchivedDocuments',
  annotations: { readOnlyHint: true },
  description: 'Lists all archived Outline documents.',
  parameters: z.object({}),
  execute: async (_args, { log, session }) => {
    const client = getOutlineClient(session);
    log.info('Listing archived Outline documents');
    try {
      const docs = await client.listArchivedDocuments();
      return formatDocumentsList(docs, 'Archived Documents');
    } catch (error: any) {
      mapError('Failed to list archived documents', error, log);
    }
  },
});

outlineServer.addTool({
  name: 'listTrash',
  annotations: { readOnlyHint: true },
  description: 'Lists all Outline documents currently in the trash.',
  parameters: z.object({}),
  execute: async (_args, { log, session }) => {
    const client = getOutlineClient(session);
    log.info('Listing Outline trash');
    try {
      const docs = await client.listTrash();
      return formatDocumentsList(docs, 'Documents in Trash');
    } catch (error: any) {
      mapError('Failed to list trash', error, log);
    }
  },
});

// === Documents: write ===

outlineServer.addTool({
  name: 'createDocument',
  description: 'Creates a new Outline document in a collection. Optionally publishes immediately, sets an icon, or nests under a parent.',
  parameters: z.object({
    title: z.string().describe('Document title.'),
    collectionId: z.string().describe('The collection ID to create the document in.'),
    text: z.string().optional().default('').describe('Markdown content (optional).'),
    parentDocumentId: z.string().optional().describe('Parent document ID for nesting.'),
    publish: z.boolean().optional().default(true).describe('Publish immediately (default true) or save as draft.'),
    template: z.boolean().optional().describe('If true, create as a template.'),
    icon: z.string().optional().describe('Optional emoji icon (e.g. "📋").'),
  }),
  execute: async (args, { log, session }) => {
    const client = getOutlineClient(session);
    log.info(`Creating Outline document "${args.title}" in collection ${args.collectionId}`);
    try {
      const doc = await client.createDocument({
        title: args.title,
        collectionId: args.collectionId,
        text: args.text,
        parentDocumentId: args.parentDocumentId,
        publish: args.publish,
        template: args.template,
        icon: args.icon,
      });
      if (!doc) throw new UserError('Failed to create document.');
      return `Document created successfully: ${doc.title ?? 'Untitled'} (ID: ${doc.id ?? 'unknown'})`;
    } catch (error: any) {
      mapError('Failed to create document', error, log);
    }
  },
});

outlineServer.addTool({
  name: 'updateDocument',
  description: 'Updates an Outline document. Replaces title/content unless append=true.',
  parameters: z.object({
    documentId: z.string().describe('The document ID to update.'),
    title: z.string().optional().describe('New title (leave empty to keep).'),
    text: z.string().optional().describe('New content (leave empty to keep).'),
    append: z.boolean().optional().default(false).describe('If true, append text instead of replacing.'),
    template: z.boolean().optional().describe('If set, convert to/from a template.'),
    icon: z.string().optional().describe('Emoji icon; empty string clears it.'),
  }),
  execute: async (args, { log, session }) => {
    const client = getOutlineClient(session);
    log.info(`Updating Outline document ${args.documentId}`);
    try {
      const doc = await client.updateDocument({
        id: args.documentId,
        title: args.title,
        text: args.text,
        append: args.text !== undefined ? args.append : undefined,
        template: args.template,
        icon: args.icon === '' ? null : args.icon,
      });
      if (!doc) throw new UserError('Failed to update document.');
      return `Document updated successfully: ${doc.title ?? 'Untitled'}`;
    } catch (error: any) {
      mapError('Failed to update document', error, log);
    }
  },
});

outlineServer.addTool({
  name: 'moveDocument',
  description: 'Moves an Outline document to a different collection and/or under a different parent. Must specify at least one destination.',
  parameters: z.object({
    documentId: z.string().describe('The document ID to move.'),
    collectionId: z.string().optional().describe('Target collection ID.'),
    parentDocumentId: z.string().optional().describe('New parent document ID (for nesting).'),
  }),
  execute: async (args, { log, session }) => {
    const client = getOutlineClient(session);
    if (!args.collectionId && !args.parentDocumentId) {
      throw new UserError('Specify at least one of collectionId or parentDocumentId.');
    }
    log.info(`Moving Outline document ${args.documentId}`);
    try {
      const res = await client.moveDocument({
        id: args.documentId,
        collectionId: args.collectionId,
        parentDocumentId: args.parentDocumentId,
      });
      if (res?.data) return 'Document moved successfully.';
      throw new UserError('Failed to move document.');
    } catch (error: any) {
      mapError('Failed to move document', error, log);
    }
  },
});

outlineServer.addTool({
  name: 'archiveDocument',
  description: 'Archives an Outline document (removes from collections but keeps searchable).',
  parameters: z.object({
    documentId: z.string().describe('The document ID to archive.'),
  }),
  execute: async (args, { log, session }) => {
    const client = getOutlineClient(session);
    log.info(`Archiving Outline document ${args.documentId}`);
    try {
      const doc = await client.archiveDocument(args.documentId);
      if (!doc) throw new UserError('Failed to archive document.');
      return `Document archived successfully: ${doc.title ?? 'Untitled'}`;
    } catch (error: any) {
      mapError('Failed to archive document', error, log);
    }
  },
});

outlineServer.addTool({
  name: 'unarchiveDocument',
  description: 'Unarchives a previously archived Outline document.',
  parameters: z.object({
    documentId: z.string().describe('The document ID to unarchive.'),
  }),
  execute: async (args, { log, session }) => {
    const client = getOutlineClient(session);
    log.info(`Unarchiving Outline document ${args.documentId}`);
    try {
      const doc = await client.unarchiveDocument(args.documentId);
      if (!doc) throw new UserError('Failed to unarchive document.');
      return `Document unarchived successfully: ${doc.title ?? 'Untitled'}`;
    } catch (error: any) {
      mapError('Failed to unarchive document', error, log);
    }
  },
});

outlineServer.addTool({
  name: 'restoreDocument',
  description: 'Restores an Outline document from the trash back to active status.',
  parameters: z.object({
    documentId: z.string().describe('The document ID to restore from trash.'),
  }),
  execute: async (args, { log, session }) => {
    const client = getOutlineClient(session);
    log.info(`Restoring Outline document ${args.documentId} from trash`);
    try {
      const doc = await client.restoreDocument(args.documentId);
      if (!doc) throw new UserError('Failed to restore document.');
      return `Document restored successfully: ${doc.title ?? 'Untitled'}`;
    } catch (error: any) {
      mapError('Failed to restore document', error, log);
    }
  },
});

outlineServer.addTool({
  name: 'deleteDocument',
  description: 'Moves an Outline document to trash. Set permanent=true to skip trash and delete immediately (irreversible).',
  parameters: z.object({
    documentId: z.string().describe('The document ID to delete.'),
    permanent: z.boolean().optional().default(false).describe('If true, permanently delete (no recovery).'),
  }),
  execute: async (args, { log, session }) => {
    const client = getOutlineClient(session);
    log.info(`Deleting Outline document ${args.documentId} (permanent=${args.permanent})`);
    try {
      if (args.permanent) {
        const res = await client.permanentlyDeleteDocument(args.documentId);
        if (res?.success) return 'Document permanently deleted.';
        throw new UserError('Failed to permanently delete document.');
      }
      const doc = await client.getDocument(args.documentId).catch(() => undefined);
      const title = doc?.title ?? 'Untitled';
      const res = await client.moveToTrash(args.documentId);
      if (res?.success) return `Document moved to trash: ${title}`;
      throw new UserError('Failed to move document to trash.');
    } catch (error: any) {
      mapError('Failed to delete document', error, log);
    }
  },
});

// === Collections ===

outlineServer.addTool({
  name: 'listCollections',
  annotations: { readOnlyHint: true },
  description: 'Lists all Outline collections in the workspace.',
  parameters: z.object({
    limit: z.number().int().min(1).max(100).optional().default(100).describe('Max collections (default 100).'),
    offset: z.number().int().min(0).optional().default(0).describe('Skip N results.'),
  }),
  execute: async (args, { log, session }) => {
    const client = getOutlineClient(session);
    log.info(`Listing Outline collections (limit=${args.limit}, offset=${args.offset})`);
    try {
      const collections = await client.listCollections({ limit: args.limit, offset: args.offset });
      return formatCollections(collections);
    } catch (error: any) {
      mapError('Failed to list collections', error, log);
    }
  },
});

outlineServer.addTool({
  name: 'getCollectionStructure',
  annotations: { readOnlyHint: true },
  description: 'Returns the hierarchical document tree for an Outline collection.',
  parameters: z.object({
    collectionId: z.string().describe('The collection ID.'),
  }),
  execute: async (args, { log, session }) => {
    const client = getOutlineClient(session);
    log.info(`Fetching Outline collection structure ${args.collectionId}`);
    try {
      const nodes = await client.getCollectionDocuments(args.collectionId);
      return formatCollectionStructure(nodes);
    } catch (error: any) {
      mapError('Failed to fetch collection structure', error, log);
    }
  },
});

outlineServer.addTool({
  name: 'createCollection',
  description: 'Creates a new Outline collection.',
  parameters: z.object({
    name: z.string().describe('Collection name.'),
    description: z.string().optional().default('').describe('Optional description.'),
    color: z
      .string()
      .regex(/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/, 'Color must be a hex like #RRGGBB or #RGB.')
      .optional()
      .describe('Optional hex color, e.g. #FF0000.'),
  }),
  execute: async (args, { log, session }) => {
    const client = getOutlineClient(session);
    log.info(`Creating Outline collection "${args.name}"`);
    try {
      const c = await client.createCollection({
        name: args.name,
        description: args.description,
        color: args.color,
      });
      if (!c) throw new UserError('Failed to create collection.');
      return `Collection created successfully: ${c.name ?? 'Untitled'} (ID: ${c.id ?? 'unknown'})`;
    } catch (error: any) {
      mapError('Failed to create collection', error, log);
    }
  },
});

outlineServer.addTool({
  name: 'updateCollection',
  description: 'Updates an Outline collection\'s name, description, or color. Provide at least one field.',
  parameters: z.object({
    collectionId: z.string().describe('The collection ID.'),
    name: z.string().optional().describe('New name.'),
    description: z.string().optional().describe('New description.'),
    color: z
      .string()
      .regex(/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/, 'Color must be a hex like #RRGGBB or #RGB.')
      .optional()
      .describe('New hex color, e.g. #FF0000.'),
  }),
  execute: async (args, { log, session }) => {
    const client = getOutlineClient(session);
    if (args.name === undefined && args.description === undefined && args.color === undefined) {
      throw new UserError('Specify at least one field to update (name, description, or color).');
    }
    log.info(`Updating Outline collection ${args.collectionId}`);
    try {
      const c = await client.updateCollection({
        id: args.collectionId,
        name: args.name,
        description: args.description,
        color: args.color,
      });
      if (!c) throw new UserError('Failed to update collection.');
      return `Collection updated successfully: ${c.name ?? 'Untitled'}`;
    } catch (error: any) {
      mapError('Failed to update collection', error, log);
    }
  },
});

outlineServer.addTool({
  name: 'deleteCollection',
  description: 'Permanently deletes an Outline collection AND all documents in it. This cannot be undone.',
  parameters: z.object({
    collectionId: z.string().describe('The collection ID to delete.'),
  }),
  execute: async (args, { log, session }) => {
    const client = getOutlineClient(session);
    log.info(`Deleting Outline collection ${args.collectionId}`);
    try {
      const res = await client.deleteCollection(args.collectionId);
      if (res?.success) return 'Collection and all its documents deleted successfully.';
      throw new UserError('Failed to delete collection.');
    } catch (error: any) {
      mapError('Failed to delete collection', error, log);
    }
  },
});

outlineServer.addTool({
  name: 'exportCollection',
  annotations: { readOnlyHint: true },
  description: 'Starts an async export of an Outline collection. Returns a file operation ID and status.',
  parameters: z.object({
    collectionId: z.string().describe('The collection ID.'),
    format: z.enum(['outline-markdown', 'json', 'html']).optional().default('outline-markdown').describe('Export format.'),
  }),
  execute: async (args, { log, session }) => {
    const client = getOutlineClient(session);
    log.info(`Exporting Outline collection ${args.collectionId} as ${args.format}`);
    try {
      const op = await client.exportCollection(args.collectionId, args.format);
      if (!op) throw new UserError('Failed to start export operation.');
      return formatFileOperation(op);
    } catch (error: any) {
      mapError('Failed to export collection', error, log);
    }
  },
});

outlineServer.addTool({
  name: 'exportAllCollections',
  annotations: { readOnlyHint: true },
  description: 'Starts an async export of the entire Outline workspace. Returns a file operation ID and status.',
  parameters: z.object({
    format: z.enum(['outline-markdown', 'json', 'html']).optional().default('outline-markdown').describe('Export format.'),
  }),
  execute: async (args, { log, session }) => {
    const client = getOutlineClient(session);
    log.info(`Exporting all Outline collections as ${args.format}`);
    try {
      const op = await client.exportAllCollections(args.format);
      if (!op) throw new UserError('Failed to start export operation.');
      return formatFileOperation(op);
    } catch (error: any) {
      mapError('Failed to export all collections', error, log);
    }
  },
});

// === Comments ===

outlineServer.addTool({
  name: 'listDocumentComments',
  annotations: { readOnlyHint: true },
  description: 'Lists comments on an Outline document (paginated).',
  parameters: z.object({
    documentId: z.string().describe('The document ID.'),
    includeAnchorText: z.boolean().optional().default(false).describe('Include the referenced document text with each comment.'),
    limit: z.number().int().min(1).max(100).optional().default(25).describe('Max comments (default 25).'),
    offset: z.number().int().min(0).optional().default(0).describe('Skip N results.'),
  }),
  execute: async (args, { log, session }) => {
    const client = getOutlineClient(session);
    log.info(`Listing comments for Outline document ${args.documentId}`);
    try {
      const { data, pagination } = await client.listDocumentComments({
        documentId: args.documentId,
        includeAnchorText: args.includeAnchorText,
        limit: args.limit,
        offset: args.offset,
      });
      return formatComments(data, pagination, args.limit, args.offset);
    } catch (error: any) {
      mapError('Failed to list comments', error, log);
    }
  },
});

outlineServer.addTool({
  name: 'getComment',
  annotations: { readOnlyHint: true },
  description: 'Retrieves a single Outline comment by ID.',
  parameters: z.object({
    commentId: z.string().describe('The comment ID.'),
    includeAnchorText: z.boolean().optional().default(false).describe('Include the referenced document text.'),
  }),
  execute: async (args, { log, session }) => {
    const client = getOutlineClient(session);
    log.info(`Fetching Outline comment ${args.commentId}`);
    try {
      const c = await client.getComment(args.commentId, args.includeAnchorText);
      if (!c) throw new UserError('Comment not found.');
      return formatComment(c);
    } catch (error: any) {
      mapError('Failed to fetch comment', error, log);
    }
  },
});

outlineServer.addTool({
  name: 'addComment',
  description: 'Adds a comment on an Outline document, or replies to an existing comment.',
  parameters: z.object({
    documentId: z.string().describe('The document to comment on.'),
    text: z.string().describe('Comment text (supports markdown).'),
    parentCommentId: z.string().optional().describe('Parent comment ID for replies.'),
  }),
  execute: async (args, { log, session }) => {
    const client = getOutlineClient(session);
    log.info(`Adding Outline comment on ${args.documentId}${args.parentCommentId ? ` (reply to ${args.parentCommentId})` : ''}`);
    try {
      const c = await client.createComment({
        documentId: args.documentId,
        text: args.text,
        parentCommentId: args.parentCommentId,
      });
      if (!c) throw new UserError('Failed to create comment.');
      const kind = args.parentCommentId ? 'Reply' : 'Comment';
      return `${kind} added successfully (ID: ${c.id ?? 'unknown'})`;
    } catch (error: any) {
      mapError('Failed to add comment', error, log);
    }
  },
});

// === Attachments ===

outlineServer.addTool({
  name: 'listDocumentAttachments',
  annotations: { readOnlyHint: true },
  description: 'Lists attachment IDs referenced in an Outline document by parsing its markdown for /api/attachments.redirect links.',
  parameters: z.object({
    documentId: z.string().describe('The document ID to scan.'),
  }),
  execute: async (args, { log, session }) => {
    const client = getOutlineClient(session);
    log.info(`Scanning Outline document ${args.documentId} for attachments`);
    try {
      const doc = await client.getDocument(args.documentId);
      if (!doc) throw new UserError('Document not found.');
      const attachments = parseAttachmentIds(doc.text ?? '');
      return formatAttachmentList(doc.title ?? 'Untitled', attachments);
    } catch (error: any) {
      mapError('Failed to list attachments', error, log);
    }
  },
});

outlineServer.addTool({
  name: 'getAttachmentUrl',
  annotations: { readOnlyHint: true },
  description: 'Resolves an Outline attachment ID to a signed download URL by following the /api/attachments.redirect redirect.',
  parameters: z.object({
    attachmentId: z.string().describe('The attachment UUID.'),
  }),
  execute: async (args, { log, session }) => {
    const client = getOutlineClient(session);
    log.info(`Resolving Outline attachment URL for ${args.attachmentId}`);
    try {
      const url = await client.getAttachmentRedirectUrl(args.attachmentId);
      if (!url) throw new UserError('Failed to resolve attachment URL.');
      return url;
    } catch (error: any) {
      mapError('Failed to resolve attachment URL', error, log);
    }
  },
});
