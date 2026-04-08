// src/sheetsServer.ts
import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';
import { sheets_v4, drive_v3 } from 'googleapis';

import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';

import * as SheetsHelpers from './apiHelpers.js';
import { operationToRequest } from './formatHelpers.js';
import { SharedDriveParameters, BatchUpdateOperationSchema } from '../types.js';
import { buildSharedDriveParams } from '../google-drive/toolHandlers.js';

const sheetsServer = new FastMCP<UserSession>({
  name: 'Google Sheets MCP Server',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'google-sheets'),
});

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

// === TOOL DEFINITIONS ===

sheetsServer.addTool({
  name: 'readSpreadsheet',
  description: 'Reads data from a specific range in a Google Spreadsheet.',
  parameters: z.object({
    spreadsheetId: z.string().describe('The ID of the Google Spreadsheet (from the URL).'),
    range: z.string().describe('A1 notation range to read (e.g., "A1:B10" or "Sheet1!A1:B10").'),
    valueRenderOption: z.enum(['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA']).optional().default('FORMATTED_VALUE')
      .describe('How values should be rendered in the output.'),
  }),
  execute: async (args, { log, session }) => {
    const sheets = getSheetsClient(session);
    console.error(`[Sheets Tool] readSpreadsheet called by ${session?.email}: spreadsheetId=${args.spreadsheetId}, range=${args.range}`);

    try {
      const response = await SheetsHelpers.readRange(sheets, args.spreadsheetId, args.range);
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
  description: 'Writes data to a specific range in a Google Spreadsheet. Overwrites existing data in the range.',
  parameters: z.object({
    spreadsheetId: z.string().describe('The ID of the Google Spreadsheet (from the URL).'),
    range: z.string().describe('A1 notation range to write to (e.g., "A1:B2" or "Sheet1!A1:B2").'),
    values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe('2D array of values to write. Each inner array represents a row.'),
    valueInputOption: z.enum(['RAW', 'USER_ENTERED']).optional().default('USER_ENTERED')
      .describe('How input data should be interpreted. RAW: values are stored as-is. USER_ENTERED: values are parsed as if typed by a user.'),
  }),
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
  description: 'Appends rows of data to the end of a sheet in a Google Spreadsheet.',
  parameters: z.object({
    spreadsheetId: z.string().describe('The ID of the Google Spreadsheet (from the URL).'),
    range: z.string().describe('A1 notation range indicating where to append (e.g., "A1" or "Sheet1!A1"). Data will be appended starting from this range.'),
    values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe('2D array of values to append. Each inner array represents a row.'),
    valueInputOption: z.enum(['RAW', 'USER_ENTERED']).optional().default('USER_ENTERED')
      .describe('How input data should be interpreted. RAW: values are stored as-is. USER_ENTERED: values are parsed as if typed by a user.'),
  }),
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
  description: 'Clears all values from a specific range in a Google Spreadsheet.',
  parameters: z.object({
    spreadsheetId: z.string().describe('The ID of the Google Spreadsheet (from the URL).'),
    range: z.string().describe('A1 notation range to clear (e.g., "A1:B10" or "Sheet1!A1:B10").'),
  }),
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
  description: 'Adds a new sheet/tab to an existing Google Spreadsheet.',
  parameters: z.object({
    spreadsheetId: z.string().describe('The ID of the Google Spreadsheet (from the URL).'),
    sheetTitle: z.string().min(1).describe('Title for the new sheet/tab.'),
  }),
  execute: async (args, { log, session }) => {
    const sheets = getSheetsClient(session);
    log.info(`Adding sheet "${args.sheetTitle}" to spreadsheet ${args.spreadsheetId}`);

    try {
      const response = await SheetsHelpers.addSheet(sheets, args.spreadsheetId, args.sheetTitle);
      const addedSheet = response.replies?.[0]?.addSheet?.properties;

      if (!addedSheet) {
        throw new UserError('Failed to add sheet - no sheet properties returned.');
      }

      return `Successfully added sheet "${addedSheet.title}" (Sheet ID: ${addedSheet.sheetId}) to spreadsheet.`;
    } catch (error: any) {
      log.error(`Error adding sheet to spreadsheet ${args.spreadsheetId}: ${error.message || error}`);
      if (error instanceof UserError) throw error;
      throw new UserError(`Failed to add sheet: ${error.message || 'Unknown error'}`);
    }
  }
});

sheetsServer.addTool({
  name: 'createSpreadsheet',
  description: 'Creates a new Google Spreadsheet (works with shared drives).',
  parameters: z.object({
    title: z.string().min(1).describe('Title for the new spreadsheet.'),
    parentFolderId: z.string().optional().describe('ID of folder where spreadsheet should be created. If not provided, creates in Drive root. For shared drives, use a folder ID within the shared drive.'),
    initialData: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).optional().describe('Optional initial data to populate in the first sheet. Each inner array represents a row.'),
  }),
  execute: async (args, { log, session }) => {
    const drive = getDriveClient(session);
    const sheets = getSheetsClient(session);
    log.info(`Creating new spreadsheet "${args.title}"`);

    try {
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

      const locationInfo = driveResponse.data.driveId ? ` (in shared drive ID: ${driveResponse.data.driveId})` : '';
      let result = `Successfully created spreadsheet "${driveResponse.data.name}" (ID: ${spreadsheetId})${locationInfo}\nView Link: ${driveResponse.data.webViewLink}`;

      if (args.initialData && args.initialData.length > 0) {
        try {
          await SheetsHelpers.writeRange(
            sheets,
            spreadsheetId,
            'A1',
            args.initialData,
            'USER_ENTERED'
          );
          result += `\n\nInitial data added to the spreadsheet.`;
        } catch (contentError: any) {
          log.warn(`Spreadsheet created but failed to add initial data: ${contentError.message}`);
          result += `\n\nSpreadsheet created but failed to add initial data. You can add data manually.`;
        }
      }

      return result;
    } catch (error: any) {
      log.error(`Error creating spreadsheet: ${error.message || error}`);
      if (error.code === 404) throw new UserError("Parent folder not found. Check the folder ID.");
      if (error.code === 403) throw new UserError("Permission denied. Make sure you have write access to the destination folder.");
      throw new UserError(`Failed to create spreadsheet: ${error.message || 'Unknown error'}`);
    }
  }
});

sheetsServer.addTool({
  name: 'listGoogleSheets',
  description: 'Lists Google Spreadsheets from your Google Drive and shared drives with optional filtering.',
  parameters: z.object({
    maxResults: z.number().int().min(1).max(100).optional().default(20).describe('Maximum number of spreadsheets to return (1-100).'),
    query: z.string().optional().describe('Search query to filter spreadsheets by name or content.'),
    orderBy: z.enum(['name', 'modifiedTime', 'createdTime']).optional().default('modifiedTime').describe('Sort order for results.'),
  }).merge(SharedDriveParameters),
  execute: async (args, { log, session }) => {
    const drive = getDriveClient(session);
    log.info(`Listing Google Sheets. Query: ${args.query || 'none'}, Max: ${args.maxResults}, Order: ${args.orderBy}`);

    try {
      let queryString = "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false";
      if (args.query) {
        queryString += ` and (name contains '${args.query}' or fullText contains '${args.query}')`;
      }

      const sharedDriveParams = buildSharedDriveParams(args);
      const response = await drive.files.list({
        q: queryString,
        pageSize: args.maxResults,
        orderBy: args.orderBy === 'name' ? 'name' : args.orderBy,
        fields: 'files(id,name,modifiedTime,createdTime,size,webViewLink,owners(displayName,emailAddress),driveId)',
        ...sharedDriveParams,
      });

      const files = response.data.files || [];

      if (files.length === 0) {
        return "No Google Spreadsheets found matching your criteria.";
      }

      let result = `Found ${files.length} Google Spreadsheet(s):\n\n`;
      files.forEach((file, index) => {
        const modifiedDate = file.modifiedTime ? new Date(file.modifiedTime).toLocaleDateString() : 'Unknown';
        const owner = file.owners?.[0]?.displayName || 'Unknown';
        const driveInfo = file.driveId ? ` (Shared Drive)` : '';
        result += `${index + 1}. **${file.name}**${driveInfo}\n`;
        result += `   ID: ${file.id}\n`;
        result += `   Modified: ${modifiedDate}\n`;
        result += `   Owner: ${owner}\n`;
        if (file.driveId) {
          result += `   Drive ID: ${file.driveId}\n`;
        }
        result += `   Link: ${file.webViewLink}\n\n`;
      });

      return result;
    } catch (error: any) {
      log.error(`Error listing Google Sheets: ${error.message || error}`);
      if (error.code === 403) throw new UserError("Permission denied. Make sure you have granted Google Drive access to the application.");
      throw new UserError(`Failed to list spreadsheets: ${error.message || 'Unknown error'}`);
    }
  }
});

sheetsServer.addTool({
  name: 'findRowByValue',
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
  description: 'Find a row by searching a column for a value, then update a specific field (identified by header name) in that row.',
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
  description: 'Apply multiple formatting operations to a Google Spreadsheet in a single atomic batch. Supports number formats, text styling, background colors, borders, freezing, conditional formatting, cell merging, and column/row sizing.',
  parameters: z.object({
    spreadsheetId: z.string().describe('The ID of the Google Spreadsheet (from the URL).'),
    operations: z.array(BatchUpdateOperationSchema).min(1).describe('Array of formatting operations to apply atomically.'),
  }),
  execute: async (args, { log, session }) => {
    const sheets = getSheetsClient(session);
    log.info(`batchUpdateSpreadsheet: ${args.operations.length} ops on ${args.spreadsheetId}`);

    try {
      const metadata = await SheetsHelpers.getSpreadsheetMetadata(sheets, args.spreadsheetId);

      const requests: sheets_v4.Schema$Request[] = [];
      const summaries: string[] = [];
      args.operations.forEach((op, i) => {
        try {
          requests.push(operationToRequest(op, metadata));
          const target = 'range' in op ? op.range : ('sheetName' in op && op.sheetName) ? op.sheetName : '(first sheet)';
          summaries.push(`  ${i}. ${op.type} → ${target}`);
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

      const applied = response.data.replies?.length ?? requests.length;
      const title = metadata.properties?.title ?? args.spreadsheetId;
      return `Applied ${applied} operation(s) to "${title}".\n${summaries.join('\n')}`;
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

export { sheetsServer };
