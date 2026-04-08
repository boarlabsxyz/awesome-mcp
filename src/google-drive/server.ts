// src/google-drive/server.ts
import { FastMCP } from 'fastmcp';
import { z } from 'zod';

import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import { DocumentIdParameter, SharedDriveParameters } from '../types.js';
import {
  getDriveClient,
  getDocsClient,
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
  handleDownloadDriveFile,
  handleGetFilePermissions,
  handleShareDriveFile,
  handleCheckPublicAccess,
} from './toolHandlers.js';

const driveServer = new FastMCP<UserSession>({
  name: 'Google Drive MCP Server',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'google-drive'),
});

driveServer.addTool({
  name: 'getDocumentInfo',
  description: 'Gets detailed information about a specific Google Document (works with shared drives).',
  parameters: DocumentIdParameter,
  execute: async (args, { log, session }) => handleGetDocumentInfo(getDriveClient(session), args, log),
});

driveServer.addTool({
  name: 'createFolder',
  description: 'Creates a new folder in Google Drive or a shared drive.',
  parameters: z.object({
    name: z.string().min(1).describe('Name for the new folder.'),
    parentFolderId: z.string().optional().describe('Parent folder ID. If not provided, creates folder in Drive root. For shared drives, provide the shared drive ID or a folder ID within it.'),
  }),
  execute: async (args, { log, session }) => handleCreateFolder(getDriveClient(session), args, log),
});

driveServer.addTool({
  name: 'listFolderContents',
  description: 'Lists the contents of a specific folder in Google Drive or a shared drive.',
  parameters: z.object({
    folderId: z.string().describe('ID of the folder to list contents of. Use "root" for the root Drive folder. For shared drives, use the shared drive ID.'),
    includeSubfolders: z.boolean().optional().default(true).describe('Whether to include subfolders in results.'),
    includeFiles: z.boolean().optional().default(true).describe('Whether to include files in results.'),
    maxResults: z.number().int().min(1).max(100).optional().default(50).describe('Maximum number of items to return.'),
  }).merge(SharedDriveParameters),
  execute: async (args, { log, session }) => handleListFolderContents(getDriveClient(session), args, log),
});

driveServer.addTool({
  name: 'getFolderInfo',
  description: 'Gets detailed information about a specific folder in Google Drive or a shared drive.',
  parameters: z.object({
    folderId: z.string().describe('ID of the folder to get information about.'),
  }),
  execute: async (args, { log, session }) => handleGetFolderInfo(getDriveClient(session), args, log),
});

driveServer.addTool({
  name: 'moveFile',
  description: 'Moves a file or folder to a different location in Google Drive (works with shared drives).',
  parameters: z.object({
    fileId: z.string().describe('ID of the file or folder to move.'),
    newParentId: z.string().describe('ID of the destination folder. Use "root" for Drive root. For shared drives, use a folder ID within the shared drive.'),
    removeFromAllParents: z.boolean().optional().default(false).describe('If true, removes from all current parents. If false, adds to new parent while keeping existing parents.'),
  }),
  execute: async (args, { log, session }) => handleMoveFile(getDriveClient(session), args, log),
});

driveServer.addTool({
  name: 'copyFile',
  description: 'Creates a copy of a Google Drive file or document (works with shared drives).',
  parameters: z.object({
    fileId: z.string().describe('ID of the file to copy.'),
    newName: z.string().optional().describe('Name for the copied file. If not provided, will use "Copy of [original name]".'),
    parentFolderId: z.string().optional().describe('ID of folder where copy should be placed. If not provided, places in same location as original. For shared drives, use a folder ID within the shared drive.'),
  }),
  execute: async (args, { log, session }) => handleCopyFile(getDriveClient(session), args, log),
});

driveServer.addTool({
  name: 'renameFile',
  description: 'Renames a file or folder in Google Drive (works with shared drives).',
  parameters: z.object({
    fileId: z.string().describe('ID of the file or folder to rename.'),
    newName: z.string().min(1).describe('New name for the file or folder.'),
  }),
  execute: async (args, { log, session }) => handleRenameFile(getDriveClient(session), args, log),
});

driveServer.addTool({
  name: 'deleteFile',
  description: 'Permanently deletes a file or folder from Google Drive (works with shared drives).',
  parameters: z.object({
    fileId: z.string().describe('ID of the file or folder to delete.'),
    skipTrash: z.boolean().optional().default(false).describe('If true, permanently deletes the file. If false, moves to trash (can be restored).'),
  }),
  execute: async (args, { log, session }) => handleDeleteFile(getDriveClient(session), args, log),
});

driveServer.addTool({
  name: 'createDocument',
  description: 'Creates a new Google Document (works with shared drives).',
  parameters: z.object({
    title: z.string().min(1).describe('Title for the new document.'),
    parentFolderId: z.string().optional().describe('ID of folder where document should be created. If not provided, creates in Drive root. For shared drives, use a folder ID within the shared drive.'),
    initialContent: z.string().optional().describe('Initial text content to add to the document.'),
  }),
  execute: async (args, { log, session }) =>
    handleCreateDocument(getDriveClient(session), () => getDocsClient(session), args, log),
});

driveServer.addTool({
  name: 'createFromTemplate',
  description: 'Creates a new Google Document from an existing document template (works with shared drives).',
  parameters: z.object({
    templateId: z.string().describe('ID of the template document to copy from.'),
    newTitle: z.string().min(1).describe('Title for the new document.'),
    parentFolderId: z.string().optional().describe('ID of folder where document should be created. If not provided, creates in Drive root. For shared drives, use a folder ID within the shared drive.'),
    replacements: z.record(z.string()).optional().describe('Key-value pairs for text replacements in the template (e.g., {"{{NAME}}": "John Doe", "{{DATE}}": "2024-01-01"}).'),
  }),
  execute: async (args, { log, session }) =>
    handleCreateFromTemplate(getDriveClient(session), () => getDocsClient(session), args, log),
});

driveServer.addTool({
  name: 'listSharedDrives',
  description: 'Lists shared drives (Team Drives) the user has access to.',
  parameters: z.object({
    maxResults: z.number().int().min(1).max(100).optional().default(20).describe('Maximum number of shared drives to return (1-100).'),
    query: z.string().optional().describe('Filter shared drives by name (case insensitive partial match).'),
  }),
  execute: async (args, { log, session }) => handleListSharedDrives(getDriveClient(session), args, log),
});

driveServer.addTool({
  name: 'downloadDriveFile',
  description: 'Download/export a Google Drive file. For Google Workspace files (Docs, Sheets, Slides), exports to a chosen format (PDF, DOCX, XLSX, PPTX, CSV) and saves the exported file to Drive. For binary files, returns the direct download link.',
  parameters: z.object({
    fileId: z.string().describe('The Drive file ID to download/export.'),
    exportFormat: z.enum(['pdf', 'docx', 'xlsx', 'pptx', 'csv']).optional().describe('Export format for Google Workspace files. Auto-detected from mime type if omitted.'),
    folderId: z.string().optional().describe('Optional Drive folder ID to save the exported file in.'),
  }),
  execute: async (args, { log, session }) => (await handleDownloadDriveFile(getDriveClient(session), args, log)) as string,
});

driveServer.addTool({
  name: 'getFilePermissions',
  description: 'Retrieve all permissions on a Google Drive file or folder. Shows who has access, their roles, and sharing status.',
  parameters: z.object({
    fileId: z.string().describe('The Drive file or folder ID.'),
  }),
  execute: async (args, { log, session }) => (await handleGetFilePermissions(getDriveClient(session), args, log)) as string,
});

driveServer.addTool({
  name: 'shareDriveFile',
  description: 'Share a Google Drive file or folder by creating a permission. Can share with specific users/groups, a domain, or create an "anyone with the link" share.',
  parameters: z.object({
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
  }),
  execute: async (args, { log, session }) => (await handleShareDriveFile(getDriveClient(session), args, log)) as string,
});

driveServer.addTool({
  name: 'checkPublicAccess',
  description: 'Check whether a Google Drive file is publicly accessible ("anyone with the link"). Returns public/private status, file info, and permissions summary.',
  parameters: z.object({
    fileId: z.string().describe('The Drive file ID to check.'),
  }),
  execute: async (args, { log, session }) => (await handleCheckPublicAccess(getDriveClient(session), args, log)) as string,
});

export { driveServer };
