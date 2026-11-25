// src/google-drive/schemas.ts
// Zod parameter schemas for the Drive write tools. Separate from server.ts so
// the REST routes validate with exactly what the MCP tools validate, without
// importing a module that constructs a FastMCP server.

import { z } from 'zod';

export const createFolderSchema = z.object({
  name: z.string().min(1).describe('Name for the new folder.'),
  parentFolderId: z.string().optional().describe('Parent folder ID. If not provided, creates folder in Drive root. For shared drives, provide the shared drive ID or a folder ID within it.'),
});

export const moveFileSchema = z.object({
  fileId: z.string().describe('ID of the file or folder to move.'),
  newParentId: z.string().describe('ID of the destination folder. Use "root" for Drive root. For shared drives, use a folder ID within the shared drive.'),
  // Drive allows one parent per item, so "keep the existing parents" can only
  // be done as a copy. The description says so, since that is what happens.
  removeFromAllParents: z.boolean().optional().default(false).describe('If true, moves the item: removes it from all current parents. If false, leaves the original where it is and puts a copy in the destination (Drive allows one parent per item, and folders cannot be copied).'),
});

export const copyFileSchema = z.object({
  fileId: z.string().describe('ID of the file to copy.'),
  newName: z.string().optional().describe('Name for the copied file. If not provided, will use "Copy of [original name]".'),
  parentFolderId: z.string().optional().describe('ID of folder where copy should be placed. If not provided, places in same location as original. For shared drives, use a folder ID within the shared drive.'),
});

export const renameFileSchema = z.object({
  fileId: z.string().describe('ID of the file or folder to rename.'),
  newName: z.string().min(1).describe('New name for the file or folder.'),
});

export const deleteFileSchema = z.object({
  fileId: z.string().describe('ID of the file or folder to delete.'),
  skipTrash: z.boolean().optional().default(false).describe('If true, permanently deletes the file. If false, moves to trash (can be restored).'),
});

/**
 * POST /drive/files/{fileId}/trash. The tool's schema, minus the permanent
 * delete: the sign-off for this endpoint covered moving to the trash only, and
 * a dropped `skipTrash: true` would be a quieter surprise than a 400.
 */
export const trashFileRestSchema = deleteFileSchema.refine((v) => v.skipTrash !== true, {
  message: 'skipTrash is not accepted here: this endpoint only moves to the trash.',
  path: ['skipTrash'],
});

export const createDocumentSchema = z.object({
  title: z.string().min(1).describe('Title for the new document.'),
  parentFolderId: z.string().optional().describe('ID of folder where document should be created. If not provided, creates in Drive root. For shared drives, use a folder ID within the shared drive.'),
  initialContent: z.string().optional().describe('Initial text content to add to the document.'),
});

export const createFromTemplateSchema = z.object({
  templateId: z.string().describe('ID of the template document to copy from.'),
  newTitle: z.string().min(1).describe('Title for the new document.'),
  parentFolderId: z.string().optional().describe('ID of folder where document should be created. If not provided, creates in Drive root. For shared drives, use a folder ID within the shared drive.'),
  replacements: z.record(z.string()).optional().describe('Key-value pairs for text replacements in the template (e.g., {"{{NAME}}": "John Doe", "{{DATE}}": "2024-01-01"}).'),
});

export const shareDriveFileSchema = z.object({
  fileId: z.string().describe('The Drive file or folder ID to share.'),
  role: z.enum(['reader', 'writer', 'commenter']).describe('The access role to grant.'),
  type: z.enum(['user', 'group', 'domain', 'anyone']).describe('The type of grantee.'),
  emailAddress: z.string().optional().describe('Email address of the user or group (required for type "user" or "group").'),
  domain: z.string().optional().describe('Domain name (required for type "domain").'),
  sendNotification: z.boolean().optional().default(true).describe('Whether to send an email notification (only for user/group shares).'),
  expirationTime: z.string().optional().describe('Expiration time in RFC 3339 format (e.g., "2025-12-31T23:59:59Z"). Only for user/group shares on files (not folders).'),
}).superRefine((val, ctx) => {
  if ((val.type === 'user' || val.type === 'group') && !val.emailAddress) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['emailAddress'],
      message: 'emailAddress is required when type is "user" or "group".',
    });
  }
  if (val.type === 'domain' && !val.domain) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['domain'],
      message: 'domain is required when type is "domain".',
    });
  }
  if (val.expirationTime && val.type !== 'user' && val.type !== 'group') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expirationTime'],
      message: `expirationTime is only supported for user/group shares, not "${val.type}".`,
    });
  }
});
