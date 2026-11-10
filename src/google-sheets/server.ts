// src/sheetsServer.ts
import { FastMCP, UserError } from 'fastmcp';
import { instrumentServer } from '../usage/instrumentServer.js';
import { z } from 'zod';
import { sheets_v4, drive_v3 } from 'googleapis';

import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';

import * as SheetsHelpers from './apiHelpers.js';
import { operationToRequest, createBatchState } from './formatHelpers.js';
import { SharedDriveParameters, BatchUpdateOperationSchema } from '../types.js';
import { describeDriveError } from '../google-drive/driveErrors.js';
import {
  listSpreadsheetFiles,
  formatSpreadsheetList,
  LIST_SPREADSHEETS_SCOPE,
} from './listHandlers.js';
import { registerMintRestBearerForCurl } from '../sharedTools/mintRestBearerForCurl.js';
import { registerListRestEndpoints } from '../sharedTools/listRestEndpoints.js';

const sheetsServer = instrumentServer(new FastMCP<UserSession>({
  name: 'Google Sheets MCP Server',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'google-sheets'),
}), 'google-sheets');

registerMintRestBearerForCurl(sheetsServer);
registerListRestEndpoints(sheetsServer);

// --- Helper to get Sheets client within tools ---
function getSheetsClient(session?: UserSession): sheets_v4.Sheets {
  if (session?.googleSheets) return session.googleSheets;
  throw new UserError("Google Sheets client is not available. Make sure you have granted spreadsheet access.");
}

// --- Helper to get Drive client within tools ---
function getDriveClient(session?: UserSession): drive_v3.Drive {
  if (session?.googleDrive) return session.googleDrive;
  throw new UserError("Google Drive client is not available. Make sure you have granted drive access.");
}

// === SHARED WRITE SCHEMAS AND OPS ===
//
// Lifted out of the addTool calls and exported so the REST data plane can reuse
// them verbatim. The POST routes safeParse `req.body` with these schemas; before
// that the ChatGPT-compat routes hand-rolled `if (!range || !values)`, which
// checks presence and nothing else -- `values: "a,b"` (a string, not a 2D array)
// passed that check and reached the Google API, where it fails as an opaque
// upstream 400. One schema for both surfaces is the only thing that keeps them
// in step as either changes.

export const writeSpreadsheetSchema = z.object({
  spreadsheetId: z.string().describe('The ID of the Google Spreadsheet (from the URL).'),
  range: z.string().describe('A1 notation range to write to (e.g., "A1:B2" or "Sheet1!A1:B2").'),
  values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe('2D array of values to write. Each inner array represents a row.'),
  valueInputOption: z.enum(['RAW', 'USER_ENTERED']).optional().default('USER_ENTERED')
    .describe('How input data should be interpreted. RAW: values are stored as-is. USER_ENTERED: values are parsed as if typed by a user.'),
});

export const appendSpreadsheetRowsSchema = z.object({
  spreadsheetId: z.string().describe('The ID of the Google Spreadsheet (from the URL).'),
  range: z.string().describe('A1 notation range indicating where to append (e.g., "A1" or "Sheet1!A1"). Data will be appended starting from this range.'),
  values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe('2D array of values to append. Each inner array represents a row.'),
  valueInputOption: z.enum(['RAW', 'USER_ENTERED']).optional().default('USER_ENTERED')
    .describe('How input data should be interpreted. RAW: values are stored as-is. USER_ENTERED: values are parsed as if typed by a user.'),
});

export const createSpreadsheetSchema = z.object({
  title: z.string().min(1).describe('Title for the new spreadsheet.'),
  parentFolderId: z.string().optional().describe('ID of folder where spreadsheet should be created. If not provided, creates in Drive root. For shared drives, use a folder ID within the shared drive.'),
  initialData: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).optional().describe('Optional initial data to populate in the first sheet. Each inner array represents a row.'),
});

// Destructive (destructiveHint on the tool). Exported for the same reason as the
// others: POST /api/v1/sheets/{spreadsheetId}/ranges/clear validates with it.
export const clearSpreadsheetRangeSchema = z.object({
  spreadsheetId: z.string().describe('The ID of the Google Spreadsheet (from the URL).'),
  range: z.string().describe('A1 notation range to clear (e.g., "A1:B10" or "Sheet1!A1:B10").'),
});

export const batchUpdateSpreadsheetSchema = z.object({
  spreadsheetId: z.string().describe('The ID of the Google Spreadsheet (from the URL).'),
  operations: z.array(BatchUpdateOperationSchema).min(1).describe('Array of formatting operations to apply atomically.'),
});

export type CreateSpreadsheetArgs = z.infer<typeof createSpreadsheetSchema>;
export type BatchUpdateSpreadsheetArgs = z.infer<typeof batchUpdateSpreadsheetSchema>;

/**
 * Create the spreadsheet through Drive, then optionally seed the first sheet.
 *
 * It goes through Drive rather than sheets.spreadsheets.create because only the
 * Drive call can place the file in a shared drive (`supportsAllDrives`), which
 * is the whole reason this tool exists in this shape.
 *
 * The seeding failure is reported, never thrown: the spreadsheet exists by then,
 * and turning a partial success into an error would leave the caller believing
 * nothing was created while an empty sheet sat in their Drive. REST answers 201
 * with `initialDataWritten: false` for the same reason.
 */
export async function performCreateSpreadsheet(
  drive: drive_v3.Drive,
  sheets: sheets_v4.Sheets,
  args: CreateSpreadsheetArgs,
): Promise<{
  file: drive_v3.Schema$File;
  initialDataWritten: boolean;
  initialDataError?: string;
}> {
  const spreadsheetMetadata: drive_v3.Schema$File = {
    name: args.title,
    mimeType: 'application/vnd.google-apps.spreadsheet',
  };
  if (args.parentFolderId) {
    spreadsheetMetadata.parents = [args.parentFolderId];
  }

  const driveResponse = await drive.files.create({
    requestBody: spreadsheetMetadata,
    supportsAllDrives: true,
    fields: 'id,name,webViewLink,driveId',
  });

  const spreadsheetId = driveResponse.data.id;
  if (!spreadsheetId) {
    throw new UserError('Failed to create spreadsheet - no ID returned.');
  }

  if (!args.initialData || args.initialData.length === 0) {
    return { file: driveResponse.data, initialDataWritten: false };
  }

  try {
    await SheetsHelpers.writeRange(sheets, spreadsheetId, 'A1', args.initialData, 'USER_ENTERED');
    return { file: driveResponse.data, initialDataWritten: true };
  } catch (contentError: any) {
    return {
      file: driveResponse.data,
      initialDataWritten: false,
      initialDataError: contentError?.message || String(contentError),
    };
  }
}

/**
 * Translate the operation list into Google requests and apply them in one batch.
 *
 * The translation is the valuable part and the reason this is shared: each
 * operation is resolved against the spreadsheet's live metadata, mapping sheet
 * names to sheetIds, with a `batchState` carrying the per-sheet conditional-format
 * insertion indices so a batch of rules keeps the caller's order.
 * A per-operation failure is re-thrown with the operation's index and type,
 * because "invalid request" against a 40-operation batch is undiagnosable.
 *
 * That metadata is read ONCE, before any operation runs, so a sheet added by an
 * addSheet earlier in the same batch has no sheetId to resolve and cannot be
 * named by a later operation — which is why addSheet takes rowCount/columnCount
 * rather than leaving an appendDimension to size the new tab.
 */
export async function performBatchUpdateSpreadsheet(
  sheets: sheets_v4.Sheets,
  args: BatchUpdateSpreadsheetArgs,
): Promise<{ applied: number; title: string; summaries: string[]; chartIds: number[] }> {
  const metadata = await SheetsHelpers.getSpreadsheetMetadata(sheets, args.spreadsheetId);
  const batchState = createBatchState(metadata);

  const requests: sheets_v4.Schema$Request[] = [];
  const summaries: string[] = [];
  args.operations.forEach((op, i) => {
    try {
      requests.push(operationToRequest(op, metadata, batchState));
      const target = 'range' in op ? op.range
        : op.type === 'addChart' ? (op.newSheet ? '(new sheet)' : (op.anchorCell ?? '(beside the data)'))
        : ('sheetName' in op && op.sheetName) ? op.sheetName
        : ('sourceSheetName' in op && op.sourceSheetName) ? op.sourceSheetName
        : ('title' in op && op.title) ? op.title
        : '(first sheet)';
      // How much the grid grew IS the content of a dimension op, so the audit
      // line carries it: "appendDimension → Data" alone says nothing about
      // whether 5 or 5000 rows were added.
      const detail = op.type === 'appendDimension' ? ` (+${op.length} ${op.dimension})`
        : op.type === 'insertDimension' ? ` (${op.dimension} ${op.startIndex}-${op.endIndex})`
        : op.type === 'addChart' ? ` (${op.chartType} from ${op.sourceRange})`
        : op.type === 'dataValidation' ? ` (${op.rule.kind})`
        : '';
      summaries.push(`  ${i}. ${op.type} → ${target}${detail}`);
    } catch (e: any) {
      if (e instanceof UserError) {
        throw new UserError(`operation[${i}] (type=${op.type}): ${e.message}`);
      }
      throw e;
    }
  });

  const response = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: args.spreadsheetId,
    requestBody: { requests },
  });

  // A chart is only addressable by the id Google assigned, so it is returned.
  const chartIds = (response.data.replies ?? [])
    .map((reply) => reply.addChart?.chart?.chartId)
    .filter((id): id is number => typeof id === 'number');

  return {
    applied: response.data.replies?.length ?? requests.length,
    title: metadata.properties?.title ?? args.spreadsheetId,
    summaries,
    chartIds,
  };
}

// Destructive and MCP-only: not on the REST plane and not a batch operation,
// because the batch schema is shared with REST and filters no operation types.
export const deleteSpreadsheetRowsOrColumnsSchema = z.object({
  spreadsheetId: z.string().describe('The ID of the Google Spreadsheet (from the URL).'),
  sheetName: z.string().optional().describe('Tab name. Defaults to the first sheet.'),
  dimension: z.enum(['ROWS', 'COLUMNS']).describe('Delete rows or columns.'),
  startIndex: z.number().int().min(1).describe('1-based first row/column to delete (inclusive). Column A is 1.'),
  endIndex: z.number().int().min(1).describe('1-based last row/column to delete (inclusive). Equal to startIndex deletes one.'),
});

export type DeleteSpreadsheetRowsOrColumnsArgs = z.infer<typeof deleteSpreadsheetRowsOrColumnsSchema>;

/**
 * Structurally delete rows or columns: everything below/right moves up/left.
 * The grid is read before and after, so the size change is reported from what
 * Google now holds rather than from the request.
 */
export async function performDeleteSpreadsheetRowsOrColumns(
  sheets: sheets_v4.Sheets,
  args: DeleteSpreadsheetRowsOrColumnsArgs,
): Promise<{ sheetTitle: string; deleted: number; sizeBefore: number; sizeAfter: number | null; confirmed: boolean }> {
  if (args.endIndex < args.startIndex) throw new UserError('endIndex must be >= startIndex.');
  const metadata = await SheetsHelpers.getSpreadsheetMetadata(sheets, args.spreadsheetId);
  const sheetId = SheetsHelpers.resolveSheetId(metadata, args.sheetName);
  const sizeOf = (meta: sheets_v4.Schema$Spreadsheet) => {
    const grid = meta.sheets?.find((s) => s.properties?.sheetId === sheetId)?.properties?.gridProperties;
    return (args.dimension === 'ROWS' ? grid?.rowCount : grid?.columnCount) ?? null;
  };
  const sheetTitle = metadata.sheets?.find((s) => s.properties?.sheetId === sheetId)?.properties?.title ?? '(first sheet)';
  const sizeBefore = sizeOf(metadata) ?? 0;
  const noun = args.dimension === 'ROWS' ? 'rows' : 'columns';
  if (args.endIndex > sizeBefore) {
    throw new UserError(`"${sheetTitle}" has ${sizeBefore} ${noun}; ${args.startIndex}-${args.endIndex} is past the end.`);
  }
  // Google refuses to delete every row or column of a sheet; say so by name.
  if (args.startIndex === 1 && args.endIndex === sizeBefore) {
    throw new UserError(`That would delete every ${noun.slice(0, -1)} of "${sheetTitle}", which Google does not allow. Delete the sheet instead.`);
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: args.spreadsheetId,
    requestBody: {
      requests: [{
        deleteDimension: { range: { sheetId, dimension: args.dimension, startIndex: args.startIndex - 1, endIndex: args.endIndex } },
      }],
    },
  });

  const deleted = args.endIndex - args.startIndex + 1;
  const sizeAfter = sizeOf(await SheetsHelpers.getSpreadsheetMetadata(sheets, args.spreadsheetId));
  return { sheetTitle, deleted, sizeBefore, sizeAfter, confirmed: sizeAfter === sizeBefore - deleted };
}

export const inspectSpreadsheetCellsSchema = z.object({
  spreadsheetId: z.string().describe('The ID of the Google Spreadsheet (from the URL).'),
  range: z.string().describe('A1 range to inspect, e.g. "Sheet1!A1:D20". Keep it small: every cell carries its formatting.'),
  maxCells: z.number().int().min(1).max(2000).optional().default(500)
    .describe('Cap on cells returned (default 500, max 2000). Cells past the cap are counted, not listed.'),
});

export type InspectSpreadsheetCellsArgs = z.infer<typeof inspectSpreadsheetCellsSchema>;

const CELL_FIELDS = 'sheets(properties(title),data(startRow,startColumn,rowData(values('
  + 'userEnteredValue,effectiveValue,formattedValue,userEnteredFormat,hyperlink,textFormatRuns,note,dataValidation))))';

/** Whether a cell holds anything beyond formatting: a value, note, link or rule. */
export function hasCellContent(cell: sheets_v4.Schema$CellData | undefined): boolean {
  return Boolean(cell && (cell.userEnteredValue || cell.effectiveValue || cell.note || cell.hyperlink
    || cell.dataValidation || cell.textFormatRuns?.length));
}

function columnLetter(index: number): string {
  let out = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
}

/**
 * Formula text, raw and displayed values, formatting, links, notes and
 * validation per cell, without writing anything. Only non-empty cells are
 * listed. A cell with several links has no `hyperlink`; its links are on
 * `textFormatRuns[].format.link`, so both are returned.
 */
export async function performInspectSpreadsheetCells(sheets: sheets_v4.Sheets, args: InspectSpreadsheetCellsArgs) {
  const res = await sheets.spreadsheets.get({
    spreadsheetId: args.spreadsheetId,
    ranges: [args.range],
    includeGridData: true,
    fields: CELL_FIELDS,
  });
  const sheet = res.data.sheets?.[0];
  const cells: Record<string, unknown>[] = [];
  let nonEmpty = 0;
  for (const block of sheet?.data ?? []) {
    (block.rowData ?? []).forEach((row, r) => {
      (row.values ?? []).forEach((cell, c) => {
        // A blank cell that is only coloured or formatted still comes back with
        // userEnteredFormat; listing it would let a styled band crowd out cells
        // with content under maxCells.
        if (!hasCellContent(cell)) return;
        nonEmpty += 1;
        if (cells.length >= args.maxCells) return;
        const links = (cell.textFormatRuns ?? []).map((run) => run.format?.link?.uri).filter(Boolean);
        cells.push({
          cell: `${columnLetter((block.startColumn ?? 0) + c)}${(block.startRow ?? 0) + r + 1}`,
          ...(cell.userEnteredValue?.formulaValue ? { formula: cell.userEnteredValue.formulaValue } : {}),
          userEnteredValue: cell.userEnteredValue ?? null,
          effectiveValue: cell.effectiveValue ?? null,
          formattedValue: cell.formattedValue ?? null,
          ...(cell.userEnteredFormat ? { format: cell.userEnteredFormat } : {}),
          ...(cell.hyperlink ? { hyperlink: cell.hyperlink } : {}),
          ...(links.length ? { links } : {}),
          ...(cell.note ? { note: cell.note } : {}),
          ...(cell.dataValidation ? { dataValidation: cell.dataValidation } : {}),
        });
      });
    });
  }
  return {
    sheetTitle: sheet?.properties?.title ?? null,
    range: args.range,
    cells,
    nonEmptyCells: nonEmpty,
    truncated: nonEmpty > cells.length,
  };
}

// === TOOL DEFINITIONS ===

sheetsServer.addTool({
  name: 'readSpreadsheet',
  annotations: { readOnlyHint: true },
  description: 'Reads data from a specific range in a Google Spreadsheet.',
  parameters: z.object({
    spreadsheetId: z.string().describe('The ID of the Google Spreadsheet (from the URL).'),
    range: z.string().describe('A1 notation range to read (e.g., "A1:B10" or "Sheet1!A1:B10").'),
    valueRenderOption: z.enum(['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA']).optional().default('FORMATTED_VALUE')
      .describe('How values should be rendered: FORMATTED_VALUE as displayed, UNFORMATTED_VALUE raw numbers, FORMULA the formula text.'),
  }),
  execute: async (args, { log, session }) => {
    const sheets = getSheetsClient(session);
    console.error(`[Sheets Tool] readSpreadsheet called by ${session?.email}: spreadsheetId=${args.spreadsheetId}, range=${args.range}`);

    try {
      const response = await SheetsHelpers.readRange(sheets, args.spreadsheetId, args.range, args.valueRenderOption);
      const values = response.values || [];

      console.error(`[Sheets Tool] readSpreadsheet success: ${values.length} rows`);

      if (values.length === 0) {
        return `Range ${args.range} is empty or does not exist.`;
      }

      let result = `**Spreadsheet Range:** ${args.range}\n\n`;
      values.forEach((row, index) => {
        result += `Row ${index + 1}: ${JSON.stringify(row)}\n`;
      });

      return result;
    } catch (error: any) {
      console.error(`[Sheets Tool] readSpreadsheet FAILED for ${session?.email}: ${error.message || error}`, error.code, error.status);
      log.error(`Error reading spreadsheet ${args.spreadsheetId}: ${error.message || error}`);
      if (error instanceof UserError) throw error;
      throw new UserError(`Failed to read spreadsheet: ${error.message || 'Unknown error'}`);
    }
  }
});

sheetsServer.addTool({
  name: 'writeSpreadsheet',
  annotations: { readOnlyHint: false },
  description: 'Writes data to a specific range in a Google Spreadsheet. Overwrites existing data in the range.',
  parameters: writeSpreadsheetSchema,
  execute: async (args, { log, session }) => {
    const sheets = getSheetsClient(session);
    console.error(`[Sheets Tool] writeSpreadsheet called by ${session?.email}: spreadsheetId=${args.spreadsheetId}, range=${args.range}`);

    try {
      const response = await SheetsHelpers.writeRange(
        sheets,
        args.spreadsheetId,
        args.range,
        args.values,
        args.valueInputOption
      );

      const updatedCells = response.updatedCells || 0;
      const updatedRows = response.updatedRows || 0;
      const updatedColumns = response.updatedColumns || 0;

      console.error(`[Sheets Tool] writeSpreadsheet success: ${updatedCells} cells`);
      return `Successfully wrote ${updatedCells} cells (${updatedRows} rows, ${updatedColumns} columns) to range ${args.range}.`;
    } catch (error: any) {
      console.error(`[Sheets Tool] writeSpreadsheet FAILED for ${session?.email}: ${error.message || error}`, error.code, error.status);
      log.error(`Error writing to spreadsheet ${args.spreadsheetId}: ${error.message || error}`);
      if (error instanceof UserError) throw error;
      throw new UserError(`Failed to write to spreadsheet: ${error.message || 'Unknown error'}`);
    }
  }
});

sheetsServer.addTool({
  name: 'appendSpreadsheetRows',
  annotations: { readOnlyHint: false },
  description: 'Appends rows of data to the end of a sheet in a Google Spreadsheet.',
  parameters: appendSpreadsheetRowsSchema,
  execute: async (args, { log, session }) => {
    const sheets = getSheetsClient(session);
    log.info(`Appending rows to spreadsheet ${args.spreadsheetId}, starting at: ${args.range}`);

    try {
      const response = await SheetsHelpers.appendValues(
        sheets,
        args.spreadsheetId,
        args.range,
        args.values,
        args.valueInputOption
      );

      const updatedCells = response.updates?.updatedCells || 0;
      const updatedRows = response.updates?.updatedRows || 0;
      const updatedRange = response.updates?.updatedRange || args.range;

      return `Successfully appended ${updatedRows} row(s) (${updatedCells} cells) to spreadsheet. Updated range: ${updatedRange}`;
    } catch (error: any) {
      log.error(`Error appending to spreadsheet ${args.spreadsheetId}: ${error.message || error}`);
      if (error instanceof UserError) throw error;
      throw new UserError(`Failed to append to spreadsheet: ${error.message || 'Unknown error'}`);
    }
  }
});

sheetsServer.addTool({
  name: 'clearSpreadsheetRange',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Clears all values from a specific range in a Google Spreadsheet.',
  parameters: clearSpreadsheetRangeSchema,
  execute: async (args, { log, session }) => {
    const sheets = getSheetsClient(session);
    log.info(`Clearing range ${args.range} in spreadsheet ${args.spreadsheetId}`);

    try {
      const response = await SheetsHelpers.clearRange(sheets, args.spreadsheetId, args.range);
      const clearedRange = response.clearedRange || args.range;

      return `Successfully cleared range ${clearedRange}.`;
    } catch (error: any) {
      log.error(`Error clearing range in spreadsheet ${args.spreadsheetId}: ${error.message || error}`);
      if (error instanceof UserError) throw error;
      throw new UserError(`Failed to clear range: ${error.message || 'Unknown error'}`);
    }
  }
});

sheetsServer.addTool({
  name: 'getSpreadsheetInfo',
  annotations: { readOnlyHint: true },
  description: 'Gets detailed information about a Google Spreadsheet including all sheets/tabs.',
  parameters: z.object({
    spreadsheetId: z.string().describe('The ID of the Google Spreadsheet (from the URL).'),
  }),
  execute: async (args, { log, session }) => {
    const sheets = getSheetsClient(session);
    log.info(`Getting info for spreadsheet: ${args.spreadsheetId}`);

    try {
      const metadata = await SheetsHelpers.getSpreadsheetMetadata(sheets, args.spreadsheetId);

      let result = `**Spreadsheet Information:**\n\n`;
      result += `**Title:** ${metadata.properties?.title || 'Untitled'}\n`;
      result += `**ID:** ${metadata.spreadsheetId}\n`;
      result += `**URL:** https://docs.google.com/spreadsheets/d/${metadata.spreadsheetId}\n\n`;

      const sheetList = metadata.sheets || [];
      result += `**Sheets (${sheetList.length}):**\n`;
      sheetList.forEach((sheet, index) => {
        const props = sheet.properties;
        result += `${index + 1}. **${props?.title || 'Untitled'}**\n`;
        result += `   - Sheet ID: ${props?.sheetId}\n`;
        result += `   - Grid: ${props?.gridProperties?.rowCount || 0} rows × ${props?.gridProperties?.columnCount || 0} columns\n`;
        if (props?.hidden) {
          result += `   - Status: Hidden\n`;
        }
        result += `\n`;
      });

      return result;
    } catch (error: any) {
      log.error(`Error getting spreadsheet info ${args.spreadsheetId}: ${error.message || error}`);
      if (error instanceof UserError) throw error;
      throw new UserError(`Failed to get spreadsheet info: ${error.message || 'Unknown error'}`);
    }
  }
});

sheetsServer.addTool({
  name: 'addSpreadsheetSheet',
  annotations: { readOnlyHint: false },
  description: 'Adds a new sheet/tab to an existing Google Spreadsheet. Google sizes a new tab at 1000 rows x 26 columns, and writeSpreadsheet does NOT grow a grid — pass rowCount/columnCount when the data is bigger, or the write fails with "exceeds grid limits".',
  parameters: z.object({
    spreadsheetId: z.string().describe('The ID of the Google Spreadsheet (from the URL).'),
    sheetTitle: z.string().min(1).describe('Title for the new sheet/tab.'),
    rowCount: z.number().int().min(1).optional().describe('Rows in the new tab (Google default: 1000). Set this to at least the number of rows you are about to write.'),
    columnCount: z.number().int().min(1).optional().describe('Columns in the new tab (Google default: 26, i.e. A-Z).'),
  }),
  execute: async (args, { log, session }) => {
    const sheets = getSheetsClient(session);
    log.info(`Adding sheet "${args.sheetTitle}" to spreadsheet ${args.spreadsheetId}`);

    try {
      const response = await SheetsHelpers.addSheet(sheets, args.spreadsheetId, args.sheetTitle, {
        rowCount: args.rowCount,
        columnCount: args.columnCount,
      });
      const addedSheet = response.replies?.[0]?.addSheet?.properties;

      if (!addedSheet) {
        throw new UserError('Failed to add sheet - no sheet properties returned.');
      }

      // The grid comes from Google's reply, not from the request: a rowCount it
      // clamped or ignored must not be reported back as the size that was
      // created, since the next writeSpreadsheet depends on it.
      const grid = addedSheet.gridProperties;
      const gridInfo = grid?.rowCount != null || grid?.columnCount != null
        ? ` Grid: ${grid?.rowCount ?? '?'} rows x ${grid?.columnCount ?? '?'} columns.`
        : '';
      return `Successfully added sheet "${addedSheet.title}" (Sheet ID: ${addedSheet.sheetId}) to spreadsheet.${gridInfo}`;
    } catch (error: any) {
      log.error(`Error adding sheet to spreadsheet ${args.spreadsheetId}: ${error.message || error}`);
      if (error instanceof UserError) throw error;
      throw new UserError(`Failed to add sheet: ${error.message || 'Unknown error'}`);
    }
  }
});

sheetsServer.addTool({
  name: 'createSpreadsheet',
  annotations: { readOnlyHint: false },
  description: 'Creates a new Google Spreadsheet (works with shared drives).',
  parameters: createSpreadsheetSchema,
  execute: async (args, { log, session }) => {
    const drive = getDriveClient(session);
    const sheets = getSheetsClient(session);
    log.info(`Creating new spreadsheet "${args.title}"`);

    try {
      const { file, initialDataWritten, initialDataError } = await performCreateSpreadsheet(drive, sheets, args);
      const locationInfo = file.driveId ? ` (in shared drive ID: ${file.driveId})` : '';
      let result = `Successfully created spreadsheet "${file.name}" (ID: ${file.id})${locationInfo}\nView Link: ${file.webViewLink}`;
      if (initialDataWritten) {
        result += `\n\nInitial data added to the spreadsheet.`;
      } else if (initialDataError) {
        log.warn(`Spreadsheet created but failed to add initial data: ${initialDataError}`);
        result += `\n\nSpreadsheet created but failed to add initial data. You can add data manually.`;
      }
      return result;
    } catch (error: any) {
      log.error(`Error creating spreadsheet: ${error.message || error}`);
      if (error instanceof UserError) throw error;
      if (error.code === 404) throw new UserError("Parent folder not found. Check the folder ID.");
      if (error.code === 403) throw new UserError("Permission denied. Make sure you have write access to the destination folder.");
      throw new UserError(`Failed to create spreadsheet: ${error.message || 'Unknown error'}`);
    }
  }
});

sheetsServer.addTool({
  name: 'listGoogleSheets',
  annotations: { readOnlyHint: true },
  description: 'Lists Google Spreadsheets from your Google Drive and shared drives with optional filtering.',
  parameters: z.object({
    maxResults: z.number().int().min(1).max(100).optional().default(20).describe('Maximum number of spreadsheets to return (1-100).'),
    query: z.string().optional().describe('Filter spreadsheets by name.'),
    searchContent: z.boolean().optional().default(false).describe('Also match text inside the spreadsheets, not just their names. Slower, and unavailable on some Drive configurations.'),
    orderBy: z.enum(['name', 'modifiedTime', 'createdTime']).optional().default('modifiedTime').describe('Sort order for results.'),
  }).merge(SharedDriveParameters),
  execute: async (args, { log, session }) => {
    const drive = getDriveClient(session);
    log.info(`Listing Google Sheets. Query: ${args.query || 'none'}, Max: ${args.maxResults}, Order: ${args.orderBy}`);

    try {
      // Shared with GET /api/v1/sheets — see listHandlers.ts. Do not inline a
      // Drive query here; that divergence is the bug this replaced.
      const files = await listSpreadsheetFiles(drive, args);
      return formatSpreadsheetList(files);
    } catch (error: any) {
      log.error(`Error listing Google Sheets: ${error.message || error}`);
      throw new UserError(
        describeDriveError(error, 'list spreadsheets', LIST_SPREADSHEETS_SCOPE),
      );
    }
  }
});

sheetsServer.addTool({
  name: 'findRowByValue',
  annotations: { readOnlyHint: true },
  description: 'Search a column for a specific value and return the 1-based row number where it was found.',
  parameters: z.object({
    spreadsheetId: z.string().describe('The ID of the Google Spreadsheet (from the URL).'),
    searchColumn: z.string().describe('Column letter to search in (e.g., "A", "B", "AA").'),
    searchValue: z.string().describe('The value to search for (exact match).'),
    sheetName: z.string().optional().describe('Sheet/tab name. Defaults to the first sheet.'),
  }),
  execute: async (args, { log, session }) => {
    const sheets = getSheetsClient(session);
    log.info(`Finding row with "${args.searchValue}" in column ${args.searchColumn}`);

    const rowNumber = await SheetsHelpers.findRowByValue(
      sheets, args.spreadsheetId, args.searchColumn, args.searchValue, args.sheetName
    );

    if (rowNumber === null) {
      return `Value "${args.searchValue}" not found in column ${args.searchColumn}.`;
    }
    return `Found "${args.searchValue}" in row ${rowNumber}.`;
  }
});

sheetsServer.addTool({
  name: 'readRowByField',
  annotations: { readOnlyHint: true },
  description: 'Look up a row by searching a column for a value, then return the row as a named JSON object using header names from row 1.',
  parameters: z.object({
    spreadsheetId: z.string().describe('The ID of the Google Spreadsheet (from the URL).'),
    searchColumn: z.string().describe('Column letter to search in (e.g., "A").'),
    searchValue: z.string().describe('The value to search for (exact match).'),
    sheetName: z.string().optional().describe('Sheet/tab name. Defaults to the first sheet.'),
  }),
  execute: async (args, { log, session }) => {
    const sheets = getSheetsClient(session);
    log.info(`Reading row where column ${args.searchColumn} = "${args.searchValue}"`);

    const rowNumber = await SheetsHelpers.findRowByValue(
      sheets, args.spreadsheetId, args.searchColumn, args.searchValue, args.sheetName
    );

    if (rowNumber === null) {
      return `Value "${args.searchValue}" not found in column ${args.searchColumn}.`;
    }

    const [headers, values] = await Promise.all([
      SheetsHelpers.getHeaders(sheets, args.spreadsheetId, args.sheetName),
      SheetsHelpers.getRowValues(sheets, args.spreadsheetId, rowNumber, args.sheetName),
    ]);

    const obj: Record<string, any> = {};
    headers.forEach((header, i) => {
      obj[header] = values[i] !== undefined ? values[i] : null;
    });

    return JSON.stringify(obj, null, 2);
  }
});

sheetsServer.addTool({
  name: 'updateCellByFieldName',
  annotations: { readOnlyHint: false },
  description: 'Find a row by searching a column for a value, then update a specific field (identified by header name) in that row. Assumes row 1 contains the header names.',
  parameters: z.object({
    spreadsheetId: z.string().describe('The ID of the Google Spreadsheet (from the URL).'),
    searchColumn: z.string().describe('Column letter to search in (e.g., "A").'),
    searchValue: z.string().describe('The value to search for (exact match) to locate the row.'),
    fieldName: z.string().describe('The header name of the column to update.'),
    newValue: z.string().describe('The new value to write into the cell.'),
    sheetName: z.string().optional().describe('Sheet/tab name. Defaults to the first sheet.'),
  }),
  execute: async (args, { log, session }) => {
    const sheets = getSheetsClient(session);
    log.info(`Updating "${args.fieldName}" where column ${args.searchColumn} = "${args.searchValue}"`);

    const [rowNumber, headers] = await Promise.all([
      SheetsHelpers.findRowByValue(sheets, args.spreadsheetId, args.searchColumn, args.searchValue, args.sheetName),
      SheetsHelpers.getHeaders(sheets, args.spreadsheetId, args.sheetName),
    ]);

    if (rowNumber === null) {
      return JSON.stringify({ success: false, error: `Value "${args.searchValue}" not found in column ${args.searchColumn}.` });
    }

    const colIndex = headers.indexOf(args.fieldName);
    if (colIndex === -1) {
      return JSON.stringify({ success: false, error: `Field "${args.fieldName}" not found in headers.`, availableHeaders: headers });
    }

    // Read the current row so we can return context for sanity-checking
    const rowData = await SheetsHelpers.getRowValues(sheets, args.spreadsheetId, rowNumber, args.sheetName);

    const colLetter = SheetsHelpers.columnIndexToLetter(colIndex);
    const cellRef = args.sheetName
      ? `${args.sheetName}!${colLetter}${rowNumber}`
      : `${colLetter}${rowNumber}`;

    const oldValue = rowData[colIndex] !== undefined ? String(rowData[colIndex]) : null;

    await SheetsHelpers.writeRange(sheets, args.spreadsheetId, cellRef, [[args.newValue]]);

    // Build a context object from the row so the AI can verify it updated the right record
    const rowContext: Record<string, any> = {};
    headers.forEach((header, i) => {
      if (i < rowData.length) rowContext[header] = rowData[i];
    });

    return JSON.stringify({
      success: true,
      updated: { row: rowNumber, column: colLetter, cell: `${colLetter}${rowNumber}` },
      rowContext,
      field: args.fieldName,
      oldValue,
      newValue: args.newValue,
    }, null, 2);
  }
});

sheetsServer.addTool({
  name: 'batchUpdateSpreadsheet',
  annotations: { readOnlyHint: false },
  description: 'Apply multiple formatting and sheet-lifecycle operations to a Google Spreadsheet in a single atomic batch. Supports number formats, text styling, background colors, borders, freezing, conditional formatting, cell merging, alignment and text wrapping, data validation (dropdowns, checkboxes, number and formula rules), native charts (addChart returns the chart ID), column/row sizing, tab-level ops (rename/reorder/hide/recolor via updateSheetProperties, deleteSheet, duplicateSheet, addSheet), and grid growth (appendDimension adds rows/columns at the end, insertDimension makes room in the middle). Use appendDimension before a writeSpreadsheet that exceeds the tab\'s current row count — writeSpreadsheet does not grow the grid. A tab added by addSheet in THIS batch cannot be targeted by a later operation in the same batch (it has no sheetId yet), so size it with addSheet rowCount/columnCount instead.',
  parameters: batchUpdateSpreadsheetSchema,
  execute: async (args, { log, session }) => {
    const sheets = getSheetsClient(session);
    log.info(`batchUpdateSpreadsheet: ${args.operations.length} ops on ${args.spreadsheetId}`);

    try {
      const { applied, title, summaries, chartIds } = await performBatchUpdateSpreadsheet(sheets, args);
      const charts = chartIds.length ? `\nChart ID(s) created: ${chartIds.join(', ')}` : '';
      return `Applied ${applied} operation(s) to "${title}".\n${summaries.join('\n')}${charts}`;
    } catch (error: any) {
      log.error(`batchUpdateSpreadsheet failed: ${error.message || error}`);
      if (error instanceof UserError) throw error;
      if (error.code === 404) throw new UserError(`Spreadsheet not found (ID: ${args.spreadsheetId}).`);
      if (error.code === 403) throw new UserError(`Permission denied for spreadsheet (ID: ${args.spreadsheetId}).`);
      const apiErrors = error?.errors || error?.response?.data?.error?.errors;
      const detail = Array.isArray(apiErrors) && apiErrors.length > 0
        ? apiErrors.map((e: any) => e.message).join('; ')
        : (error.message || 'Unknown error');
      throw new UserError(`Failed to apply batch update: ${detail}`);
    }
  },
});

sheetsServer.addTool({
  name: 'deleteSpreadsheetRowsOrColumns',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Deletes whole rows or columns from a tab, with their content; the rest shift up or left. Not reversible through the API.',
  parameters: deleteSpreadsheetRowsOrColumnsSchema,
  execute: async (args, { log, session }) => {
    const sheets = getSheetsClient(session);
    log.info(`deleteSpreadsheetRowsOrColumns: ${args.dimension} ${args.startIndex}-${args.endIndex} on ${args.spreadsheetId}`);
    let r: Awaited<ReturnType<typeof performDeleteSpreadsheetRowsOrColumns>>;
    try {
      r = await performDeleteSpreadsheetRowsOrColumns(sheets, args);
    } catch (error: any) {
      log.error(`deleteSpreadsheetRowsOrColumns failed: ${error.message || error}`);
      if (error instanceof UserError) throw error;
      if (error.code === 404) throw new UserError(`Spreadsheet not found (ID: ${args.spreadsheetId}).`);
      if (error.code === 403) throw new UserError(`Permission denied for spreadsheet (ID: ${args.spreadsheetId}). Deleting needs edit access.`);
      // Google also refuses deleting every NON-FROZEN row or column, which the
      // local check (every row/column) does not catch; its message says so.
      throw new UserError(`Nothing was deleted: ${error.message || 'Unknown error'}`);
    }
    const noun = args.dimension === 'ROWS' ? 'row' : 'column';
    if (!r.confirmed) {
      return `Google accepted deleting ${r.deleted} ${noun}(s) from "${r.sheetTitle}", but the grid reads back as `
        + `${r.sizeAfter ?? 'unknown'} ${noun}s (was ${r.sizeBefore}). Re-read before relying on it.`;
    }
    return `Deleted ${noun}s ${args.startIndex}-${args.endIndex} (${r.deleted}) from "${r.sheetTitle}": ${r.sizeBefore} → ${r.sizeAfter} ${noun}s.`;
  },
});

sheetsServer.addTool({
  name: 'inspectSpreadsheetCells',
  annotations: { readOnlyHint: true },
  description: 'Reads cells without changing them: formula text, raw and displayed values, formatting, hyperlinks, notes and validation rules.',
  parameters: inspectSpreadsheetCellsSchema,
  execute: async (args, { log, session }) => {
    const sheets = getSheetsClient(session);
    log.info(`inspectSpreadsheetCells: ${args.range} on ${args.spreadsheetId}`);
    let result: Awaited<ReturnType<typeof performInspectSpreadsheetCells>>;
    try {
      result = await performInspectSpreadsheetCells(sheets, args);
    } catch (error: any) {
      if (error.code === 404) throw new UserError(`Spreadsheet not found (ID: ${args.spreadsheetId}).`);
      if (error.code === 403) throw new UserError(`Permission denied for spreadsheet (ID: ${args.spreadsheetId}).`);
      throw new UserError(`Failed to inspect cells: ${error.message || 'Unknown error'}`);
    }
    if (result.nonEmptyCells === 0) return `No non-empty cells in ${args.range}.`;
    const head = result.truncated
      ? `Showing ${result.cells.length} of ${result.nonEmptyCells} non-empty cells in ${args.range} (raise maxCells or narrow the range for the rest).`
      : `${result.nonEmptyCells} non-empty cell(s) in ${args.range}.`;
    return `${head}\n${JSON.stringify(result.cells, null, 2)}`;
  },
});

export { sheetsServer };
