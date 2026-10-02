import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { UserError } from 'fastmcp';

// Same reasoning as calendarWriteTools.test.ts: the Sheets write path was
// untested, and webServer.ts held a second copy of the create-spreadsheet and
// batch-translation logic. With the ops extracted, a stub client can assert what
// reaches Google — including the batch translation, which is the part a caller
// cannot verify from the outside.

const toolMap = new Map<string, { execute: (...args: any[]) => any; parameters: any }>();
const FastMCPModule = await import('fastmcp');
const origAddTool = FastMCPModule.FastMCP.prototype.addTool;
FastMCPModule.FastMCP.prototype.addTool = function (tool: any) {
  toolMap.set(tool.name, tool);
  return origAddTool.call(this, tool);
};
const sheetsModule = await import('../google-sheets/server.js');
FastMCPModule.FastMCP.prototype.addTool = origAddTool;

const {
  writeSpreadsheetSchema,
  appendSpreadsheetRowsSchema,
  createSpreadsheetSchema,
  clearSpreadsheetRangeSchema,
  batchUpdateSpreadsheetSchema,
  performCreateSpreadsheet,
  performBatchUpdateSpreadsheet,
} = sheetsModule as any;

const noopLog = { info: () => {}, error: () => {}, warn: () => {} };

function mkErr(code: number, message = 'boom'): any {
  const e: any = new Error(message);
  e.code = code;
  return e;
}

const METADATA = {
  properties: { title: 'Q3 Plan' },
  sheets: [
    { properties: { sheetId: 0, title: 'Sheet1', index: 0 } },
    { properties: { sheetId: 77, title: 'Data', index: 1 } },
  ],
};

function mkSheets(overrides: any = {}): any {
  return {
    spreadsheets: {
      get: mock.fn(async () => ({ data: METADATA })),
      batchUpdate: mock.fn(async () => ({ data: { replies: [{}] } })),
      values: {
        update: mock.fn(async () => ({ data: { updatedCells: 4, updatedRows: 2, updatedColumns: 2, updatedRange: 'Sheet1!A1:B2' } })),
        append: mock.fn(async () => ({ data: { updates: { updatedCells: 2, updatedRows: 1, updatedRange: 'Sheet1!A3:B3' } } })),
        clear: mock.fn(async () => ({ data: { clearedRange: 'Sheet1!A1:B10' } })),
        ...(overrides.values || {}),
      },
      ...(overrides.spreadsheets || {}),
    },
  };
}

function mkDrive(overrides: any = {}): any {
  return {
    files: {
      create: mock.fn(async () => ({ data: { id: 'ss-new', name: 'Seeded', webViewLink: 'https://docs/ss-new' } })),
      ...(overrides.files || {}),
    },
  };
}

const callTool = (name: string, args: any, session: any) =>
  toolMap.get(name)!.execute(args, { session, log: noopLog });

describe('performCreateSpreadsheet', () => {
  it('creates through Drive with shared-drive support and no parents key when none given', async () => {
    const drive = mkDrive();
    const out = await performCreateSpreadsheet(drive, mkSheets(), createSpreadsheetSchema.parse({ title: 'Fresh' }));
    const sent = drive.files.create.mock.calls[0].arguments[0];
    assert.equal(sent.requestBody.name, 'Fresh');
    assert.equal(sent.requestBody.mimeType, 'application/vnd.google-apps.spreadsheet');
    assert.equal('parents' in sent.requestBody, false);
    // supportsAllDrives is why this goes through Drive at all rather than
    // sheets.spreadsheets.create.
    assert.equal(sent.supportsAllDrives, true);
    assert.equal(out.initialDataWritten, false);
  });

  it('places the file in a parent folder when asked', async () => {
    const drive = mkDrive();
    await performCreateSpreadsheet(drive, mkSheets(), createSpreadsheetSchema.parse({ title: 'Fresh', parentFolderId: 'folder-1' }));
    assert.deepEqual(drive.files.create.mock.calls[0].arguments[0].requestBody.parents, ['folder-1']);
  });

  it('writes initialData to A1 and reports it', async () => {
    const sheets = mkSheets();
    const out = await performCreateSpreadsheet(mkDrive(), sheets, createSpreadsheetSchema.parse({
      title: 'Seeded',
      initialData: [['h1', 'h2'], [1, true]],
    }));
    assert.equal(out.initialDataWritten, true);
    const sent = sheets.spreadsheets.values.update.mock.calls[0].arguments[0];
    assert.equal(sent.range, 'A1');
    assert.equal(sent.valueInputOption, 'USER_ENTERED');
    assert.deepEqual(sent.requestBody.values, [['h1', 'h2'], [1, true]]);
  });

  it('reports a failed seed instead of throwing — the spreadsheet already exists by then', async () => {
    const sheets = mkSheets({ values: { update: mock.fn(async () => { throw new Error('seed exploded'); }) } });
    const out = await performCreateSpreadsheet(mkDrive(), sheets, createSpreadsheetSchema.parse({
      title: 'Seeded',
      initialData: [['a']],
    }));
    assert.equal(out.file.id, 'ss-new');
    assert.equal(out.initialDataWritten, false);
    assert.match(out.initialDataError, /seed exploded/);
  });

  it('throws when Drive returns no id, since nothing can be seeded or reported', async () => {
    const drive = mkDrive({ files: { create: mock.fn(async () => ({ data: {} })) } });
    await assert.rejects(
      () => performCreateSpreadsheet(drive, mkSheets(), createSpreadsheetSchema.parse({ title: 'x' })),
      (err: any) => err instanceof UserError,
    );
  });
});

describe('performBatchUpdateSpreadsheet', () => {
  it('translates operations in order and applies them in one call', async () => {
    const sheets = mkSheets();
    const out = await performBatchUpdateSpreadsheet(sheets, batchUpdateSpreadsheetSchema.parse({
      spreadsheetId: 'ss-1',
      operations: [
        { type: 'freeze', sheetName: 'Data', frozenRowCount: 1 },
        { type: 'backgroundColor', range: 'Data!A1:B1', color: '#FF0000' },
      ],
    }));
    assert.equal(sheets.spreadsheets.batchUpdate.mock.calls.length, 1, 'the batch must be a single atomic call');
    const requests = sheets.spreadsheets.batchUpdate.mock.calls[0].arguments[0].requestBody.requests;
    assert.equal(requests.length, 2);
    assert.equal(out.title, 'Q3 Plan');
    assert.equal(out.summaries.length, 2);
    assert.match(out.summaries[0], /freeze → Data/);
    assert.match(out.summaries[1], /backgroundColor → Data!A1:B1/);
  });

  it('resolves a sheet name to the sheetId from the live metadata', async () => {
    const sheets = mkSheets();
    await performBatchUpdateSpreadsheet(sheets, batchUpdateSpreadsheetSchema.parse({
      spreadsheetId: 'ss-1',
      operations: [{ type: 'freeze', sheetName: 'Data', frozenRowCount: 2 }],
    }));
    const req = sheets.spreadsheets.batchUpdate.mock.calls[0].arguments[0].requestBody.requests[0];
    assert.equal(JSON.stringify(req).includes('77'), true, 'expected the Data sheet id 77 in the request');
  });

  it('names the failing operation by index and type', async () => {
    await assert.rejects(
      () => performBatchUpdateSpreadsheet(mkSheets(), batchUpdateSpreadsheetSchema.parse({
        spreadsheetId: 'ss-1',
        operations: [
          { type: 'freeze', sheetName: 'Data', frozenRowCount: 1 },
          { type: 'freeze', sheetName: 'NoSuchSheet', frozenRowCount: 1 },
        ],
      })),
      (err: any) => {
        assert.ok(err instanceof UserError);
        // "invalid request" against a 40-op batch is undiagnosable; the index is
        // the whole point.
        assert.match(err.message, /operation\[1\]/);
        assert.match(err.message, /type=freeze/);
        return true;
      },
    );
  });

  it('labels each operation by whatever names its target — range, sheet, source, title, or the first sheet', async () => {
    // The summary line is the only audit trail a 40-operation batch leaves, and
    // each operation type names its target with a different key.
    const sheets = mkSheets();
    const out = await performBatchUpdateSpreadsheet(sheets, batchUpdateSpreadsheetSchema.parse({
      spreadsheetId: 'ss-1',
      operations: [
        { type: 'backgroundColor', range: 'Data!A1:B1', color: '#FF0000' },
        { type: 'freeze', sheetName: 'Data', frozenColumnCount: 1 },
        { type: 'duplicateSheet', sourceSheetName: 'Data', newSheetName: 'Data copy' },
        { type: 'addSheet', title: 'Fresh tab' },
        { type: 'freeze', frozenRowCount: 1 },
      ],
    }));
    assert.deepEqual(out.summaries.map((l: string) => l.trim()), [
      '0. backgroundColor → Data!A1:B1',
      '1. freeze → Data',
      '2. duplicateSheet → Data',
      '3. addSheet → Fresh tab',
      // No range and no sheetName: the op applies to the first sheet, and
      // saying so beats an empty arrow.
      '4. freeze → (first sheet)',
    ]);
  });

  it('falls back to the request count when Google replies with no replies array', async () => {
    const sheets = mkSheets({ spreadsheets: { batchUpdate: mock.fn(async () => ({ data: {} })) } });
    const out = await performBatchUpdateSpreadsheet(sheets, batchUpdateSpreadsheetSchema.parse({
      spreadsheetId: 'ss-1',
      operations: [{ type: 'freeze', sheetName: 'Data', frozenRowCount: 1 }],
    }));
    assert.equal(out.applied, 1);
  });
});

describe('sheets write tools', () => {
  it('writeSpreadsheet reports the cells written', async () => {
    const sheets = mkSheets();
    const out = await callTool('writeSpreadsheet', writeSpreadsheetSchema.parse({
      spreadsheetId: 'ss-1', range: 'Sheet1!A1:B2', values: [['a', 'b'], [1, 2]],
    }), { googleSheets: sheets, email: 't@example.com' });
    assert.match(out, /wrote 4 cells/);
    assert.equal(sheets.spreadsheets.values.update.mock.calls[0].arguments[0].valueInputOption, 'USER_ENTERED');
  });

  it('writeSpreadsheet honours RAW', async () => {
    const sheets = mkSheets();
    await callTool('writeSpreadsheet', writeSpreadsheetSchema.parse({
      spreadsheetId: 'ss-1', range: 'A1', values: [['=1+1']], valueInputOption: 'RAW',
    }), { googleSheets: sheets });
    assert.equal(sheets.spreadsheets.values.update.mock.calls[0].arguments[0].valueInputOption, 'RAW');
  });

  it('appendSpreadsheetRows reports the updated range', async () => {
    const out = await callTool('appendSpreadsheetRows', appendSpreadsheetRowsSchema.parse({
      spreadsheetId: 'ss-1', range: 'A1', values: [['x', 'y']],
    }), { googleSheets: mkSheets() });
    assert.match(out, /appended 1 row/);
    assert.match(out, /Sheet1!A3:B3/);
  });

  it('createSpreadsheet reports the seed outcome in both directions', async () => {
    const ok = await callTool('createSpreadsheet', createSpreadsheetSchema.parse({
      title: 'Seeded', initialData: [['a']],
    }), { googleDrive: mkDrive(), googleSheets: mkSheets() });
    assert.match(ok, /Initial data added/);

    const failed = await callTool('createSpreadsheet', createSpreadsheetSchema.parse({
      title: 'Seeded', initialData: [['a']],
    }), {
      googleDrive: mkDrive(),
      googleSheets: mkSheets({ values: { update: mock.fn(async () => { throw new Error('nope'); }) } }),
    });
    assert.match(failed, /failed to add initial data/);
  });

  it('createSpreadsheet explains a 403 on the destination folder', async () => {
    const drive = mkDrive({ files: { create: mock.fn(async () => { throw mkErr(403); }) } });
    await assert.rejects(
      () => callTool('createSpreadsheet', createSpreadsheetSchema.parse({ title: 'x' }), { googleDrive: drive, googleSheets: mkSheets() }),
      (err: any) => err instanceof UserError && /write access/.test(err.message),
    );
  });

  it('clearSpreadsheetRange reports the range Google says it cleared', async () => {
    const out = await callTool('clearSpreadsheetRange', clearSpreadsheetRangeSchema.parse({
      spreadsheetId: 'ss-1', range: 'Sheet1!A:B',
    }), { googleSheets: mkSheets() });
    // Google can clear wider than asked when the request is unbounded, so the
    // report must come from its answer, not from the request.
    assert.match(out, /Sheet1!A1:B10/);
  });

  it('batchUpdateSpreadsheet lists what it applied', async () => {
    const out = await callTool('batchUpdateSpreadsheet', batchUpdateSpreadsheetSchema.parse({
      spreadsheetId: 'ss-1', operations: [{ type: 'freeze', sheetName: 'Data', frozenRowCount: 1 }],
    }), { googleSheets: mkSheets() });
    assert.match(out, /Applied 1 operation\(s\) to "Q3 Plan"/);
    assert.match(out, /freeze → Data/);
  });

  it('batchUpdateSpreadsheet maps a 404 to a spreadsheet-not-found message', async () => {
    const sheets = mkSheets({ spreadsheets: { get: mock.fn(async () => { throw mkErr(404); }) } });
    await assert.rejects(
      () => callTool('batchUpdateSpreadsheet', batchUpdateSpreadsheetSchema.parse({
        spreadsheetId: 'ss-gone', operations: [{ type: 'freeze', sheetName: 'Data', frozenRowCount: 1 }],
      }), { googleSheets: sheets }),
      (err: any) => err instanceof UserError && /not found/.test(err.message),
    );
  });

  it('every write tool refuses a session with no sheets client', async () => {
    for (const [name, args] of [
      ['writeSpreadsheet', { spreadsheetId: 's', range: 'A1', values: [['a']] }],
      ['appendSpreadsheetRows', { spreadsheetId: 's', range: 'A1', values: [['a']] }],
      ['clearSpreadsheetRange', { spreadsheetId: 's', range: 'A1' }],
      ['batchUpdateSpreadsheet', { spreadsheetId: 's', operations: [{ type: 'freeze', sheetName: 'Data', frozenRowCount: 1 }] }],
    ] as const) {
      await assert.rejects(
        () => callTool(name, args, {}),
        (err: any) => err instanceof UserError,
        `${name} should refuse an unconnected session`,
      );
    }
  });
});
