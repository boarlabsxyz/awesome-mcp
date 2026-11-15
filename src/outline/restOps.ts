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
import { diffLines, describeRevision, bodyMarkdown, type OutlineClient, type OutlineRevision } from './apiHelpers.js';

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

/**
 * A refusal the caller can fix. Named `UserError` with no numeric status, which
 * is how sendOutlineError (REST, 400) and mapOutlineError (MCP) both read it;
 * this module imports neither FastMCP nor Express.
 */
function callerError(message: string): Error {
  const err = new Error(message);
  err.name = 'UserError';
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
  color: hexColor.optional().describe('Icon colour, hex like #FF0000.'),
  fullWidth: z.boolean().optional().describe('Display the document full width.'),
  templateId: z.string().optional().describe('Start from this template (from listTemplates). Its content is used when text is empty.'),
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
    color: args.color,
    fullWidth: args.fullWidth,
    templateId: args.templateId,
  });
  if (!doc) throw upstreamEmpty('Outline accepted the request but returned no document.');
  return doc;
}

/** Fields of an Outline document update. See createDocumentFields. */
export const updateDocumentFields = {
  title: z.string().optional().describe('New title (omit to keep the current one).'),
  text: z.string().optional().describe('New content (omit to keep the current body). Replaces it unless append is true, or findText is given.'),
  append: z.boolean().optional().default(false).describe('If true, append text instead of replacing. Ignored unless text is supplied.'),
  findText: z.string().min(1).optional()
    .describe('Edit one passage: replace the first exact occurrence of this markdown with text, keeping the rest of the document and its formatting untouched. Needs a recent Outline.'),
  template: z.boolean().optional().describe('If set, convert to/from a template.'),
  // An empty string CLEARS the icon, which is why this is not `.min(1)`: Outline
  // distinguishes "no icon" (null) from "leave it alone" (absent), and the only
  // way to express the former over JSON is a value the caller can actually send.
  icon: z.string().optional().describe('Emoji icon; an empty string clears it.'),
  color: hexColor.optional().describe('Icon colour, hex like #FF0000.'),
  fullWidth: z.boolean().optional().describe('Display the document full width (true) or normal width (false).'),
  publish: z.literal(true).optional().describe('Publish a draft. To return a published document to draft, use unpublishDocument.'),
} as const;

/** The `.refine` is REST-only: an empty body would be a silent no-op answered 200. */
export const updateDocumentRestSchema = z.object(updateDocumentFields).refine(
  (v) => v.title !== undefined || v.text !== undefined || v.template !== undefined || v.icon !== undefined
    || v.color !== undefined || v.fullWidth !== undefined || v.publish !== undefined,
  { message: 'Provide at least one of title, text, template, icon, color, fullWidth, or publish.' },
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
  if (args.findText !== undefined) {
    if (args.text === undefined) throw callerError('findText needs text: the replacement for that passage (an empty string deletes it).');
    if (args.append) throw callerError('findText replaces one passage; it cannot be combined with append.');
  }
  // The passage must exist before anything is written: Outline would otherwise
  // reject it at best, and the document is read anyway to guard the write below.
  const before = args.findText !== undefined ? await client.getDocument(documentId) : undefined;
  if (args.findText !== undefined) {
    if (!before) throw upstreamEmpty('Outline returned no document to edit.');
    if (!(before.text ?? '').includes(args.findText)) {
      throw callerError('findText does not occur in the document (exact markdown match). Nothing was changed; read the document and copy the passage exactly.');
    }
  }
  const doc = await client.updateDocument({
    id: documentId,
    title: args.title,
    text: args.text,
    // `append` only means something when text is being written. Forwarding it
    // without text would ask Outline to append nothing, which it treats as a
    // replace-with-empty on some versions.
    append: args.text !== undefined && args.findText === undefined ? args.append : undefined,
    ...(args.findText !== undefined ? { editMode: 'patch' as const, findText: args.findText } : {}),
    template: args.template,
    icon: args.icon === '' ? null : args.icon,
    color: args.color,
    fullWidth: args.fullWidth,
    publish: args.publish,
  });
  if (!doc) throw upstreamEmpty('Outline accepted the request but returned no document.');
  if (args.findText !== undefined && before) {
    // true: the text around the passage survived; null: could not be read back.
    const passageEditVerified = await guardPatch(client, documentId, before.text ?? '', args.findText, doc.text);
    return { ...doc, passageEditVerified };
  }
  return doc;
}

/** Words only: Outline re-serialises markdown, so escapes, list markers and spacing may differ from what was sent. */
function words(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Whether the text before and after the passage (a few words each side) is still in `body`. */
function surroundingsSurvived(original: string, findText: string, body: string): boolean {
  const idx = original.indexOf(findText);
  const head = words(original.slice(0, idx)).slice(-6).join(' ');
  const tail = words(original.slice(idx + findText.length)).slice(0, 6).join(' ');
  const now = ` ${words(body).join(' ')} `;
  return (!head || now.includes(` ${head} `)) && (!tail || now.includes(` ${tail} `));
}

/**
 * An Outline older than editMode ignores it and treats the call as a plain
 * update — replacing the WHOLE body with the replacement passage. Detected by
 * what should have survived: the words just before and after the passage. Not
 * by comparing with the replacement, which Outline echoes re-serialised. When
 * they are gone the original markdown is written back and the call fails
 * loudly; formatting markdown cannot carry may need restoring from history.
 * Returns true when verified, null when the body could not be read back.
 */
async function guardPatch(client: OutlineClient, documentId: string, original: string, findText: string, after: string | undefined): Promise<true | null> {
  let body = after;
  if (body === undefined) body = (await client.getDocument(documentId).catch(() => undefined))?.text;
  if (body === undefined) return null;
  if (surroundingsSurvived(original, findText, body)) return true;
  let restored = false;
  try {
    const back = await client.updateDocument({ id: documentId, text: original });
    restored = back?.text !== undefined ? surroundingsSurvived(original, findText, back.text) : false;
  } catch { /* reported below */ }
  const err = new Error(restored
    ? 'This Outline server does not support passage edits (findText): it replaced the whole document. The original text was written back; '
      + 'formatting markdown cannot carry may need restoring from the document history, and any other field sent in the same call (title, icon, publish…) stays applied. '
      + 'Edit without findText instead.'
    : 'This Outline server does not support passage edits (findText): it replaced the whole document, and writing the original back could not be confirmed. '
      + 'Restore the previous version from the document history in Outline now.');
  (err as any).status = 502;
  throw err;
}

/** Return a published document to draft. `detach` also removes it from its collection. */
export const unpublishDocumentFields = {
  detach: z.boolean().optional().describe('Also take it out of its collection (default: stays in place as a draft).'),
} as const;

export const unpublishDocumentRestSchema = z.object(unpublishDocumentFields);

export async function performUnpublishDocument(
  client: OutlineClient,
  documentId: string,
  args: z.infer<typeof unpublishDocumentRestSchema>,
): Promise<any> {
  const doc = await client.unpublishDocument(documentId, args.detach);
  if (!doc) throw upstreamEmpty('Outline accepted the request but returned no document.');
  return doc;
}

/** Size cap for imports and attachment uploads, decoded. REST bodies are capped lower (5 MB of JSON). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** base64 or UTF-8 text → bytes, refusing input Buffer.from would silently mangle. */
function decodeContent(args: { contentBase64?: string; textContent?: string }): Uint8Array {
  if ((args.contentBase64 === undefined) === (args.textContent === undefined)) {
    throw callerError('Give exactly one of contentBase64 or textContent.');
  }
  if (args.contentBase64 !== undefined && !/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(args.contentBase64)) {
    throw callerError('contentBase64 is not valid base64.');
  }
  const bytes = args.contentBase64 !== undefined ? Buffer.from(args.contentBase64, 'base64') : Buffer.from(args.textContent!, 'utf8');
  if (bytes.length === 0) throw callerError('The content is empty.');
  if (bytes.length > MAX_UPLOAD_BYTES) throw callerError(`The content is ${bytes.length} bytes; the limit here is ${MAX_UPLOAD_BYTES} (20 MB).`);
  return bytes;
}

/** Fields of an HTML import. See createDocumentFields. */
export const importHtmlDocumentFields = {
  html: z.string().min(1).describe('The HTML to import. Remote and base64 images in it are copied into Outline as attachments.'),
  title: z.string().min(1).optional().describe('File name used for the import; Outline takes the title from the HTML <title> or first heading, else this.'),
  collectionId: z.string().optional().describe('Collection to import into. Give this or parentDocumentId.'),
  parentDocumentId: z.string().optional().describe('Import as a child of this document. Give this or collectionId.'),
  publish: z.boolean().optional().default(true).describe('Publish immediately (default true) or leave a draft.'),
} as const;

export const importHtmlDocumentRestSchema = z.object(importHtmlDocumentFields);

export async function performImportHtmlDocument(
  client: OutlineClient,
  args: z.infer<typeof importHtmlDocumentRestSchema>,
): Promise<any> {
  if (!args.collectionId && !args.parentDocumentId) throw callerError('Give collectionId or parentDocumentId.');
  const content = decodeContent({ textContent: args.html });
  const doc = await client.importDocument({
    fileName: `${(args.title ?? 'import').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'import'}.html`,
    contentType: 'text/html',
    content,
    collectionId: args.collectionId,
    parentDocumentId: args.parentDocumentId,
    publish: args.publish,
  });
  if (!doc) throw upstreamEmpty('Outline accepted the import but returned no document.');
  return doc;
}

/** Fields of an attachment upload. */
export const uploadAttachmentFields = {
  fileName: z.string().min(1).describe('File name, e.g. "diagram.png".'),
  contentType: z.string().min(1).describe('MIME type, e.g. "image/png", "application/pdf".'),
  contentBase64: z.string().min(1).optional().describe('The file bytes, base64-encoded. Give this or textContent.'),
  textContent: z.string().optional().describe('The file as UTF-8 text. Give this or contentBase64.'),
  documentId: z.string().optional().describe('Document the attachment belongs to (needs edit access to it). It is not inserted: put the returned markdown into the document with updateDocument.'),
} as const;

export const uploadAttachmentRestSchema = z.object(uploadAttachmentFields);

/**
 * Create the attachment record, then send the bytes where Outline said to —
 * creating the record alone uploads nothing. Returns the document-ready URL and
 * a markdown snippet to insert.
 */
export async function performUploadAttachment(
  client: OutlineClient,
  args: z.infer<typeof uploadAttachmentRestSchema>,
): Promise<any> {
  const bytes = decodeContent(args);
  const upload = await client.createAttachment({
    name: args.fileName,
    contentType: args.contentType,
    size: bytes.length,
    ...(args.documentId ? { documentId: args.documentId } : {}),
  });
  if (!upload?.attachment?.id) throw upstreamEmpty('Outline created no attachment record.');
  if (upload.maxUploadSize && bytes.length > upload.maxUploadSize) {
    throw callerError(`The file is ${bytes.length} bytes; this Outline workspace accepts up to ${upload.maxUploadSize}.`);
  }
  await client.uploadAttachmentBytes(upload, bytes, args.contentType, args.fileName);
  const url = upload.attachment.url ?? `/api/attachments.redirect?id=${upload.attachment.id}`;
  const markdown = args.contentType.startsWith('image/') ? `![${args.fileName}](${url})` : `[${args.fileName}](${url})`;
  return { attachmentId: upload.attachment.id, url, markdown, bytes: bytes.length };
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
  icon: z.string().optional().describe('Optional icon: an emoji, or an Outline icon name.'),
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
    icon: args.icon,
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
  icon: z.string().nullable().optional().describe('New icon (emoji or Outline icon name). Pass null to clear it.'),
} as const;

// `!== undefined` rather than a truthiness test, so an explicit null counts as a
// supplied field — clearing a description IS an update.
export const updateCollectionRestSchema = z.object(updateCollectionFields).refine(
  (v) => v.name !== undefined || v.description !== undefined || v.color !== undefined || v.icon !== undefined,
  { message: 'Specify at least one field to update (name, description, color, or icon).' },
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
    icon: args.icon,
  });
  if (!c) throw upstreamEmpty('Outline accepted the request but returned no collection.');
  return c;
}

/** Fields of a collection archive. */
export const archiveCollectionFields = {
  reason: z.string().optional().describe('Optional reason, shown on the archived collection.'),
} as const;

export const archiveCollectionRestSchema = z.object(archiveCollectionFields);

/**
 * Archive (hides the collection and every document in it) or restore it. Both
 * are reversible, unlike collections.delete. A personal collection cannot be
 * archived; Outline refuses it.
 */
export async function performCollectionLifecycle(
  client: OutlineClient,
  action: 'archive' | 'restore',
  collectionId: string,
  args: z.infer<typeof archiveCollectionRestSchema> = {},
): Promise<any> {
  const c = action === 'archive'
    ? await client.archiveCollection(collectionId, args.reason)
    : await client.restoreCollection(collectionId);
  if (!c) throw upstreamEmpty(`Outline accepted the ${action} but returned no collection.`);
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
  anchorText: z.string().min(1).optional()
    .describe('Make it an inline comment on this exact text in the document (first occurrence unless anchorPrefix/anchorSuffix narrow it). Needs a recent Outline.'),
  anchorPrefix: z.string().optional().describe('Text just before anchorText, to pick the right occurrence.'),
  anchorSuffix: z.string().optional().describe('Text just after anchorText, to pick the right occurrence.'),
} as const;

export const addCommentRestSchema = z.object(addCommentFields);

/** Comment on a document, or reply to an existing comment when `parentCommentId` is set. */
export async function performAddComment(
  client: OutlineClient,
  documentId: string,
  args: z.infer<typeof addCommentRestSchema>,
): Promise<any> {
  if ((args.anchorPrefix !== undefined || args.anchorSuffix !== undefined) && args.anchorText === undefined) {
    throw callerError('anchorPrefix and anchorSuffix only narrow anchorText; give anchorText too.');
  }
  if (args.anchorText !== undefined && args.parentCommentId) {
    throw callerError('A reply sits in its thread; only a new comment can be anchored to text.');
  }
  const c = await client.createComment({
    documentId,
    text: args.text,
    parentCommentId: args.parentCommentId,
    anchorText: args.anchorText,
    anchorPrefix: args.anchorPrefix,
    anchorSuffix: args.anchorSuffix,
  });
  if (!c) throw upstreamEmpty('Outline accepted the request but returned no comment.');
  return c;
}

/** Fields of a comment edit. */
export const updateCommentFields = {
  text: z.string().min(1).describe('New comment text (markdown). Replaces the old text. Only the author (or an admin) can edit.'),
} as const;

export const updateCommentRestSchema = z.object(updateCommentFields);

export async function performUpdateComment(
  client: OutlineClient,
  commentId: string,
  args: z.infer<typeof updateCommentRestSchema>,
): Promise<any> {
  const c = await client.updateComment(commentId, args.text);
  if (!c) throw upstreamEmpty('Outline accepted the request but returned no comment.');
  return c;
}

/**
 * Resolve or reopen a comment thread (top-level comments only). Confirmed from
 * the comment Outline returns: resolvedAt set, or cleared.
 */
export async function performCommentResolution(
  client: OutlineClient,
  action: 'resolve' | 'unresolve',
  commentId: string,
): Promise<any> {
  const c = action === 'resolve' ? await client.resolveComment(commentId) : await client.unresolveComment(commentId);
  if (!c) throw upstreamEmpty(`Outline accepted the ${action} but returned no comment.`);
  const confirmed = 'resolvedAt' in c ? (action === 'resolve' ? Boolean(c.resolvedAt) : !c.resolvedAt) : null;
  return { comment: c, confirmed };
}

// === Revisions ===

/**
 * Compare two versions of a document: `from` a revision, `to` another revision
 * or (default) the current document. Listed revisions carry no body, so each
 * side is read in full; the diff is computed here.
 */
export async function performCompareRevisions(
  client: OutlineClient,
  documentId: string,
  fromRevisionId: string,
  toRevisionId?: string,
): Promise<{ from: OutlineRevision; to: OutlineRevision | 'current'; diff: ReturnType<typeof diffLines>; header: string }> {
  const from = await client.getRevision(fromRevisionId);
  if (!from) throw upstreamEmpty('Outline returned no revision.');
  if (from.documentId && from.documentId !== documentId) {
    throw callerError(`Revision ${fromRevisionId} belongs to another document (${from.documentId}).`);
  }
  let to: OutlineRevision | 'current' = 'current';
  let toBody: string;
  if (toRevisionId) {
    const r = await client.getRevision(toRevisionId);
    if (!r) throw upstreamEmpty('Outline returned no revision.');
    if (r.documentId && r.documentId !== documentId) {
      throw callerError(`Revision ${toRevisionId} belongs to another document (${r.documentId}).`);
    }
    to = r;
    toBody = bodyMarkdown(r);
  } else {
    const doc = await client.getDocument(documentId);
    if (!doc) throw upstreamEmpty('Outline returned no document.');
    toBody = doc.text ?? '';
  }
  const diff = diffLines(bodyMarkdown(from), toBody);
  const header = `Changes from ${describeRevision(from)} to ${describeRevision(to)}: ${diff.added} line(s) added, ${diff.removed} removed.`;
  return { from, to, diff, header };
}
