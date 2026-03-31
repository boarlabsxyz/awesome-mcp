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

// --- Export format resolution ---

export interface ResolvedExport {
  format: string;
  exportMime: string;
}

export function resolveExportFormat(
  mime: string,
  requestedFormat?: string,
): ResolvedExport | null {
  const workspaceInfo = WORKSPACE_MIME_MAP[mime];
  if (!workspaceInfo) return null;

  const format = requestedFormat || workspaceInfo.defaultFormat;
  const exportMime = workspaceInfo.exports[format];
  if (!exportMime) {
    throw new UserError(
      `Format "${format}" is not supported for this file type (${mime}). Supported: ${Object.keys(workspaceInfo.exports).join(', ')}`,
    );
  }
  return { format, exportMime };
}

// --- Download/export result formatters ---

export function formatExportResult(
  sourceName: string,
  exported: { name?: string | null; id?: string | null; size?: string | null; webViewLink?: string | null },
): string {
  return `File exported successfully:\n  Source: ${sourceName}\n  Exported as: ${exported.name}\n  File ID: ${exported.id}\n  Size: ${exported.size} bytes\n  Link: ${exported.webViewLink}`;
}

export function formatBinaryFileInfo(
  file: { name?: string | null; id?: string | null; mimeType?: string | null; size?: string | null; webContentLink?: string | null; webViewLink?: string | null },
): string {
  return `File: ${file.name || 'Untitled'}\n  File ID: ${file.id}\n  Type: ${file.mimeType}\n  Size: ${file.size || 'Unknown'} bytes\n  Download Link: ${file.webContentLink || 'Not available (file may not be downloadable directly)'}\n  View Link: ${file.webViewLink || 'Not available'}`;
}

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

// --- Format full permissions list for getFilePermissions ---

export function formatPermissionsList(
  file: { name?: string | null; id?: string | null; mimeType?: string | null; shared?: boolean | null; webViewLink?: string | null },
  permissions: drive_v3.Schema$Permission[],
): string {
  let result = `Permissions for "${file.name}" (${file.id}):\n`;
  result += `  Type: ${file.mimeType}\n`;
  result += `  Shared: ${file.shared ? 'Yes' : 'No'}\n`;
  result += `  Link: ${file.webViewLink || 'N/A'}\n\n`;

  if (permissions.length === 0) {
    result += 'No permissions found.';
  } else {
    result += `${permissions.length} permission(s):\n\n`;
    permissions.forEach((perm, index) => {
      result += formatPermission(perm, index);
    });
  }

  return result;
}

// --- Share parameter validation ---

export interface ShareArgs {
  type: string;
  emailAddress?: string;
  domain?: string;
  expirationTime?: string;
}

export function validateShareArgs(args: ShareArgs): void {
  if ((args.type === 'user' || args.type === 'group') && !args.emailAddress) {
    throw new UserError(`emailAddress is required when sharing with type "${args.type}".`);
  }
  if (args.type === 'domain' && !args.domain) {
    throw new UserError('domain is required when sharing with type "domain".');
  }
  const isUserOrGroup = args.type === 'user' || args.type === 'group';
  if (args.expirationTime && !isUserOrGroup) {
    throw new UserError(`expirationTime is only supported for type "user" or "group", not "${args.type}".`);
  }
}

// --- Resolve share target label ---

export function formatShareTarget(type: string, emailAddress?: string, domain?: string): string {
  if (type === 'anyone') return 'anyone with the link';
  if (type === 'domain') return `domain ${domain}`;
  return emailAddress || 'unknown';
}

// --- Format public access check result ---

export function formatPublicAccessResult(
  file: { name?: string | null; id?: string | null; mimeType?: string | null; shared?: boolean | null; webViewLink?: string | null },
  permissions: drive_v3.Schema$Permission[],
): string {
  const publicPerm = permissions.find(p => p.type === 'anyone');
  const isPublic = !!publicPerm;

  let result = `File: ${file.name} (${file.id})\n`;
  result += `Type: ${file.mimeType}\n`;
  result += `Public Access: ${isPublic ? `YES — anyone with the link has "${publicPerm!.role}" access` : 'NO — not publicly shared'}\n`;
  result += `Shared: ${file.shared ? 'Yes' : 'No'}\n`;
  result += `Total permissions: ${permissions.length}\n`;

  if (isPublic && file.webViewLink) {
    result += `\nPublic Link: ${file.webViewLink}`;
  }

  const otherPerms = permissions.filter(p => p.type !== 'anyone');
  if (otherPerms.length > 0) {
    result += `\n\nOther permissions:\n`;
    result += summarizePermissions(otherPerms);
  }

  return result;
}
