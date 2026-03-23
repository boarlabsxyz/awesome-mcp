import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { uploadImageToDrive, getPublicUrlForDriveFile } from '../google-docs/apiHelpers.js';

// --- Helpers to build mock Drive clients ---

function makeMockDrive(overrides: {
  createResult?: any;
  permissionsCreateResult?: any;
  filesGetResult?: any;
} = {}) {
  return {
    files: {
      create: async (opts: any) => overrides.createResult ?? {
        data: { id: 'file-123', webContentLink: 'https://drive.google.com/uc?id=file-123' }
      },
      get: async (opts: any) => overrides.filesGetResult ?? {
        data: { webContentLink: 'https://drive.google.com/uc?id=file-123' }
      },
    },
    permissions: {
      create: async (opts: any) => overrides.permissionsCreateResult ?? { data: {} },
    },
  };
}

// ---------- uploadImageToDrive ----------

describe('uploadImageToDrive', () => {

  // --- Input validation / source routing ---

  it('throws when no source is provided', async () => {
    const drive = makeMockDrive();
    await assert.rejects(
      () => uploadImageToDrive(drive, undefined, undefined, undefined, undefined, undefined),
      (err: any) => {
        assert.match(err.message, /Either localFilePath, imageUrl, or imageBuffer \+ fileName must be provided/);
        return true;
      }
    );
  });

  it('throws when localFilePath does not exist on disk', async () => {
    const drive = makeMockDrive();
    await assert.rejects(
      () => uploadImageToDrive(drive, '/nonexistent/path/photo.png'),
      (err: any) => {
        assert.match(err.message, /Image file not found/);
        return true;
      }
    );
  });

  // --- imageBuffer + fileName branch ---

  it('uses imageBuffer + fileName when both provided', async () => {
    let capturedOpts: any;
    const drive = {
      ...makeMockDrive(),
      files: {
        create: async (opts: any) => {
          capturedOpts = opts;
          return { data: { id: 'buf-file' } };
        },
        get: async () => ({ data: { webContentLink: 'https://drive.google.com/uc?id=buf-file' } }),
      },
    };

    const buf = Buffer.from('fake-png-data');
    const result = await uploadImageToDrive(drive, undefined, undefined, buf, 'screenshot.png', undefined);

    assert.equal(result, 'https://drive.google.com/uc?id=buf-file');
    assert.equal(capturedOpts.requestBody.name, 'screenshot.png');
    assert.equal(capturedOpts.requestBody.mimeType, 'image/png');
  });

  it('falls back to application/octet-stream for unknown extension via buffer', async () => {
    let capturedOpts: any;
    const drive = {
      ...makeMockDrive(),
      files: {
        create: async (opts: any) => { capturedOpts = opts; return { data: { id: 'x' } }; },
        get: async () => ({ data: { webContentLink: 'https://example.com/dl' } }),
      },
    };

    await uploadImageToDrive(drive, undefined, undefined, Buffer.from('data'), 'file.xyz', undefined);
    assert.equal(capturedOpts.requestBody.mimeType, 'application/octet-stream');
  });

  // --- parentFolderId ---

  it('sets parents when parentFolderId is provided', async () => {
    let capturedOpts: any;
    const drive = {
      ...makeMockDrive(),
      files: {
        create: async (opts: any) => { capturedOpts = opts; return { data: { id: 'f1' } }; },
        get: async () => ({ data: { webContentLink: 'https://example.com/dl' } }),
      },
    };

    await uploadImageToDrive(drive, undefined, 'folder-abc', Buffer.from('img'), 'pic.jpg', undefined);
    assert.deepEqual(capturedOpts.requestBody.parents, ['folder-abc']);
  });

  it('omits parents when parentFolderId is not provided', async () => {
    let capturedOpts: any;
    const drive = {
      ...makeMockDrive(),
      files: {
        create: async (opts: any) => { capturedOpts = opts; return { data: { id: 'f2' } }; },
        get: async () => ({ data: { webContentLink: 'https://example.com/dl' } }),
      },
    };

    await uploadImageToDrive(drive, undefined, undefined, Buffer.from('img'), 'pic.jpg', undefined);
    assert.equal(capturedOpts.requestBody.parents, undefined);
  });

  // --- Drive API error handling ---

  it('throws when Drive files.create returns no file ID', async () => {
    const drive = makeMockDrive({ createResult: { data: { id: null } } });
    await assert.rejects(
      () => uploadImageToDrive(drive, undefined, undefined, Buffer.from('img'), 'pic.png', undefined),
      (err: any) => {
        assert.match(err.message, /no file ID returned/);
        return true;
      }
    );
  });

  it('throws when webContentLink is missing after upload', async () => {
    const drive = makeMockDrive({
      createResult: { data: { id: 'file-ok' } },
      filesGetResult: { data: { webContentLink: null } },
    });
    await assert.rejects(
      () => uploadImageToDrive(drive, undefined, undefined, Buffer.from('img'), 'pic.png', undefined),
      (err: any) => {
        assert.match(err.message, /Failed to get public URL/);
        return true;
      }
    );
  });

  // --- MIME type mapping ---

  it('resolves known extensions to correct MIME types via buffer path', async () => {
    const cases = [
      ['photo.jpg', 'image/jpeg'],
      ['photo.jpeg', 'image/jpeg'],
      ['icon.png', 'image/png'],
      ['anim.gif', 'image/gif'],
      ['img.bmp', 'image/bmp'],
      ['hero.webp', 'image/webp'],
      ['logo.svg', 'image/svg+xml'],
    ] as const;

    for (const [fileName, expectedMime] of cases) {
      let capturedOpts: any;
      const drive = {
        ...makeMockDrive(),
        files: {
          create: async (opts: any) => { capturedOpts = opts; return { data: { id: 'x' } }; },
          get: async () => ({ data: { webContentLink: 'https://example.com/dl' } }),
        },
      };

      await uploadImageToDrive(drive, undefined, undefined, Buffer.from('data'), fileName, undefined);
      assert.equal(capturedOpts.requestBody.mimeType, expectedMime, `Expected ${expectedMime} for ${fileName}`);
    }
  });
});

// ---------- getPublicUrlForDriveFile ----------

describe('getPublicUrlForDriveFile', () => {

  it('returns webContentLink when Drive responds normally', async () => {
    const drive = makeMockDrive({
      filesGetResult: { data: { webContentLink: 'https://drive.google.com/uc?id=abc' } },
    });
    const url = await getPublicUrlForDriveFile(drive, 'abc');
    assert.equal(url, 'https://drive.google.com/uc?id=abc');
  });

  it('calls permissions.create with correct args', async () => {
    let capturedArgs: any;
    const drive = {
      files: { get: async () => ({ data: { webContentLink: 'https://example.com/dl' } }) },
      permissions: {
        create: async (args: any) => { capturedArgs = args; return { data: {} }; },
      },
    };

    await getPublicUrlForDriveFile(drive, 'file-xyz');
    assert.equal(capturedArgs.fileId, 'file-xyz');
    assert.equal(capturedArgs.requestBody.role, 'reader');
    assert.equal(capturedArgs.requestBody.type, 'anyone');
    assert.equal(capturedArgs.supportsAllDrives, true);
  });

  it('throws when webContentLink is missing (e.g. Google Docs editor file)', async () => {
    const drive = makeMockDrive({
      filesGetResult: { data: { webContentLink: null } },
    });
    await assert.rejects(
      () => getPublicUrlForDriveFile(drive, 'doc-id'),
      (err: any) => {
        assert.match(err.message, /Ensure the file is a binary file/);
        return true;
      }
    );
  });

  it('propagates Drive API errors', async () => {
    const drive = {
      permissions: {
        create: async () => { throw new Error('403 Forbidden'); },
      },
      files: { get: async () => ({ data: {} }) },
    };
    await assert.rejects(
      () => getPublicUrlForDriveFile(drive, 'no-access'),
      (err: any) => {
        assert.match(err.message, /403 Forbidden/);
        return true;
      }
    );
  });
});
