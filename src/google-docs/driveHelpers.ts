// src/google-docs/driveHelpers.ts
import { drive_v3 } from 'googleapis';
import { UserError } from 'fastmcp';

type Drive = drive_v3.Drive;

// --- Workspace mime type mapping for export ---

export interface WorkspaceExportInfo {
  defaultFormat: string;
  exports: Record<string, string>;
}

export const WORKSPACE_MIME_MAP: Record<string, WorkspaceExportInfo> = {
  'application/vnd.google-apps.document': {
    defaultFormat: 'pdf',
    exports: {
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
  },
  'application/vnd.google-apps.spreadsheet': {
    defaultFormat: 'xlsx',
    exports: {
      pdf: 'application/pdf',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      csv: 'text/csv',
    },
  },
  'application/vnd.google-apps.presentation': {
    defaultFormat: 'pptx',
    exports: {
      pdf: 'application/pdf',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    },
  },
};

// --- Fetch file info + permissions in parallel ---

export interface FileWithPermissions {
  file: drive_v3.Schema$File;
  permissions: drive_v3.Schema$Permission[];
}

export async function getFileAndPermissions(
  drive: Drive,
  fileId: string,
  fileFields: string,
  permissionFields: string,
): Promise<FileWithPermissions> {
  // Ensure nextPageToken is in fields so pagination works
  const paginatedFields = permissionFields.includes('nextPageToken')
    ? permissionFields
    : `nextPageToken,${permissionFields}`;

  // Start file info fetch in parallel with the first permissions page
  const [fileInfo, firstPage] = await Promise.all([
    drive.files.get({
      fileId,
      supportsAllDrives: true,
      fields: fileFields,
    }),
    drive.permissions.list({
      fileId,
      supportsAllDrives: true,
      fields: paginatedFields,
    }),
  ]);

  const allPermissions: drive_v3.Schema$Permission[] = [
    ...(firstPage.data.permissions || []),
  ];

  // Fetch remaining pages if any
  let nextPageToken = firstPage.data.nextPageToken;
  while (nextPageToken) {
    const nextPage = await drive.permissions.list({
      fileId,
      supportsAllDrives: true,
      fields: paginatedFields,
      pageToken: nextPageToken,
    });
    allPermissions.push(...(nextPage.data.permissions || []));
    nextPageToken = nextPage.data.nextPageToken;
  }

  return {
    file: fileInfo.data,
    permissions: allPermissions,
  };
}

// --- Common Drive error handler ---

export function handleDriveError(error: any, context: string, fileId: string): never {
  if (error.code === 404) throw new UserError(`File not found (ID: ${fileId}).`);
  if (error.code === 403) throw new UserError(`Permission denied. You don't have access to ${context} this file.`);
  throw new UserError(`Failed to ${context}: ${error.message || 'Unknown error'}`);
}

// --- Format a permission entry as a readable string ---

export function formatPermission(perm: drive_v3.Schema$Permission, index: number): string {
  let result = `${index + 1}. **${perm.role}** — `;
  if (perm.type === 'anyone') {
    result += 'Anyone with the link';
  } else if (perm.type === 'domain') {
    result += 'Domain';
  } else {
    const principal = perm.displayName || perm.emailAddress || 'Unknown';
    result += principal;
    if (perm.displayName && perm.emailAddress) result += ` (${perm.emailAddress})`;
  }
  result += `\n   Type: ${perm.type}`;
  if (perm.expirationTime) result += `\n   Expires: ${perm.expirationTime}`;
  if (perm.deleted) result += `\n   (Deleted user)`;
  result += '\n';
  return result;
}

// --- Summarize permissions by type/role ---

export function summarizePermissions(permissions: drive_v3.Schema$Permission[]): string {
  const typeCounts: Record<string, number> = {};
  for (const p of permissions) {
    const key = `${p.type}/${p.role}`;
    typeCounts[key] = (typeCounts[key] || 0) + 1;
  }
  return Object.entries(typeCounts)
    .map(([key, count]) => `  ${count}x ${key}`)
    .join('\n');
}
