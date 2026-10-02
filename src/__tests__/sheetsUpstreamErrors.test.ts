import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { UserError } from 'fastmcp';
import {
  readRange,
  writeRange,
  appendValues,
  clearRange,
  getSpreadsheetMetadata,
  addSheet,
  formatCells,
} from '../google-sheets/apiHelpers.js';

// Every Sheets helper wraps Google's failure in a UserError. That wrapper used to
// build a bare `new UserError(message)`, which drops `error.code` — and
// `sendUpstreamError` on the REST plane reads exactly that to choose 404 vs 403
// vs 500. So a missing spreadsheet reached a curl client as a flat
// "500 Failed to write range", with nothing in it to act on.
//
// These cover both halves of the contract: the message a human reads (unchanged,
// so the MCP tools that only print it are unaffected) and the status a machine
// routes on. The status is also what the REST batch route uses to tell an
// upstream failure from an operation-validation one, where a missing status is
// the signal for 400.

function mkErr(code: unknown, message = 'upstream exploded'): any {
  const e: any = new Error(message);
  e.code = code;
  return e;
}

/** A Sheets stub whose every entry point throws the given error. */
function throwingSheets(err: any): any {
  const boom = mock.fn(async () => { throw err; });
  return {
    spreadsheets: {
      get: boom,
      batchUpdate: boom,
      values: { get: boom, update: boom, append: boom, clear: boom },
    },
  };
}

/** One call per helper, so each catch block is exercised. */
const CALLS: ReadonlyArray<[string, (sheets: any) => Promise<unknown>, RegExp]> = [
  ['readRange', (s) => readRange(s, 'ss-1', 'A1'), /read range/i],
  ['writeRange', (s) => writeRange(s, 'ss-1', 'A1', [['a']]), /write range/i],
  ['appendValues', (s) => appendValues(s, 'ss-1', 'A1', [['a']]), /append values/i],
  ['clearRange', (s) => clearRange(s, 'ss-1', 'A1'), /clear range/i],
  ['getSpreadsheetMetadata', (s) => getSpreadsheetMetadata(s, 'ss-1'), /spreadsheet metadata|get spreadsheet/i],
  ['addSheet', (s) => addSheet(s, 'ss-1', 'New tab'), /add sheet/i],
];

describe('Sheets helpers preserve the upstream status', () => {
  for (const [name, call] of CALLS) {
    it(`${name} keeps a 404 and names the spreadsheet`, async () => {
      await assert.rejects(
        () => call(throwingSheets(mkErr(404))),
        (err: any) => {
          assert.ok(err instanceof UserError);
          assert.equal((err as any).code, 404);
          assert.match(err.message, /not found/i);
          assert.match(err.message, /ss-1/);
          return true;
        },
      );
    });

    it(`${name} keeps a 403 and says it is a permission problem`, async () => {
      await assert.rejects(
        () => call(throwingSheets(mkErr(403))),
        (err: any) => {
          assert.equal((err as any).code, 403);
          assert.match(err.message, /permission denied/i);
          return true;
        },
      );
    });
  }

  for (const [name, call, verb] of CALLS) {
    it(`${name} keeps an unclassified status and names the operation`, async () => {
      await assert.rejects(
        () => call(throwingSheets(mkErr(500))),
        (err: any) => {
          assert.equal((err as any).code, 500);
          // The generic branch has to name what failed: "Unknown error" alone
          // tells the caller nothing about which call to retry.
          assert.match(err.message, verb);
          return true;
        },
      );
    });
  }

  for (const [name, call] of CALLS) {
    it(`${name} still names the operation when Google's message is empty`, async () => {
      // The generic branch reads `error.message || 'Unknown error'`. A
      // message-less rejection is what makes that fallback run, and the
      // operation name is then the only thing left for the caller to act on.
      await assert.rejects(
        () => call(throwingSheets(mkErr(503, ''))),
        (err: any) => {
          assert.equal((err as any).code, 503);
          assert.match(err.message, /Unknown error/);
          return true;
        },
      );
    });
  }

  describe('formatCells, whose own catch sits behind a successful metadata read', () => {
    /** Metadata resolves; only the batchUpdate write fails. */
    function formatStub(err: any): any {
      return {
        spreadsheets: {
          get: mock.fn(async () => ({
            // sheetId deliberately non-zero: formatCells resolves a named sheet
            // with `!sheet.properties?.sheetId`, which rejects the id 0 that
            // Google always gives the first tab. Pre-existing, not this change,
            // but it is why this fixture cannot use 0.
            data: { properties: { title: 'Q3' }, sheets: [{ properties: { sheetId: 42, title: 'Sheet1', index: 0 } }] },
          })),
          batchUpdate: mock.fn(async () => { throw err; }),
        },
      };
    }

    it('keeps a 404', async () => {
      await assert.rejects(
        () => formatCells(formatStub(mkErr(404)), 'ss-1', 'Sheet1!A1:B2', { textFormat: { bold: true } }),
        (err: any) => (err as any).code === 404 && /not found/i.test(err.message),
      );
    });

    it('keeps a 403', async () => {
      await assert.rejects(
        () => formatCells(formatStub(mkErr(403)), 'ss-1', 'Sheet1!A1:B2', { textFormat: { bold: true } }),
        (err: any) => (err as any).code === 403 && /permission denied/i.test(err.message),
      );
    });

    it('keeps an unclassified status and names the operation', async () => {
      await assert.rejects(
        () => formatCells(formatStub(mkErr(500)), 'ss-1', 'Sheet1!A1:B2', { textFormat: { bold: true } }),
        (err: any) => (err as any).code === 500 && /format cells/i.test(err.message),
      );
    });
  });

  describe('status fallback chain', () => {
    it('reads response.status when the error has no code — the shape a gaxios HTTP error uses', async () => {
      const err: any = new Error('http failure');
      err.response = { status: 404 };
      await assert.rejects(
        () => writeRange(throwingSheets(err), 'ss-1', 'A1', [['a']]),
        (e: any) => (e as any).code === 404,
      );
    });

    it('reads a bare status property', async () => {
      const err: any = new Error('http failure');
      err.status = 403;
      await assert.rejects(
        () => clearRange(throwingSheets(err), 'ss-1', 'A1'),
        (e: any) => (e as any).code === 403,
      );
    });

    it('leaves code unset when the failure carries no status at all', async () => {
      // A DNS failure or a thrown string has no status, and inventing one would
      // make the REST plane answer 404 for a network outage.
      await assert.rejects(
        () => readRange(throwingSheets(new Error('getaddrinfo ENOTFOUND')), 'ss-1', 'A1'),
        (e: any) => {
          assert.ok(e instanceof UserError);
          assert.equal((e as any).code, undefined);
          return true;
        },
      );
    });

    it('ignores a non-numeric code rather than passing it to res.status', async () => {
      // Node throws errors whose `code` is a string ('ENOTFOUND', 'ECONNRESET').
      // res.status('ENOTFOUND') would throw inside the error handler.
      await assert.rejects(
        () => writeRange(throwingSheets(mkErr('ECONNRESET')), 'ss-1', 'A1', [['a']]),
        (e: any) => {
          assert.equal((e as any).code, undefined);
          return true;
        },
      );
    });
  });
});
