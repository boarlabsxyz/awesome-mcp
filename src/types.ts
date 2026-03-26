// src/types.ts
import { z } from 'zod';
import { docs_v1 } from 'googleapis';

// --- Helper function for hex color validation ---
export const hexColorRegex = /^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;
export const validateHexColor = (color: string) => hexColorRegex.test(color);

// --- Helper function for Hex to RGB conversion ---
export function hexToRgbColor(hex: string): docs_v1.Schema$RgbColor | null {
if (!hex) return null;
let hexClean = hex.startsWith('#') ? hex.slice(1) : hex;

if (hexClean.length === 3) {
hexClean = hexClean[0] + hexClean[0] + hexClean[1] + hexClean[1] + hexClean[2] + hexClean[2];
}
if (hexClean.length !== 6) return null;
const bigint = parseInt(hexClean, 16);
if (isNaN(bigint)) return null;

const r = ((bigint >> 16) & 255) / 255;
const g = ((bigint >> 8) & 255) / 255;
const b = (bigint & 255) / 255;

return { red: r, green: g, blue: b };
}

// --- Zod Schema Fragments for Reusability ---

export const DocumentIdParameter = z.object({
documentId: z.string().describe('The ID of the Google Document (from the URL).'),
});

export const RangeParameters = z.object({
startIndex: z.number().int().min(1).describe('The starting index of the text range (inclusive, starts from 1).'),
endIndex: z.number().int().min(1).describe('The ending index of the text range (exclusive).'),
}).refine(data => data.endIndex > data.startIndex, {
message: "endIndex must be greater than startIndex",
path: ["endIndex"],
});

export const OptionalRangeParameters = z.object({
startIndex: z.number().int().min(1).optional().describe('Optional: The starting index of the text range (inclusive, starts from 1). If omitted, might apply to a found element or whole paragraph.'),
endIndex: z.number().int().min(1).optional().describe('Optional: The ending index of the text range (exclusive). If omitted, might apply to a found element or whole paragraph.'),
}).refine(data => !data.startIndex || !data.endIndex || data.endIndex > data.startIndex, {
message: "If both startIndex and endIndex are provided, endIndex must be greater than startIndex",
path: ["endIndex"],
});

export const TextFindParameter = z.object({
textToFind: z.string().min(1).describe('The exact text string to locate.'),
matchInstance: z.number().int().min(1).optional().default(1).describe('Which instance of the text to target (1st, 2nd, etc.). Defaults to 1.'),
});

// --- Style Parameter Schemas ---

export const TextStyleParameters = z.object({
bold: z.boolean().optional().describe('Apply bold formatting.'),
italic: z.boolean().optional().describe('Apply italic formatting.'),
underline: z.boolean().optional().describe('Apply underline formatting.'),
strikethrough: z.boolean().optional().describe('Apply strikethrough formatting.'),
fontSize: z.number().min(1).optional().describe('Set font size (in points, e.g., 12).'),
fontFamily: z.string().optional().describe('Set font family (e.g., "Arial", "Times New Roman").'),
foregroundColor: z.string()
.refine(validateHexColor, { message: "Invalid hex color format (e.g., #FF0000 or #F00)" })
.optional()
.describe('Set text color using hex format (e.g., "#FF0000").'),
backgroundColor: z.string()
.refine(validateHexColor, { message: "Invalid hex color format (e.g., #00FF00 or #0F0)" })
.optional()
.describe('Set text background color using hex format (e.g., "#FFFF00").'),
linkUrl: z.string().url().optional().describe('Make the text a hyperlink pointing to this URL.'),
// clearDirectFormatting: z.boolean().optional().describe('If true, attempts to clear all direct text formatting within the range before applying new styles.') // Harder to implement perfectly
}).describe("Parameters for character-level text formatting.");

// Subset of TextStyle used for passing to helpers
export type TextStyleArgs = z.infer<typeof TextStyleParameters>;

export const ParagraphStyleParameters = z.object({
alignment: z.enum(['START', 'END', 'CENTER', 'JUSTIFIED']).optional().describe('Paragraph alignment. START=left for LTR languages, END=right for LTR languages.'),
indentStart: z.number().min(0).optional().describe('Left indentation in points.'),
indentEnd: z.number().min(0).optional().describe('Right indentation in points.'),
spaceAbove: z.number().min(0).optional().describe('Space before the paragraph in points.'),
spaceBelow: z.number().min(0).optional().describe('Space after the paragraph in points.'),
namedStyleType: z.enum([
'NORMAL_TEXT', 'TITLE', 'SUBTITLE',
'HEADING_1', 'HEADING_2', 'HEADING_3', 'HEADING_4', 'HEADING_5', 'HEADING_6'
]).optional().describe('Apply a built-in named paragraph style (e.g., HEADING_1).'),
keepWithNext: z.boolean().optional().describe('Keep this paragraph together with the next one on the same page.'),
// Borders are more complex, might need separate objects/tools
// clearDirectFormatting: z.boolean().optional().describe('If true, attempts to clear all direct paragraph formatting within the range before applying new styles.') // Harder to implement perfectly
}).describe("Parameters for paragraph-level formatting.");

// Subset of ParagraphStyle used for passing to helpers
export type ParagraphStyleArgs = z.infer<typeof ParagraphStyleParameters>;

// --- Combination Schemas for Tools ---

export const ApplyTextStyleToolParameters = DocumentIdParameter.extend({
// Target EITHER by range OR by finding text
target: z.union([
RangeParameters,
TextFindParameter
]).describe("Specify the target range either by start/end indices or by finding specific text."),
style: TextStyleParameters.refine(
styleArgs => Object.values(styleArgs).some(v => v !== undefined),
{ message: "At least one text style option must be provided." }
).describe("The text styling to apply.")
});
export type ApplyTextStyleToolArgs = z.infer<typeof ApplyTextStyleToolParameters>;

export const ApplyParagraphStyleToolParameters = DocumentIdParameter.extend({
// Target EITHER by range OR by finding text (tool logic needs to find paragraph boundaries)
target: z.union([
RangeParameters, // User provides paragraph start/end (less likely)
TextFindParameter, // Find text within paragraph to apply style
z.object({ // Target by specific index within the paragraph
indexWithinParagraph: z.number().int().min(1).describe("An index located anywhere within the target paragraph.")
})
]).describe("Specify the target paragraph either by start/end indices, by finding text within it, or by providing an index within it."),
style: ParagraphStyleParameters.refine(
styleArgs => Object.values(styleArgs).some(v => v !== undefined),
{ message: "At least one paragraph style option must be provided." }
).describe("The paragraph styling to apply.")
});
export type ApplyParagraphStyleToolArgs = z.infer<typeof ApplyParagraphStyleToolParameters>;

// --- Shared Drive Parameters Schema ---
export const SharedDriveParameters = z.object({
  includeSharedDrives: z.boolean().optional()
    .describe('Include items from shared drives. Defaults to true.'),
  driveId: z.string().optional()
    .describe('Filter to a specific shared drive ID.'),
  corpora: z.enum(['user', 'drive', 'allDrives', 'domain']).optional()
    .describe('Source of files: user (My Drive), drive (specific), allDrives, domain.'),
});

// --- Batch Operation Schema ---

const InsertTextOp = z.object({
  type: z.literal('insert_text'),
  index: z.number().int().min(1).describe('1-based index where text will be inserted.'),
  text: z.string().min(1).describe('The text to insert.'),
});

const DeleteTextOp = z.object({
  type: z.literal('delete_text'),
  startIndex: z.number().int().min(1).describe('Start index (inclusive).'),
  endIndex: z.number().int().min(1).describe('End index (exclusive).'),
});

const ReplaceTextOp = z.object({
  type: z.literal('replace_text'),
  findText: z.string().min(1).describe('Text to find.'),
  replaceText: z.string().describe('Replacement text.'),
  matchCase: z.boolean().optional().default(false).describe('Case-sensitive match.'),
});

const FormatTextOp = z.object({
  type: z.literal('format_text'),
  startIndex: z.number().int().min(1).describe('Start index (inclusive).'),
  endIndex: z.number().int().min(1).describe('End index (exclusive).'),
  style: TextStyleParameters,
});

const UpdateParagraphStyleOp = z.object({
  type: z.literal('update_paragraph_style'),
  startIndex: z.number().int().min(1).describe('Start index (inclusive).'),
  endIndex: z.number().int().min(1).describe('End index (exclusive).'),
  style: ParagraphStyleParameters,
});

const InsertTableOp = z.object({
  type: z.literal('insert_table'),
  index: z.number().int().min(1).describe('1-based index where table will be inserted.'),
  rows: z.number().int().min(1).max(20).describe('Number of rows (1-20).'),
  columns: z.number().int().min(1).max(20).describe('Number of columns (1-20).'),
});

const InsertPageBreakOp = z.object({
  type: z.literal('insert_page_break'),
  index: z.number().int().min(1).describe('1-based index where page break will be inserted.'),
});

const FindReplaceOp = z.object({
  type: z.literal('find_replace'),
  findText: z.string().min(1).describe('Text to find.'),
  replaceText: z.string().describe('Replacement text.'),
  matchCase: z.boolean().optional().default(false).describe('Case-sensitive match.'),
});

const CreateBulletListOp = z.object({
  type: z.literal('create_bullet_list'),
  startIndex: z.number().int().min(1).describe('Start index (inclusive).'),
  endIndex: z.number().int().min(1).describe('End index (exclusive).'),
});

export const BatchOperationSchema = z.discriminatedUnion('type', [
  InsertTextOp,
  DeleteTextOp,
  ReplaceTextOp,
  FormatTextOp,
  UpdateParagraphStyleOp,
  InsertTableOp,
  InsertPageBreakOp,
  FindReplaceOp,
  CreateBulletListOp,
]);

export type BatchOperation = z.infer<typeof BatchOperationSchema>;

// --- Error Class ---
// Use FastMCP's UserError for client-facing issues
// Define a custom error for internal issues if needed
export class NotImplementedError extends Error {
constructor(message = "This feature is not yet implemented.") {
super(message);
this.name = "NotImplementedError";
}
}