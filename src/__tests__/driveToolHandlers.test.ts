import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { UserError } from 'fastmcp';
import {
  getDriveClient,
  getDocsClient,
  buildSharedDriveParams,
  handleListGoogleDocs,
  handleSearchGoogleDocs,
  handleGetRecentGoogleDocs,
  handleGetDocumentInfo,
  handleCreateFolder,
  handleListFolderContents,
  handleGetFolderInfo,
  handleMoveFile,
  handleCopyFile,
  handleRenameFile,
  handleDeleteFile,
  handleCreateDocument,
  handleCreateFromTemplate,
  handleListSharedDrives,
  handleExportDocToPdf,
  handleDownloadDriveFile,
  handleGetFilePermissions,
  handleShareDriveFile,
  handleCheckPublicAccess,
} from '../google-drive/toolHandlers.js';

const noopLog = { info: () => {}, error: () => {}, warn: () => {} };

function mkErr(code: number, message = 'err'): any {
  const e: any = new Error(message);
  e.code = code;
  return e;
}

function mkDrive(overrides: any = {}): any {
  return {
    files: {
      list: mock.fn(async () => ({ data: { files: [] } })),
      get: mock.fn(async () => ({ data: {} })),
      create: mock.fn(async () => ({ data: { id: 'new1', name: 'New', webViewLink: 'http://link' } })),
      copy: mock.fn(async () => ({ data: { id: 'copy1', name: 'Copy', webViewLink: 'http://link' } })),
      update: mock.fn(async () => ({ data: { id: 'f1', name: 'Renamed', webViewLink: 'http://link' } })),
      delete: mock.fn(async () => ({})),
      export: mock.fn(async () => ({ data: new ArrayBuffer(8) })),
    },
    drives: {
      list: mock.fn(async () => ({ data: { drives: [] } })),
    },
    permissions: {
      create: mock.fn(async () => ({ data: {} })),
      list: mock.fn(async () => ({ data: { permissions: [] } })),
    },
    ...overrides,
  };
}

describe('Session client getters', () => {
  it('getDriveClient returns client from session', () => {
    const fake: any = { files: {} };
    assert.strictEqual(getDriveClient({ googleDrive: fake }), fake);
  });
  it('getDriveClient throws without session', () => {
    assert.throws(() => getDriveClient(undefined), UserError);
    assert.throws(() => getDriveClient({}), UserError);
  });
  it('getDocsClient returns client from session', () => {
    const fake: any = { documents: {} };
    assert.strictEqual(getDocsClient({ googleDocs: fake }), fake);
  });
  it('getDocsClient throws without session', () => {
    assert.throws(() => getDocsClient(undefined), UserError);
    assert.throws(() => getDocsClient({}), UserError);
  });
});

describe('buildSharedDriveParams', () => {
  it('defaults to allDrives corpora with supportsAllDrives', () => {
    const p = buildSharedDriveParams({});
    assert.deepEqual(p, { supportsAllDrives: true, includeItemsFromAllDrives: true, corpora: 'allDrives' });
  });
  it('honors includeSharedDrives=false', () => {
    const p = buildSharedDriveParams({ includeSharedDrives: false });
    assert.deepEqual(p, { supportsAllDrives: false });
  });
  it('uses driveId when provided', () => {
    const p = buildSharedDriveParams({ driveId: 'd1' });
    assert.equal(p.driveId, 'd1');
    assert.equal(p.corpora, 'drive');
  });
  it('uses explicit corpora override', () => {
    const p = buildSharedDriveParams({ corpora: 'user' });
    assert.equal(p.corpora, 'user');
  });
});

describe('handleListGoogleDocs', () => {
  it('returns empty message when no files', async () => {
    const drive = mkDrive();
    const r = await handleListGoogleDocs(drive, { maxResults: 10, orderBy: 'modifiedTime' }, noopLog);
    assert.match(r, /No Google Docs found/);
  });
  it('formats file list', async () => {
    const drive = mkDrive({
      files: {
        ...mkDrive().files,
        list: mock.fn(async () => ({
          data: {
            files: [
              { id: 'a', name: 'Doc A', modifiedTime: '2024-01-02T00:00:00Z', owners: [{ displayName: 'Alice' }], webViewLink: 'l1', driveId: 'sd1' },
              { id: 'b', name: 'Doc B', webViewLink: 'l2' },
            ],
          },
        })),
      },
    });
    const r = await handleListGoogleDocs(drive, { maxResults: 5, query: 'foo', orderBy: 'name' }, noopLog);
    assert.match(r, /Found 2/);
    assert.match(r, /Doc A.*Shared Drive/s);
    assert.match(r, /Drive ID: sd1/);
    assert.match(r, /Doc B/);
  });
  it('throws on 403', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, list: mock.fn(async () => { throw mkErr(403); }) } });
    await assert.rejects(
      handleListGoogleDocs(drive, { maxResults: 10, orderBy: 'modifiedTime' }, noopLog),
      /Permission denied/
    );
  });
  it('throws on generic error', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, list: mock.fn(async () => { throw new Error('boom'); }) } });
    await assert.rejects(
      handleListGoogleDocs(drive, { maxResults: 10, orderBy: 'modifiedTime' }, noopLog),
      /Failed to list documents/
    );
  });
});

describe('handleSearchGoogleDocs', () => {
  for (const searchIn of ['name', 'content', 'both'] as const) {
    it(`searches in ${searchIn}`, async () => {
      const drive = mkDrive();
      const r = await handleSearchGoogleDocs(drive, { searchQuery: 'x', searchIn, maxResults: 10 }, noopLog);
      assert.match(r, /No Google Docs found/);
    });
  }
  it('includes modifiedAfter filter and formats results', async () => {
    const drive = mkDrive({
      files: {
        ...mkDrive().files,
        list: mock.fn(async () => ({ data: { files: [{ id: 'x', name: 'N', webViewLink: 'l' }] } })),
      },
    });
    const r = await handleSearchGoogleDocs(
      drive,
      { searchQuery: 'q', searchIn: 'both', maxResults: 10, modifiedAfter: '2024-01-01' },
      noopLog,
    );
    assert.match(r, /Found 1 document/);
  });
  it('throws on 403', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, list: mock.fn(async () => { throw mkErr(403); }) } });
    await assert.rejects(
      handleSearchGoogleDocs(drive, { searchQuery: 'q', searchIn: 'both', maxResults: 10 }, noopLog),
      /Permission denied/
    );
  });
  it('throws on generic error', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, list: mock.fn(async () => { throw new Error('boom'); }) } });
    await assert.rejects(
      handleSearchGoogleDocs(drive, { searchQuery: 'q', searchIn: 'name', maxResults: 10 }, noopLog),
      /Failed to search documents/
    );
  });
});

describe('handleGetRecentGoogleDocs', () => {
  it('returns empty message when no files', async () => {
    const drive = mkDrive();
    const r = await handleGetRecentGoogleDocs(drive, { maxResults: 5, daysBack: 7 }, noopLog);
    assert.match(r, /No Google Docs found/);
  });
  it('formats results with last modifier', async () => {
    const drive = mkDrive({
      files: {
        ...mkDrive().files,
        list: mock.fn(async () => ({
          data: { files: [{ id: 'x', name: 'N', modifiedTime: '2024-01-01T00:00:00Z', lastModifyingUser: { displayName: 'Bob' }, webViewLink: 'l' }] },
        })),
      },
    });
    const r = await handleGetRecentGoogleDocs(drive, { maxResults: 5, daysBack: 3 }, noopLog);
    assert.match(r, /by Bob/);
  });
  it('throws on 403', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, list: mock.fn(async () => { throw mkErr(403); }) } });
    await assert.rejects(
      handleGetRecentGoogleDocs(drive, { maxResults: 5, daysBack: 7 }, noopLog),
      /Permission denied/
    );
  });
  it('throws on generic error', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, list: mock.fn(async () => { throw new Error('x'); }) } });
    await assert.rejects(
      handleGetRecentGoogleDocs(drive, { maxResults: 5, daysBack: 7 }, noopLog),
      /Failed to get recent/
    );
  });
});

describe('handleGetDocumentInfo', () => {
  it('formats document info with all fields', async () => {
    const drive = mkDrive({
      files: {
        ...mkDrive().files,
        get: mock.fn(async () => ({
          data: {
            id: 'd1', name: 'Doc', createdTime: '2024-01-01T00:00:00Z', modifiedTime: '2024-01-02T00:00:00Z',
            owners: [{ displayName: 'Alice', emailAddress: 'a@e' }],
            lastModifyingUser: { displayName: 'Bob', emailAddress: 'b@e' },
            shared: true, webViewLink: 'l', driveId: 'sd1', description: 'desc',
          },
        })),
      },
    });
    const r = await handleGetDocumentInfo(drive, { documentId: 'd1' }, noopLog);
    assert.match(r, /Alice/);
    assert.match(r, /Bob/);
    assert.match(r, /Shared Drive/);
    assert.match(r, /desc/);
  });
  it('handles minimal fields', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, get: mock.fn(async () => ({ data: { id: 'd1', name: 'Doc' } })) } });
    const r = await handleGetDocumentInfo(drive, { documentId: 'd1' }, noopLog);
    assert.match(r, /Doc/);
    assert.match(r, /Shared:\*\* No/);
  });
  it('throws UserError on 404', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, get: mock.fn(async () => { throw mkErr(404); }) } });
    await assert.rejects(handleGetDocumentInfo(drive, { documentId: 'd1' }, noopLog), /Document not found/);
  });
  it('throws UserError on 403', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, get: mock.fn(async () => { throw mkErr(403); }) } });
    await assert.rejects(handleGetDocumentInfo(drive, { documentId: 'd1' }, noopLog), /Permission denied/);
  });
  it('throws UserError on other errors', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, get: mock.fn(async () => { throw new Error('x'); }) } });
    await assert.rejects(handleGetDocumentInfo(drive, { documentId: 'd1' }, noopLog), /Failed to get document info/);
  });
});

describe('handleCreateFolder', () => {
  it('creates folder in root', async () => {
    const drive = mkDrive({
      files: { ...mkDrive().files, create: mock.fn(async () => ({ data: { id: 'f1', name: 'F', webViewLink: 'l' } })) },
    });
    const r = await handleCreateFolder(drive, { name: 'F' }, noopLog);
    assert.match(r, /Successfully created folder "F"/);
  });
  it('creates folder with parent and driveId', async () => {
    const drive = mkDrive({
      files: { ...mkDrive().files, create: mock.fn(async () => ({ data: { id: 'f1', name: 'F', webViewLink: 'l', driveId: 'sd1' } })) },
    });
    const r = await handleCreateFolder(drive, { name: 'F', parentFolderId: 'p1' }, noopLog);
    assert.match(r, /shared drive/);
  });
  it('throws on 404', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, create: mock.fn(async () => { throw mkErr(404); }) } });
    await assert.rejects(handleCreateFolder(drive, { name: 'F' }, noopLog), /Parent folder not found/);
  });
  it('throws on 403', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, create: mock.fn(async () => { throw mkErr(403); }) } });
    await assert.rejects(handleCreateFolder(drive, { name: 'F' }, noopLog), /Permission denied/);
  });
  it('throws on other error', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, create: mock.fn(async () => { throw new Error('x'); }) } });
    await assert.rejects(handleCreateFolder(drive, { name: 'F' }, noopLog), /Failed to create folder/);
  });
});

describe('handleListFolderContents', () => {
  it('throws when both includeSubfolders and includeFiles are false', async () => {
    await assert.rejects(
      handleListFolderContents(mkDrive(), { folderId: 'f', includeSubfolders: false, includeFiles: false, maxResults: 10 }, noopLog),
      /At least one of/
    );
  });
  it('returns empty message when folder is empty', async () => {
    const r = await handleListFolderContents(
      mkDrive(),
      { folderId: 'f', includeSubfolders: true, includeFiles: true, maxResults: 10 },
      noopLog,
    );
    assert.match(r, /empty/);
  });
  it('lists folders and mixed file types', async () => {
    const drive = mkDrive({
      files: {
        ...mkDrive().files,
        list: mock.fn(async () => ({
          data: {
            files: [
              { id: '1', name: 'Sub', mimeType: 'application/vnd.google-apps.folder' },
              { id: '2', name: 'D', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2024-01-01T00:00:00Z', owners: [{ displayName: 'A' }], webViewLink: 'l' },
              { id: '3', name: 'S', mimeType: 'application/vnd.google-apps.spreadsheet', webViewLink: 'l' },
              { id: '4', name: 'P', mimeType: 'application/vnd.google-apps.presentation', webViewLink: 'l', driveId: 'sd1' },
              { id: '5', name: 'O', mimeType: 'application/octet-stream', webViewLink: 'l' },
            ],
          },
        })),
      },
    });
    const r = await handleListFolderContents(
      drive,
      { folderId: 'f', includeSubfolders: true, includeFiles: true, maxResults: 10 },
      noopLog,
    );
    assert.match(r, /Folders \(1\)/);
    assert.match(r, /Files \(4\)/);
    assert.match(r, /📄/);
    assert.match(r, /📊/);
    assert.match(r, /📈/);
    assert.match(r, /📎/);
  });
  it('filters to files only', async () => {
    const drive = mkDrive({
      files: { ...mkDrive().files, list: mock.fn(async () => ({ data: { files: [{ id: '1', name: 'D', mimeType: 'x', webViewLink: 'l' }] } })) },
    });
    await handleListFolderContents(drive, { folderId: 'f', includeSubfolders: false, includeFiles: true, maxResults: 10 }, noopLog);
    const call = (drive.files.list as any).mock.calls[0].arguments[0];
    assert.match(call.q, /mimeType!='application\/vnd.google-apps.folder'/);
  });
  it('filters to subfolders only', async () => {
    const drive = mkDrive({
      files: { ...mkDrive().files, list: mock.fn(async () => ({ data: { files: [{ id: '1', name: 'Sub', mimeType: 'application/vnd.google-apps.folder' }] } })) },
    });
    await handleListFolderContents(drive, { folderId: 'f', includeSubfolders: true, includeFiles: false, maxResults: 10 }, noopLog);
    const call = (drive.files.list as any).mock.calls[0].arguments[0];
    assert.match(call.q, /mimeType='application\/vnd.google-apps.folder'/);
  });
  it('throws on 404', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, list: mock.fn(async () => { throw mkErr(404); }) } });
    await assert.rejects(
      handleListFolderContents(drive, { folderId: 'f', includeSubfolders: true, includeFiles: true, maxResults: 10 }, noopLog),
      /Folder not found/
    );
  });
  it('throws on 403', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, list: mock.fn(async () => { throw mkErr(403); }) } });
    await assert.rejects(
      handleListFolderContents(drive, { folderId: 'f', includeSubfolders: true, includeFiles: true, maxResults: 10 }, noopLog),
      /Permission denied/
    );
  });
  it('throws on other error', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, list: mock.fn(async () => { throw new Error('x'); }) } });
    await assert.rejects(
      handleListFolderContents(drive, { folderId: 'f', includeSubfolders: true, includeFiles: true, maxResults: 10 }, noopLog),
      /Failed to list folder contents/
    );
  });
});

describe('handleGetFolderInfo', () => {
  it('formats folder info', async () => {
    const drive = mkDrive({
      files: {
        ...mkDrive().files,
        get: mock.fn(async () => ({
          data: {
            id: 'f1', name: 'F', mimeType: 'application/vnd.google-apps.folder',
            createdTime: '2024-01-01T00:00:00Z', modifiedTime: '2024-01-02T00:00:00Z',
            owners: [{ displayName: 'A', emailAddress: 'a@e' }],
            lastModifyingUser: { displayName: 'B' },
            shared: true, webViewLink: 'l', description: 'd', parents: ['p1'], driveId: 'sd1',
          },
        })),
      },
    });
    const r = await handleGetFolderInfo(drive, { folderId: 'f1' }, noopLog);
    assert.match(r, /Folder Information/);
    assert.match(r, /Parent Folder ID/);
  });
  it('throws when not a folder', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, get: mock.fn(async () => ({ data: { mimeType: 'application/pdf' } })) } });
    await assert.rejects(handleGetFolderInfo(drive, { folderId: 'f1' }, noopLog), /does not belong to a folder/);
  });
  it('throws on 404', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, get: mock.fn(async () => { throw mkErr(404); }) } });
    await assert.rejects(handleGetFolderInfo(drive, { folderId: 'f1' }, noopLog), /Folder not found/);
  });
  it('throws on 403', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, get: mock.fn(async () => { throw mkErr(403); }) } });
    await assert.rejects(handleGetFolderInfo(drive, { folderId: 'f1' }, noopLog), /Permission denied/);
  });
  it('throws on other error', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, get: mock.fn(async () => { throw new Error('x'); }) } });
    await assert.rejects(handleGetFolderInfo(drive, { folderId: 'f1' }, noopLog), /Failed to get folder info/);
  });
});

describe('handleMoveFile', () => {
  it('moves file (add+remove)', async () => {
    const drive = mkDrive({
      files: {
        ...mkDrive().files,
        get: mock.fn(async () => ({ data: { name: 'F', parents: ['p1'] } })),
        update: mock.fn(async () => ({ data: { id: 'f1', name: 'F', driveId: 'sd1' } })),
      },
    });
    const r = await handleMoveFile(drive, { fileId: 'f1', newParentId: 'p2', removeFromAllParents: true }, noopLog);
    assert.match(r, /moved/);
    assert.match(r, /shared drive/);
  });
  it('copies file (no removal)', async () => {
    const drive = mkDrive({
      files: {
        ...mkDrive().files,
        get: mock.fn(async () => ({ data: { name: 'F', parents: ['p1'] } })),
      },
    });
    const r = await handleMoveFile(drive, { fileId: 'f1', newParentId: 'p2', removeFromAllParents: false }, noopLog);
    assert.match(r, /copied/);
  });
  it('throws on 404', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, get: mock.fn(async () => { throw mkErr(404); }) } });
    await assert.rejects(handleMoveFile(drive, { fileId: 'f1', newParentId: 'p2', removeFromAllParents: false }, noopLog), /not found/);
  });
  it('throws on 403', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, get: mock.fn(async () => { throw mkErr(403); }) } });
    await assert.rejects(handleMoveFile(drive, { fileId: 'f1', newParentId: 'p2', removeFromAllParents: false }, noopLog), /Permission denied/);
  });
  it('throws on other error', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, get: mock.fn(async () => { throw new Error('x'); }) } });
    await assert.rejects(handleMoveFile(drive, { fileId: 'f1', newParentId: 'p2', removeFromAllParents: false }, noopLog), /Failed to move/);
  });
});

describe('handleCopyFile', () => {
  it('copies with default name using original parents', async () => {
    const drive = mkDrive({
      files: {
        ...mkDrive().files,
        get: mock.fn(async () => ({ data: { name: 'Orig', parents: ['p1'] } })),
        copy: mock.fn(async () => ({ data: { id: 'c1', name: 'Copy of Orig', webViewLink: 'l' } })),
      },
    });
    const r = await handleCopyFile(drive, { fileId: 'f1' }, noopLog);
    assert.match(r, /Copy of Orig/);
  });
  it('copies with custom name and parent', async () => {
    const drive = mkDrive({
      files: {
        ...mkDrive().files,
        get: mock.fn(async () => ({ data: { name: 'Orig' } })),
        copy: mock.fn(async () => ({ data: { id: 'c1', name: 'New', webViewLink: 'l', driveId: 'sd1' } })),
      },
    });
    const r = await handleCopyFile(drive, { fileId: 'f1', newName: 'New', parentFolderId: 'p2' }, noopLog);
    assert.match(r, /New/);
    assert.match(r, /shared drive/);
  });
  it('throws on 404', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, get: mock.fn(async () => { throw mkErr(404); }) } });
    await assert.rejects(handleCopyFile(drive, { fileId: 'f1' }, noopLog), /not found/);
  });
  it('throws on 403', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, get: mock.fn(async () => { throw mkErr(403); }) } });
    await assert.rejects(handleCopyFile(drive, { fileId: 'f1' }, noopLog), /Permission denied/);
  });
  it('throws on other error', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, get: mock.fn(async () => { throw new Error('x'); }) } });
    await assert.rejects(handleCopyFile(drive, { fileId: 'f1' }, noopLog), /Failed to copy/);
  });
});

describe('handleRenameFile', () => {
  it('renames', async () => {
    const drive = mkDrive();
    const r = await handleRenameFile(drive, { fileId: 'f1', newName: 'New' }, noopLog);
    assert.match(r, /renamed/);
  });
  it('throws on 404', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, update: mock.fn(async () => { throw mkErr(404); }) } });
    await assert.rejects(handleRenameFile(drive, { fileId: 'f1', newName: 'New' }, noopLog), /not found/);
  });
  it('throws on 403', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, update: mock.fn(async () => { throw mkErr(403); }) } });
    await assert.rejects(handleRenameFile(drive, { fileId: 'f1', newName: 'New' }, noopLog), /Permission denied/);
  });
  it('throws on other error', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, update: mock.fn(async () => { throw new Error('x'); }) } });
    await assert.rejects(handleRenameFile(drive, { fileId: 'f1', newName: 'New' }, noopLog), /Failed to rename/);
  });
});

describe('handleDeleteFile', () => {
  it('trashes regular file', async () => {
    const drive = mkDrive({
      files: { ...mkDrive().files, get: mock.fn(async () => ({ data: { name: 'F', mimeType: 'text/plain' } })) },
    });
    const r = await handleDeleteFile(drive, { fileId: 'f1', skipTrash: false }, noopLog);
    assert.match(r, /Moved file/);
  });
  it('permanently deletes when skipTrash', async () => {
    const drive = mkDrive({
      files: { ...mkDrive().files, get: mock.fn(async () => ({ data: { name: 'F', mimeType: 'application/vnd.google-apps.folder' } })) },
    });
    const r = await handleDeleteFile(drive, { fileId: 'f1', skipTrash: true }, noopLog);
    assert.match(r, /Permanently deleted folder/);
  });
  it('trashes shared drive files when skipTrash is false', async () => {
    const drive = mkDrive({
      files: { ...mkDrive().files, get: mock.fn(async () => ({ data: { name: 'F', mimeType: 'text/plain', driveId: 'sd1' } })) },
    });
    const r = await handleDeleteFile(drive, { fileId: 'f1', skipTrash: false }, noopLog);
    assert.match(r, /Moved file/);
  });
  it('permanently deletes shared drive files when skipTrash is true', async () => {
    const drive = mkDrive({
      files: { ...mkDrive().files, get: mock.fn(async () => ({ data: { name: 'F', mimeType: 'text/plain', driveId: 'sd1' } })) },
    });
    const r = await handleDeleteFile(drive, { fileId: 'f1', skipTrash: true }, noopLog);
    assert.match(r, /from shared drive/);
  });
  it('throws on 404', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, get: mock.fn(async () => { throw mkErr(404); }) } });
    await assert.rejects(handleDeleteFile(drive, { fileId: 'f1', skipTrash: false }, noopLog), /not found/);
  });
  it('throws on 403', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, get: mock.fn(async () => { throw mkErr(403); }) } });
    await assert.rejects(handleDeleteFile(drive, { fileId: 'f1', skipTrash: false }, noopLog), /Permission denied/);
  });
  it('throws on other error', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, get: mock.fn(async () => { throw new Error('x'); }) } });
    await assert.rejects(handleDeleteFile(drive, { fileId: 'f1', skipTrash: false }, noopLog), /Failed to delete/);
  });
});

describe('handleCreateDocument', () => {
  const mockDocs = (): any => ({ documents: { batchUpdate: mock.fn(async () => ({})) } });
  it('creates without initial content', async () => {
    const drive = mkDrive({
      files: { ...mkDrive().files, create: mock.fn(async () => ({ data: { id: 'd1', name: 'T', webViewLink: 'l' } })) },
    });
    const r = await handleCreateDocument(drive, mockDocs, { title: 'T' }, noopLog);
    assert.match(r, /Successfully created/);
  });
  it('creates with initial content and parent folder', async () => {
    const drive = mkDrive({
      files: { ...mkDrive().files, create: mock.fn(async () => ({ data: { id: 'd1', name: 'T', webViewLink: 'l', driveId: 'sd1' } })) },
    });
    const r = await handleCreateDocument(drive, mockDocs, { title: 'T', parentFolderId: 'p', initialContent: 'hi' }, noopLog);
    assert.match(r, /Initial content added/);
    assert.match(r, /shared drive/);
  });
  it('warns but succeeds when initial content fails', async () => {
    const drive = mkDrive({
      files: { ...mkDrive().files, create: mock.fn(async () => ({ data: { id: 'd1', name: 'T', webViewLink: 'l' } })) },
    });
    const failingDocs = (): any => { throw new Error('no docs'); };
    const r = await handleCreateDocument(drive, failingDocs, { title: 'T', initialContent: 'hi' }, noopLog);
    assert.match(r, /failed to add initial content/);
  });
  it('throws on 404', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, create: mock.fn(async () => { throw mkErr(404); }) } });
    await assert.rejects(handleCreateDocument(drive, mockDocs, { title: 'T' }, noopLog), /Parent folder not found/);
  });
  it('throws on 403', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, create: mock.fn(async () => { throw mkErr(403); }) } });
    await assert.rejects(handleCreateDocument(drive, mockDocs, { title: 'T' }, noopLog), /Permission denied/);
  });
  it('throws on other error', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, create: mock.fn(async () => { throw new Error('x'); }) } });
    await assert.rejects(handleCreateDocument(drive, mockDocs, { title: 'T' }, noopLog), /Failed to create document/);
  });
});

describe('handleCreateFromTemplate', () => {
  const mockDocs = (): any => ({ documents: { batchUpdate: mock.fn(async () => ({})) } });
  it('creates from template without replacements', async () => {
    const drive = mkDrive({
      files: { ...mkDrive().files, copy: mock.fn(async () => ({ data: { id: 'd1', name: 'T', webViewLink: 'l' } })) },
    });
    const r = await handleCreateFromTemplate(drive, mockDocs, { templateId: 'tpl', newTitle: 'T' }, noopLog);
    assert.match(r, /from template/);
  });
  it('applies replacements', async () => {
    const drive = mkDrive({
      files: { ...mkDrive().files, copy: mock.fn(async () => ({ data: { id: 'd1', name: 'T', webViewLink: 'l', driveId: 'sd1' } })) },
    });
    const r = await handleCreateFromTemplate(
      drive, mockDocs,
      { templateId: 'tpl', newTitle: 'T', parentFolderId: 'p', replacements: { '{{A}}': 'X', '{{B}}': 'Y' } },
      noopLog,
    );
    assert.match(r, /Applied 2 text replacements/);
  });
  it('warns but succeeds when replacements fail', async () => {
    const drive = mkDrive({
      files: { ...mkDrive().files, copy: mock.fn(async () => ({ data: { id: 'd1', name: 'T', webViewLink: 'l' } })) },
    });
    const failing = (): any => { throw new Error('no'); };
    const r = await handleCreateFromTemplate(drive, failing, { templateId: 'tpl', newTitle: 'T', replacements: { x: 'y' } }, noopLog);
    assert.match(r, /failed to apply/);
  });
  it('throws on 404', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, copy: mock.fn(async () => { throw mkErr(404); }) } });
    await assert.rejects(handleCreateFromTemplate(drive, mockDocs, { templateId: 'tpl', newTitle: 'T' }, noopLog), /not found/);
  });
  it('throws on 403', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, copy: mock.fn(async () => { throw mkErr(403); }) } });
    await assert.rejects(handleCreateFromTemplate(drive, mockDocs, { templateId: 'tpl', newTitle: 'T' }, noopLog), /Permission denied/);
  });
  it('throws on other error', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, copy: mock.fn(async () => { throw new Error('x'); }) } });
    await assert.rejects(handleCreateFromTemplate(drive, mockDocs, { templateId: 'tpl', newTitle: 'T' }, noopLog), /Failed to create document from template/);
  });
});

describe('handleListSharedDrives', () => {
  it('returns empty (no query)', async () => {
    const r = await handleListSharedDrives(mkDrive(), { maxResults: 10 }, noopLog);
    assert.match(r, /No shared drives found/);
  });
  it('returns empty (with query)', async () => {
    const r = await handleListSharedDrives(mkDrive(), { maxResults: 10, query: 'x' }, noopLog);
    assert.match(r, /matching "x"/);
  });
  it('lists drives', async () => {
    const drive = mkDrive({
      drives: {
        list: mock.fn(async () => ({
          data: { drives: [{ id: 'd1', name: 'SD', createdTime: '2024-01-01T00:00:00Z', capabilities: { canEdit: true, canManageMembers: false } }] },
        })),
      },
    });
    const r = await handleListSharedDrives(drive, { maxResults: 10 }, noopLog);
    assert.match(r, /Found 1 Shared Drive/);
    assert.match(r, /Can Edit: Yes/);
  });
  it('throws on 403', async () => {
    const drive = mkDrive({ drives: { list: mock.fn(async () => { throw mkErr(403); }) } });
    await assert.rejects(handleListSharedDrives(drive, { maxResults: 10 }, noopLog), /Permission denied/);
  });
  it('throws on other error', async () => {
    const drive = mkDrive({ drives: { list: mock.fn(async () => { throw new Error('x'); }) } });
    await assert.rejects(handleListSharedDrives(drive, { maxResults: 10 }, noopLog), /Failed to list shared drives/);
  });
});

describe('handleExportDocToPdf', () => {
  it('exports google doc to PDF', async () => {
    const drive = mkDrive({
      files: {
        ...mkDrive().files,
        get: mock.fn(async () => ({ data: { mimeType: 'application/vnd.google-apps.document', name: 'Doc' } })),
        create: mock.fn(async () => ({ data: { id: 'p1', name: 'Doc.pdf', webViewLink: 'l', size: '1024' } })),
      },
    });
    const r = await handleExportDocToPdf(drive, { documentId: 'd1' }, noopLog);
    assert.match(r, /PDF exported successfully/);
  });
  it('uses custom filename and folder', async () => {
    const drive = mkDrive({
      files: {
        ...mkDrive().files,
        get: mock.fn(async () => ({ data: { mimeType: 'application/vnd.google-apps.document', name: 'Doc' } })),
        create: mock.fn(async () => ({ data: { id: 'p1', name: 'Custom.pdf', webViewLink: 'l', size: '10' } })),
      },
    });
    const r = await handleExportDocToPdf(drive, { documentId: 'd1', pdfFilename: 'Custom', folderId: 'fx' }, noopLog);
    assert.match(r, /Custom\.pdf/);
  });
  it('throws when not a Google Doc', async () => {
    const drive = mkDrive({
      files: { ...mkDrive().files, get: mock.fn(async () => ({ data: { mimeType: 'application/pdf', name: 'x' } })) },
    });
    await assert.rejects(handleExportDocToPdf(drive, { documentId: 'd1' }, noopLog), /not a Google Doc/);
  });
});

describe('handleDownloadDriveFile', () => {
  it('exports workspace file', async () => {
    const drive = mkDrive({
      files: {
        ...mkDrive().files,
        get: mock.fn(async () => ({ data: { id: 'd1', name: 'D', mimeType: 'application/vnd.google-apps.document' } })),
        create: mock.fn(async () => ({ data: { id: 'e1', name: 'D.pdf', webViewLink: 'l', size: '10' } })),
      },
    });
    const r = await handleDownloadDriveFile(drive, { fileId: 'd1', exportFormat: 'pdf', folderId: 'f' }, noopLog);
    assert.match(r!, /exported successfully/);
  });
  it('returns binary file info for non-workspace', async () => {
    const drive = mkDrive({
      files: {
        ...mkDrive().files,
        get: mock.fn(async () => ({ data: { id: 'b1', name: 'B', mimeType: 'application/octet-stream', size: '100' } })),
      },
    });
    const r = await handleDownloadDriveFile(drive, { fileId: 'b1' }, noopLog);
    assert.match(r!, /File:/);
  });
  it('re-throws UserError from resolveExportFormat', async () => {
    const drive = mkDrive({
      files: { ...mkDrive().files, get: mock.fn(async () => ({ data: { name: 'D', mimeType: 'application/vnd.google-apps.document' } })) },
    });
    await assert.rejects(
      handleDownloadDriveFile(drive, { fileId: 'd1', exportFormat: 'xlsx' }, noopLog),
      /not supported/
    );
  });
  it('calls handleDriveError on failure', async () => {
    const drive = mkDrive({ files: { ...mkDrive().files, get: mock.fn(async () => { throw mkErr(404); }) } });
    await assert.rejects(handleDownloadDriveFile(drive, { fileId: 'd1' }, noopLog), /not found/);
  });
});

describe('handleGetFilePermissions', () => {
  it('returns permissions list', async () => {
    const drive = mkDrive({
      files: { ...mkDrive().files, get: mock.fn(async () => ({ data: { id: 'f1', name: 'F', mimeType: 'x', shared: true, webViewLink: 'l' } })) },
      permissions: {
        list: mock.fn(async () => ({ data: { permissions: [{ id: 'p1', type: 'user', role: 'reader', displayName: 'U', emailAddress: 'u@e' }] } })),
        create: mock.fn(),
      },
    });
    const r = await handleGetFilePermissions(drive, { fileId: 'f1' }, noopLog);
    assert.match(r!, /Permissions for/);
  });
  it('calls handleDriveError on 404', async () => {
    const drive = mkDrive({
      files: { ...mkDrive().files, get: mock.fn(async () => { throw mkErr(404); }) },
      permissions: { list: mock.fn(async () => { throw mkErr(404); }), create: mock.fn() },
    });
    await assert.rejects(handleGetFilePermissions(drive, { fileId: 'f1' }, noopLog), /not found/);
  });
});

describe('handleShareDriveFile', () => {
  it('shares with user', async () => {
    const drive = mkDrive({
      files: { ...mkDrive().files, get: mock.fn(async () => ({ data: { name: 'F', webViewLink: 'l' } })) },
    });
    const r = await handleShareDriveFile(
      drive,
      { fileId: 'f1', role: 'reader', type: 'user', emailAddress: 'a@e' },
      noopLog,
    );
    assert.match(r!, /Shared successfully/);
  });
  it('shares with anyone', async () => {
    const drive = mkDrive({
      files: { ...mkDrive().files, get: mock.fn(async () => ({ data: { name: 'F' } })) },
    });
    const r = await handleShareDriveFile(drive, { fileId: 'f1', role: 'writer', type: 'anyone' }, noopLog);
    assert.match(r!, /anyone with the link/);
  });
  it('shares with domain and expiration honored only for user/group', async () => {
    const drive = mkDrive({
      files: { ...mkDrive().files, get: mock.fn(async () => ({ data: { name: 'F' } })) },
    });
    const r = await handleShareDriveFile(drive, { fileId: 'f1', role: 'commenter', type: 'domain', domain: 'e.com' }, noopLog);
    assert.match(r!, /domain e.com/);
  });
  it('throws on validation error for user without email', async () => {
    const drive = mkDrive();
    await assert.rejects(
      handleShareDriveFile(drive, { fileId: 'f1', role: 'reader', type: 'user' }, noopLog),
      /emailAddress is required/
    );
  });
  it('delegates error to handleDriveError', async () => {
    const drive = mkDrive({
      permissions: { create: mock.fn(async () => { throw mkErr(404); }), list: mock.fn() },
    });
    await assert.rejects(
      handleShareDriveFile(drive, { fileId: 'f1', role: 'reader', type: 'anyone' }, noopLog),
      /not found/
    );
  });
});

describe('handleCheckPublicAccess', () => {
  it('returns result for public file', async () => {
    const drive = mkDrive({
      files: { ...mkDrive().files, get: mock.fn(async () => ({ data: { id: 'f1', name: 'F', mimeType: 'x', shared: true, webViewLink: 'l' } })) },
      permissions: {
        list: mock.fn(async () => ({ data: { permissions: [{ type: 'anyone', role: 'reader' }] } })),
        create: mock.fn(),
      },
    });
    const r = await handleCheckPublicAccess(drive, { fileId: 'f1' }, noopLog);
    assert.match(r!, /Public Access: YES/);
  });
  it('calls handleDriveError on failure', async () => {
    const drive = mkDrive({
      files: { ...mkDrive().files, get: mock.fn(async () => { throw mkErr(403); }) },
      permissions: { list: mock.fn(async () => { throw mkErr(403); }), create: mock.fn() },
    });
    await assert.rejects(handleCheckPublicAccess(drive, { fileId: 'f1' }, noopLog), /Permission denied/);
  });
});
