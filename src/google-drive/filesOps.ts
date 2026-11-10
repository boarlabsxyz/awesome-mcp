// Drive-wide file search, the change feed, and file upload with conversion.
//
// Schemas and ops live here rather than in server.ts so the REST routes under
// /api/v1/drive/* validate with the same schemas and run the same code as the
// MCP tools. Ops return data; the tool renders text, the route returns JSON.

import { Readable } from 'node:stream';
import { z } from 'zod';
import { drive_v3 } from 'googleapis';
import { UserError } from 'fastmcp';
import { SharedDriveParameters } from '../types.js';
import { buildSharedDriveParams, escapeDriveQueryLiteral } from './toolHandlers.js';

type Drive = drive_v3.Drive;

/** Friendly names for the MIME types people filter by most. Anything else is passed as a raw MIME type. */
const MIME_ALIASES: Record<string, string> = {
  document: 'application/vnd.google-apps.document',
  spreadsheet: 'application/vnd.google-apps.spreadsheet',
  presentation: 'application/vnd.google-apps.presentation',
  folder: 'application/vnd.google-apps.folder',
  form: 'application/vnd.google-apps.form',
  pdf: 'application/pdf',
};

const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,createdTime,webViewLink,owners(displayName),lastModifyingUser(displayName),parents,driveId';

// === Search ===

export const searchDriveFilesSchema = z.object({
  query: z.string().min(1).optional()
    .describe('Text to look for. Omit to list the most recently modified files.'),
  searchIn: z.enum(['name', 'content', 'both']).optional().default('both')
    .describe('Match the query against file names, file content, or both.'),
  mimeType: z.string().optional()
    .describe('Optional type filter: document, spreadsheet, presentation, folder, form, pdf, or any MIME type (e.g. "image/png").'),
  modifiedAfter: z.string().optional().describe('Only files modified after this RFC 3339 time, e.g. "2026-11-01T00:00:00Z".'),
  includeTrashed: z.boolean().optional().default(false).describe('Include files in the trash.'),
  maxResults: z.number().int().min(1).max(100).optional().default(25).describe('Files per page (1-100).'),
  pageToken: z.string().optional().describe('nextPageToken from a previous call, to get the next page.'),
}).merge(SharedDriveParameters);

export type SearchDriveFilesArgs = z.infer<typeof searchDriveFilesSchema>;

export async function performSearchDriveFiles(drive: Drive, args: SearchDriveFilesArgs) {
  const clauses: string[] = [];
  if (!args.includeTrashed) clauses.push('trashed=false');
  if (args.mimeType) clauses.push(`mimeType='${escapeDriveQueryLiteral(MIME_ALIASES[args.mimeType] ?? args.mimeType)}'`);
  if (args.modifiedAfter) clauses.push(`modifiedTime > '${escapeDriveQueryLiteral(args.modifiedAfter)}'`);
  const usesFullText = Boolean(args.query) && args.searchIn !== 'name';
  if (args.query) {
    const q = escapeDriveQueryLiteral(args.query);
    clauses.push(args.searchIn === 'name' ? `name contains '${q}'`
      : args.searchIn === 'content' ? `fullText contains '${q}'`
      : `(name contains '${q}' or fullText contains '${q}')`);
  }

  const response = await drive.files.list({
    q: clauses.join(' and ') || undefined,
    pageSize: args.maxResults,
    // Drive refuses any orderBy on a query with a fullText term (results come
    // back by relevance), so only name-only and query-less listings are sorted.
    ...(usesFullText ? {} : { orderBy: 'modifiedTime desc' }),
    ...(args.pageToken ? { pageToken: args.pageToken } : {}),
    fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`,
    ...buildSharedDriveParams(args),
  });
  return {
    files: response.data.files ?? [],
    nextPageToken: response.data.nextPageToken ?? null,
    // Drive sets this when it could not search every corpus (common with
    // allDrives): the page is not the whole answer even without a next page.
    incompleteSearch: Boolean(response.data.incompleteSearch),
    sortedBy: usesFullText ? 'relevance' : 'modifiedTime desc',
  };
}

// === Change feed ===

export const listDriveChangesSchema = z.object({
  pageToken: z.string().optional()
    .describe('Token from a previous call (newStartPageToken or nextPageToken). Omit on the first call to get a starting token: changes are recorded from that moment on.'),
  maxResults: z.number().int().min(1).max(1000).optional().default(100).describe('Changes per page (1-1000).'),
  driveId: z.string().optional().describe('Optional shared drive ID, to follow that drive instead of My Drive.'),
});

export type ListDriveChangesArgs = z.infer<typeof listDriveChangesSchema>;

export async function performListDriveChanges(drive: Drive, args: ListDriveChangesArgs) {
  const driveParams = args.driveId
    ? { driveId: args.driveId, supportsAllDrives: true, includeItemsFromAllDrives: true }
    : { supportsAllDrives: true, includeItemsFromAllDrives: true };

  // The feed only reports what happens after a token was issued, so a first
  // call cannot list anything: it hands back the token to poll with.
  if (!args.pageToken) {
    const start = await drive.changes.getStartPageToken({
      ...(args.driveId ? { driveId: args.driveId } : {}),
      supportsAllDrives: true,
    });
    if (!start.data.startPageToken) throw new Error('Google returned no start page token.');
    return { changes: [], startPageToken: start.data.startPageToken, nextPageToken: null, newStartPageToken: null };
  }

  const response = await drive.changes.list({
    pageToken: args.pageToken,
    pageSize: args.maxResults,
    ...driveParams,
    fields: `nextPageToken,newStartPageToken,changes(changeType,time,removed,fileId,file(${FILE_FIELDS},trashed))`,
  });
  return {
    changes: response.data.changes ?? [],
    startPageToken: null,
    // nextPageToken: more changes are waiting now. newStartPageToken: this is
    // the end of the feed; keep it and poll with it later.
    nextPageToken: response.data.nextPageToken ?? null,
    newStartPageToken: response.data.newStartPageToken ?? null,
  };
}

// === Upload ===

const CONVERT_TARGETS = {
  document: 'application/vnd.google-apps.document',
  spreadsheet: 'application/vnd.google-apps.spreadsheet',
  presentation: 'application/vnd.google-apps.presentation',
} as const;

/** Decoded size cap. Matches the image upload path; larger files belong in a resumable upload outside a chat. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export const uploadDriveFileSchema = z.object({
  fileName: z.string().min(1).describe('Name for the file in Drive, e.g. "budget.xlsx".'),
  sourceMimeType: z.string().min(1).describe('MIME type of the content, e.g. "text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/pdf".'),
  contentBase64: z.string().min(1).optional().describe('The file bytes, base64-encoded. Give this or textContent.'),
  textContent: z.string().optional().describe('The file as UTF-8 text (CSV, Markdown, HTML, plain text). Give this or contentBase64.'),
  parentFolderId: z.string().optional().describe('Folder (or shared drive) to put it in. Defaults to My Drive root.'),
  convertTo: z.enum(['document', 'spreadsheet', 'presentation']).optional()
    .describe('Convert into a native Google Doc, Sheet or Slides file. Checked against what Drive can import from sourceMimeType.'),
});

export type UploadDriveFileArgs = z.infer<typeof uploadDriveFileSchema>;

export async function performUploadDriveFile(drive: Drive, args: UploadDriveFileArgs) {
  if ((args.contentBase64 === undefined) === (args.textContent === undefined)) {
    throw new UserError('Give exactly one of contentBase64 or textContent.');
  }
  const bytes = args.contentBase64 !== undefined
    ? Buffer.from(args.contentBase64, 'base64')
    : Buffer.from(args.textContent!, 'utf8');
  if (args.contentBase64 !== undefined && bytes.length === 0) throw new UserError('contentBase64 decoded to zero bytes.');
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new UserError(`The file is ${bytes.length} bytes; the limit here is ${MAX_UPLOAD_BYTES} (20 MB).`);
  }

  let targetMimeType: string | undefined;
  if (args.convertTo) {
    targetMimeType = CONVERT_TARGETS[args.convertTo];
    // Drive silently stores an unconvertible upload as the original type, so
    // the conversion is checked first rather than reported as done.
    const about = await drive.about.get({ fields: 'importFormats' });
    const allowed = about.data.importFormats?.[args.sourceMimeType] ?? [];
    if (!allowed.includes(targetMimeType)) {
      throw new UserError(`Drive cannot convert ${args.sourceMimeType} into a Google ${args.convertTo}. `
        + (allowed.length ? `It can convert it into: ${allowed.join(', ')}.` : 'It cannot convert that type at all; upload it without convertTo.'));
    }
  }

  const response = await drive.files.create({
    requestBody: {
      name: args.fileName,
      ...(targetMimeType ? { mimeType: targetMimeType } : {}),
      ...(args.parentFolderId ? { parents: [args.parentFolderId] } : {}),
    },
    media: { mimeType: args.sourceMimeType, body: Readable.from(bytes) },
    supportsAllDrives: true,
    fields: 'id,name,mimeType,size,webViewLink,parents,driveId',
  });
  const file = response.data;
  if (!file.id) throw new Error('Drive accepted the upload but returned no file ID.');
  return {
    file,
    bytes: bytes.length,
    converted: Boolean(targetMimeType) && file.mimeType === targetMimeType,
  };
}
