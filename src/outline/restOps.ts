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
import { z } from 'zod';
import type { OutlineClient } from './apiHelpers.js';

/**
 * Outline answered the write, but with no record in the payload.
 *
 * Tagged 502 rather than raised as a FastMCP user error, because the request
 * reached Outline and was accepted — the failure is upstream, and reporting it as
 * 400 would tell the caller to fix a request that was valid. `sendOutlineError`
 * matches on the name; nothing here imports Express.
 */
function upstreamEmpty(message: string): Error {
  const err = new Error(message);
  err.name = 'UpstreamEmptyError';
  (err as any).status = 502;
  return err;
}

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

/** Create a document. `publish: false` leaves it a draft, invisible in its collection. */
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
  if (!doc) throw upstreamEmpty('Outline accepted the request but returned no document.');
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

/**
 * Update a document. REPLACES title and text unless `append`, and an empty-string
 * icon is translated to an explicit null because that is how Outline clears it.
 */
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
  if (!doc) throw upstreamEmpty('Outline accepted the request but returned no document.');
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

/** Move a document between collections and/or parents. Outline returns the moved set, not one document. */
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
  if (!res?.data) throw upstreamEmpty('Outline accepted the request but reported no move.');
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
  if (!doc) throw upstreamEmpty(`Outline accepted the ${action} but returned no document.`);
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

/** Create a collection. Outline assigns a colour when none is given. */
export async function performCreateCollection(
  client: OutlineClient,
  args: z.infer<typeof createCollectionRestSchema>,
): Promise<any> {
  const c = await client.createCollection({
    name: args.name,
    description: args.description,
    color: args.color,
  });
  if (!c) throw upstreamEmpty('Outline accepted the request but returned no collection.');
  return c;
}

/**
 * Fields of an Outline collection update. See createDocumentFields.
 *
 * `description` and `color` are `.nullable()` so a caller can CLEAR them. Outline
 * accepts null on both and applies it, so rejecting null here would make a field
 * un-clearable through this API for no reason — the same rule that makes
 * updateDocumentFields treat an empty-string icon as a clear. Null is forwarded
 * unchanged rather than translated.
 */
export const updateCollectionFields = {
  name: z.string().optional().describe('New name.'),
  description: z.string().nullable().optional().describe('New description. Pass null to clear it.'),
  color: hexColor.nullable().optional().describe('New hex color, e.g. #FF0000. Pass null to clear it.'),
} as const;

// `!== undefined` rather than a truthiness test, so an explicit null counts as a
// supplied field — clearing a description IS an update.
export const updateCollectionRestSchema = z.object(updateCollectionFields).refine(
  (v) => v.name !== undefined || v.description !== undefined || v.color !== undefined,
  { message: 'Specify at least one field to update (name, description, or color).' },
);

/** Update a collection. A null description or colour is forwarded as-is, which clears it. */
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
  if (!c) throw upstreamEmpty('Outline accepted the request but returned no collection.');
  return c;
}

// === Exports ===

/**
 * Body of the two export routes.
 *
 * They are POSTs, not GETs, even though the MCP tools are annotated read-only:
 * each call QUEUES a server-side export job, and a GET is fair game for a proxy
 * or retry middleware to repeat after a timeout — which would queue a second
 * export (of the whole workspace, in one case) that nobody asked for.
 */
export const exportRestSchema = z.object({
  format: z.enum(['outline-markdown', 'json', 'html']).optional().default('outline-markdown')
    .describe('Export format. Defaults to outline-markdown.'),
});

/** Start an export of one collection, or of the whole workspace when no id is given. */
export async function performExport(
  client: OutlineClient,
  collectionId: string | undefined,
  args: z.infer<typeof exportRestSchema>,
): Promise<any> {
  const op = collectionId
    ? await client.exportCollection(collectionId, args.format)
    : await client.exportAllCollections(args.format);
  if (!op) throw upstreamEmpty('Outline accepted the request but returned no file operation.');
  return op;
}

// === Comments ===

/** Fields of an Outline comment. See createDocumentFields. */
export const addCommentFields = {
  text: z.string().min(1).describe('Comment text (supports markdown).'),
  parentCommentId: z.string().optional().describe('Parent comment ID for replies.'),
} as const;

export const addCommentRestSchema = z.object(addCommentFields);

/** Comment on a document, or reply to an existing comment when `parentCommentId` is set. */
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
  if (!c) throw upstreamEmpty('Outline accepted the request but returned no comment.');
  return c;
}
