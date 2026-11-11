// src/google-drive/server.ts
import { FastMCP } from 'fastmcp';
import { instrumentServer } from '../usage/instrumentServer.js';
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
import {
  listDriveChangesSchema,
  performListDriveChanges,
  performSearchDriveFiles,
  performUploadDriveFile,
  searchDriveFilesSchema,
  uploadDriveFileSchema,
} from './filesOps.js';
import { describeDriveError } from './driveErrors.js';
import { UserError } from 'fastmcp';
import type { drive_v3 } from 'googleapis';
import { registerMintRestBearerForCurl } from '../sharedTools/mintRestBearerForCurl.js';
import { registerListRestEndpoints } from '../sharedTools/listRestEndpoints.js';

const driveServer = instrumentServer(new FastMCP<UserSession>({
  name: 'Google Drive MCP Server',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'google-drive'),
}), 'google-drive');

registerMintRestBearerForCurl(driveServer);
registerListRestEndpoints(driveServer);

driveServer.addTool({
  name: 'getDocumentInfo',
  annotations: { readOnlyHint: true },
  description: 'Gets detailed information about a specific Google Document (works with shared drives).',
  parameters: DocumentIdParameter,
  execute: async (args, { log, session }) => handleGetDocumentInfo(getDriveClient(session), args, log),
});

driveServer.addTool({
  name: 'createFolder',
  annotations: { readOnlyHint: false },
  description: 'Creates a new folder in Google Drive or a shared drive.',
  parameters: z.object({
    name: z.string().min(1).describe('Name for the new folder.'),
    parentFolderId: z.string().optional().describe('Parent folder ID. If not provided, creates folder in Drive root. For shared drives, provide the shared drive ID or a folder ID within it.'),
  }),
  execute: async (args, { log, session }) => handleCreateFolder(getDriveClient(session), args, log),
});

driveServer.addTool({
  name: 'listFolderContents',
  annotations: { readOnlyHint: true },
  description: 'Lists the contents of a specific folder in Google Drive or a shared drive.',
  parameters: z.object({
    folderId: z.string().describe('ID of the folder to list contents of. Use "root" for the root Drive folder. For shared drives, use the shared drive ID.'),
    includeSubfolders: z.boolean().optional().default(true).describe('Whether to include subfolders in results.'),
    includeFiles: z.boolean().optional().default(true).describe('Whether to include files in results.'),
    maxResults: z.number().int().min(1).max(100).optional().default(50).describe('Maximum number of items to return.'),
    pageToken: z.string().optional().describe('Token from a previous call, to list the next page.'),
  }).merge(SharedDriveParameters),
  execute: async (args, { log, session }) => handleListFolderContents(getDriveClient(session), args, log),
});

driveServer.addTool({
  name: 'getFolderInfo',
  annotations: { readOnlyHint: true },
  description: 'Gets detailed information about a specific folder in Google Drive or a shared drive.',
  parameters: z.object({
    folderId: z.string().describe('ID of the folder to get information about.'),
  }),
  execute: async (args, { log, session }) => handleGetFolderInfo(getDriveClient(session), args, log),
});

driveServer.addTool({
  name: 'moveFile',
  annotations: { readOnlyHint: false },
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
  annotations: { readOnlyHint: false },
  description: 'Creates a copy of an existing Google Drive file or document (works with shared drives). For a brand-new blank document, use createDocument instead.',
  parameters: z.object({
    fileId: z.string().describe('ID of the file to copy.'),
    newName: z.string().optional().describe('Name for the copied file. If not provided, will use "Copy of [original name]".'),
    parentFolderId: z.string().optional().describe('ID of folder where copy should be placed. If not provided, places in same location as original. For shared drives, use a folder ID within the shared drive.'),
  }),
  execute: async (args, { log, session }) => handleCopyFile(getDriveClient(session), args, log),
});

driveServer.addTool({
  name: 'renameFile',
  annotations: { readOnlyHint: false },
  description: 'Renames a file or folder in Google Drive (works with shared drives).',
  parameters: z.object({
    fileId: z.string().describe('ID of the file or folder to rename.'),
    newName: z.string().min(1).describe('New name for the file or folder.'),
  }),
  execute: async (args, { log, session }) => handleRenameFile(getDriveClient(session), args, log),
});

driveServer.addTool({
  name: 'deleteFile',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Permanently deletes a file or folder from Google Drive (works with shared drives).',
  parameters: z.object({
    fileId: z.string().describe('ID of the file or folder to delete.'),
    skipTrash: z.boolean().optional().default(false).describe('If true, permanently deletes the file. If false, moves to trash (can be restored).'),
  }),
  execute: async (args, { log, session }) => handleDeleteFile(getDriveClient(session), args, log),
});

driveServer.addTool({
  name: 'createDocument',
  annotations: { readOnlyHint: false },
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
  annotations: { readOnlyHint: false },
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
  annotations: { readOnlyHint: true },
  description: 'Lists shared drives (Team Drives) the user has access to.',
  parameters: z.object({
    maxResults: z.number().int().min(1).max(100).optional().default(20).describe('Maximum number of shared drives to return (1-100).'),
    query: z.string().optional().describe('Filter shared drives by name (case insensitive partial match).'),
  }),
  execute: async (args, { log, session }) => handleListSharedDrives(getDriveClient(session), args, log),
});

driveServer.addTool({
  name: 'downloadDriveFile',
  annotations: { readOnlyHint: true },
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
  annotations: { readOnlyHint: true },
  description: 'Retrieve all permissions on a Google Drive file or folder. Shows who has access, their roles, and sharing status.',
  parameters: z.object({
    fileId: z.string().describe('The Drive file or folder ID.'),
  }),
  execute: async (args, { log, session }) => (await handleGetFilePermissions(getDriveClient(session), args, log)) as string,
});

driveServer.addTool({
  name: 'shareDriveFile',
  annotations: { readOnlyHint: false },
  description: 'Share a Google Drive file or folder by creating a permission. Required fields by type: type=user|group → emailAddress; type=domain → domain; type=anyone → no extra field.',
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
  annotations: { readOnlyHint: true },
  description: 'List the file\'s direct permissions and report whether an "anyone with link" grant exists on the file itself. Does NOT follow folder-inherited, domain-wide, or shared-drive policies, so a file inside a public folder may report private here.',
  parameters: z.object({
    fileId: z.string().describe('The Drive file ID to check.'),
  }),
  execute: async (args, { log, session }) => (await handleCheckPublicAccess(getDriveClient(session), args, log)) as string,
});

/** One line per file, shared by search and the change feed. */
function fileLine(file: drive_v3.Schema$File): string {
  const modified = file.modifiedTime ? new Date(file.modifiedTime).toISOString().slice(0, 16).replace('T', ' ') : 'unknown';
  const by = file.lastModifyingUser?.displayName ? ` by ${file.lastModifyingUser.displayName}` : '';
  return `**${file.name}** (${file.mimeType})\n   ID: ${file.id} · modified ${modified}${by}${file.driveId ? ' · shared drive' : ''}\n   ${file.webViewLink ?? ''}`;
}

/** Drive errors in Google's own words (403 reason, 404), not a guessed cause. */
function driveFailure(error: any, what: string): never {
  if (error instanceof UserError) throw error;
  throw new UserError(describeDriveError(error, what, 'https://www.googleapis.com/auth/drive'));
}

driveServer.addTool({
  name: 'searchDriveFiles',
  annotations: { readOnlyHint: true },
  description: 'Searches all of Drive (any file type, any folder) by name or content, or lists recently modified files when no query is given. Paginated.',
  parameters: searchDriveFilesSchema,
  execute: async (args, { log, session }) => {
    log.info(`searchDriveFiles: ${args.query ?? '(recent)'} type=${args.mimeType ?? 'any'}`);
    let r: Awaited<ReturnType<typeof performSearchDriveFiles>>;
    try { r = await performSearchDriveFiles(getDriveClient(session), args); } catch (e) { driveFailure(e, 'search Drive'); }
    const more = r.nextPageToken ? `\nMORE results: call again with pageToken "${r.nextPageToken}".` : '';
    const partial = r.incompleteSearch ? '\nDrive could not search every location (incompleteSearch), so files may be missing even without more pages.' : '';
    if (r.files.length === 0) return `No files found.${partial}`;
    return `${r.files.length} file(s), sorted by ${r.sortedBy}:\n\n${r.files.map((f, i) => `${i + 1}. ${fileLine(f)}`).join('\n\n')}${more}${partial}`;
  },
});

driveServer.addTool({
  name: 'listDriveChanges',
  annotations: { readOnlyHint: true },
  description: 'Follows the Drive change feed: what was created, edited, trashed or removed since a token. First call (no pageToken) returns the token to poll with.',
  parameters: listDriveChangesSchema,
  execute: async (args, { log, session }) => {
    log.info(`listDriveChanges: ${args.pageToken ? 'from token' : 'start'}`);
    let r: Awaited<ReturnType<typeof performListDriveChanges>>;
    try { r = await performListDriveChanges(getDriveClient(session), args); } catch (e) { driveFailure(e, 'read the change feed'); }
    if (r.startPageToken) {
      return `Change feed started. Nothing is listed yet: Drive records changes from now on. Call again later with pageToken "${r.startPageToken}".`;
    }
    const lines = r.changes.map((c, i) => {
      const when = c.time ?? 'unknown time';
      if (c.removed || !c.file) return `${i + 1}. ${when} — file ${c.fileId} removed or no longer visible to you`;
      return `${i + 1}. ${when} — ${c.file.trashed ? 'TRASHED ' : ''}${fileLine(c.file)}`;
    });
    const next = r.nextPageToken
      ? `\nMORE changes are waiting: call again now with pageToken "${r.nextPageToken}".`
      : `\nEnd of feed. Poll later with pageToken "${r.newStartPageToken}".`;
    return `${r.changes.length} change(s):\n\n${lines.join('\n') || '(none)'}${next}`;
  },
});

driveServer.addTool({
  name: 'uploadDriveFile',
  annotations: { readOnlyHint: false },
  description: 'Uploads a file (base64 bytes or text) to Drive, optionally converting it into a Google Doc, Sheet or Slides. Up to 20 MB.',
  parameters: uploadDriveFileSchema,
  execute: async (args, { log, session }) => {
    log.info(`uploadDriveFile: ${args.fileName} (${args.sourceMimeType})${args.convertTo ? ` → ${args.convertTo}` : ''}`);
    let r: Awaited<ReturnType<typeof performUploadDriveFile>>;
    try { r = await performUploadDriveFile(getDriveClient(session), args); } catch (e) { driveFailure(e, 'upload the file'); }
    const conversion = args.convertTo
      ? (r.converted ? ` Converted to a Google ${args.convertTo}.` : ` Conversion to a Google ${args.convertTo} was asked for, but Drive stored it as ${r.file.mimeType}.`)
      : '';
    return `Uploaded "${r.file.name}" (${r.bytes} bytes) — ID ${r.file.id}.${conversion}\n${r.file.webViewLink ?? ''}`;
  },
});

export { driveServer };
