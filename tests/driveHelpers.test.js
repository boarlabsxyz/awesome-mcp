// tests/driveHelpers.test.js
import {
  WORKSPACE_MIME_MAP,
  getFileAndPermissions,
  handleDriveError,
  formatPermission,
  summarizePermissions,
} from '../dist/google-docs/driveHelpers.js';
import assert from 'node:assert';
import { describe, it, mock } from 'node:test';

describe('Drive Helpers', () => {

  describe('WORKSPACE_MIME_MAP', () => {
    it('should have entries for Docs, Sheets, and Slides', () => {
      assert.ok(WORKSPACE_MIME_MAP['application/vnd.google-apps.document']);
      assert.ok(WORKSPACE_MIME_MAP['application/vnd.google-apps.spreadsheet']);
      assert.ok(WORKSPACE_MIME_MAP['application/vnd.google-apps.presentation']);
    });

    it('should have correct default formats', () => {
      assert.strictEqual(WORKSPACE_MIME_MAP['application/vnd.google-apps.document'].defaultFormat, 'pdf');
      assert.strictEqual(WORKSPACE_MIME_MAP['application/vnd.google-apps.spreadsheet'].defaultFormat, 'xlsx');
      assert.strictEqual(WORKSPACE_MIME_MAP['application/vnd.google-apps.presentation'].defaultFormat, 'pptx');
    });

    it('should map Google Docs to pdf and docx export mimes', () => {
      const docExports = WORKSPACE_MIME_MAP['application/vnd.google-apps.document'].exports;
      assert.strictEqual(docExports.pdf, 'application/pdf');
      assert.strictEqual(docExports.docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      assert.strictEqual(Object.keys(docExports).length, 2);
    });

    it('should map Google Sheets to pdf, xlsx, and csv export mimes', () => {
      const sheetExports = WORKSPACE_MIME_MAP['application/vnd.google-apps.spreadsheet'].exports;
      assert.strictEqual(sheetExports.pdf, 'application/pdf');
      assert.strictEqual(sheetExports.xlsx, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      assert.strictEqual(sheetExports.csv, 'text/csv');
      assert.strictEqual(Object.keys(sheetExports).length, 3);
    });

    it('should map Google Slides to pdf and pptx export mimes', () => {
      const slideExports = WORKSPACE_MIME_MAP['application/vnd.google-apps.presentation'].exports;
      assert.strictEqual(slideExports.pdf, 'application/pdf');
      assert.strictEqual(slideExports.pptx, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
      assert.strictEqual(Object.keys(slideExports).length, 2);
    });

    it('should not contain entries for non-workspace mime types', () => {
      assert.strictEqual(WORKSPACE_MIME_MAP['application/pdf'], undefined);
      assert.strictEqual(WORKSPACE_MIME_MAP['image/png'], undefined);
    });
  });

  describe('getFileAndPermissions', () => {
    it('should fetch file info and permissions in parallel', async () => {
      const mockDrive = {
        files: {
          get: mock.fn(async () => ({
            data: { id: 'file1', name: 'Test File', mimeType: 'text/plain' },
          })),
        },
        permissions: {
          list: mock.fn(async () => ({
            data: {
              permissions: [
                { id: 'perm1', type: 'user', role: 'owner', emailAddress: 'owner@test.com' },
              ],
            },
          })),
        },
      };

      const result = await getFileAndPermissions(
        mockDrive, 'file1', 'id,name,mimeType', 'permissions(id,type,role,emailAddress)',
      );

      assert.strictEqual(result.file.id, 'file1');
      assert.strictEqual(result.file.name, 'Test File');
      assert.strictEqual(result.permissions.length, 1);
      assert.strictEqual(result.permissions[0].emailAddress, 'owner@test.com');

      // Verify API calls
      assert.strictEqual(mockDrive.files.get.mock.calls.length, 1);
      assert.strictEqual(mockDrive.permissions.list.mock.calls.length, 1);
      assert.deepStrictEqual(mockDrive.files.get.mock.calls[0].arguments[0], {
        fileId: 'file1',
        supportsAllDrives: true,
        fields: 'id,name,mimeType',
      });
      assert.deepStrictEqual(mockDrive.permissions.list.mock.calls[0].arguments[0], {
        fileId: 'file1',
        supportsAllDrives: true,
        fields: 'permissions(id,type,role,emailAddress)',
      });
    });

    it('should return empty permissions array when permissions data is null', async () => {
      const mockDrive = {
        files: {
          get: mock.fn(async () => ({
            data: { id: 'file2', name: 'No Perms' },
          })),
        },
        permissions: {
          list: mock.fn(async () => ({
            data: { permissions: null },
          })),
        },
      };

      const result = await getFileAndPermissions(mockDrive, 'file2', 'id,name', 'permissions(id)');
      assert.deepStrictEqual(result.permissions, []);
    });
  });

  describe('handleDriveError', () => {
    it('should throw UserError with "not found" for 404 errors', () => {
      const error = { code: 404, message: 'Not Found' };
      assert.throws(
        () => handleDriveError(error, 'view', 'file123'),
        (err) => err.message === 'File not found (ID: file123).',
      );
    });

    it('should throw UserError with "permission denied" for 403 errors', () => {
      const error = { code: 403, message: 'Forbidden' };
      assert.throws(
        () => handleDriveError(error, 'share', 'file456'),
        (err) => err.message === "Permission denied. You don't have access to share this file.",
      );
    });

    it('should throw generic UserError for other errors', () => {
      const error = { code: 500, message: 'Internal Server Error' };
      assert.throws(
        () => handleDriveError(error, 'share', 'file789'),
        (err) => err.message === 'Failed to share: Internal Server Error',
      );
    });

    it('should handle errors without a message', () => {
      const error = { code: 500 };
      assert.throws(
        () => handleDriveError(error, 'download', 'fileXYZ'),
        (err) => err.message === 'Failed to download: Unknown error',
      );
    });
  });

  describe('formatPermission', () => {
    it('should format a user permission with email', () => {
      const perm = { type: 'user', role: 'writer', displayName: 'Alice', emailAddress: 'alice@test.com' };
      const result = formatPermission(perm, 0);
      assert.ok(result.includes('1. **writer**'));
      assert.ok(result.includes('Alice (alice@test.com)'));
      assert.ok(result.includes('Type: user'));
    });

    it('should format an "anyone" permission', () => {
      const perm = { type: 'anyone', role: 'reader' };
      const result = formatPermission(perm, 2);
      assert.ok(result.includes('3. **reader**'));
      assert.ok(result.includes('Anyone with the link'));
    });

    it('should format a domain permission', () => {
      const perm = { type: 'domain', role: 'reader' };
      const result = formatPermission(perm, 0);
      assert.ok(result.includes('Domain'));
      assert.ok(result.includes('Type: domain'));
    });

    it('should show expiration time when present', () => {
      const perm = { type: 'user', role: 'reader', emailAddress: 'bob@test.com', expirationTime: '2025-12-31T23:59:59Z' };
      const result = formatPermission(perm, 0);
      assert.ok(result.includes('Expires: 2025-12-31T23:59:59Z'));
    });

    it('should show deleted user marker', () => {
      const perm = { type: 'user', role: 'reader', emailAddress: 'gone@test.com', deleted: true };
      const result = formatPermission(perm, 0);
      assert.ok(result.includes('(Deleted user)'));
    });

    it('should fall back to emailAddress when displayName is missing', () => {
      const perm = { type: 'user', role: 'writer', emailAddress: 'no-name@test.com' };
      const result = formatPermission(perm, 0);
      assert.ok(result.includes('no-name@test.com'));
    });

    it('should show "Unknown" when both displayName and emailAddress are missing', () => {
      const perm = { type: 'user', role: 'reader' };
      const result = formatPermission(perm, 0);
      assert.ok(result.includes('Unknown'));
    });
  });

  describe('summarizePermissions', () => {
    it('should count permissions by type/role', () => {
      const perms = [
        { type: 'user', role: 'writer' },
        { type: 'user', role: 'writer' },
        { type: 'user', role: 'reader' },
        { type: 'group', role: 'reader' },
      ];
      const result = summarizePermissions(perms);
      assert.ok(result.includes('2x user/writer'));
      assert.ok(result.includes('1x user/reader'));
      assert.ok(result.includes('1x group/reader'));
    });

    it('should return empty string for empty array', () => {
      const result = summarizePermissions([]);
      assert.strictEqual(result, '');
    });

    it('should handle single permission', () => {
      const perms = [{ type: 'anyone', role: 'reader' }];
      const result = summarizePermissions(perms);
      assert.ok(result.includes('1x anyone/reader'));
    });
  });

});
