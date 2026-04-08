// src/google-sheets/formatHelpers.ts
import { sheets_v4 } from 'googleapis';
import { UserError } from 'fastmcp';

import type { BatchUpdateOperation } from '../types.js';
import { a1RangeToGridRange, resolveSheetId, hexToRgb } from './apiHelpers.js';

type Request = sheets_v4.Schema$Request;
type Color = sheets_v4.Schema$Color;

function toColor(hex: string): Color {
  const rgb = hexToRgb(hex);
  if (!rgb) throw new UserError(`Invalid hex color: ${hex}`);
  return { ...rgb, alpha: 1 };
}

// Default patterns per format type. CURRENCY is intentionally omitted so the
// spreadsheet's locale-aware currency formatting is used unless the caller
// passes an explicit pattern (e.g. "€#,##0.00").
const NUMBER_FORMAT_PATTERNS: Record<string, string> = {
  PERCENT: '0.00%',
  NUMBER: '#,##0.00',
  DATE: 'yyyy-mm-dd',
  TIME: 'hh:mm:ss',
  DATE_TIME: 'yyyy-mm-dd hh:mm:ss',
  SCIENTIFIC: '0.00E+00',
  TEXT: '@',
};

/**
 * Mutable state shared across a batch of operations so that conditional-format
 * rules receive monotonically increasing insertion indices (preserving caller
 * order instead of reversing them with a constant index: 0).
 */
export interface BatchState {
  /** Per-sheet next insertion index for addConditionalFormatRule. */
  conditionalFormatNextIndex: Map<number, number>;
}

export function createBatchState(metadata: sheets_v4.Schema$Spreadsheet): BatchState {
  const conditionalFormatNextIndex = new Map<number, number>();
  for (const sheet of metadata.sheets ?? []) {
    const id = sheet.properties?.sheetId;
    if (id != null) {
      conditionalFormatNextIndex.set(id, sheet.conditionalFormats?.length ?? 0);
    }
  }
  return { conditionalFormatNextIndex };
}

/**
 * Translate a single operation into a Google Sheets Request.
 * Pure: no I/O. Throws UserError on invalid input.
 */
export function operationToRequest(
  op: BatchUpdateOperation,
  metadata: sheets_v4.Schema$Spreadsheet,
  state?: BatchState
): Request {
  switch (op.type) {
    case 'numberFormat': {
      const gridRange = a1RangeToGridRange(metadata, op.range);
      const pattern = op.pattern ?? NUMBER_FORMAT_PATTERNS[op.format];
      const numberFormat: sheets_v4.Schema$NumberFormat = { type: op.format };
      if (pattern !== undefined) numberFormat.pattern = pattern;
      return {
        repeatCell: {
          range: gridRange,
          cell: { userEnteredFormat: { numberFormat } },
          fields: 'userEnteredFormat.numberFormat',
        },
      };
    }

    case 'textStyle': {
      const gridRange = a1RangeToGridRange(metadata, op.range);
      const textFormat: sheets_v4.Schema$TextFormat = {};
      const fieldParts: string[] = [];
      if (op.bold !== undefined) { textFormat.bold = op.bold; fieldParts.push('bold'); }
      if (op.italic !== undefined) { textFormat.italic = op.italic; fieldParts.push('italic'); }
      if (op.underline !== undefined) { textFormat.underline = op.underline; fieldParts.push('underline'); }
      if (op.strikethrough !== undefined) { textFormat.strikethrough = op.strikethrough; fieldParts.push('strikethrough'); }
      if (op.fontFamily !== undefined) { textFormat.fontFamily = op.fontFamily; fieldParts.push('fontFamily'); }
      if (op.fontSize !== undefined) { textFormat.fontSize = op.fontSize; fieldParts.push('fontSize'); }
      if (op.foregroundColor !== undefined) {
        textFormat.foregroundColor = toColor(op.foregroundColor);
        fieldParts.push('foregroundColor');
      }
      if (fieldParts.length === 0) {
        throw new UserError('textStyle operation requires at least one style property.');
      }
      const fields = fieldParts.map(f => `userEnteredFormat.textFormat.${f}`).join(',');
      return {
        repeatCell: {
          range: gridRange,
          cell: { userEnteredFormat: { textFormat } },
          fields,
        },
      };
    }

    case 'backgroundColor': {
      const gridRange = a1RangeToGridRange(metadata, op.range);
      return {
        repeatCell: {
          range: gridRange,
          cell: { userEnteredFormat: { backgroundColor: toColor(op.color) } },
          fields: 'userEnteredFormat.backgroundColor',
        },
      };
    }

    case 'borders': {
      const gridRange = a1RangeToGridRange(metadata, op.range);
      const style = op.style ?? 'SOLID';
      const color = op.color ? toColor(op.color) : toColor('#000000');
      const border: sheets_v4.Schema$Border = { style, color };
      const req: sheets_v4.Schema$UpdateBordersRequest = { range: gridRange };
      if (op.top) req.top = border;
      if (op.bottom) req.bottom = border;
      if (op.left) req.left = border;
      if (op.right) req.right = border;
      if (op.innerHorizontal) req.innerHorizontal = border;
      if (op.innerVertical) req.innerVertical = border;
      if (!op.top && !op.bottom && !op.left && !op.right && !op.innerHorizontal && !op.innerVertical) {
        // Default: apply all outer borders
        req.top = border;
        req.bottom = border;
        req.left = border;
        req.right = border;
      }
      return { updateBorders: req };
    }

    case 'freeze': {
      const sheetId = resolveSheetId(metadata, op.sheetName);
      const gridProperties: sheets_v4.Schema$GridProperties = {};
      const fields: string[] = [];
      if (op.frozenRowCount !== undefined) {
        gridProperties.frozenRowCount = op.frozenRowCount;
        fields.push('gridProperties.frozenRowCount');
      }
      if (op.frozenColumnCount !== undefined) {
        gridProperties.frozenColumnCount = op.frozenColumnCount;
        fields.push('gridProperties.frozenColumnCount');
      }
      if (fields.length === 0) {
        throw new UserError('freeze operation requires frozenRowCount and/or frozenColumnCount.');
      }
      return {
        updateSheetProperties: {
          properties: { sheetId, gridProperties },
          fields: fields.join(','),
        },
      };
    }

    case 'conditionalFormat': {
      const gridRange = a1RangeToGridRange(metadata, op.range);
      // Compute per-sheet insertion index so rules preserve caller order.
      const sheetId = gridRange.sheetId!;
      let ruleIndex = 0;
      if (state) {
        ruleIndex = state.conditionalFormatNextIndex.get(sheetId) ?? 0;
        state.conditionalFormatNextIndex.set(sheetId, ruleIndex + 1);
      }
      if (op.rule.kind === 'boolean') {
        const r = op.rule;
        const condValues: sheets_v4.Schema$ConditionValue[] = [];
        if (r.value !== undefined) condValues.push({ userEnteredValue: String(r.value) });
        if (r.value2 !== undefined) condValues.push({ userEnteredValue: String(r.value2) });
        const format: sheets_v4.Schema$CellFormat = {};
        if (r.backgroundColor) format.backgroundColor = toColor(r.backgroundColor);
        const textFormat: sheets_v4.Schema$TextFormat = {};
        if (r.textColor) textFormat.foregroundColor = toColor(r.textColor);
        if (r.bold !== undefined) textFormat.bold = r.bold;
        if (r.italic !== undefined) textFormat.italic = r.italic;
        if (Object.keys(textFormat).length > 0) format.textFormat = textFormat;
        return {
          addConditionalFormatRule: {
            rule: {
              ranges: [gridRange],
              booleanRule: {
                condition: { type: r.condition, values: condValues.length > 0 ? condValues : undefined },
                format,
              },
            },
            index: ruleIndex,
          },
        };
      } else {
        const r = op.rule;
        const gradientRule: sheets_v4.Schema$GradientRule = {
          minpoint: { color: toColor(r.minColor), type: 'MIN' },
          maxpoint: { color: toColor(r.maxColor), type: 'MAX' },
        };
        if (r.midColor) {
          gradientRule.midpoint = { color: toColor(r.midColor), type: 'PERCENTILE', value: '50' };
        }
        return {
          addConditionalFormatRule: {
            rule: { ranges: [gridRange], gradientRule },
            index: ruleIndex,
          },
        };
      }
    }

    case 'mergeCells': {
      const gridRange = a1RangeToGridRange(metadata, op.range);
      return {
        mergeCells: {
          range: gridRange,
          mergeType: op.mergeType ?? 'MERGE_ALL',
        },
      };
    }

    case 'unmergeCells': {
      const gridRange = a1RangeToGridRange(metadata, op.range);
      return { unmergeCells: { range: gridRange } };
    }

    case 'columnWidth': {
      const sheetId = resolveSheetId(metadata, op.sheetName);
      if (op.endColumn < op.startColumn) {
        throw new UserError('columnWidth: endColumn must be >= startColumn.');
      }
      return {
        updateDimensionProperties: {
          range: {
            sheetId,
            dimension: 'COLUMNS',
            startIndex: op.startColumn - 1,
            endIndex: op.endColumn,
          },
          properties: { pixelSize: op.pixels },
          fields: 'pixelSize',
        },
      };
    }

    case 'rowHeight': {
      const sheetId = resolveSheetId(metadata, op.sheetName);
      if (op.endRow < op.startRow) {
        throw new UserError('rowHeight: endRow must be >= startRow.');
      }
      return {
        updateDimensionProperties: {
          range: {
            sheetId,
            dimension: 'ROWS',
            startIndex: op.startRow - 1,
            endIndex: op.endRow,
          },
          properties: { pixelSize: op.pixels },
          fields: 'pixelSize',
        },
      };
    }
  }
}
