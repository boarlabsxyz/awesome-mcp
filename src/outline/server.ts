// src/outline/server.ts
// Adapted from https://github.com/Vortiago/mcp-outline@e699cd5d16a983c7bcb4e67c3cf213608df7eeac
// (tool names, params, and behavior mirror the reference; response shapes are
// translated to plain text per this repo's tool-pattern conventions.)
import { FastMCP, UserError } from 'fastmcp';
import { instrumentServer } from '../usage/instrumentServer.js';
import { z } from 'zod';

import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import {
  formatCollections,
  formatCollectionStructure,
  formatComment,
  formatComments,
  formatDocumentsList,
  formatFileOperation,
  formatSearchResults,
  formatAttachmentList,
  formatRevisions,
  formatTemplate,
  formatTemplates,
  formatUser,
  formatUsers,
  bodyMarkdown,
  describeRevision,
  parseAttachmentIds,
  withOutlineClient,
} from './apiHelpers.js';
import { registerMintRestBearerForCurl } from '../sharedTools/mintRestBearerForCurl.js';
import { registerListRestEndpoints } from '../sharedTools/listRestEndpoints.js';
// The write-parameter fields are defined ONCE in ./restOps.js and composed by both
// surfaces: the tools below add the id as a parameter, the REST routes take it
// from the path. Copying them would let the two drift on what is valid.
import {
  addCommentFields,
  archiveCollectionFields,
  createCollectionFields,
  createDocumentFields,
  importHtmlDocumentFields,
  moveDocumentFields,
  unpublishDocumentFields,
  updateCollectionFields,
  updateCommentFields,
  updateDocumentFields,
  uploadAttachmentFields,
  performAddComment,
  performCollectionLifecycle,
  performCommentResolution,
  performCompareRevisions,
  performCreateCollection,
  performCreateDocument,
  performDocumentLifecycle,
  performImportHtmlDocument,
  performMoveDocument,
  performUnpublishDocument,
  performUpdateCollection,
  performUpdateComment,
  performUpdateDocument,
  performUploadAttachment,
} from './restOps.js';

// Outline may normalise a colour's case.
const sameValue = (a: unknown, b: unknown) =>
  typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b;

/** What a write asked for that the returned record does not show — likely an Outline too old for the field. */
function notReflected(asked: Record<string, unknown>, got: Record<string, unknown> | undefined): string {
  const missing = Object.entries(asked)
    .filter(([k, v]) => v !== undefined && got !== undefined && !sameValue(got[k], v))
    .map(([k]) => k);
  return missing.length ? ` Not shown on the returned record (your Outline may not support it): ${missing.join(', ')}.` : '';
}

export const outlineServer = instrumentServer(new FastMCP<UserSession>({
  name: 'Outline Wiki MCP',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'outline'),
}), 'outline');

// Outline now has a live REST data plane, so an MCP client must be able to mint a
// short-lived bearer for it and discover what it exposes. Without these two the
// only usable credential is the permanent dashboard API key.
registerMintRestBearerForCurl(outlineServer);
registerListRestEndpoints(outlineServer);

// === Documents: reading ===

outlineServer.addTool({
  name: 'getDocument',
  annotations: { readOnlyHint: true },
  description: 'Retrieves an Outline document by ID and returns its title and markdown content.',
  parameters: z.object({
    documentId: z.string().describe('The Outline document ID (from documents.info).'),
  }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to read document', session, log, async (client) => {
      log.info(`Reading Outline document ${args.documentId}`);
      const doc = await client.getDocument(args.documentId);
      if (!doc) throw new UserError('Document not found.');
      const parts = [`# ${doc.title ?? 'Untitled'}`, ''];
      if (doc.text) parts.push(doc.text);
      if (doc.url) parts.push('', `URL: ${doc.url}`);
      return parts.join('\n');
    }),
});

outlineServer.addTool({
  name: 'exportDocument',
  annotations: { readOnlyHint: true },
  description: 'Exports an Outline document as plain markdown text.',
  parameters: z.object({
    documentId: z.string().describe('The document ID to export.'),
  }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to export document', session, log, async (client) => {
      log.info(`Exporting Outline document ${args.documentId}`);
      return client.exportDocument(args.documentId);
    }),
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
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to search documents', session, log, async (client) => {
      log.info(`Searching Outline for "${args.query}"`);
      const { data, pagination } = await client.searchDocuments({
        query: args.query,
        collectionId: args.collectionId,
        limit: args.limit,
        offset: args.offset,
        statusFilter: args.statusFilter,
      });
      return formatSearchResults(data, pagination);
    }),
});

outlineServer.addTool({
  name: 'getDocumentIdFromTitle',
  annotations: { readOnlyHint: true },
  description: 'Find an Outline document ID by title. Prefers exact matches, falls back to best partial match.',
  parameters: z.object({
    query: z.string().describe('Title (exact or partial).'),
    collectionId: z.string().optional().describe('Restrict search to a single collection.'),
  }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to look up document', session, log, async (client) => {
      log.info(`Looking up Outline document by title "${args.query}"`);
      const { data: results } = await client.searchDocuments({
        query: args.query,
        collectionId: args.collectionId,
      });
      if (results.length === 0) return `No documents found matching '${args.query}'`;
      const needle = args.query.toLowerCase();
      const exact = results.find((r) => (r.document?.title ?? '').toLowerCase() === needle);
      const pick = exact ?? results[0];
      const doc = pick.document;
      const label = exact ? 'Document ID' : 'Best match - Document ID';
      return `${label}: ${doc?.id ?? 'unknown'} (Title: ${doc?.title ?? 'Untitled'})`;
    }),
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
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to list recently updated documents', session, log, async (client) => {
      log.info(`Listing recently updated Outline documents (dateFilter=${args.dateFilter})`);
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
      const docs = results.map((r) => r.document ?? { id: '' });
      return formatDocumentsList(docs, 'Recently Updated Documents');
    }),
});

outlineServer.addTool({
  name: 'getDocumentBacklinks',
  annotations: { readOnlyHint: true },
  description: 'Lists all Outline documents that link to a given document.',
  parameters: z.object({
    documentId: z.string().describe('The document ID to find backlinks for.'),
  }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to fetch backlinks', session, log, async (client) => {
      log.info(`Fetching backlinks for Outline document ${args.documentId}`);
      const docs = await client.listDocuments({ backlinkDocumentId: args.documentId });
      if (docs.length === 0) return 'No documents link to this document.';
      return formatDocumentsList(docs, 'Documents Linking to This Document');
    }),
});

outlineServer.addTool({
  name: 'listArchivedDocuments',
  annotations: { readOnlyHint: true },
  description: 'Lists all archived Outline documents.',
  parameters: z.object({}),
  execute: (_args, { log, session }) =>
    withOutlineClient('Failed to list archived documents', session, log, async (client) => {
      log.info('Listing archived Outline documents');
      const docs = await client.listArchivedDocuments();
      return formatDocumentsList(docs, 'Archived Documents');
    }),
});

outlineServer.addTool({
  name: 'listTrash',
  annotations: { readOnlyHint: true },
  description: 'Lists all Outline documents currently in the trash.',
  parameters: z.object({}),
  execute: (_args, { log, session }) =>
    withOutlineClient('Failed to list trash', session, log, async (client) => {
      log.info('Listing Outline trash');
      const docs = await client.listTrash();
      return formatDocumentsList(docs, 'Documents in Trash');
    }),
});

// === Documents: write ===

outlineServer.addTool({
  name: 'createDocument',
  annotations: { readOnlyHint: false },
  description: 'Creates a new Outline document in a collection. Optionally publishes immediately, sets an icon and its colour, full width, nests under a parent, or starts from a template (templateId).',
  parameters: z.object(createDocumentFields),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to create document', session, log, async (client) => {
      log.info(`Creating Outline document "${args.title}" in collection ${args.collectionId}`);
      const doc = await performCreateDocument(client, args);
      return `Document created successfully: ${doc.title ?? 'Untitled'} (ID: ${doc.id ?? 'unknown'})`
        + notReflected({ color: args.color, fullWidth: args.fullWidth, templateId: args.templateId }, doc);
    }),
});

outlineServer.addTool({
  name: 'updateDocument',
  annotations: { readOnlyHint: false },
  description: 'Updates an Outline document. Replaces title/content unless append=true. To change one passage and keep the rest (and its formatting), '
    + 'pass findText (the exact markdown to replace) with text (the replacement). Also sets icon colour, full width, or publishes a draft (publish: true).',
  parameters: z.object({
    documentId: z.string().describe('The document ID to update.'),
    ...updateDocumentFields,
  }),
  execute: (args, { log, session }) => {
    const { documentId, ...fields } = args;
    if (Object.values({ ...fields, append: undefined }).every((v) => v === undefined)) {
      throw new UserError('Provide at least one of title, text, template, icon, color, fullWidth, or publish.');
    }
    return withOutlineClient('Failed to update document', session, log, async (client) => {
      log.info(`Updating Outline document ${documentId}${fields.findText !== undefined ? ' (passage edit)' : ''}`);
      const doc = await performUpdateDocument(client, documentId, fields);
      const published = fields.publish ? (doc.publishedAt ? ' Published.' : ' publish was sent, but the document shows no publish date.') : '';
      const passage = doc.passageEditVerified === null ? ' The passage edit could not be checked on re-read; look at the document.' : '';
      return `Document updated successfully: ${doc.title ?? 'Untitled'}.${published}${passage}`
        + notReflected({ color: fields.color, fullWidth: fields.fullWidth }, doc);
    });
  },
});

outlineServer.addTool({
  name: 'moveDocument',
  annotations: { readOnlyHint: false },
  description: 'Moves an Outline document to a different collection and/or under a different parent. Must specify at least one destination.',
  parameters: z.object({
    documentId: z.string().describe('The document ID to move.'),
    ...moveDocumentFields,
  }),
  execute: (args, { log, session }) => {
    if (!args.collectionId && !args.parentDocumentId) {
      throw new UserError('Specify at least one of collectionId or parentDocumentId.');
    }
    return withOutlineClient('Failed to move document', session, log, async (client) => {
      log.info(`Moving Outline document ${args.documentId}`);
      await performMoveDocument(client, args.documentId, args);
      return 'Document moved successfully.';
    });
  },
});

outlineServer.addTool({
  name: 'archiveDocument',
  annotations: { readOnlyHint: false },
  description: 'Archives an Outline document (removes from collections but keeps searchable). Reversible via unarchiveDocument.',
  parameters: z.object({
    documentId: z.string().describe('The document ID to archive.'),
  }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to archive document', session, log, async (client) => {
      log.info(`Archiving Outline document ${args.documentId}`);
      const doc = await performDocumentLifecycle(client, 'archive', args.documentId);
      return `Document archived successfully: ${doc.title ?? 'Untitled'}`;
    }),
});

outlineServer.addTool({
  name: 'unarchiveDocument',
  annotations: { readOnlyHint: false },
  description: 'Unarchives a previously archived Outline document.',
  parameters: z.object({
    documentId: z.string().describe('The document ID to unarchive.'),
  }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to unarchive document', session, log, async (client) => {
      log.info(`Unarchiving Outline document ${args.documentId}`);
      const doc = await performDocumentLifecycle(client, 'unarchive', args.documentId);
      return `Document unarchived successfully: ${doc.title ?? 'Untitled'}`;
    }),
});

outlineServer.addTool({
  name: 'restoreDocument',
  annotations: { readOnlyHint: false },
  description: 'Restores an Outline document from the trash back to active status.',
  parameters: z.object({
    documentId: z.string().describe('The document ID to restore from trash.'),
  }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to restore document', session, log, async (client) => {
      log.info(`Restoring Outline document ${args.documentId} from trash`);
      const doc = await performDocumentLifecycle(client, 'restore', args.documentId);
      return `Document restored successfully: ${doc.title ?? 'Untitled'}`;
    }),
});

outlineServer.addTool({
  name: 'unpublishDocument',
  annotations: { readOnlyHint: false },
  description: 'Returns a published Outline document to draft: it disappears from its collection for everyone else until published again (updateDocument with publish: true).',
  parameters: z.object({
    documentId: z.string().describe('The document ID to unpublish.'),
    ...unpublishDocumentFields,
  }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to unpublish document', session, log, async (client) => {
      log.info(`Unpublishing Outline document ${args.documentId}`);
      const doc = await performUnpublishDocument(client, args.documentId, args);
      const state = doc.publishedAt ? ' Outline still shows a publish date, so it may not have changed.' : ' It is a draft now.';
      return `Document unpublished: ${doc.title ?? 'Untitled'}.${state}`;
    }),
});

outlineServer.addTool({
  name: 'importHtmlDocument',
  annotations: { readOnlyHint: false },
  description: 'Creates an Outline document from HTML using Outline\'s importer, which also copies remote and base64 images into the workspace. '
    + 'Give collectionId or parentDocumentId. Up to 20 MB.',
  parameters: z.object(importHtmlDocumentFields),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to import document', session, log, async (client) => {
      log.info(`Importing HTML into Outline (${args.html.length} chars)`);
      const doc = await performImportHtmlDocument(client, args);
      return `Document imported: ${doc.title ?? 'Untitled'} (ID: ${doc.id ?? 'unknown'})${doc.url ? `\nURL: ${doc.url}` : ''}`;
    }),
});

outlineServer.addTool({
  name: 'deleteDocument',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Moves an Outline document to trash. Set permanent=true to skip trash and delete immediately (irreversible).',
  parameters: z.object({
    documentId: z.string().describe('The document ID to delete.'),
    permanent: z.boolean().optional().default(false).describe('If true, permanently delete (no recovery).'),
  }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to delete document', session, log, async (client) => {
      log.info(`Deleting Outline document ${args.documentId} (permanent=${args.permanent})`);
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
    }),
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
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to list collections', session, log, async (client) => {
      log.info(`Listing Outline collections (limit=${args.limit}, offset=${args.offset})`);
      const collections = await client.listCollections({ limit: args.limit, offset: args.offset });
      return formatCollections(collections);
    }),
});

outlineServer.addTool({
  name: 'getCollectionStructure',
  annotations: { readOnlyHint: true },
  description: 'Returns the hierarchical document tree for an Outline collection.',
  parameters: z.object({
    collectionId: z.string().describe('The collection ID.'),
  }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to fetch collection structure', session, log, async (client) => {
      log.info(`Fetching Outline collection structure ${args.collectionId}`);
      const nodes = await client.getCollectionDocuments(args.collectionId);
      return formatCollectionStructure(nodes);
    }),
});

outlineServer.addTool({
  name: 'createCollection',
  annotations: { readOnlyHint: false },
  description: 'Creates a new Outline collection.',
  parameters: z.object(createCollectionFields),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to create collection', session, log, async (client) => {
      log.info(`Creating Outline collection "${args.name}"`);
      const c = await performCreateCollection(client, args);
      return `Collection created successfully: ${c.name ?? 'Untitled'} (ID: ${c.id ?? 'unknown'})`;
    }),
});

outlineServer.addTool({
  name: 'updateCollection',
  annotations: { readOnlyHint: false },
  description: 'Updates an Outline collection\'s name, description, color, or icon. Provide at least one field.',
  parameters: z.object({
    collectionId: z.string().describe('The collection ID.'),
    ...updateCollectionFields,
  }),
  execute: (args, { log, session }) => {
    if (args.name === undefined && args.description === undefined && args.color === undefined && args.icon === undefined) {
      throw new UserError('Specify at least one field to update (name, description, color, or icon).');
    }
    return withOutlineClient('Failed to update collection', session, log, async (client) => {
      log.info(`Updating Outline collection ${args.collectionId}`);
      const c = await performUpdateCollection(client, args.collectionId, args);
      return `Collection updated successfully: ${c.name ?? 'Untitled'}`;
    });
  },
});

outlineServer.addTool({
  name: 'archiveCollection',
  annotations: { readOnlyHint: false },
  description: 'Archives an Outline collection: it and every document in it disappear from the sidebar and search until restored with restoreCollection. '
    + 'Nothing is deleted. Personal collections cannot be archived.',
  parameters: z.object({
    collectionId: z.string().describe('The collection ID.'),
    ...archiveCollectionFields,
  }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to archive collection', session, log, async (client) => {
      log.info(`Archiving Outline collection ${args.collectionId}`);
      const c = await performCollectionLifecycle(client, 'archive', args.collectionId, args);
      const state = 'archivedAt' in c ? (c.archivedAt ? '' : ' Outline does not show it as archived.') : '';
      return `Collection archived: ${c.name ?? 'Untitled'}.${state} Restore it with restoreCollection.`;
    }),
});

outlineServer.addTool({
  name: 'restoreCollection',
  annotations: { readOnlyHint: false },
  description: 'Restores an archived Outline collection and its documents to the sidebar and search.',
  parameters: z.object({
    collectionId: z.string().describe('The collection ID.'),
  }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to restore collection', session, log, async (client) => {
      log.info(`Restoring Outline collection ${args.collectionId}`);
      const c = await performCollectionLifecycle(client, 'restore', args.collectionId);
      return `Collection restored: ${c.name ?? 'Untitled'}.`;
    }),
});

outlineServer.addTool({
  name: 'deleteCollection',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Permanently deletes an Outline collection AND all documents in it. This cannot be undone.',
  parameters: z.object({
    collectionId: z.string().describe('The collection ID to delete.'),
  }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to delete collection', session, log, async (client) => {
      log.info(`Deleting Outline collection ${args.collectionId}`);
      const res = await client.deleteCollection(args.collectionId);
      if (res?.success) return 'Collection and all its documents deleted successfully.';
      throw new UserError('Failed to delete collection.');
    }),
});

outlineServer.addTool({
  name: 'exportCollection',
  annotations: { readOnlyHint: true },
  description: 'Starts an async export of an Outline collection. Returns a file operation ID and status.',
  parameters: z.object({
    collectionId: z.string().describe('The collection ID.'),
    format: z.enum(['outline-markdown', 'json', 'html']).optional().default('outline-markdown').describe('Export format.'),
  }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to export collection', session, log, async (client) => {
      log.info(`Exporting Outline collection ${args.collectionId} as ${args.format}`);
      const op = await client.exportCollection(args.collectionId, args.format);
      if (!op) throw new UserError('Failed to start export operation.');
      return formatFileOperation(op);
    }),
});

outlineServer.addTool({
  name: 'exportAllCollections',
  annotations: { readOnlyHint: true },
  description: 'Starts an async export of the entire Outline workspace. Returns a file operation ID and status.',
  parameters: z.object({
    format: z.enum(['outline-markdown', 'json', 'html']).optional().default('outline-markdown').describe('Export format.'),
  }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to export all collections', session, log, async (client) => {
      log.info(`Exporting all Outline collections as ${args.format}`);
      const op = await client.exportAllCollections(args.format);
      if (!op) throw new UserError('Failed to start export operation.');
      return formatFileOperation(op);
    }),
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
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to list comments', session, log, async (client) => {
      log.info(`Listing comments for Outline document ${args.documentId}`);
      const { data, pagination } = await client.listDocumentComments({
        documentId: args.documentId,
        includeAnchorText: args.includeAnchorText,
        limit: args.limit,
        offset: args.offset,
      });
      return formatComments(data, pagination, args.limit, args.offset);
    }),
});

outlineServer.addTool({
  name: 'getComment',
  annotations: { readOnlyHint: true },
  description: 'Retrieves a single Outline comment by ID.',
  parameters: z.object({
    commentId: z.string().describe('The comment ID.'),
    includeAnchorText: z.boolean().optional().default(false).describe('Include the referenced document text.'),
  }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to fetch comment', session, log, async (client) => {
      log.info(`Fetching Outline comment ${args.commentId}`);
      const c = await client.getComment(args.commentId, args.includeAnchorText);
      if (!c) throw new UserError('Comment not found.');
      return formatComment(c);
    }),
});

outlineServer.addTool({
  name: 'addComment',
  annotations: { readOnlyHint: false },
  description: 'Adds a comment on an Outline document, or replies to an existing comment. With anchorText it becomes an inline comment on that text.',
  parameters: z.object({
    documentId: z.string().describe('The document to comment on.'),
    ...addCommentFields,
  }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to add comment', session, log, async (client) => {
      log.info(`Adding Outline comment on ${args.documentId}${args.parentCommentId ? ` (reply to ${args.parentCommentId})` : ''}`);
      const c = await performAddComment(client, args.documentId, args);
      const kind = args.parentCommentId ? 'Reply' : 'Comment';
      // Outline echoes anchorText on an anchored comment; one that comes back
      // without it may have been placed as a page comment by an older server.
      const anchor = args.anchorText ? (c.anchorText ? ` Anchored to "${c.anchorText}".` : ' Outline did not confirm the anchor; it may be a page comment.') : '';
      return `${kind} added successfully (ID: ${c.id ?? 'unknown'}).${anchor}`;
    }),
});

outlineServer.addTool({
  name: 'updateComment',
  annotations: { readOnlyHint: false },
  description: 'Replaces the text of an Outline comment. Only its author (or an admin) can edit it.',
  parameters: z.object({
    commentId: z.string().describe('The comment ID.'),
    ...updateCommentFields,
  }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to update comment', session, log, async (client) => {
      log.info(`Updating Outline comment ${args.commentId}`);
      const c = await performUpdateComment(client, args.commentId, args);
      return `Comment updated (ID: ${c.id ?? args.commentId}).`;
    }),
});

outlineServer.addTool({
  name: 'resolveComment',
  annotations: { readOnlyHint: false },
  description: 'Marks an Outline comment thread resolved (top-level comments only). Reopen it with reopenComment.',
  parameters: z.object({ commentId: z.string().describe('The top-level comment ID.') }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to resolve comment', session, log, async (client) => {
      log.info(`Resolving Outline comment ${args.commentId}`);
      const r = await performCommentResolution(client, 'resolve', args.commentId);
      return r.confirmed === false ? 'Outline accepted the request, but the comment does not show as resolved.' : 'Comment resolved.';
    }),
});

outlineServer.addTool({
  name: 'reopenComment',
  annotations: { readOnlyHint: false },
  description: 'Reopens a resolved Outline comment thread.',
  parameters: z.object({ commentId: z.string().describe('The top-level comment ID.') }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to reopen comment', session, log, async (client) => {
      log.info(`Reopening Outline comment ${args.commentId}`);
      const r = await performCommentResolution(client, 'unresolve', args.commentId);
      return r.confirmed === false ? 'Outline accepted the request, but the comment still shows as resolved.' : 'Comment reopened.';
    }),
});

outlineServer.addTool({
  name: 'deleteComment',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Permanently deletes an Outline comment, and with a top-level comment its replies. Cannot be undone. Only the author (or an admin) can delete.',
  parameters: z.object({ commentId: z.string().describe('The comment ID.') }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to delete comment', session, log, async (client) => {
      log.info(`Deleting Outline comment ${args.commentId}`);
      const res = await client.deleteComment(args.commentId);
      if (res?.success) return 'Comment deleted.';
      throw new UserError('Outline did not confirm the delete.');
    }),
});

// === Users ===

outlineServer.addTool({
  name: 'listUsers',
  annotations: { readOnlyHint: true },
  description: 'Lists or searches people in the Outline workspace (name, role, last active; email only where this connection may see it). Paginated.',
  parameters: z.object({
    query: z.string().optional().describe('Search by name or email.'),
    filter: z.enum(['all', 'active', 'invited', 'suspended']).optional().describe('Status filter (default: active members).'),
    limit: z.number().int().min(1).max(100).optional().default(25).describe('Max users (default 25).'),
    offset: z.number().int().min(0).optional().default(0).describe('Skip N results.'),
  }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to list users', session, log, async (client) => {
      log.info('Listing Outline users');
      const { data, pagination } = await client.listUsers(args);
      return formatUsers(data, pagination, args.limit, args.offset);
    }),
});

outlineServer.addTool({
  name: 'getUser',
  annotations: { readOnlyHint: true },
  description: 'Reads one Outline user\'s profile by ID.',
  parameters: z.object({ userId: z.string().describe('The user ID (from listUsers).') }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to read user', session, log, async (client) => {
      log.info(`Reading Outline user ${args.userId}`);
      const u = await client.getUser(args.userId);
      if (!u) throw new UserError('User not found.');
      return formatUser(u);
    }),
});

// === Templates ===

outlineServer.addTool({
  name: 'listTemplates',
  annotations: { readOnlyHint: true },
  description: 'Lists the Outline templates this connection can use (workspace-wide and per collection). Create a document from one with createDocument templateId. Needs a recent Outline.',
  parameters: z.object({
    query: z.string().optional().describe('Filter by title.'),
    collectionId: z.string().optional().describe('Only templates of this collection.'),
    limit: z.number().int().min(1).max(100).optional().default(25).describe('Max templates (default 25).'),
    offset: z.number().int().min(0).optional().default(0).describe('Skip N results.'),
  }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to list templates', session, log, async (client) => {
      log.info('Listing Outline templates');
      const { data, pagination } = await client.listTemplates(args);
      return formatTemplates(data, pagination, args.limit, args.offset);
    }),
});

outlineServer.addTool({
  name: 'getTemplate',
  annotations: { readOnlyHint: true },
  description: 'Reads one Outline template with its content.',
  parameters: z.object({ templateId: z.string().describe('The template ID (from listTemplates).') }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to read template', session, log, async (client) => {
      log.info(`Reading Outline template ${args.templateId}`);
      const t = await client.getTemplate(args.templateId);
      if (!t) throw new UserError('Template not found.');
      return formatTemplate(t);
    }),
});

// === Revisions ===

outlineServer.addTool({
  name: 'listDocumentRevisions',
  annotations: { readOnlyHint: true },
  description: 'Lists an Outline document\'s history, newest first: when each version was saved and by whom. Paginated.',
  parameters: z.object({
    documentId: z.string().describe('The document ID.'),
    limit: z.number().int().min(1).max(100).optional().default(25).describe('Max revisions (default 25).'),
    offset: z.number().int().min(0).optional().default(0).describe('Skip N results.'),
  }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to list revisions', session, log, async (client) => {
      log.info(`Listing revisions of Outline document ${args.documentId}`);
      const { data, pagination } = await client.listRevisions(args);
      return formatRevisions(data, pagination, args.limit, args.offset);
    }),
});

outlineServer.addTool({
  name: 'getDocumentRevision',
  annotations: { readOnlyHint: true },
  description: 'Reads one saved version of an Outline document: its content, time and author.',
  parameters: z.object({ revisionId: z.string().describe('The revision ID (from listDocumentRevisions).') }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to read revision', session, log, async (client) => {
      log.info(`Reading Outline revision ${args.revisionId}`);
      const r = await client.getRevision(args.revisionId);
      if (!r) throw new UserError('Revision not found.');
      return [`# ${r.title ?? 'Untitled'}`, `${describeRevision(r)}`, '', bodyMarkdown(r) || '(empty)'].join('\n');
    }),
});

outlineServer.addTool({
  name: 'compareDocumentRevisions',
  annotations: { readOnlyHint: true },
  description: 'Shows what changed in an Outline document between a saved version and a later one (default: the current document), with who saved each. '
    + 'Line diff: "-" removed, "+" added.',
  parameters: z.object({
    documentId: z.string().describe('The document ID.'),
    fromRevisionId: z.string().describe('The older version (from listDocumentRevisions).'),
    toRevisionId: z.string().optional().describe('The newer version. Omit to compare with the current document.'),
  }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to compare revisions', session, log, async (client) => {
      log.info(`Comparing revisions of Outline document ${args.documentId}`);
      const r = await performCompareRevisions(client, args.documentId, args.fromRevisionId, args.toRevisionId);
      return `${r.header}\n\n${r.diff.text}`;
    }),
});

// === Attachments ===

outlineServer.addTool({
  name: 'listDocumentAttachments',
  annotations: { readOnlyHint: true },
  description: 'Lists attachment IDs referenced in an Outline document by parsing its markdown for /api/attachments.redirect links.',
  parameters: z.object({
    documentId: z.string().describe('The document ID to scan.'),
  }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to list attachments', session, log, async (client) => {
      log.info(`Scanning Outline document ${args.documentId} for attachments`);
      const doc = await client.getDocument(args.documentId);
      if (!doc) throw new UserError('Document not found.');
      const attachments = parseAttachmentIds(doc.text ?? '');
      return formatAttachmentList(doc.title ?? 'Untitled', attachments);
    }),
});

outlineServer.addTool({
  name: 'getAttachmentUrl',
  annotations: { readOnlyHint: true },
  description: 'Resolves an Outline attachment ID to a signed download URL by following the /api/attachments.redirect redirect.',
  parameters: z.object({
    attachmentId: z.string().describe('The attachment UUID.'),
  }),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to resolve attachment URL', session, log, async (client) => {
      log.info(`Resolving Outline attachment URL for ${args.attachmentId}`);
      const url = await client.getAttachmentRedirectUrl(args.attachmentId);
      if (!url) throw new UserError('Failed to resolve attachment URL.');
      return url;
    }),
});

outlineServer.addTool({
  name: 'uploadAttachment',
  annotations: { readOnlyHint: false },
  description: 'Uploads a file (base64 bytes or text) to Outline and returns its URL plus a markdown snippet to put into a document with updateDocument. '
    + 'It is not inserted automatically. Up to 20 MB, or less if the workspace limit is lower.',
  parameters: z.object(uploadAttachmentFields),
  execute: (args, { log, session }) =>
    withOutlineClient('Failed to upload attachment', session, log, async (client) => {
      log.info(`Uploading attachment "${args.fileName}" (${args.contentType}) to Outline`);
      const r = await performUploadAttachment(client, args);
      return `Uploaded ${args.fileName} (${r.bytes} bytes) — attachment ID ${r.attachmentId}.\nInsert into a document with this markdown:\n${r.markdown}`;
    }),
});
