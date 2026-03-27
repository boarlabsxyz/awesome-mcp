import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BatchOperationSchema } from '../types.js';
import { mapBatchOperationToRequest } from '../google-docs/apiHelpers.js';

// --- BatchOperationSchema validation tests ---

describe('BatchOperationSchema', () => {

  it('parses valid insert_text operation', () => {
    const result = BatchOperationSchema.parse({ type: 'insert_text', index: 1, text: 'hello' });
    assert.equal(result.type, 'insert_text');
    assert.equal(result.index, 1);
    assert.equal(result.text, 'hello');
  });

  it('parses valid delete_text operation', () => {
    const result = BatchOperationSchema.parse({ type: 'delete_text', startIndex: 1, endIndex: 5 });
    assert.equal(result.type, 'delete_text');
    assert.equal(result.startIndex, 1);
    assert.equal(result.endIndex, 5);
  });

  it('parses valid replace_text with matchCase', () => {
    const result = BatchOperationSchema.parse({ type: 'replace_text', findText: 'foo', replaceText: 'bar', matchCase: true });
    assert.equal(result.type, 'replace_text');
    assert.equal(result.matchCase, true);
  });

  it('parses valid replace_text without matchCase (defaults to false)', () => {
    const result = BatchOperationSchema.parse({ type: 'replace_text', findText: 'foo', replaceText: 'bar' });
    assert.equal(result.type, 'replace_text');
    if (result.type === 'replace_text') {
      assert.equal(result.matchCase, false);
    }
  });

  it('parses valid format_text operation', () => {
    const result = BatchOperationSchema.parse({
      type: 'format_text', startIndex: 1, endIndex: 10,
      style: { bold: true, fontSize: 14 }
    });
    assert.equal(result.type, 'format_text');
    assert.equal(result.style.bold, true);
    assert.equal(result.style.fontSize, 14);
  });

  it('parses valid update_paragraph_style operation', () => {
    const result = BatchOperationSchema.parse({
      type: 'update_paragraph_style', startIndex: 1, endIndex: 10,
      style: { alignment: 'CENTER' }
    });
    assert.equal(result.type, 'update_paragraph_style');
    assert.equal(result.style.alignment, 'CENTER');
  });

  it('parses valid insert_table operation', () => {
    const result = BatchOperationSchema.parse({ type: 'insert_table', index: 1, rows: 3, columns: 4 });
    assert.equal(result.type, 'insert_table');
    assert.equal(result.rows, 3);
    assert.equal(result.columns, 4);
  });

  it('rejects insert_table with rows > 20', () => {
    assert.throws(() => {
      BatchOperationSchema.parse({ type: 'insert_table', index: 1, rows: 25, columns: 4 });
    });
  });

  it('parses valid insert_page_break operation', () => {
    const result = BatchOperationSchema.parse({ type: 'insert_page_break', index: 5 });
    assert.equal(result.type, 'insert_page_break');
    assert.equal(result.index, 5);
  });

  it('parses valid find_replace operation', () => {
    const result = BatchOperationSchema.parse({ type: 'find_replace', findText: 'old', replaceText: 'new', matchCase: true });
    assert.equal(result.type, 'find_replace');
  });

  it('parses valid create_bullet_list operation', () => {
    const result = BatchOperationSchema.parse({ type: 'create_bullet_list', startIndex: 1, endIndex: 20 });
    assert.equal(result.type, 'create_bullet_list');
  });

  it('rejects delete_text when endIndex <= startIndex', () => {
    assert.throws(() => {
      BatchOperationSchema.parse({ type: 'delete_text', startIndex: 10, endIndex: 5 });
    }, /endIndex must be greater than startIndex/);
  });

  it('rejects format_text when endIndex equals startIndex', () => {
    assert.throws(() => {
      BatchOperationSchema.parse({ type: 'format_text', startIndex: 5, endIndex: 5, style: { bold: true } });
    }, /endIndex must be greater than startIndex/);
  });

  it('rejects create_bullet_list when endIndex <= startIndex', () => {
    assert.throws(() => {
      BatchOperationSchema.parse({ type: 'create_bullet_list', startIndex: 20, endIndex: 10 });
    }, /endIndex must be greater than startIndex/);
  });

  it('rejects update_paragraph_style when endIndex <= startIndex', () => {
    assert.throws(() => {
      BatchOperationSchema.parse({ type: 'update_paragraph_style', startIndex: 5, endIndex: 3, style: { alignment: 'CENTER' } });
    }, /endIndex must be greater than startIndex/);
  });

  it('rejects unknown operation type', () => {
    assert.throws(() => {
      BatchOperationSchema.parse({ type: 'unknown_op', index: 1 });
    });
  });

  it('rejects insert_text without required index', () => {
    assert.throws(() => {
      BatchOperationSchema.parse({ type: 'insert_text', text: 'hello' });
    });
  });

  it('rejects insert_text without required text', () => {
    assert.throws(() => {
      BatchOperationSchema.parse({ type: 'insert_text', index: 1 });
    });
  });
});

// --- mapBatchOperationToRequest tests ---

describe('mapBatchOperationToRequest', () => {

  it('maps insert_text to insertText request', () => {
    const requests = mapBatchOperationToRequest({ type: 'insert_text', index: 5, text: 'hello' });
    assert.equal(requests.length, 1);
    assert.ok(requests[0].insertText);
    assert.equal(requests[0].insertText!.location!.index, 5);
    assert.equal(requests[0].insertText!.text, 'hello');
  });

  it('maps delete_text to deleteContentRange request', () => {
    const requests = mapBatchOperationToRequest({ type: 'delete_text', startIndex: 3, endIndex: 10 });
    assert.equal(requests.length, 1);
    assert.ok(requests[0].deleteContentRange);
    assert.equal(requests[0].deleteContentRange!.range!.startIndex, 3);
    assert.equal(requests[0].deleteContentRange!.range!.endIndex, 10);
  });

  it('maps replace_text to replaceAllText request', () => {
    const requests = mapBatchOperationToRequest({ type: 'replace_text', findText: 'foo', replaceText: 'bar', matchCase: true });
    assert.equal(requests.length, 1);
    assert.ok(requests[0].replaceAllText);
    assert.equal(requests[0].replaceAllText!.containsText!.text, 'foo');
    assert.equal(requests[0].replaceAllText!.containsText!.matchCase, true);
    assert.equal(requests[0].replaceAllText!.replaceText, 'bar');
  });

  it('maps format_text to updateTextStyle request via buildUpdateTextStyleRequest', () => {
    const requests = mapBatchOperationToRequest({
      type: 'format_text', startIndex: 1, endIndex: 10,
      style: { bold: true }
    });
    assert.equal(requests.length, 1);
    assert.ok(requests[0].updateTextStyle);
    assert.equal(requests[0].updateTextStyle!.range!.startIndex, 1);
    assert.equal(requests[0].updateTextStyle!.range!.endIndex, 10);
    assert.equal(requests[0].updateTextStyle!.textStyle!.bold, true);
  });

  it('maps format_text with no styles to empty array', () => {
    const requests = mapBatchOperationToRequest({
      type: 'format_text', startIndex: 1, endIndex: 10,
      style: {}
    });
    assert.equal(requests.length, 0);
  });

  it('maps update_paragraph_style to updateParagraphStyle request', () => {
    const requests = mapBatchOperationToRequest({
      type: 'update_paragraph_style', startIndex: 1, endIndex: 10,
      style: { alignment: 'CENTER' }
    });
    assert.equal(requests.length, 1);
    assert.ok(requests[0].updateParagraphStyle);
    assert.equal(requests[0].updateParagraphStyle!.paragraphStyle!.alignment, 'CENTER');
  });

  it('maps insert_table to insertTable request', () => {
    const requests = mapBatchOperationToRequest({ type: 'insert_table', index: 1, rows: 3, columns: 4 });
    assert.equal(requests.length, 1);
    assert.ok(requests[0].insertTable);
    assert.equal(requests[0].insertTable!.rows, 3);
    assert.equal(requests[0].insertTable!.columns, 4);
    assert.equal(requests[0].insertTable!.location!.index, 1);
  });

  it('maps insert_page_break to insertPageBreak request', () => {
    const requests = mapBatchOperationToRequest({ type: 'insert_page_break', index: 5 });
    assert.equal(requests.length, 1);
    assert.ok(requests[0].insertPageBreak);
    assert.equal(requests[0].insertPageBreak!.location!.index, 5);
  });

  it('maps find_replace to replaceAllText request', () => {
    const requests = mapBatchOperationToRequest({ type: 'find_replace', findText: 'old', replaceText: 'new', matchCase: false });
    assert.equal(requests.length, 1);
    assert.ok(requests[0].replaceAllText);
    assert.equal(requests[0].replaceAllText!.containsText!.text, 'old');
    assert.equal(requests[0].replaceAllText!.replaceText, 'new');
  });

  it('maps create_bullet_list to createParagraphBullets request', () => {
    const requests = mapBatchOperationToRequest({ type: 'create_bullet_list', startIndex: 1, endIndex: 20 });
    assert.equal(requests.length, 1);
    assert.ok(requests[0].createParagraphBullets);
    assert.equal(requests[0].createParagraphBullets!.range!.startIndex, 1);
    assert.equal(requests[0].createParagraphBullets!.range!.endIndex, 20);
  });
});
