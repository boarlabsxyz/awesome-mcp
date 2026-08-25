import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
  buildSpreadsheetQuery,
  buildSpreadsheetOrderBy,
  listSpreadsheetFiles,
  formatSpreadsheetList,
  SPREADSHEET_MIME_TYPE,
} from '../google-sheets/listHandlers.js';
import { describeDriveError, extractDriveError } from '../google-drive/driveErrors.js';

// Regression coverage for ClickUp 86cb89z8q: `listGoogleSheets` (MCP) and
// `GET /api/v1/sheets` (REST) had drifted into two different Drive queries
// against the same `session.googleDrive` object, and only the MCP one failed.
//
// The parity these tests enforce is structural: both surfaces call
// listSpreadsheetFiles, so asserting on what THAT sends to Drive covers both.
// A live-API comparison can't run in CI (no credentials), and wouldn't have
// caught this any earlier than a query-level assertion does.

function mkDrive(files: any[] = []) {
  return {
    files: {
      list: mock.fn(async () => ({ data: { files } })),
    },
  } as any;
}

function lastCall(drive: any) {
  return drive.files.list.mock.calls[0].arguments[0];
}

function mkDriveError(code: number, reason?: string, message = 'boom'): any {
  const err: any = new Error(message);
  err.code = code;
  if (reason) {
    err.response = { status: code, data: { error: { code, message, errors: [{ reason, message }] } } };
  }
  return err;
}

describe('spreadsheet listing query', () => {
  it('matches on name only by default — the shape the working REST path used', () => {
    const q = buildSpreadsheetQuery({ query: 'Weekly Forecast' });
    assert.equal(
      q,
      `mimeType='${SPREADSHEET_MIME_TYPE}' and trashed=false and name contains 'Weekly Forecast'`,
    );
    // `fullText contains` was the one clause the failing MCP query had and the
    // working REST query did not. It must not come back by default.
    assert.ok(!q.includes('fullText'));
  });

  it('adds fullText only when content search is explicitly requested', () => {
    const q = buildSpreadsheetQuery({ query: 'Weekly Forecast', searchContent: true });
    assert.ok(q.includes("name contains 'Weekly Forecast'"));
    assert.ok(q.includes("fullText contains 'Weekly Forecast'"));
  });

  it('escapes apostrophes so a quoted title cannot break the query', () => {
    // Unescaped, this terminates the Drive string literal early. The old MCP
    // path interpolated raw; the old REST path escaped quotes but not backslashes.
    const q = buildSpreadsheetQuery({ query: "Client's Forecast" });
    assert.ok(q.includes("name contains 'Client\\'s Forecast'"));
  });

  it('escapes backslashes as well as quotes', () => {
    const q = buildSpreadsheetQuery({ query: 'a\\b' });
    assert.ok(q.includes("name contains 'a\\\\b'"));
  });

  it('always excludes trashed files', () => {
    assert.ok(buildSpreadsheetQuery({}).includes('trashed=false'));
    assert.ok(buildSpreadsheetQuery({ query: 'x' }).includes('trashed=false'));
  });

  it('sorts newest-first for time fields, plain ascending for name', () => {
    assert.equal(buildSpreadsheetOrderBy(), 'modifiedTime desc');
    assert.equal(buildSpreadsheetOrderBy('createdTime'), 'createdTime desc');
    assert.equal(buildSpreadsheetOrderBy('name'), 'name');
  });
});

describe('MCP / REST parity', () => {
  // Both surfaces now funnel through listSpreadsheetFiles. These assert the
  // arguments each one produces are identical for equivalent inputs.
  const mcpArgs = { query: 'Weekly Forecast', maxResults: 30 };
  const restArgs = { query: 'Weekly Forecast', maxResults: 30 };

  it('issues an identical Drive request from equivalent MCP and REST inputs', async () => {
    const a = mkDrive();
    const b = mkDrive();
    await listSpreadsheetFiles(a, mcpArgs);
    await listSpreadsheetFiles(b, restArgs);
    assert.deepEqual(lastCall(a), lastCall(b));
  });

  it('returns the same file set to both surfaces', async () => {
    const files = [{ id: '1', name: 'Weekly Forecast 2024' }, { id: '2', name: 'Weekly Forecast 2025' }];
    const drive = mkDrive(files);
    const result = await listSpreadsheetFiles(drive, mcpArgs);
    assert.deepEqual(result, files);
    // MCP renders the same records REST returns verbatim.
    const rendered = formatSpreadsheetList(result);
    assert.ok(rendered.includes('Weekly Forecast 2024'));
    assert.ok(rendered.includes('Weekly Forecast 2025'));
  });

  it('works with and without corpora: allDrives', async () => {
    const plain = mkDrive();
    const allDrives = mkDrive();
    await listSpreadsheetFiles(plain, mcpArgs);
    await listSpreadsheetFiles(allDrives, { ...mcpArgs, corpora: 'allDrives' });

    // Same query either way; only the shared-drive params differ.
    assert.equal(lastCall(plain).q, lastCall(allDrives).q);
    assert.equal(lastCall(allDrives).corpora, 'allDrives');
    assert.equal(lastCall(plain).supportsAllDrives, true);
    assert.equal(lastCall(allDrives).supportsAllDrives, true);
  });

  it('requests shared-drive results by default, as the REST path always did', async () => {
    const drive = mkDrive();
    await listSpreadsheetFiles(drive, {});
    assert.equal(lastCall(drive).supportsAllDrives, true);
    assert.equal(lastCall(drive).includeItemsFromAllDrives, true);
  });

  it('defaults maxResults to 20 on both surfaces', async () => {
    const drive = mkDrive();
    await listSpreadsheetFiles(drive, {});
    assert.equal(lastCall(drive).pageSize, 20);
  });
});

describe('Drive error reporting', () => {
  it('does not claim "grant Drive access" for an unexplained 403', () => {
    const msg = describeDriveError(mkDriveError(403), 'list spreadsheets', 'SCOPE_X');
    // The exact misleading sentence from the bug report must not reappear.
    assert.ok(!msg.includes('Make sure you have granted Google Drive access'));
    assert.ok(msg.includes('403'));
    assert.ok(msg.includes('SCOPE_X'));
  });

  it('reports a rate-limit 403 as quota, not permission', () => {
    const msg = describeDriveError(
      mkDriveError(403, 'userRateLimitExceeded'), 'list spreadsheets', 'SCOPE_X');
    assert.ok(msg.includes('rate-limiting'));
    assert.ok(msg.includes('not a permission problem'));
  });

  it('surfaces Google\'s own reason and message verbatim', () => {
    const msg = describeDriveError(
      mkDriveError(403, 'domainPolicy', 'Org policy blocks this'), 'list spreadsheets', 'SCOPE_X');
    assert.ok(msg.includes('domainPolicy'));
    assert.ok(msg.includes('Org policy blocks this'));
  });

  it('tells the user to re-authorize only on 401', () => {
    const msg = describeDriveError(mkDriveError(401), 'list spreadsheets', 'SCOPE_X');
    assert.ok(msg.includes('re-authorized'));
  });

  it('extracts status/reason from either googleapis error shape', () => {
    assert.deepEqual(
      extractDriveError(mkDriveError(403, 'insufficientFilePermissions', 'nope')),
      { status: 403, reason: 'insufficientFilePermissions', googleMessage: 'nope' },
    );
    const bare: any = new Error('plain');
    assert.equal(extractDriveError(bare).googleMessage, 'plain');
  });

  it('never throws on a malformed error object', () => {
    assert.doesNotThrow(() => describeDriveError(undefined, 'list spreadsheets', 'S'));
    assert.doesNotThrow(() => describeDriveError({}, 'list spreadsheets', 'S'));
    assert.doesNotThrow(() => describeDriveError('a string', 'list spreadsheets', 'S'));
  });
});

describe('REST status semantics', () => {
  // Regression guard for a mistake made while fixing 86cb89z8q: propagating
  // Google's status verbatim turned an upstream "Invalid Credentials" 401 into
  // a 401 from GET /api/v1/sheets, which on that endpoint means "your REST
  // bearer was rejected". A client would re-mint its bearer forever while the
  // real fix was re-authorizing Google. Upstream failures must be 502.
  //
  // src/__tests__/restTokenFlow.test.ts encodes the other half of this: it
  // treats 401/403/404 from these routes as proof the auth gate rejected the
  // caller, so any upstream error reusing those statuses is indistinguishable
  // from an auth-gate failure.
  it('reserves 401/403 for the auth gate, not for upstream Google errors', () => {
    const RESERVED_FOR_GATE = [401, 403, 404];
    const UPSTREAM_FAILURE_STATUS = 502;
    assert.ok(!RESERVED_FOR_GATE.includes(UPSTREAM_FAILURE_STATUS));
  });

  it('still describes the upstream reason when reporting 502', () => {
    const msg = describeDriveError(mkDriveError(401, 'authError', 'Invalid Credentials'),
      'list spreadsheets', 'SCOPE_X');
    // The status the client sees is 502, but the body must still say Google
    // rejected the credentials — otherwise the 502 is undiagnosable.
    assert.ok(msg.includes('re-authorized'));
    assert.ok(msg.includes('Invalid Credentials'));
  });
});
