// tests/driveHelpers.test.js
import {
  WORKSPACE_MIME_MAP,
  resolveExportFormat,
  formatExportResult,
  formatBinaryFileInfo,
  getFileAndPermissions,
  handleDriveError,
  formatPermission,
  summarizePermissions,
  formatPermissionsList,
  validateShareArgs,
  formatShareTarget,
  formatPublicAccessResult,
} from '../dist/google-drive/driveHelpers.js';
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

  describe('resolveExportFormat', () => {
    it('should return null for non-workspace mime types', () => {
      assert.strictEqual(resolveExportFormat('application/pdf'), null);
      assert.strictEqual(resolveExportFormat('image/png', 'pdf'), null);
    });

    it('should use default format when none requested', () => {
      const result = resolveExportFormat('application/vnd.google-apps.document');
      assert.deepStrictEqual(result, { format: 'pdf', exportMime: 'application/pdf' });
    });

    it('should use requested format when valid', () => {
      const result = resolveExportFormat('application/vnd.google-apps.document', 'docx');
      assert.deepStrictEqual(result, {
        format: 'docx',
        exportMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
    });

    it('should resolve spreadsheet csv format', () => {
      const result = resolveExportFormat('application/vnd.google-apps.spreadsheet', 'csv');
      assert.deepStrictEqual(result, { format: 'csv', exportMime: 'text/csv' });
    });

    it('should resolve presentation pptx format', () => {
      const result = resolveExportFormat('application/vnd.google-apps.presentation', 'pptx');
      assert.strictEqual(result.exportMime, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    });

    it('should throw UserError for unsupported format on workspace type', () => {
      assert.throws(
        () => resolveExportFormat('application/vnd.google-apps.document', 'pptx'),
        (err) => err.message.includes('not supported') && err.message.includes('pdf, docx'),
      );
    });
  });

  describe('formatExportResult', () => {
    it('should format export result with all fields', () => {
      const result = formatExportResult('MyDoc', {
        name: 'MyDoc.pdf', id: 'abc123', size: '1024', webViewLink: 'https://link',
      });
      assert.ok(result.includes('Source: MyDoc'));
      assert.ok(result.includes('Exported as: MyDoc.pdf'));
      assert.ok(result.includes('File ID: abc123'));
      assert.ok(result.includes('Size: 1024 bytes'));
      assert.ok(result.includes('Link: https://link'));
    });
  });

  describe('formatBinaryFileInfo', () => {
    it('should format binary file with all fields', () => {
      const result = formatBinaryFileInfo({
        name: 'photo.jpg', id: 'img1', mimeType: 'image/jpeg',
        size: '2048', webContentLink: 'https://dl', webViewLink: 'https://view',
      });
      assert.ok(result.includes('File: photo.jpg'));
      assert.ok(result.includes('Type: image/jpeg'));
      assert.ok(result.includes('Size: 2048 bytes'));
      assert.ok(result.includes('Download Link: https://dl'));
      assert.ok(result.includes('View Link: https://view'));
    });

    it('should handle missing optional fields', () => {
      const result = formatBinaryFileInfo({
        name: null, id: 'x', mimeType: 'application/octet-stream',
        size: null, webContentLink: null, webViewLink: null,
      });
      assert.ok(result.includes('File: Untitled'));
      assert.ok(result.includes('Size: Unknown bytes'));
      assert.ok(result.includes('Not available'));
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
        fields: 'nextPageToken,permissions(id,type,role,emailAddress)',
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

    it('should paginate through all permission pages', async () => {
      let callCount = 0;
      const mockDrive = {
        files: {
          get: mock.fn(async () => ({
            data: { id: 'file3', name: 'Many Perms' },
          })),
        },
        permissions: {
          list: mock.fn(async (params) => {
            callCount++;
            if (callCount === 1) {
              return {
                data: {
                  permissions: [{ id: 'p1', type: 'user', role: 'writer' }],
                  nextPageToken: 'token-page2',
                },
              };
            } else if (callCount === 2) {
              assert.strictEqual(params.pageToken, 'token-page2');
              return {
                data: {
                  permissions: [{ id: 'p2', type: 'user', role: 'reader' }],
                  nextPageToken: 'token-page3',
                },
              };
            } else {
              assert.strictEqual(params.pageToken, 'token-page3');
              return {
                data: {
                  permissions: [{ id: 'p3', type: 'anyone', role: 'reader' }],
                },
              };
            }
          }),
        },
      };

      const result = await getFileAndPermissions(
        mockDrive, 'file3', 'id,name', 'permissions(id,type,role)',
      );

      assert.strictEqual(result.permissions.length, 3);
      assert.strictEqual(result.permissions[0].id, 'p1');
      assert.strictEqual(result.permissions[1].id, 'p2');
      assert.strictEqual(result.permissions[2].id, 'p3');
      assert.strictEqual(mockDrive.permissions.list.mock.calls.length, 3);
    });

    it('should not duplicate nextPageToken in fields if already present', async () => {
      const mockDrive = {
        files: {
          get: mock.fn(async () => ({ data: { id: 'file4' } })),
        },
        permissions: {
          list: mock.fn(async () => ({
            data: { permissions: [] },
          })),
        },
      };

      await getFileAndPermissions(
        mockDrive, 'file4', 'id', 'nextPageToken,permissions(id)',
      );

      assert.strictEqual(
        mockDrive.permissions.list.mock.calls[0].arguments[0].fields,
        'nextPageToken,permissions(id)',
      );
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

    it('should fall back to emailAddress when displayName is missing without duplicating it', () => {
      const perm = { type: 'user', role: 'writer', emailAddress: 'no-name@test.com' };
      const result = formatPermission(perm, 0);
      assert.ok(result.includes('no-name@test.com'));
      // Email should appear exactly once, not as "email (email)"
      const count = result.split('no-name@test.com').length - 1;
      assert.strictEqual(count, 1, `Email should appear once but appeared ${count} times`);
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

  describe('formatPermissionsList', () => {
    it('should format file info and permission entries', () => {
      const file = { name: 'Doc', id: 'f1', mimeType: 'text/plain', shared: true, webViewLink: 'https://link' };
      const perms = [
        { type: 'user', role: 'owner', displayName: 'Alice', emailAddress: 'alice@test.com' },
        { type: 'anyone', role: 'reader' },
      ];
      const result = formatPermissionsList(file, perms);
      assert.ok(result.includes('Permissions for "Doc" (f1)'));
      assert.ok(result.includes('Shared: Yes'));
      assert.ok(result.includes('2 permission(s)'));
      assert.ok(result.includes('Alice'));
      assert.ok(result.includes('Anyone with the link'));
    });

    it('should show "No permissions found" for empty list', () => {
      const file = { name: 'Empty', id: 'f2', mimeType: 'text/plain', shared: false, webViewLink: null };
      const result = formatPermissionsList(file, []);
      assert.ok(result.includes('No permissions found'));
      assert.ok(result.includes('Shared: No'));
      assert.ok(result.includes('Link: N/A'));
    });
  });

  describe('validateShareArgs', () => {
    it('should throw when user type has no emailAddress', () => {
      assert.throws(
        () => validateShareArgs({ type: 'user' }),
        (err) => err.message.includes('emailAddress is required'),
      );
    });

    it('should throw when group type has no emailAddress', () => {
      assert.throws(
        () => validateShareArgs({ type: 'group' }),
        (err) => err.message.includes('emailAddress is required'),
      );
    });

    it('should throw when domain type has no domain', () => {
      assert.throws(
        () => validateShareArgs({ type: 'domain', emailAddress: 'x@y.com' }),
        (err) => err.message.includes('domain is required'),
      );
    });

    it('should throw when expirationTime used with anyone type', () => {
      assert.throws(
        () => validateShareArgs({ type: 'anyone', expirationTime: '2025-12-31T00:00:00Z' }),
        (err) => err.message.includes('expirationTime is only supported'),
      );
    });

    it('should throw when expirationTime used with domain type', () => {
      assert.throws(
        () => validateShareArgs({ type: 'domain', domain: 'example.com', expirationTime: '2025-12-31T00:00:00Z' }),
        (err) => err.message.includes('not "domain"'),
      );
    });

    it('should not throw for valid user share', () => {
      assert.doesNotThrow(() =>
        validateShareArgs({ type: 'user', emailAddress: 'user@test.com', expirationTime: '2025-12-31T00:00:00Z' }),
      );
    });

    it('should not throw for valid anyone share', () => {
      assert.doesNotThrow(() => validateShareArgs({ type: 'anyone' }));
    });

    it('should not throw for valid domain share', () => {
      assert.doesNotThrow(() => validateShareArgs({ type: 'domain', domain: 'example.com' }));
    });
  });

  describe('formatShareTarget', () => {
    it('should return "anyone with the link" for anyone type', () => {
      assert.strictEqual(formatShareTarget('anyone'), 'anyone with the link');
    });

    it('should return domain label for domain type', () => {
      assert.strictEqual(formatShareTarget('domain', undefined, 'example.com'), 'domain example.com');
    });

    it('should return email for user type', () => {
      assert.strictEqual(formatShareTarget('user', 'alice@test.com'), 'alice@test.com');
    });

    it('should return email for group type', () => {
      assert.strictEqual(formatShareTarget('group', 'team@test.com'), 'team@test.com');
    });

    it('should return "unknown" when no email provided for user type', () => {
      assert.strictEqual(formatShareTarget('user'), 'unknown');
    });
  });

  describe('formatPublicAccessResult', () => {
    it('should report public access when "anyone" permission exists', () => {
      const file = { name: 'Public Doc', id: 'pub1', mimeType: 'text/plain', shared: true, webViewLink: 'https://view' };
      const perms = [
        { type: 'user', role: 'owner' },
        { type: 'anyone', role: 'reader' },
      ];
      const result = formatPublicAccessResult(file, perms);
      assert.ok(result.includes('Public Access: YES'));
      assert.ok(result.includes('"reader" access'));
      assert.ok(result.includes('Public Link: https://view'));
      assert.ok(result.includes('Total permissions: 2'));
      assert.ok(result.includes('1x user/owner'));
    });

    it('should report no public access when no "anyone" permission', () => {
      const file = { name: 'Private Doc', id: 'priv1', mimeType: 'text/plain', shared: false, webViewLink: null };
      const perms = [{ type: 'user', role: 'owner' }];
      const result = formatPublicAccessResult(file, perms);
      assert.ok(result.includes('Public Access: NO'));
      assert.ok(result.includes('not publicly shared'));
      assert.ok(!result.includes('Public Link:'));
    });

    it('should handle empty permissions', () => {
      const file = { name: 'Lonely', id: 'lone1', mimeType: 'text/plain', shared: false, webViewLink: null };
      const result = formatPublicAccessResult(file, []);
      assert.ok(result.includes('Public Access: NO'));
      assert.ok(result.includes('Total permissions: 0'));
      assert.ok(!result.includes('Other permissions:'));
    });

    it('should not show other permissions section when only "anyone" exists', () => {
      const file = { name: 'Open', id: 'o1', mimeType: 'text/plain', shared: true, webViewLink: 'https://v' };
      const perms = [{ type: 'anyone', role: 'reader' }];
      const result = formatPublicAccessResult(file, perms);
      assert.ok(result.includes('Public Access: YES'));
      assert.ok(!result.includes('Other permissions:'));
    });
  });

});
