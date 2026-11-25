// src/google-drive/restRoutes.ts
// The Drive REST writes as data: one descriptor per endpoint, which webServer.ts
// registers from a loop. Same shape and reasons as src/google-gmail/restRoutes.ts.
// Every request is validated with the MCP tool's own schema and goes through
// the same perform* function the tool calls.
//
// POST /drive/folders and /drive/files/:fileId/copy were served long before they
// were catalogued, as ChatGPT Custom Actions compat, so their paths, bodies, 200
// status and response keys stay as they were. Upload and the resumable upload
// session have their own handlers in webServer.ts.

import type { docs_v1, drive_v3 } from 'googleapis';
import type { ZodTypeAny } from 'zod';

import {
  copyFileSchema, createDocumentSchema, createFolderSchema, createFromTemplateSchema, moveFileSchema, renameFileSchema,
  shareDriveFileSchema, trashFileRestSchema,
} from './schemas.js';
import {
  performCopyFile, performCreateDocument, performCreateFolder, performCreateFromTemplate, performMoveFile, performRenameFile,
  performShareDriveFile, performTrashFile,
} from './toolHandlers.js';

/** The parts of an Express request a descriptor reads. */
export interface DriveRestRequest {
  params: Record<string, string | string[] | undefined>;
  body?: unknown;
}

/** The session clients a Drive write can need; createFromTemplate also edits the new Doc. */
export interface DriveRestClients {
  googleDrive: drive_v3.Drive;
  googleDocs: docs_v1.Docs;
}

export interface DriveWriteResult {
  status: number;
  body: unknown;
}

export interface DriveWriteRoute {
  path: string;
  tool: string;
  schema: ZodTypeAny;
  /** Path params, which override same-named body keys. */
  params: (req: DriveRestRequest) => Record<string, unknown>;
  run: (clients: DriveRestClients, args: any) => Promise<DriveWriteResult>;
  notFound: string;
  fallback: string;
}

const param = (req: DriveRestRequest, name: string): string => {
  const v = req.params[name];
  return Array.isArray(v) ? v.join('/') : (v ?? '');
};

const fileIdParam = (req: DriveRestRequest) => ({ fileId: param(req, 'fileId') });

export const DRIVE_WRITE_ROUTES: ReadonlyArray<DriveWriteRoute> = [
  {
    path: '/api/v1/drive/folders', tool: 'createFolder', schema: createFolderSchema,
    params: () => ({}),
    run: async ({ googleDrive }, args) => ({ status: 200, body: await performCreateFolder(googleDrive, args) }),
    notFound: 'Parent folder not found', fallback: 'Failed to create folder',
  },
  {
    path: '/api/v1/drive/documents', tool: 'createDocument', schema: createDocumentSchema,
    params: () => ({}),
    run: async ({ googleDrive, googleDocs }, args) => {
      const { document, initialContent } = await performCreateDocument(googleDrive, () => googleDocs, args);
      // 201 even when the content insert failed: the document exists either
      // way. initialContentWritten is three-valued: null when none was sent.
      return {
        status: 201,
        body: {
          ...document,
          initialContentWritten: initialContent ? initialContent.written : null,
          ...(initialContent && !initialContent.written ? { initialContentError: initialContent.error } : {}),
        },
      };
    },
    notFound: 'Parent folder not found', fallback: 'Failed to create document',
  },
  {
    path: '/api/v1/drive/templates/:templateId/documents', tool: 'createFromTemplate', schema: createFromTemplateSchema,
    params: (req) => ({ templateId: param(req, 'templateId') }),
    run: async ({ googleDrive, googleDocs }, args) => {
      const { document, replacements } = await performCreateFromTemplate(googleDrive, () => googleDocs, args);
      // 201 even when the replacements failed: the document exists either way,
      // and `replacements` says what happened to them.
      return { status: 201, body: { ...document, replacements } };
    },
    notFound: 'Template or parent folder not found', fallback: 'Failed to create document from template',
  },
  {
    path: '/api/v1/drive/files/:fileId/copy', tool: 'copyFile', schema: copyFileSchema,
    params: fileIdParam,
    run: async ({ googleDrive }, args) => ({ status: 200, body: await performCopyFile(googleDrive, args) }),
    notFound: 'File or destination folder not found', fallback: 'Failed to copy file',
  },
  {
    path: '/api/v1/drive/files/:fileId/move', tool: 'moveFile', schema: moveFileSchema,
    params: fileIdParam,
    run: async ({ googleDrive }, args) => {
      const { file, action } = await performMoveFile(googleDrive, args);
      // Without removeFromAllParents the tool copies, which creates a new file.
      return { status: action === 'copied' ? 201 : 200, body: { ...file, action } };
    },
    notFound: 'File or destination folder not found', fallback: 'Failed to move file',
  },
  {
    path: '/api/v1/drive/files/:fileId/rename', tool: 'renameFile', schema: renameFileSchema,
    params: fileIdParam,
    run: async ({ googleDrive }, args) => ({ status: 200, body: await performRenameFile(googleDrive, args) }),
    notFound: 'File not found', fallback: 'Failed to rename file',
  },
  {
    path: '/api/v1/drive/files/:fileId/trash', tool: 'deleteFile', schema: trashFileRestSchema,
    params: fileIdParam,
    run: async ({ googleDrive }, args) => {
      const file = await performTrashFile(googleDrive, args.fileId);
      // Drive answers with the file it updated, so its `trashed` is the proof.
      if (file.trashed !== true) {
        return { status: 502, body: { error: 'Drive accepted the request but the file is not in the trash.', file } };
      }
      return { status: 200, body: file };
    },
    notFound: 'File not found', fallback: 'Failed to trash file',
  },
  {
    path: '/api/v1/drive/files/:fileId/permissions', tool: 'shareDriveFile', schema: shareDriveFileSchema,
    params: fileIdParam,
    run: async ({ googleDrive }, args) => ({ status: 201, body: await performShareDriveFile(googleDrive, args) }),
    notFound: 'File not found', fallback: 'Failed to share file',
  },
];

/** The body merged with the path params, which win: the URL names the record. */
export function writeArgs(route: DriveWriteRoute, req: DriveRestRequest): Record<string, unknown> {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
  return { ...body, ...route.params(req) };
}
