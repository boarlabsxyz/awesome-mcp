// src/outline/restOps.ts
//
// Body schemas and ops for the Outline REST write plane.
//
// Outline is the one service where the REST schemas can match the MCP tools'
// parameters exactly — the routes are new, so there is no published contract to
// preserve (contrast ClickUp, whose older write routes take ClickUp-native
// snake_case bodies and cannot be narrowed; see ./../clickup/restWrites.ts). The
// camelCase names below are therefore the same ones the tools take, which is what
// stops the two surfaces drifting on what is valid.
//
// The ops exist for the other half of that problem: the mapping from parameters
// to Outline's request body (`documentId` → `id`, the `append` flag that is only
// meaningful alongside `text`, the empty-string-clears-it `icon` convention) is
// stated once here rather than rebuilt in the route.
import { UserError } from 'fastmcp';
import { z } from 'zod';
import type { OutlineClient } from './apiHelpers.js';

/** Hex colour accepted by Outline's collection endpoints. */
const hexColor = z
  .string()
  .regex(/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/, 'Color must be a hex like #RRGGBB or #RGB.');

// === Documents ===

/**
 * Fields of an Outline document creation, with the descriptions the LLM reads.
 *
 * A field OBJECT rather than a schema so both surfaces compose it without copying
 * it — the tool and the route take the same fields here, and sharing the
 * definition is what stops them drifting on what is valid.
 */
export const createDocumentFields = {
  title: z.string().min(1).describe('Document title.'),
  collectionId: z.string().min(1).describe('The collection ID to create the document in.'),
  text: z.string().optional().default('').describe('Markdown content (optional).'),
  parentDocumentId: z.string().optional().describe('Parent document ID for nesting.'),
  publish: z.boolean().optional().default(true).describe('Publish immediately (default true) or save as a draft.'),
  template: z.boolean().optional().describe('If true, create as a template.'),
  icon: z.string().optional().describe('Optional emoji icon (e.g. "📋").'),
} as const;

export const createDocumentRestSchema = z.object(createDocumentFields);

export async function performCreateDocument(
  client: OutlineClient,
  args: z.infer<typeof createDocumentRestSchema>,
): Promise<any> {
  const doc = await client.createDocument({
    title: args.title,
    collectionId: args.collectionId,
    text: args.text,
    parentDocumentId: args.parentDocumentId,
    publish: args.publish,
    template: args.template,
    icon: args.icon,
  });
  if (!doc) throw new UserError('Outline accepted the request but returned no document.');
  return doc;
}

/** Fields of an Outline document update. See createDocumentFields. */
export const updateDocumentFields = {
  title: z.string().optional().describe('New title (omit to keep the current one).'),
  text: z.string().optional().describe('New content (omit to keep the current body). Replaces it unless append is true.'),
  append: z.boolean().optional().default(false).describe('If true, append text instead of replacing. Ignored unless text is supplied.'),
  template: z.boolean().optional().describe('If set, convert to/from a template.'),
  // An empty string CLEARS the icon, which is why this is not `.min(1)`: Outline
  // distinguishes "no icon" (null) from "leave it alone" (absent), and the only
  // way to express the former over JSON is a value the caller can actually send.
  icon: z.string().optional().describe('Emoji icon; an empty string clears it.'),
} as const;

/** The `.refine` is REST-only: an empty body would be a silent no-op answered 200. */
export const updateDocumentRestSchema = z.object(updateDocumentFields).refine(
  (v) => v.title !== undefined || v.text !== undefined || v.template !== undefined || v.icon !== undefined,
  { message: 'Provide at least one of title, text, template, or icon.' },
);

export async function performUpdateDocument(
  client: OutlineClient,
  documentId: string,
  args: z.infer<typeof updateDocumentRestSchema>,
): Promise<any> {
  const doc = await client.updateDocument({
    id: documentId,
    title: args.title,
    text: args.text,
    // `append` only means something when text is being written. Forwarding it
    // without text would ask Outline to append nothing, which it treats as a
    // replace-with-empty on some versions.
    append: args.text !== undefined ? args.append : undefined,
    template: args.template,
    icon: args.icon === '' ? null : args.icon,
  });
  if (!doc) throw new UserError('Outline accepted the request but returned no document.');
  return doc;
}

/** Fields of an Outline document move. See createDocumentFields. */
export const moveDocumentFields = {
  collectionId: z.string().optional().describe('Target collection ID.'),
  parentDocumentId: z.string().optional().describe('New parent document ID (for nesting).'),
} as const;

export const moveDocumentRestSchema = z.object(moveDocumentFields).refine(
  (v) => v.collectionId !== undefined || v.parentDocumentId !== undefined,
  { message: 'Specify at least one of collectionId or parentDocumentId.' },
);

export async function performMoveDocument(
  client: OutlineClient,
  documentId: string,
  args: z.infer<typeof moveDocumentRestSchema>,
): Promise<any> {
  const res = await client.moveDocument({
    id: documentId,
    collectionId: args.collectionId,
    parentDocumentId: args.parentDocumentId,
  });
  if (!res?.data) throw new UserError('Outline accepted the request but reported no move.');
  return res.data;
}

/**
 * Archive, unarchive, or restore-from-trash.
 *
 * One op for the three because they differ only in the endpoint called: three
 * copies of "call it, reject an empty response" is three places a later fix can
 * fail to be applied.
 */
export async function performDocumentLifecycle(
  client: OutlineClient,
  action: 'archive' | 'unarchive' | 'restore',
  documentId: string,
): Promise<any> {
  const doc = action === 'archive'
    ? await client.archiveDocument(documentId)
    : action === 'unarchive'
      ? await client.unarchiveDocument(documentId)
      : await client.restoreDocument(documentId);
  if (!doc) throw new UserError(`Outline accepted the ${action} but returned no document.`);
  return doc;
}

// === Collections ===

/** Fields of an Outline collection creation. See createDocumentFields. */
export const createCollectionFields = {
  name: z.string().min(1).describe('Collection name.'),
  description: z.string().optional().default('').describe('Optional description.'),
  color: hexColor.optional().describe('Optional hex color, e.g. #FF0000.'),
} as const;

export const createCollectionRestSchema = z.object(createCollectionFields);

export async function performCreateCollection(
  client: OutlineClient,
  args: z.infer<typeof createCollectionRestSchema>,
): Promise<any> {
  const c = await client.createCollection({
    name: args.name,
    description: args.description,
    color: args.color,
  });
  if (!c) throw new UserError('Outline accepted the request but returned no collection.');
  return c;
}

/** Fields of an Outline collection update. See createDocumentFields. */
export const updateCollectionFields = {
  name: z.string().optional().describe('New name.'),
  description: z.string().optional().describe('New description.'),
  color: hexColor.optional().describe('New hex color, e.g. #FF0000.'),
} as const;

export const updateCollectionRestSchema = z.object(updateCollectionFields).refine(
  (v) => v.name !== undefined || v.description !== undefined || v.color !== undefined,
  { message: 'Specify at least one field to update (name, description, or color).' },
);

export async function performUpdateCollection(
  client: OutlineClient,
  collectionId: string,
  args: z.infer<typeof updateCollectionRestSchema>,
): Promise<any> {
  const c = await client.updateCollection({
    id: collectionId,
    name: args.name,
    description: args.description,
    color: args.color,
  });
  if (!c) throw new UserError('Outline accepted the request but returned no collection.');
  return c;
}

// === Comments ===

/** Fields of an Outline comment. See createDocumentFields. */
export const addCommentFields = {
  text: z.string().min(1).describe('Comment text (supports markdown).'),
  parentCommentId: z.string().optional().describe('Parent comment ID for replies.'),
} as const;

export const addCommentRestSchema = z.object(addCommentFields);

export async function performAddComment(
  client: OutlineClient,
  documentId: string,
  args: z.infer<typeof addCommentRestSchema>,
): Promise<any> {
  const c = await client.createComment({
    documentId,
    text: args.text,
    parentCommentId: args.parentCommentId,
  });
  if (!c) throw new UserError('Outline accepted the request but returned no comment.');
  return c;
}
