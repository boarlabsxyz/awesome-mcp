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

    case 'updateSheetProperties': {
      const sheetId = resolveSheetId(metadata, op.sheetName);
      const properties: sheets_v4.Schema$SheetProperties = { sheetId };
      const fields: string[] = [];
      if (op.title !== undefined) {
        properties.title = op.title;
        fields.push('title');
      }
      if (op.index !== undefined) {
        properties.index = op.index;
        fields.push('index');
      }
      if (op.hidden !== undefined) {
        properties.hidden = op.hidden;
        fields.push('hidden');
      }
      if (op.tabColor !== undefined) {
        properties.tabColorStyle = { rgbColor: toColor(op.tabColor) };
        fields.push('tabColorStyle');
      }
      if (fields.length === 0) {
        throw new UserError('updateSheetProperties requires at least one of: title, index, hidden, tabColor.');
      }
      return {
        updateSheetProperties: {
          properties,
          fields: fields.join(','),
        },
      };
    }

    case 'deleteSheet': {
      const sheetId = resolveSheetId(metadata, op.sheetName);
      return { deleteSheet: { sheetId } };
    }

    case 'duplicateSheet': {
      const sourceSheetId = resolveSheetId(metadata, op.sourceSheetName);
      const req: sheets_v4.Schema$DuplicateSheetRequest = { sourceSheetId };
      if (op.newSheetName !== undefined) req.newSheetName = op.newSheetName;
      if (op.insertIndex !== undefined) req.insertSheetIndex = op.insertIndex;
      return { duplicateSheet: req };
    }

    case 'addSheet': {
      const properties: sheets_v4.Schema$SheetProperties = { title: op.title };
      if (op.index !== undefined) properties.index = op.index;
      // Sizing the tab at creation is the ONLY way to get a tall new tab in one
      // request: a sheet added in this batch has no sheetId yet, so an
      // appendDimension later in the same batch cannot resolve it by name.
      if (op.rowCount !== undefined || op.columnCount !== undefined) {
        const gridProperties: sheets_v4.Schema$GridProperties = {};
        if (op.rowCount !== undefined) gridProperties.rowCount = op.rowCount;
        if (op.columnCount !== undefined) gridProperties.columnCount = op.columnCount;
        properties.gridProperties = gridProperties;
      }
      return { addSheet: { properties } };
    }

    case 'appendDimension': {
      const sheetId = resolveSheetId(metadata, op.sheetName);
      return {
        appendDimension: {
          sheetId,
          dimension: op.dimension,
          length: op.length,
        },
      };
    }

    case 'alignment': {
      const gridRange = a1RangeToGridRange(metadata, op.range);
      const format: sheets_v4.Schema$CellFormat = {};
      const fields: string[] = [];
      if (op.horizontalAlignment !== undefined) { format.horizontalAlignment = op.horizontalAlignment; fields.push('horizontalAlignment'); }
      if (op.verticalAlignment !== undefined) { format.verticalAlignment = op.verticalAlignment; fields.push('verticalAlignment'); }
      if (op.wrapStrategy !== undefined) { format.wrapStrategy = op.wrapStrategy; fields.push('wrapStrategy'); }
      if (fields.length === 0) {
        throw new UserError('alignment operation requires at least one of horizontalAlignment, verticalAlignment, wrapStrategy.');
      }
      // One mask entry per property named, so the rest of the cell format
      // (number format, colours, fonts) is left as it was.
      return {
        repeatCell: {
          range: gridRange,
          cell: { userEnteredFormat: format },
          fields: fields.map((f) => `userEnteredFormat.${f}`).join(','),
        },
      };
    }

    case 'dataValidation': {
      const gridRange = a1RangeToGridRange(metadata, op.range);
      if (op.rule.kind === 'clear') return { setDataValidation: { range: gridRange } };
      return {
        setDataValidation: {
          range: gridRange,
          rule: {
            condition: validationCondition(op.rule),
            strict: op.strict ?? true,
            showCustomUi: op.rule.kind === 'dropdown' || op.rule.kind === 'dropdownFromRange',
            ...(op.inputMessage ? { inputMessage: op.inputMessage } : {}),
          },
        },
      };
    }

    case 'addChart':
      return { addChart: { chart: chartSpec(op, metadata) } };

    case 'insertDimension': {
      const sheetId = resolveSheetId(metadata, op.sheetName);
      if (op.endIndex < op.startIndex) {
        throw new UserError('insertDimension: endIndex must be >= startIndex.');
      }
      // Google rejects inheritFromBefore at startIndex 0 with a bare
      // "invalid request"; refusing it here names the reason, and the
      // operation's index is added by the caller.
      if (op.inheritFromBefore && op.startIndex === 1) {
        throw new UserError('insertDimension: inheritFromBefore cannot be true when startIndex is 1 — there is no row/column before the first one to inherit from.');
      }
      const req: sheets_v4.Schema$InsertDimensionRequest = {
        range: {
          sheetId,
          dimension: op.dimension,
          startIndex: op.startIndex - 1,
          endIndex: op.endIndex,
        },
      };
      if (op.inheritFromBefore !== undefined) req.inheritFromBefore = op.inheritFromBefore;
      return { insertDimension: req };
    }
  }
}

type DataValidationRule = Extract<BatchUpdateOperation, { type: 'dataValidation' }>['rule'];

function validationCondition(rule: Exclude<DataValidationRule, { kind: 'clear' }>): sheets_v4.Schema$BooleanCondition {
  switch (rule.kind) {
    case 'dropdown':
      return { type: 'ONE_OF_LIST', values: rule.values.map((userEnteredValue) => ({ userEnteredValue })) };
    case 'dropdownFromRange': {
      // ONE_OF_RANGE takes the range as a formula string.
      const source = rule.sourceRange.startsWith('=') ? rule.sourceRange : `=${rule.sourceRange}`;
      return { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: source }] };
    }
    case 'checkbox':
      if (rule.uncheckedValue !== undefined && rule.checkedValue === undefined) {
        throw new UserError('checkbox: uncheckedValue needs checkedValue as well.');
      }
      return rule.checkedValue === undefined
        ? { type: 'BOOLEAN' }
        : {
          type: 'BOOLEAN',
          values: [rule.checkedValue, ...(rule.uncheckedValue !== undefined ? [rule.uncheckedValue] : [])]
            .map((userEnteredValue) => ({ userEnteredValue })),
        };
    case 'number': {
      const between = rule.condition === 'NUMBER_BETWEEN' || rule.condition === 'NUMBER_NOT_BETWEEN';
      if (between && rule.value2 === undefined) throw new UserError(`${rule.condition} needs value2.`);
      if (!between && rule.value2 !== undefined) throw new UserError(`${rule.condition} does not take value2.`);
      const values = between ? [rule.value, rule.value2!] : [rule.value];
      return { type: rule.condition, values: values.map((v) => ({ userEnteredValue: String(v) })) };
    }
    case 'customFormula':
      return { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: rule.formula }] };
  }
}

type AddChartOperation = Extract<BatchUpdateOperation, { type: 'addChart' }>;

/**
 * A chart over a block with a header row: first column the categories, each
 * further column one series. Needs bounded columns, because each series is
 * addressed by its own column.
 */
function chartSpec(op: AddChartOperation, metadata: sheets_v4.Schema$Spreadsheet): sheets_v4.Schema$EmbeddedChart {
  const source = a1RangeToGridRange(metadata, op.sourceRange);
  const firstCol = source.startColumnIndex;
  const endCol = source.endColumnIndex;
  if (firstCol == null || endCol == null) {
    throw new UserError(`addChart: sourceRange "${op.sourceRange}" needs explicit columns, e.g. "Sheet1!A1:C20".`);
  }
  const columnCount = endCol - firstCol;
  if (columnCount < 2) throw new UserError('addChart: sourceRange needs a category column and at least one data column.');
  if (op.chartType === 'PIE' && columnCount !== 2) {
    throw new UserError('addChart: a PIE chart takes exactly two columns (labels, values).');
  }
  const column = (index: number): sheets_v4.Schema$ChartData => ({
    sourceRange: { sources: [{ ...source, startColumnIndex: index, endColumnIndex: index + 1 }] },
  });

  const spec: sheets_v4.Schema$ChartSpec = { ...(op.title ? { title: op.title } : {}) };
  if (op.chartType === 'PIE') {
    spec.pieChart = { domain: column(firstCol), series: column(firstCol + 1), legendPosition: op.legendPosition ?? 'BOTTOM_LEGEND' };
  } else {
    spec.basicChart = {
      chartType: op.chartType,
      legendPosition: op.legendPosition ?? 'BOTTOM_LEGEND',
      headerCount: 1,
      domains: [{ domain: column(firstCol) }],
      series: Array.from({ length: columnCount - 1 }, (_, i) => ({
        series: column(firstCol + 1 + i),
        // BAR draws horizontally, so its values run along the bottom axis.
        targetAxis: op.chartType === 'BAR' ? 'BOTTOM_AXIS' : 'LEFT_AXIS',
      })),
    };
  }

  let position: sheets_v4.Schema$EmbeddedObjectPosition;
  if (op.newSheet) {
    position = { newSheet: true };
  } else if (op.anchorCell) {
    const anchor = a1RangeToGridRange(metadata, op.anchorCell);
    position = { overlayPosition: { anchorCell: { sheetId: anchor.sheetId, rowIndex: anchor.startRowIndex ?? 0, columnIndex: anchor.startColumnIndex ?? 0 } } };
  } else {
    position = { overlayPosition: { anchorCell: { sheetId: source.sheetId, rowIndex: source.startRowIndex ?? 0, columnIndex: endCol + 1 } } };
  }
  return { spec, position };
}
