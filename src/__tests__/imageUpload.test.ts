import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { uploadImageToDrive, getPublicUrlForDriveFile, validateImageSource } from '../google-docs/apiHelpers.js';

// --- Helpers to build mock Drive clients ---

function makeMockDrive(overrides: {
  createResult?: any;
  permissionsCreateResult?: any;
  filesGetResult?: any;
} = {}) {
  return {
    files: {
      create: async (_opts: any) => overrides.createResult ?? {
        data: { id: 'file-123', webContentLink: 'https://drive.google.com/uc?id=file-123' }
      },
      get: async (_opts: any) => overrides.filesGetResult ?? {
        data: { webContentLink: 'https://drive.google.com/uc?id=file-123' }
      },
    },
    permissions: {
      create: async (_opts: any) => overrides.permissionsCreateResult ?? { data: {} },
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

  // --- imageUrl fetch branch ---

  describe('imageUrl branch', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    function mockFetch(status: number, body: ArrayBuffer, headers: Record<string, string> = {}) {
      globalThis.fetch = (async (_input: any, _init?: any) => ({
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
        arrayBuffer: async () => body,
      })) as any;
    }

    it('fetches image from URL and uploads to Drive', async () => {
      const fakeImage = new TextEncoder().encode('PNG_DATA').buffer;
      mockFetch(200, fakeImage, { 'content-type': 'image/png' });

      let capturedOpts: any;
      const drive = {
        ...makeMockDrive(),
        files: {
          create: async (opts: any) => { capturedOpts = opts; return { data: { id: 'url-file' } }; },
          get: async () => ({ data: { webContentLink: 'https://drive.google.com/uc?id=url-file' } }),
        },
      };

      const result = await uploadImageToDrive(drive, undefined, undefined, undefined, undefined, 'https://example.com/images/photo.png');

      assert.equal(result, 'https://drive.google.com/uc?id=url-file');
      assert.equal(capturedOpts.requestBody.name, 'photo.png');
      assert.equal(capturedOpts.requestBody.mimeType, 'image/png');
    });

    it('throws when fetch returns non-OK status', async () => {
      mockFetch(404, new ArrayBuffer(0));
      const drive = makeMockDrive();

      await assert.rejects(
        () => uploadImageToDrive(drive, undefined, undefined, undefined, undefined, 'https://example.com/missing.png'),
        (err: any) => {
          assert.match(err.message, /Failed to fetch image from URL \(404\)/);
          return true;
        }
      );
    });

    it('derives filename from URL path', async () => {
      const fakeImage = new TextEncoder().encode('GIF_DATA').buffer;
      mockFetch(200, fakeImage, { 'content-type': 'image/gif' });

      let capturedOpts: any;
      const drive = {
        ...makeMockDrive(),
        files: {
          create: async (opts: any) => { capturedOpts = opts; return { data: { id: 'x' } }; },
          get: async () => ({ data: { webContentLink: 'https://example.com/dl' } }),
        },
      };

      await uploadImageToDrive(drive, undefined, undefined, undefined, undefined, 'https://cdn.example.com/assets/banner.gif');
      assert.equal(capturedOpts.requestBody.name, 'banner.gif');
      assert.equal(capturedOpts.requestBody.mimeType, 'image/gif');
    });

    it('uses fileName override when provided alongside imageUrl', async () => {
      const fakeImage = new TextEncoder().encode('DATA').buffer;
      mockFetch(200, fakeImage);

      let capturedOpts: any;
      const drive = {
        ...makeMockDrive(),
        files: {
          create: async (opts: any) => { capturedOpts = opts; return { data: { id: 'x' } }; },
          get: async () => ({ data: { webContentLink: 'https://example.com/dl' } }),
        },
      };

      await uploadImageToDrive(drive, undefined, undefined, undefined, 'custom.webp', 'https://example.com/img');
      assert.equal(capturedOpts.requestBody.name, 'custom.webp');
      assert.equal(capturedOpts.requestBody.mimeType, 'image/webp');
    });

    it('falls back to content-type header when extension is unknown', async () => {
      const fakeImage = new TextEncoder().encode('DATA').buffer;
      mockFetch(200, fakeImage, { 'content-type': 'image/tiff' });

      let capturedOpts: any;
      const drive = {
        ...makeMockDrive(),
        files: {
          create: async (opts: any) => { capturedOpts = opts; return { data: { id: 'x' } }; },
          get: async () => ({ data: { webContentLink: 'https://example.com/dl' } }),
        },
      };

      await uploadImageToDrive(drive, undefined, undefined, undefined, undefined, 'https://example.com/image.tiff');
      assert.equal(capturedOpts.requestBody.mimeType, 'image/tiff');
    });
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

// ---------- validateImageSource ----------

describe('validateImageSource', () => {

  it('throws when no source is provided', () => {
    assert.throws(
      () => validateImageSource({}),
      (err: any) => {
        assert.match(err.message, /Provide one of/);
        return true;
      }
    );
  });

  it('throws when imageBase64 is provided without fileName', () => {
    assert.throws(
      () => validateImageSource({ imageBase64: 'abc123' }),
      (err: any) => {
        assert.match(err.message, /fileName is required/);
        return true;
      }
    );
  });

  it('returns "driveFile" when driveFileId is provided', () => {
    const result = validateImageSource({ driveFileId: 'abc' });
    assert.equal(result, 'driveFile');
  });

  it('returns "driveFile" even when other sources are also provided', () => {
    const result = validateImageSource({ driveFileId: 'abc', imageUrl: 'https://example.com/img.png' });
    assert.equal(result, 'driveFile');
  });

  it('returns "upload" when imageUrl is provided', () => {
    const result = validateImageSource({ imageUrl: 'https://example.com/img.png' });
    assert.equal(result, 'upload');
  });

  it('returns "upload" when localImagePath is provided', () => {
    const result = validateImageSource({ localImagePath: '/tmp/img.png' });
    assert.equal(result, 'upload');
  });

  it('returns "upload" when imageBase64 + fileName are provided', () => {
    const result = validateImageSource({ imageBase64: 'abc123', fileName: 'photo.jpg' });
    assert.equal(result, 'upload');
  });
});
