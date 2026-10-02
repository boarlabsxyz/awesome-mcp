// Parameter schemas for every Google Docs WRITE tool, in one place.
//
// Why a module of its own rather than exports from `google-docs/server.ts`, which
// is where the sibling providers keep theirs: that file is the application's
// ENTRY POINT and imports `createWebApp` from the web server. Exporting the
// schemas from it would mean `webServer.ts` importing its own importer, and a
// dynamic `await import()` inside a handler is no better — in web-only mode the
// docs MCP server is not loaded at all, and reaching for it from a REST route
// would boot an entire MCP server to validate a request body.
//
// These schemas are the single validation contract for both surfaces: the MCP
// tools take them as `parameters`, and the REST routes under /api/v1/docs/*
// safeParse `req.body` with them. REST has no FastMCP Zod pass in front of it, so
// without this the routes would hand-roll presence checks that drift from the
// tools and never check a type.
//
// Shared fragments (DocumentIdParameter, the style parameter objects, the batch
// operation union) are imported from ../types.js, never re-declared.

import { z } from 'zod';
import {
  ApplyParagraphStyleToolParameters,
  ApplyTextStyleToolParameters,
  BatchOperationSchema,
  DocumentIdParameter,
} from '../types.js';

/** Hex colour, with or without the leading #, 3 or 6 digits. */
const hexColor = (what: string) =>
  z.string()
    .refine((color) => /^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(color), {
      message: 'Invalid hex color format (e.g., #FF0000 or #F00)',
    })
    .optional()
    .describe(what);

// === Text content ===

export const appendToGoogleDocSchema = DocumentIdParameter.extend({
  textToAppend: z.string().min(1).describe('The text to add to the end.'),
  addNewlineIfNeeded: z.boolean().optional().default(true)
    .describe('Automatically add a newline before the appended text if the doc does not end with one.'),
  tabId: z.string().optional().describe('The ID of the specific tab to append to. Defaults to the first tab.'),
});

export const insertTextSchema = DocumentIdParameter.extend({
  textToInsert: z.string().min(1).describe('The text to insert.'),
  index: z.number().int().min(1).describe('The index (1-based) where the text should be inserted.'),
  tabId: z.string().optional().describe('The ID of the specific tab to insert into. Defaults to the first tab.'),
});

// endIndex > startIndex is enforced here, not in the handler: a zero-width or
// inverted range is accepted by the Docs API as a no-op, which reads as success.
export const deleteRangeSchema = DocumentIdParameter.extend({
  startIndex: z.number().int().min(1).describe('The starting index of the text range (inclusive, starts from 1).'),
  endIndex: z.number().int().min(1).describe('The ending index of the text range (exclusive).'),
  tabId: z.string().optional().describe('The ID of the specific tab to delete from. Defaults to the first tab.'),
}).refine((data) => data.endIndex > data.startIndex, {
  message: 'endIndex must be greater than startIndex',
  path: ['endIndex'],
});

// === Styling ===

export const applyTextStyleSchema = ApplyTextStyleToolParameters;
export const applyParagraphStyleSchema = ApplyParagraphStyleToolParameters;

export const formatMatchingTextSchema = z.object({
  documentId: z.string().describe('The ID of the Google Document.'),
  textToFind: z.string().min(1).describe('The exact text string to find and format.'),
  matchInstance: z.number().int().min(1).optional().default(1)
    .describe('Which instance of the text to format (1st, 2nd, etc.). Defaults to 1.'),
  bold: z.boolean().optional().describe('Apply bold formatting.'),
  italic: z.boolean().optional().describe('Apply italic formatting.'),
  underline: z.boolean().optional().describe('Apply underline formatting.'),
  strikethrough: z.boolean().optional().describe('Apply strikethrough formatting.'),
  fontSize: z.number().min(1).optional().describe('Set font size (in points, e.g., 12).'),
  fontFamily: z.string().optional().describe('Set font family (e.g., "Arial", "Times New Roman").'),
  foregroundColor: hexColor('Set text color using hex format (e.g., "#FF0000").'),
  backgroundColor: hexColor('Set text background color using hex format (e.g., "#FFFF00").'),
  linkUrl: z.string().url().optional().describe('Make the text a hyperlink pointing to this URL.'),
}).refine(
  (data) => Object.keys(data).some(
    (key) => !['documentId', 'textToFind', 'matchInstance'].includes(key)
      && data[key as keyof typeof data] !== undefined,
  ),
  { message: 'At least one formatting option (bold, italic, fontSize, etc.) must be provided.' },
);

export const findAndReplaceSchema = z.object({
  documentId: z.string().describe('The ID of the Google Document.'),
  findText: z.string().min(1).describe('The text to find.'),
  replaceText: z.string().describe('The replacement text.'),
  matchCase: z.boolean().optional().default(false).describe('Whether the search should be case-sensitive.'),
  tabId: z.string().optional().describe('Optional tab ID to restrict the replacement to.'),
});

// === Structure ===

export const insertTableSchema = DocumentIdParameter.extend({
  rows: z.number().int().min(1).describe('Number of rows for the new table.'),
  columns: z.number().int().min(1).describe('Number of columns for the new table.'),
  index: z.number().int().min(1).describe('The index (1-based) where the table should be inserted.'),
});

export const insertPageBreakSchema = DocumentIdParameter.extend({
  index: z.number().int().min(1).describe('The index (1-based) where the page break should be inserted.'),
});

export const batchUpdateDocSchema = z.object({
  documentId: z.string().describe('The ID of the Google Document.'),
  operations: z.array(BatchOperationSchema).min(1).max(50).describe('Array of operations to execute (1-50).'),
});

// === Images ===

export const insertImageFromUrlSchema = DocumentIdParameter.extend({
  imageUrl: z.string().url().describe('Publicly accessible URL to the image (must be http:// or https://).'),
  index: z.number().int().min(1).describe('The index (1-based) where the image should be inserted.'),
  width: z.number().min(1).optional().describe('Optional: Width of the image in points.'),
  height: z.number().min(1).optional().describe('Optional: Height of the image in points.'),
});

export const insertLocalImageSchema = DocumentIdParameter.extend({
  imageUrl: z.string().optional().describe('Public HTTP(S) URL of the image to fetch and insert.'),
  driveFileId: z.string().optional().describe('Google Drive file ID of an existing image.'),
  localImagePath: z.string().optional().describe('Absolute path to a local image file (local/stdio deployments only).'),
  imageBase64: z.string().optional().describe('Base64-encoded image content. Only for small images.'),
  fileName: z.string().optional().describe('File name with extension for MIME detection. Required with imageBase64.'),
  index: z.number().int().min(1).describe('The index (1-based) where the image should be inserted.'),
  width: z.number().min(1).optional().describe('Optional: Width of the image in points.'),
  height: z.number().min(1).optional().describe('Optional: Height of the image in points.'),
  uploadToSameFolder: z.boolean().optional().default(true)
    .describe('If true, uploads the image to the same folder as the document. If false, Drive root.'),
});

// === Comments ===

export const addCommentSchema = DocumentIdParameter.extend({
  startIndex: z.number().int().min(1).describe('The starting index of the text range (inclusive, starts from 1).'),
  endIndex: z.number().int().min(1).describe('The ending index of the text range (exclusive).'),
  commentText: z.string().min(1).describe('The content of the comment.'),
}).refine((data) => data.endIndex > data.startIndex, {
  message: 'endIndex must be greater than startIndex',
  path: ['endIndex'],
});

export const replyToCommentSchema = DocumentIdParameter.extend({
  commentId: z.string().describe('The ID of the comment to reply to.'),
  replyText: z.string().min(1).describe('The content of the reply.'),
});

export const resolveCommentSchema = DocumentIdParameter.extend({
  commentId: z.string().describe('The ID of the comment to resolve.'),
});

export const deleteCommentSchema = DocumentIdParameter.extend({
  commentId: z.string().describe('The ID of the comment to delete.'),
});

// === Import / export ===

export const exportDocToPdfSchema = z.object({
  documentId: z.string().describe('The ID of the Google Document to export.'),
  pdfFilename: z.string().optional().describe('Custom filename for the PDF (without extension). Defaults to the document title.'),
  folderId: z.string().optional().describe('Optional Drive folder ID to save the PDF in.'),
});

export const importDocxSchema = z.object({
  fileId: z.string().describe('The Drive file ID of the .docx file to convert.'),
  targetFolderId: z.string().optional().describe('Optional folder ID to place the converted Google Doc in.'),
});

export const importToGoogleDocSchema = z.object({
  title: z.string().describe('Title for the new Google Doc.'),
  content: z.string().describe('The content to import (text, HTML, or markdown string).'),
  mimeType: z.enum(['text/plain', 'text/html', 'text/markdown']).optional().default('text/plain')
    .describe('The mime type of the source content. For DOCX files already in Drive, use importDocx instead.'),
  parentFolderId: z.string().optional().describe('Optional Drive folder ID to create the doc in.'),
});

export type AppendToGoogleDocArgs = z.infer<typeof appendToGoogleDocSchema>;
export type InsertTextArgs = z.infer<typeof insertTextSchema>;
export type DeleteRangeArgs = z.infer<typeof deleteRangeSchema>;
export type FormatMatchingTextArgs = z.infer<typeof formatMatchingTextSchema>;
export type FindAndReplaceArgs = z.infer<typeof findAndReplaceSchema>;
export type InsertTableArgs = z.infer<typeof insertTableSchema>;
export type InsertPageBreakArgs = z.infer<typeof insertPageBreakSchema>;
export type BatchUpdateDocArgs = z.infer<typeof batchUpdateDocSchema>;
export type InsertImageFromUrlArgs = z.infer<typeof insertImageFromUrlSchema>;
export type InsertLocalImageArgs = z.infer<typeof insertLocalImageSchema>;
export type AddCommentArgs = z.infer<typeof addCommentSchema>;
export type ReplyToCommentArgs = z.infer<typeof replyToCommentSchema>;
export type ResolveCommentArgs = z.infer<typeof resolveCommentSchema>;
export type DeleteCommentArgs = z.infer<typeof deleteCommentSchema>;
export type ExportDocToPdfArgs = z.infer<typeof exportDocToPdfSchema>;
export type ImportDocxArgs = z.infer<typeof importDocxSchema>;
export type ImportToGoogleDocArgs = z.infer<typeof importToGoogleDocSchema>;
