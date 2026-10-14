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

const SheetsHelpers = await import('../google-sheets/apiHelpers.js');

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

  it('reports the seed failure through the helper message, whatever was thrown', async () => {
    // Even a thrown string arrives here already wrapped: writeRange has its own
    // catch, so initialDataError always carries the helper's message. (The
    // String(contentError) fallback behind it is defensive and unreachable
    // through this path — not worth contorting the code to exercise.)
    const sheets = mkSheets({ values: { update: mock.fn(async () => { throw 'quota exhausted'; }) } });
    const out = await performCreateSpreadsheet(mkDrive(), sheets, createSpreadsheetSchema.parse({
      title: 'Seeded', initialData: [['a']],
    }));
    assert.equal(out.initialDataWritten, false);
    assert.match(out.initialDataError, /Failed to write range/);
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

  it('falls back to the spreadsheet id when the metadata carries no title', async () => {
    const sheets = mkSheets({ spreadsheets: { get: mock.fn(async () => ({ data: { sheets: METADATA.sheets } })) } });
    const out = await performBatchUpdateSpreadsheet(sheets, batchUpdateSpreadsheetSchema.parse({
      spreadsheetId: 'ss-untitled', operations: [{ type: 'freeze', sheetName: 'Data', frozenRowCount: 1 }],
    }));
    assert.equal(out.title, 'ss-untitled');
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

describe('upstream status survives the UserError wrapper', () => {
  // The REST plane's sendUpstreamError reads err.code to answer 404/403. The
  // helpers wrap Google's error in a UserError, and a bare `new UserError(msg)`
  // dropped the code — so a missing spreadsheet reached a curl client as a flat
  // 500 "Failed to write range". The message is unchanged; only the code is new.
  for (const [label, code] of [['404', 404], ['403', 403], ['500', 500]] as const) {
    it(`keeps ${label} on a write`, async () => {
      const sheets = mkSheets({ values: { update: mock.fn(async () => { throw mkErr(code); }) } });
      await assert.rejects(
        () => SheetsHelpers.writeRange(sheets, 'ss-1', 'A1', [['a']]),
        (err: any) => {
          assert.ok(err instanceof UserError);
          assert.equal((err as any).code, code);
          return true;
        },
      );
    });
  }

  it('keeps the status on the metadata read a batch starts with, so the route can answer 404', async () => {
    const sheets = mkSheets({ spreadsheets: { get: mock.fn(async () => { throw mkErr(404); }) } });
    await assert.rejects(
      () => performBatchUpdateSpreadsheet(sheets, batchUpdateSpreadsheetSchema.parse({
        spreadsheetId: 'ss-gone', operations: [{ type: 'freeze', sheetName: 'Data', frozenRowCount: 1 }],
      })),
      (err: any) => err.code === 404,
    );
  });

  it('leaves an operation-validation error with no status — that absence is what makes it a 400', async () => {
    await assert.rejects(
      () => performBatchUpdateSpreadsheet(mkSheets(), batchUpdateSpreadsheetSchema.parse({
        spreadsheetId: 'ss-1', operations: [{ type: 'freeze', sheetName: 'NoSuchSheet', frozenRowCount: 1 }],
      })),
      (err: any) => {
        assert.ok(err instanceof UserError);
        // The REST batch route reports a code-less UserError as 400 and a
        // code-bearing one through sendUpstreamError. Collapsing the two
        // reported a nonexistent spreadsheet as "fix your operations".
        assert.equal((err as any).code, undefined);
        return true;
      },
    );
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

  it('createSpreadsheet names the shared drive when the file landed in one', async () => {
    const drive = mkDrive({
      files: { create: mock.fn(async () => ({ data: { id: 'ss-sd', name: 'Team', webViewLink: 'https://docs/ss-sd', driveId: 'drive-9' } })) },
    });
    const out = await callTool('createSpreadsheet', createSpreadsheetSchema.parse({ title: 'Team' }), {
      googleDrive: drive, googleSheets: mkSheets(),
    });
    assert.match(out, /shared drive ID: drive-9/);
  });

  it('createSpreadsheet passes a UserError through rather than relabelling it', async () => {
    // performCreateSpreadsheet raises this when Drive answers without an id; the
    // tool must not rewrite it into a generic "Failed to create spreadsheet".
    const drive = mkDrive({ files: { create: mock.fn(async () => ({ data: {} })) } });
    await assert.rejects(
      () => callTool('createSpreadsheet', createSpreadsheetSchema.parse({ title: 'x' }), { googleDrive: drive, googleSheets: mkSheets() }),
      (err: any) => err instanceof UserError && /no ID returned/.test(err.message),
    );
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

// === Grid growth ===
//
// A tab is 1000 rows at creation, and writeSpreadsheet (values.update) refuses
// to grow one, so a 3,196-row import failed with Google's "exceeds grid limits"
// and nothing on this surface could make room — the import had to be chunked
// through the model's context instead (ticket 1245xaweemn). These pin the two
// operations that fix it, the sizing at creation, and the message that tells a
// caller which of the three to reach for.
describe('grid growth operations', () => {
  it('appendDimension adds rows to a named tab and leaves values alone', async () => {
    const sheets = mkSheets();
    const out = await performBatchUpdateSpreadsheet(sheets, batchUpdateSpreadsheetSchema.parse({
      spreadsheetId: 'ss-1',
      operations: [{ type: 'appendDimension', sheetName: 'Data', dimension: 'ROWS', length: 5000 }],
    }));
    const req = sheets.spreadsheets.batchUpdate.mock.calls[0].arguments[0].requestBody.requests[0];
    assert.deepEqual(req, { appendDimension: { sheetId: 77, dimension: 'ROWS', length: 5000 } });
    // The amount is the whole content of the op, so the audit line carries it.
    assert.match(out.summaries[0], /appendDimension → Data \(\+5000 ROWS\)/);
  });

  it('appendDimension defaults to the first sheet', async () => {
    const sheets = mkSheets();
    const out = await performBatchUpdateSpreadsheet(sheets, batchUpdateSpreadsheetSchema.parse({
      spreadsheetId: 'ss-1',
      operations: [{ type: 'appendDimension', dimension: 'COLUMNS', length: 4 }],
    }));
    const req = sheets.spreadsheets.batchUpdate.mock.calls[0].arguments[0].requestBody.requests[0];
    assert.equal(req.appendDimension.sheetId, 0);
    assert.match(out.summaries[0], /\(first sheet\) \(\+4 COLUMNS\)/);
  });

  it('insertDimension converts 1-based inclusive indices to Google half-open', async () => {
    const sheets = mkSheets();
    const out = await performBatchUpdateSpreadsheet(sheets, batchUpdateSpreadsheetSchema.parse({
      spreadsheetId: 'ss-1',
      operations: [{ type: 'insertDimension', sheetName: 'Data', dimension: 'ROWS', startIndex: 5, endIndex: 6, inheritFromBefore: true }],
    }));
    const req = sheets.spreadsheets.batchUpdate.mock.calls[0].arguments[0].requestBody.requests[0];
    // Rows 5 and 6, inclusive, are Google's [4, 6). Getting this wrong inserts
    // in the wrong place, which is silent — the request succeeds either way.
    assert.deepEqual(req, {
      insertDimension: {
        range: { sheetId: 77, dimension: 'ROWS', startIndex: 4, endIndex: 6 },
        inheritFromBefore: true,
      },
    });
    assert.match(out.summaries[0], /insertDimension → Data \(ROWS 5-6\)/);
  });

  it('insertDimension omits inheritFromBefore when it was not asked for', async () => {
    const sheets = mkSheets();
    await performBatchUpdateSpreadsheet(sheets, batchUpdateSpreadsheetSchema.parse({
      spreadsheetId: 'ss-1',
      operations: [{ type: 'insertDimension', dimension: 'ROWS', startIndex: 2, endIndex: 2 }],
    }));
    const req = sheets.spreadsheets.batchUpdate.mock.calls[0].arguments[0].requestBody.requests[0];
    assert.equal('inheritFromBefore' in req.insertDimension, false);
  });

  it('insertDimension refuses a reversed range and inheritFromBefore at row 1, naming the operation', async () => {
    for (const [op, pattern] of [
      [{ type: 'insertDimension', dimension: 'ROWS', startIndex: 9, endIndex: 3 }, /endIndex must be >= startIndex/],
      // Google answers this one with a bare "invalid request"; the reason is
      // that there is nothing before the first row to inherit from.
      [{ type: 'insertDimension', dimension: 'ROWS', startIndex: 1, endIndex: 1, inheritFromBefore: true }, /no row\/column before the first one/],
    ] as const) {
      await assert.rejects(
        () => performBatchUpdateSpreadsheet(mkSheets(), batchUpdateSpreadsheetSchema.parse({
          spreadsheetId: 'ss-1', operations: [op],
        })),
        (err: any) => {
          assert.ok(err instanceof UserError);
          assert.match(err.message, /operation\[0\] \(type=insertDimension\)/);
          assert.match(err.message, pattern);
          return true;
        },
      );
    }
  });

  it('addSheet sizes the new tab, and sends no gridProperties when unsized', async () => {
    const sized = mkSheets();
    await performBatchUpdateSpreadsheet(sized, batchUpdateSpreadsheetSchema.parse({
      spreadsheetId: 'ss-1',
      operations: [{ type: 'addSheet', title: 'Import', rowCount: 4000, columnCount: 12 }],
    }));
    assert.deepEqual(
      sized.spreadsheets.batchUpdate.mock.calls[0].arguments[0].requestBody.requests[0],
      { addSheet: { properties: { title: 'Import', gridProperties: { rowCount: 4000, columnCount: 12 } } } },
    );

    const plain = mkSheets();
    await performBatchUpdateSpreadsheet(plain, batchUpdateSpreadsheetSchema.parse({
      spreadsheetId: 'ss-1', operations: [{ type: 'addSheet', title: 'Plain' }],
    }));
    // An explicit gridProperties of {} is a request to size the tab; every
    // pre-existing caller must keep getting Google's 1000 x 26 default.
    assert.deepEqual(
      plain.spreadsheets.batchUpdate.mock.calls[0].arguments[0].requestBody.requests[0],
      { addSheet: { properties: { title: 'Plain' } } },
    );
  });

  it('addSpreadsheetSheet forwards the grid and reports the one Google created', async () => {
    const sheets = mkSheets({
      spreadsheets: {
        batchUpdate: mock.fn(async () => ({
          data: { replies: [{ addSheet: { properties: { title: 'Import', sheetId: 9, gridProperties: { rowCount: 4000, columnCount: 26 } } } }] },
        })),
      },
    });
    const out = await callTool('addSpreadsheetSheet', {
      spreadsheetId: 'ss-1', sheetTitle: 'Import', rowCount: 4000,
    }, { googleSheets: sheets });
    const props = sheets.spreadsheets.batchUpdate.mock.calls[0].arguments[0].requestBody.requests[0].addSheet.properties;
    assert.deepEqual(props, { title: 'Import', gridProperties: { rowCount: 4000 } });
    // Read off the reply, not the request: a count Google clamped must not be
    // reported as the size that exists, since the next write depends on it.
    assert.match(out, /Grid: 4000 rows x 26 columns/);
  });

  it('addSpreadsheetSheet says nothing about the grid when Google reports none', async () => {
    const sheets = mkSheets({
      spreadsheets: {
        batchUpdate: mock.fn(async () => ({ data: { replies: [{ addSheet: { properties: { title: 'Plain', sheetId: 3 } } }] } })),
      },
    });
    const out = await callTool('addSpreadsheetSheet', { spreadsheetId: 'ss-1', sheetTitle: 'Plain' }, { googleSheets: sheets });
    assert.equal(sheets.spreadsheets.batchUpdate.mock.calls[0].arguments[0].requestBody.requests[0].addSheet.properties.gridProperties, undefined);
    assert.doesNotMatch(out, /Grid:/);
  });
});

describe('a write that runs off the end of the grid says how to make room', () => {
  const gridErr = () => {
    const e: any = new Error("Range ('Import'!A1:Z3196) exceeds grid limits. Max rows: 1000, max columns: 26");
    e.code = 400;
    return e;
  };

  it('names every route out of it and keeps the 400', async () => {
    const sheets = mkSheets({ values: { update: mock.fn(async () => { throw gridErr(); }) } });
    await assert.rejects(
      () => callTool('writeSpreadsheet', writeSpreadsheetSchema.parse({
        spreadsheetId: 'ss-1', range: 'Import!A1', values: Array.from({ length: 3196 }, () => ['x']),
      }), { googleSheets: sheets }),
      (err: any) => {
        // Google's own text is kept — it names the actual limits — and what is
        // added is the part it never says: which call grows a grid.
        assert.match(err.message, /exceeds grid limits/);
        assert.match(err.message, /3196 row\(s\) x 1 column\(s\) sent/);
        assert.match(err.message, /appendDimension/);
        assert.match(err.message, /addSpreadsheetSheet rowCount/);
        // Both dimensions, because the same 400 is how a max-COLUMNS rejection
        // arrives: guidance that only ever says ROWS sends a column overflow
        // through a retry that fails identically.
        assert.match(err.message, /"COLUMNS" for a max-columns one/);
        // appendSpreadsheetRows is offered as a REPLACEMENT, never as the
        // make-room step: it writes the rows itself, after the detected table
        // rather than at this range, so append-then-retry writes them twice.
        assert.match(err.message, /appendSpreadsheetRows grows the grid AND writes the rows/);
        assert.match(err.message, /INSTEAD of this write, never before retrying it/);
        // The status rides along so the REST twin can answer 400 rather than
        // reporting the caller's range as a server fault.
        assert.equal((err as any).code, 400);
        return true;
      },
    );
  });

  it('leaves every other write failure worded as it was', async () => {
    const sheets = mkSheets({ values: { update: mock.fn(async () => { throw mkErr(400, 'Unable to parse range: Sheet1!Z'); }) } });
    await assert.rejects(
      () => callTool('writeSpreadsheet', writeSpreadsheetSchema.parse({
        spreadsheetId: 'ss-1', range: 'Sheet1!Z', values: [['x']],
      }), { googleSheets: sheets }),
      (err: any) => /Failed to write range: Unable to parse range/.test(err.message) && !/appendDimension/.test(err.message),
    );
  });
});
