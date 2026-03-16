// src/googleSheetsApiHelpers.ts
import { google, sheets_v4 } from 'googleapis';
import { UserError } from 'fastmcp';

type Sheets = sheets_v4.Sheets; // Alias for convenience

// --- Core Helper Functions ---

/**
 * Converts A1 notation to row/column indices (0-based)
 * Example: "A1" -> {row: 0, col: 0}, "B2" -> {row: 1, col: 1}
 */
export function a1ToRowCol(a1: string): { row: number; col: number } {
  const match = a1.match(/^([A-Z]+)(\d+)$/i);
  if (!match) {
    throw new UserError(`Invalid A1 notation: ${a1}. Expected format like "A1" or "B2"`);
  }

  const colStr = match[1].toUpperCase();
  const row = parseInt(match[2], 10) - 1; // Convert to 0-based

  let col = 0;
  for (let i = 0; i < colStr.length; i++) {
    col = col * 26 + (colStr.charCodeAt(i) - 64);
  }
  col -= 1; // Convert to 0-based

  return { row, col };
}

/**
 * Converts row/column indices (0-based) to A1 notation
 * Example: {row: 0, col: 0} -> "A1", {row: 1, col: 1} -> "B2"
 */
export function rowColToA1(row: number, col: number): string {
  if (row < 0 || col < 0) {
    throw new UserError(`Row and column indices must be non-negative. Got row: ${row}, col: ${col}`);
  }

  let colStr = '';
  let colNum = col + 1; // Convert to 1-based for calculation
  while (colNum > 0) {
    colNum -= 1;
    colStr = String.fromCharCode(65 + (colNum % 26)) + colStr;
    colNum = Math.floor(colNum / 26);
  }

  return `${colStr}${row + 1}`;
}

/**
 * Validates and normalizes a range string
 * Examples: "A1" -> "Sheet1!A1", "A1:B2" -> "Sheet1!A1:B2"
 */
export function normalizeRange(range: string, sheetName?: string): string {
  // If range already contains '!', assume it's already normalized
  if (range.includes('!')) {
    return range;
  }

  // If sheetName is provided, prepend it
  if (sheetName) {
    return `${sheetName}!${range}`;
  }

  // Default to Sheet1 if no sheet name provided
  return `Sheet1!${range}`;
}

/**
 * Reads values from a spreadsheet range
 */
export async function readRange(
  sheets: Sheets,
  spreadsheetId: string,
  range: string
): Promise<sheets_v4.Schema$ValueRange> {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });
    return response.data;
  } catch (error: any) {
    if (error.code === 404) {
      throw new UserError(`Spreadsheet not found (ID: ${spreadsheetId}). Check the ID.`);
    }
    if (error.code === 403) {
      throw new UserError(`Permission denied for spreadsheet (ID: ${spreadsheetId}). Ensure you have read access.`);
    }
    throw new UserError(`Failed to read range: ${error.message || 'Unknown error'}`);
  }
}

/**
 * Writes values to a spreadsheet range
 */
export async function writeRange(
  sheets: Sheets,
  spreadsheetId: string,
  range: string,
  values: any[][],
  valueInputOption: 'RAW' | 'USER_ENTERED' = 'USER_ENTERED'
): Promise<sheets_v4.Schema$UpdateValuesResponse> {
  try {
    const response = await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption,
      requestBody: {
        values,
      },
    });
    return response.data;
  } catch (error: any) {
    if (error.code === 404) {
      throw new UserError(`Spreadsheet not found (ID: ${spreadsheetId}). Check the ID.`);
    }
    if (error.code === 403) {
      throw new UserError(`Permission denied for spreadsheet (ID: ${spreadsheetId}). Ensure you have write access.`);
    }
    throw new UserError(`Failed to write range: ${error.message || 'Unknown error'}`);
  }
}

/**
 * Appends values to the end of a sheet
 */
export async function appendValues(
  sheets: Sheets,
  spreadsheetId: string,
  range: string,
  values: any[][],
  valueInputOption: 'RAW' | 'USER_ENTERED' = 'USER_ENTERED'
): Promise<sheets_v4.Schema$AppendValuesResponse> {
  try {
    const response = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption,
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values,
      },
    });
    return response.data;
  } catch (error: any) {
    if (error.code === 404) {
      throw new UserError(`Spreadsheet not found (ID: ${spreadsheetId}). Check the ID.`);
    }
    if (error.code === 403) {
      throw new UserError(`Permission denied for spreadsheet (ID: ${spreadsheetId}). Ensure you have write access.`);
    }
    throw new UserError(`Failed to append values: ${error.message || 'Unknown error'}`);
  }
}

/**
 * Clears values from a range
 */
export async function clearRange(
  sheets: Sheets,
  spreadsheetId: string,
  range: string
): Promise<sheets_v4.Schema$ClearValuesResponse> {
  try {
    const response = await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range,
    });
    return response.data;
  } catch (error: any) {
    if (error.code === 404) {
      throw new UserError(`Spreadsheet not found (ID: ${spreadsheetId}). Check the ID.`);
    }
    if (error.code === 403) {
      throw new UserError(`Permission denied for spreadsheet (ID: ${spreadsheetId}). Ensure you have write access.`);
    }
    throw new UserError(`Failed to clear range: ${error.message || 'Unknown error'}`);
  }
}

/**
 * Gets spreadsheet metadata including sheet information
 */
export async function getSpreadsheetMetadata(
  sheets: Sheets,
  spreadsheetId: string
): Promise<sheets_v4.Schema$Spreadsheet> {
  try {
    const response = await sheets.spreadsheets.get({
      spreadsheetId,
      includeGridData: false,
    });
    return response.data;
  } catch (error: any) {
    if (error.code === 404) {
      throw new UserError(`Spreadsheet not found (ID: ${spreadsheetId}). Check the ID.`);
    }
    if (error.code === 403) {
      throw new UserError(`Permission denied for spreadsheet (ID: ${spreadsheetId}). Ensure you have read access.`);
    }
    throw new UserError(`Failed to get spreadsheet metadata: ${error.message || 'Unknown error'}`);
  }
}

/**
 * Creates a new sheet/tab in a spreadsheet
 */
export async function addSheet(
  sheets: Sheets,
  spreadsheetId: string,
  sheetTitle: string
): Promise<sheets_v4.Schema$BatchUpdateSpreadsheetResponse> {
  try {
    const response = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: sheetTitle,
              },
            },
          },
        ],
      },
    });
    return response.data;
  } catch (error: any) {
    if (error.code === 404) {
      throw new UserError(`Spreadsheet not found (ID: ${spreadsheetId}). Check the ID.`);
    }
    if (error.code === 403) {
      throw new UserError(`Permission denied for spreadsheet (ID: ${spreadsheetId}). Ensure you have write access.`);
    }
    throw new UserError(`Failed to add sheet: ${error.message || 'Unknown error'}`);
  }
}

/**
 * Parses A1 notation range to extract sheet name and cell range
 * Returns {sheetName, a1Range} where a1Range is just the cell part (e.g., "A1:B2")
 */
function parseRange(range: string): { sheetName: string | null; a1Range: string } {
  if (range.includes('!')) {
    const parts = range.split('!');
    return {
      sheetName: parts[0].replace(/^'|'$/g, ''), // Remove quotes if present
      a1Range: parts[1],
    };
  }
  return {
    sheetName: null,
    a1Range: range,
  };
}

/**
 * Formats cells in a range
 * Note: This function requires the sheetId. For simplicity, we'll get it from the spreadsheet metadata.
 */
export async function formatCells(
  sheets: Sheets,
  spreadsheetId: string,
  range: string,
  format: {
    backgroundColor?: { red: number; green: number; blue: number };
    textFormat?: {
      foregroundColor?: { red: number; green: number; blue: number };
      fontSize?: number;
      bold?: boolean;
      italic?: boolean;
    };
    horizontalAlignment?: 'LEFT' | 'CENTER' | 'RIGHT';
    verticalAlignment?: 'TOP' | 'MIDDLE' | 'BOTTOM';
  }
): Promise<sheets_v4.Schema$BatchUpdateSpreadsheetResponse> {
  try {
    // Parse the range to get sheet name and cell range
    const { sheetName, a1Range } = parseRange(range);

    // Get spreadsheet metadata to find sheetId
    const metadata = await getSpreadsheetMetadata(sheets, spreadsheetId);
    let sheetId: number | undefined;

    if (sheetName) {
      // Find the sheet by name
      const sheet = metadata.sheets?.find(s => s.properties?.title === sheetName);
      if (!sheet || !sheet.properties?.sheetId) {
        throw new UserError(`Sheet "${sheetName}" not found in spreadsheet.`);
      }
      sheetId = sheet.properties.sheetId;
    } else {
      // Use the first sheet
      const firstSheet = metadata.sheets?.[0];
      if (!firstSheet?.properties?.sheetId) {
        throw new UserError('Spreadsheet has no sheets.');
      }
      sheetId = firstSheet.properties.sheetId;
    }

    if (sheetId === undefined) {
      throw new UserError('Could not determine sheet ID.');
    }

    // Parse A1 range to get row/column indices
    const rangeMatch = a1Range.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i);
    if (!rangeMatch) {
      throw new UserError(`Invalid range format: ${a1Range}. Expected format like "A1" or "A1:B2"`);
    }

    const startCol = rangeMatch[1].toUpperCase();
    const startRow = parseInt(rangeMatch[2], 10) - 1; // Convert to 0-based
    const endCol = rangeMatch[3] ? rangeMatch[3].toUpperCase() : startCol;
    const endRow = rangeMatch[4] ? parseInt(rangeMatch[4], 10) - 1 : startRow; // Convert to 0-based

    // Convert column letters to 0-based indices
    function colToIndex(col: string): number {
      let index = 0;
      for (let i = 0; i < col.length; i++) {
        index = index * 26 + (col.charCodeAt(i) - 64);
      }
      return index - 1;
    }

    const startColIndex = colToIndex(startCol);
    const endColIndex = colToIndex(endCol);

    const userEnteredFormat: sheets_v4.Schema$CellFormat = {};

    if (format.backgroundColor) {
      userEnteredFormat.backgroundColor = {
        red: format.backgroundColor.red,
        green: format.backgroundColor.green,
        blue: format.backgroundColor.blue,
        alpha: 1,
      };
    }

    if (format.textFormat) {
      userEnteredFormat.textFormat = {};
      if (format.textFormat.foregroundColor) {
        userEnteredFormat.textFormat.foregroundColor = {
          red: format.textFormat.foregroundColor.red,
          green: format.textFormat.foregroundColor.green,
          blue: format.textFormat.foregroundColor.blue,
          alpha: 1,
        };
      }
      if (format.textFormat.fontSize !== undefined) {
        userEnteredFormat.textFormat.fontSize = format.textFormat.fontSize;
      }
      if (format.textFormat.bold !== undefined) {
        userEnteredFormat.textFormat.bold = format.textFormat.bold;
      }
      if (format.textFormat.italic !== undefined) {
        userEnteredFormat.textFormat.italic = format.textFormat.italic;
      }
    }

    if (format.horizontalAlignment) {
      userEnteredFormat.horizontalAlignment = format.horizontalAlignment;
    }

    if (format.verticalAlignment) {
      userEnteredFormat.verticalAlignment = format.verticalAlignment;
    }

    const response = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: {
                sheetId: sheetId,
                startRowIndex: startRow,
                endRowIndex: endRow + 1, // endRowIndex is exclusive
                startColumnIndex: startColIndex,
                endColumnIndex: endColIndex + 1, // endColumnIndex is exclusive
              },
              cell: {
                userEnteredFormat,
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)',
            },
          },
        ],
      },
    });

    return response.data;
  } catch (error: any) {
    if (error.code === 404) {
      throw new UserError(`Spreadsheet not found (ID: ${spreadsheetId}). Check the ID.`);
    }
    if (error.code === 403) {
      throw new UserError(`Permission denied for spreadsheet (ID: ${spreadsheetId}). Ensure you have write access.`);
    }
    if (error instanceof UserError) throw error;
    throw new UserError(`Failed to format cells: ${error.message || 'Unknown error'}`);
  }
}

/**
 * Helper to convert hex color to RGB (0-1 range)
 */
/**
 * Converts a 0-based column index to a column letter (0→A, 25→Z, 26→AA)
 */
export function columnIndexToLetter(index: number): string {
  let colStr = '';
  let colNum = index + 1;
  while (colNum > 0) {
    colNum -= 1;
    colStr = String.fromCharCode(65 + (colNum % 26)) + colStr;
    colNum = Math.floor(colNum / 26);
  }
  return colStr;
}

/**
 * Finds the 1-based row number of the first row where searchColumn contains searchValue.
 * Returns null if not found.
 */
export async function findRowByValue(
  sheets: Sheets,
  spreadsheetId: string,
  searchColumn: string,
  searchValue: string,
  sheetName?: string
): Promise<number | null> {
  const range = sheetName
    ? `${sheetName}!${searchColumn}:${searchColumn}`
    : `${searchColumn}:${searchColumn}`;

  const data = await readRange(sheets, spreadsheetId, range);
  const rows = data.values || [];

  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] !== undefined && String(rows[i][0]) === searchValue) {
      return i + 1; // 1-based row number
    }
  }
  return null;
}

/**
 * Reads row 1 to get column headers.
 */
export async function getHeaders(
  sheets: Sheets,
  spreadsheetId: string,
  sheetName?: string
): Promise<string[]> {
  const range = sheetName ? `${sheetName}!1:1` : '1:1';
  const data = await readRange(sheets, spreadsheetId, range);
  return (data.values?.[0] || []).map(String);
}

/**
 * Reads a single row by 1-based row number.
 */
export async function getRowValues(
  sheets: Sheets,
  spreadsheetId: string,
  rowNumber: number,
  sheetName?: string
): Promise<any[]> {
  const range = sheetName ? `${sheetName}!${rowNumber}:${rowNumber}` : `${rowNumber}:${rowNumber}`;
  const data = await readRange(sheets, spreadsheetId, range);
  return data.values?.[0] || [];
}

export function hexToRgb(hex: string): { red: number; green: number; blue: number } | null {
  if (!hex) return null;
  let hexClean = hex.startsWith('#') ? hex.slice(1) : hex;

  if (hexClean.length === 3) {
    hexClean = hexClean[0] + hexClean[0] + hexClean[1] + hexClean[1] + hexClean[2] + hexClean[2];
  }
  if (hexClean.length !== 6) return null;
  const bigint = parseInt(hexClean, 16);
  if (isNaN(bigint)) return null;

  return {
    red: ((bigint >> 16) & 255) / 255,
    green: ((bigint >> 8) & 255) / 255,
    blue: (bigint & 255) / 255,
  };
}

