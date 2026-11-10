import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { UserError } from 'fastmcp';
import {
  listDriveChangesSchema,
  performListDriveChanges,
  performSearchDriveFiles,
  performUploadDriveFile,
  searchDriveFilesSchema,
  uploadDriveFileSchema,
} from '../google-drive/filesOps.js';
import { handleListFolderContents } from '../google-drive/toolHandlers.js';

// What these assert is the request that reaches Drive, which a caller cannot see:
// the query string, whether a sort was sent, and the conversion metadata.

function mkDrive(overrides: any = {}): any {
  return {
    files: {
      list: mock.fn(async (_req: any) => ({ data: { files: [{ id: 'f1', name: 'Budget' }], nextPageToken: 'next-1' } })),
      create: mock.fn(async (req: any) => ({ data: { id: 'new-1', name: req.requestBody.name, mimeType: req.requestBody.mimeType ?? req.media.mimeType } })),
      ...(overrides.files || {}),
    },
    changes: {
      getStartPageToken: mock.fn(async (_req: any) => ({ data: { startPageToken: 'start-9' } })),
      list: mock.fn(async (_req: any) => ({ data: { changes: [{ fileId: 'f1', removed: true }], newStartPageToken: 'start-10' } })),
      ...(overrides.changes || {}),
    },
    about: {
      get: mock.fn(async () => ({ data: { importFormats: { 'text/csv': ['application/vnd.google-apps.spreadsheet'] } } })),
      ...(overrides.about || {}),
    },
  };
}

const listArgs = (drive: any) => drive.files.list.mock.calls[0].arguments[0];

describe('searchDriveFiles', () => {
  it('searches every type and folder, by relevance when content is searched', async () => {
    const drive = mkDrive();
    const out = await performSearchDriveFiles(drive, searchDriveFilesSchema.parse({ query: "Q3 'plan'" }));
    const req = listArgs(drive);
    assert.equal(req.q, "trashed=false and (name contains 'Q3 \\'plan\\'' or fullText contains 'Q3 \\'plan\\'')");
    assert.equal('orderBy' in req, false, 'Drive 403s any orderBy on a fullText query');
    assert.equal(out.sortedBy, 'relevance');
    assert.equal(out.nextPageToken, 'next-1');
  });

  it('lists recent files by modified time when there is no query, with a type alias and a page token', async () => {
    const drive = mkDrive();
    await performSearchDriveFiles(drive, searchDriveFilesSchema.parse({ mimeType: 'spreadsheet', pageToken: 'p2' }));
    const req = listArgs(drive);
    assert.equal(req.q, "trashed=false and mimeType='application/vnd.google-apps.spreadsheet'");
    assert.equal(req.orderBy, 'modifiedTime desc');
    assert.equal(req.pageToken, 'p2');
  });

  it('reports a search Drive could not complete', async () => {
    const drive = mkDrive({ files: { list: mock.fn(async () => ({ data: { files: [], incompleteSearch: true } })) } });
    const out = await performSearchDriveFiles(drive, searchDriveFilesSchema.parse({ query: 'x', searchIn: 'name' }));
    assert.equal(out.incompleteSearch, true);
  });
});

describe('listDriveChanges', () => {
  it('hands back a start token, and lists nothing, on the first call', async () => {
    const drive = mkDrive();
    const out = await performListDriveChanges(drive, listDriveChangesSchema.parse({}));
    assert.equal(out.startPageToken, 'start-9');
    assert.deepEqual(out.changes, []);
    assert.equal(drive.changes.list.mock.callCount(), 0);
  });

  it('lists changes from a token and returns the token to poll with next', async () => {
    const drive = mkDrive();
    const out = await performListDriveChanges(drive, listDriveChangesSchema.parse({ pageToken: 'start-9' }));
    assert.equal(drive.changes.list.mock.calls[0].arguments[0].pageToken, 'start-9');
    assert.equal(out.changes.length, 1);
    assert.equal(out.newStartPageToken, 'start-10');
    assert.equal(out.nextPageToken, null);
  });
});

describe('uploadDriveFile', () => {
  it('converts when Drive can import the type, and reports converted from what Drive stored', async () => {
    const drive = mkDrive();
    const out = await performUploadDriveFile(drive, uploadDriveFileSchema.parse({
      fileName: 'data.csv', sourceMimeType: 'text/csv', textContent: 'a,b\n1,2\n', convertTo: 'spreadsheet', parentFolderId: 'fold-1',
    }));
    const req = drive.files.create.mock.calls[0].arguments[0];
    assert.deepEqual(req.requestBody, { name: 'data.csv', mimeType: 'application/vnd.google-apps.spreadsheet', parents: ['fold-1'] });
    assert.equal(req.media.mimeType, 'text/csv');
    assert.equal(out.converted, true);
    assert.equal(out.bytes, 8);
  });

  it('refuses a conversion Drive cannot do, before uploading', async () => {
    const drive = mkDrive();
    await assert.rejects(
      () => performUploadDriveFile(drive, uploadDriveFileSchema.parse({ fileName: 'x.csv', sourceMimeType: 'text/csv', textContent: 'a', convertTo: 'presentation' })),
      (err: any) => err instanceof UserError && /cannot convert text\/csv into a Google presentation/.test(err.message) && /spreadsheet/.test(err.message),
    );
    assert.equal(drive.files.create.mock.callCount(), 0);
  });

  it('decodes base64, and refuses both, neither, or an oversize file', async () => {
    const drive = mkDrive();
    const out = await performUploadDriveFile(drive, { fileName: 'a.bin', sourceMimeType: 'application/octet-stream', contentBase64: Buffer.from('hello').toString('base64') });
    assert.equal(out.bytes, 5);
    assert.equal(out.converted, false);
    await assert.rejects(() => performUploadDriveFile(drive, { fileName: 'a', sourceMimeType: 'text/plain' }), /exactly one/);
    await assert.rejects(() => performUploadDriveFile(drive, { fileName: 'a', sourceMimeType: 'text/plain', textContent: 'x', contentBase64: 'eA==' }), /exactly one/);
    await assert.rejects(
      () => performUploadDriveFile(drive, { fileName: 'a', sourceMimeType: 'text/plain', textContent: 'x'.repeat(20 * 1024 * 1024 + 1) }),
      /limit here is/,
    );
  });
});

describe('listFolderContents pagination', () => {
  it('passes pageToken through and says when more items remain', async () => {
    const drive = mkDrive({ files: { list: mock.fn(async (_req: any) => ({ data: { files: [{ id: 'f1', name: 'A', mimeType: 'text/plain' }], nextPageToken: 'n2' } })) } });
    const out = await handleListFolderContents(drive, {
      folderId: 'root', includeSubfolders: true, includeFiles: true, maxResults: 1, pageToken: 'p1',
    }, { info() {}, error() {} } as any);
    assert.equal(listArgs(drive).pageToken, 'p1');
    assert.match(out, /MORE remain — call again with pageToken "n2"/);
  });
});

describe('REST helpers (review follow-up)', () => {
  it('parses query booleans strictly instead of reading anything unknown as false', async () => {
    const { parseQueryBoolean } = await import('../google-drive/filesOps.js');
    assert.equal(parseQueryBoolean('includeTrashed', 'TRUE'), true);
    assert.equal(parseQueryBoolean('includeTrashed', '1'), true);
    assert.equal(parseQueryBoolean('includeTrashed', '0'), false);
    assert.equal(parseQueryBoolean('includeTrashed', undefined), undefined);
    assert.throws(() => parseQueryBoolean('includeTrashed', 'yes'), /must be true or false/);
  });

  it('maps local refusals and Drive 400s to 400, leaving 403/404/5xx to sendUpstreamError', async () => {
    const { driveRestErrorResponse } = await import('../google-drive/filesOps.js');
    assert.equal(driveRestErrorResponse(new UserError('Give exactly one'))?.status, 400);
    assert.equal(driveRestErrorResponse(Object.assign(new Error('Invalid pageToken'), { code: 400 }))?.status, 400);
    assert.equal(driveRestErrorResponse(Object.assign(new Error('x'), { response: { status: 400 } }))?.status, 400);
    assert.equal(driveRestErrorResponse(Object.assign(new Error('forbidden'), { code: 403 })), null);
    assert.equal(driveRestErrorResponse(Object.assign(new Error('boom'), { code: 500 })), null);
  });

  it('refuses base64 with characters Buffer would silently skip', async () => {
    await assert.rejects(
      () => performUploadDriveFile(mkDrive(), { fileName: 'a', sourceMimeType: 'text/plain', contentBase64: 'not*base64!' }),
      /not valid base64/,
    );
  });
});
