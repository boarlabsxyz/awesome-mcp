// tests/sheetsBatchUpdate.test.js
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  a1RangeToGridRange,
  resolveSheetId,
  parseRange,
} from '../dist/google-sheets/apiHelpers.js';
import {
  operationToRequest,
  createBatchState,
} from '../dist/google-sheets/formatHelpers.js';
import { BatchUpdateOperationSchema } from '../dist/types.js';

// Fake spreadsheet metadata used by the pure helpers.
const metadata = {
  properties: { title: 'Test' },
  sheets: [
    {
      properties: { sheetId: 0, title: 'Sheet1' },
      conditionalFormats: [{}, {}], // 2 existing rules
    },
    {
      properties: { sheetId: 42, title: 'Finance' },
      // no existing conditionalFormats
    },
  ],
};

describe('parseRange', () => {
  it('splits sheet name and a1 portion', () => {
    assert.deepStrictEqual(parseRange('Sheet1!A1:B2'), {
      sheetName: 'Sheet1',
      a1Range: 'A1:B2',
    });
  });

  it('strips surrounding quotes on sheet name', () => {
    assert.deepStrictEqual(parseRange("'My Sheet'!A1"), {
      sheetName: 'My Sheet',
      a1Range: 'A1',
    });
  });

  it('returns null sheetName when none provided', () => {
    assert.deepStrictEqual(parseRange('A1:B2'), {
      sheetName: null,
      a1Range: 'A1:B2',
    });
  });
});

describe('resolveSheetId', () => {
  it('resolves named sheet', () => {
    assert.strictEqual(resolveSheetId(metadata, 'Finance'), 42);
  });

  it('defaults to first sheet when name is null', () => {
    assert.strictEqual(resolveSheetId(metadata, null), 0);
  });

  it('throws on unknown sheet name', () => {
    assert.throws(() => resolveSheetId(metadata, 'Nope'), /not found/);
  });
});

describe('a1RangeToGridRange', () => {
  it('parses a single cell', () => {
    const g = a1RangeToGridRange(metadata, 'Sheet1!B2');
    assert.deepStrictEqual(g, {
      sheetId: 0,
      startRowIndex: 1,
      endRowIndex: 2,
      startColumnIndex: 1,
      endColumnIndex: 2,
    });
  });

  it('parses a full cell range', () => {
    const g = a1RangeToGridRange(metadata, 'Sheet1!A1:C3');
    assert.deepStrictEqual(g, {
      sheetId: 0,
      startRowIndex: 0,
      endRowIndex: 3,
      startColumnIndex: 0,
      endColumnIndex: 3,
    });
  });

  it('parses column-only range (A:C)', () => {
    const g = a1RangeToGridRange(metadata, 'Sheet1!A:C');
    assert.deepStrictEqual(g, {
      sheetId: 0,
      startColumnIndex: 0,
      endColumnIndex: 3,
    });
    assert.strictEqual(g.startRowIndex, undefined);
    assert.strictEqual(g.endRowIndex, undefined);
  });

  it('parses row-only range (1:5)', () => {
    const g = a1RangeToGridRange(metadata, 'Sheet1!1:5');
    assert.deepStrictEqual(g, {
      sheetId: 0,
      startRowIndex: 0,
      endRowIndex: 5,
    });
    assert.strictEqual(g.startColumnIndex, undefined);
    assert.strictEqual(g.endColumnIndex, undefined);
  });

  it('parses half-open range (B2:B)', () => {
    const g = a1RangeToGridRange(metadata, 'Sheet1!B2:B');
    assert.strictEqual(g.sheetId, 0);
    assert.strictEqual(g.startRowIndex, 1);
    assert.strictEqual(g.endRowIndex, undefined);
    assert.strictEqual(g.startColumnIndex, 1);
    assert.strictEqual(g.endColumnIndex, 2);
  });

  it('defaults to first sheet when no sheet name is prefixed', () => {
    const g = a1RangeToGridRange(metadata, 'A1:B2');
    assert.strictEqual(g.sheetId, 0);
  });

  it('throws on malformed a1', () => {
    assert.throws(() => a1RangeToGridRange(metadata, 'Sheet1!???'), /Invalid range/);
  });

  it('throws on reversed row order when both bounds are present', () => {
    assert.throws(() => a1RangeToGridRange(metadata, 'Sheet1!A5:A1'), /order/);
  });
});

describe('operationToRequest', () => {
  it('numberFormat CURRENCY omits pattern (locale-aware)', () => {
    const req = operationToRequest(
      { type: 'numberFormat', range: 'Sheet1!A1:A2', format: 'CURRENCY' },
      metadata
    );
    assert.deepStrictEqual(req.repeatCell.cell.userEnteredFormat.numberFormat, {
      type: 'CURRENCY',
    });
    assert.strictEqual(req.repeatCell.fields, 'userEnteredFormat.numberFormat');
  });

  it('numberFormat PERCENT supplies default pattern', () => {
    const req = operationToRequest(
      { type: 'numberFormat', range: 'Sheet1!A1', format: 'PERCENT' },
      metadata
    );
    assert.strictEqual(
      req.repeatCell.cell.userEnteredFormat.numberFormat.pattern,
      '0.00%'
    );
  });

  it('numberFormat honors explicit caller pattern override', () => {
    const req = operationToRequest(
      {
        type: 'numberFormat',
        range: 'Sheet1!A1',
        format: 'CURRENCY',
        pattern: '"€"#,##0.00',
      },
      metadata
    );
    assert.strictEqual(
      req.repeatCell.cell.userEnteredFormat.numberFormat.pattern,
      '"€"#,##0.00'
    );
  });

  it('textStyle builds fields mask from provided properties only', () => {
    const req = operationToRequest(
      { type: 'textStyle', range: 'Sheet1!A1:B1', bold: true, fontSize: 14 },
      metadata
    );
    const fmt = req.repeatCell.cell.userEnteredFormat.textFormat;
    assert.strictEqual(fmt.bold, true);
    assert.strictEqual(fmt.fontSize, 14);
    assert.strictEqual(fmt.italic, undefined);
    assert.strictEqual(
      req.repeatCell.fields,
      'userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.fontSize'
    );
  });

  it('textStyle throws when no style property supplied', () => {
    assert.throws(
      () => operationToRequest({ type: 'textStyle', range: 'Sheet1!A1' }, metadata),
      /at least one style/
    );
  });

  it('backgroundColor converts hex to 0..1 rgb', () => {
    const req = operationToRequest(
      { type: 'backgroundColor', range: 'Sheet1!A1', color: '#FF0000' },
      metadata
    );
    const bg = req.repeatCell.cell.userEnteredFormat.backgroundColor;
    assert.strictEqual(bg.red, 1);
    assert.strictEqual(bg.green, 0);
    assert.strictEqual(bg.blue, 0);
  });

  it('borders defaults to outer borders when no sides specified', () => {
    const req = operationToRequest(
      { type: 'borders', range: 'Sheet1!A1:B2' },
      metadata
    );
    assert.ok(req.updateBorders.top);
    assert.ok(req.updateBorders.bottom);
    assert.ok(req.updateBorders.left);
    assert.ok(req.updateBorders.right);
    assert.strictEqual(req.updateBorders.innerHorizontal, undefined);
  });

  it('freeze produces updateSheetProperties with correct fields mask', () => {
    const req = operationToRequest(
      { type: 'freeze', sheetName: 'Finance', frozenRowCount: 1 },
      metadata
    );
    assert.strictEqual(req.updateSheetProperties.properties.sheetId, 42);
    assert.strictEqual(
      req.updateSheetProperties.properties.gridProperties.frozenRowCount,
      1
    );
    assert.strictEqual(
      req.updateSheetProperties.fields,
      'gridProperties.frozenRowCount'
    );
  });

  it('freeze throws when nothing to set', () => {
    assert.throws(
      () => operationToRequest({ type: 'freeze' }, metadata),
      /frozenRowCount/
    );
  });

  it('mergeCells defaults to MERGE_ALL', () => {
    const req = operationToRequest(
      { type: 'mergeCells', range: 'Sheet1!A1:C1' },
      metadata
    );
    assert.strictEqual(req.mergeCells.mergeType, 'MERGE_ALL');
  });

  it('unmergeCells builds correct request', () => {
    const req = operationToRequest(
      { type: 'unmergeCells', range: 'Sheet1!A1:C1' },
      metadata
    );
    assert.ok(req.unmergeCells.range);
  });

  it('columnWidth maps 1-based columns to 0-based COLUMNS range', () => {
    const req = operationToRequest(
      { type: 'columnWidth', startColumn: 2, endColumn: 4, pixels: 120 },
      metadata
    );
    const d = req.updateDimensionProperties;
    assert.strictEqual(d.range.dimension, 'COLUMNS');
    assert.strictEqual(d.range.startIndex, 1);
    assert.strictEqual(d.range.endIndex, 4);
    assert.strictEqual(d.properties.pixelSize, 120);
  });

  it('rowHeight throws when endRow < startRow', () => {
    assert.throws(
      () =>
        operationToRequest(
          { type: 'rowHeight', startRow: 5, endRow: 2, pixels: 30 },
          metadata
        ),
      /endRow/
    );
  });
});

describe('conditionalFormat indices (createBatchState)', () => {
  it('seeds per-sheet counter from existing rules and increments in order', () => {
    const state = createBatchState(metadata);

    const r1 = operationToRequest(
      {
        type: 'conditionalFormat',
        range: 'Sheet1!A1:A10',
        rule: { kind: 'boolean', condition: 'NUMBER_LESS', value: 0, backgroundColor: '#FFCCCC' },
      },
      metadata,
      state
    );
    const r2 = operationToRequest(
      {
        type: 'conditionalFormat',
        range: 'Sheet1!A1:A10',
        rule: { kind: 'boolean', condition: 'NUMBER_GREATER', value: 0, backgroundColor: '#CCFFCC' },
      },
      metadata,
      state
    );
    const r3 = operationToRequest(
      {
        type: 'conditionalFormat',
        range: 'Finance!B2:B5',
        rule: { kind: 'gradient', minColor: '#FFFFFF', maxColor: '#00FF00' },
      },
      metadata,
      state
    );

    // Sheet1 had 2 existing rules → new ones should land at 2 then 3
    assert.strictEqual(r1.addConditionalFormatRule.index, 2);
    assert.strictEqual(r2.addConditionalFormatRule.index, 3);
    // Finance had 0 → new rule at 0
    assert.strictEqual(r3.addConditionalFormatRule.index, 0);

    // Boolean rule surfaces condition and format
    assert.strictEqual(
      r1.addConditionalFormatRule.rule.booleanRule.condition.type,
      'NUMBER_LESS'
    );
    // Gradient rule carries min/max points
    assert.ok(r3.addConditionalFormatRule.rule.gradientRule.minpoint);
    assert.ok(r3.addConditionalFormatRule.rule.gradientRule.maxpoint);
  });
});

describe('BatchUpdateOperationSchema validation', () => {
  it('accepts a valid numberFormat op', () => {
    const parsed = BatchUpdateOperationSchema.parse({
      type: 'numberFormat',
      range: 'A1:A2',
      format: 'CURRENCY',
    });
    assert.strictEqual(parsed.type, 'numberFormat');
  });

  it('rejects invalid hex color in backgroundColor', () => {
    const result = BatchUpdateOperationSchema.safeParse({
      type: 'backgroundColor',
      range: 'A1',
      color: 'not-a-color',
    });
    assert.strictEqual(result.success, false);
  });

  it('conditionalFormat NUMBER_BETWEEN requires both numeric values', () => {
    const bad = BatchUpdateOperationSchema.safeParse({
      type: 'conditionalFormat',
      range: 'A1:A10',
      rule: { kind: 'boolean', condition: 'NUMBER_BETWEEN', value: 1 },
    });
    assert.strictEqual(bad.success, false);

    const good = BatchUpdateOperationSchema.safeParse({
      type: 'conditionalFormat',
      range: 'A1:A10',
      rule: { kind: 'boolean', condition: 'NUMBER_BETWEEN', value: 1, value2: 10 },
    });
    assert.strictEqual(good.success, true);
  });

  it('conditionalFormat NUMBER_LESS rejects value2', () => {
    const result = BatchUpdateOperationSchema.safeParse({
      type: 'conditionalFormat',
      range: 'A1',
      rule: { kind: 'boolean', condition: 'NUMBER_LESS', value: 0, value2: 5 },
    });
    assert.strictEqual(result.success, false);
  });

  it('conditionalFormat NUMBER_LESS requires numeric value, not string', () => {
    const result = BatchUpdateOperationSchema.safeParse({
      type: 'conditionalFormat',
      range: 'A1',
      rule: { kind: 'boolean', condition: 'NUMBER_LESS', value: 'zero' },
    });
    assert.strictEqual(result.success, false);
  });

  it('conditionalFormat TEXT_CONTAINS requires a string value', () => {
    const bad = BatchUpdateOperationSchema.safeParse({
      type: 'conditionalFormat',
      range: 'A1',
      rule: { kind: 'boolean', condition: 'TEXT_CONTAINS', value: 42 },
    });
    assert.strictEqual(bad.success, false);

    const good = BatchUpdateOperationSchema.safeParse({
      type: 'conditionalFormat',
      range: 'A1',
      rule: { kind: 'boolean', condition: 'TEXT_CONTAINS', value: 'err' },
    });
    assert.strictEqual(good.success, true);
  });

  it('conditionalFormat BLANK rejects any operand', () => {
    const bad = BatchUpdateOperationSchema.safeParse({
      type: 'conditionalFormat',
      range: 'A1',
      rule: { kind: 'boolean', condition: 'BLANK', value: 'x' },
    });
    assert.strictEqual(bad.success, false);

    const good = BatchUpdateOperationSchema.safeParse({
      type: 'conditionalFormat',
      range: 'A1',
      rule: { kind: 'boolean', condition: 'BLANK' },
    });
    assert.strictEqual(good.success, true);
  });
});
