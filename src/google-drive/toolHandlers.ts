// src/google-drive/toolHandlers.ts
// Pure tool handler functions for Google Drive — testable with mocked clients.
import { UserError } from 'fastmcp';
import { docs_v1, drive_v3 } from 'googleapis';
import {
  resolveExportFormat,
  formatExportResult,
  formatBinaryFileInfo,
  getFileAndPermissions,
  handleDriveError,
  formatPermissionsList,
  validateShareArgs,
  formatShareTarget,
  formatPublicAccessResult,
} from './driveHelpers.js';

type Log = { info: (msg: string) => void; error: (msg: string) => void; warn: (msg: string) => void };

// --- Session client getters ---
export function getDriveClient(session?: { googleDrive?: drive_v3.Drive }): drive_v3.Drive {
  if (session?.googleDrive) return session.googleDrive;
  throw new UserError("Google Drive client is not available. Make sure you have granted drive access.");
}

export function getDocsClient(session?: { googleDocs?: docs_v1.Docs }): docs_v1.Docs {
  if (session?.googleDocs) return session.googleDocs;
  throw new UserError("Google Docs client is not available. Make sure you have granted documents access.");
}

// --- Shared drive query builder ---
export interface SharedDriveArgs {
  includeSharedDrives?: boolean;
  driveId?: string;
  corpora?: 'user' | 'drive' | 'allDrives' | 'domain';
}

export function buildSharedDriveParams(args: SharedDriveArgs): Record<string, any> {
  const supportsAllDrives = args.includeSharedDrives !== false;
  const params: any = { supportsAllDrives };
  if (supportsAllDrives) params.includeItemsFromAllDrives = true;
  if (args.driveId) {
    params.driveId = args.driveId;
    params.corpora = 'drive';
  } else if (args.corpora) {
    params.corpora = args.corpora;
  } else if (supportsAllDrives) {
    params.corpora = 'allDrives';
  }
  return params;
}

// --- Listing/search formatters ---
function formatFileListEntry(file: drive_v3.Schema$File, index: number, opts: { showModifiedFull?: boolean; lastModifier?: string } = {}): string {
  const modifiedDate = file.modifiedTime
    ? (opts.showModifiedFull ? new Date(file.modifiedTime).toLocaleString() : new Date(file.modifiedTime).toLocaleDateString())
    : 'Unknown';
  const owner = file.owners?.[0]?.displayName || 'Unknown';
  const driveInfo = file.driveId ? ` (Shared Drive)` : '';
  let result = `${index + 1}. **${file.name}**${driveInfo}\n`;
  result += `   ID: ${file.id}\n`;
  if (opts.lastModifier) {
    result += `   Last Modified: ${modifiedDate} by ${opts.lastModifier}\n`;
  } else {
    result += `   Modified: ${modifiedDate}\n`;
  }
  result += `   Owner: ${owner}\n`;
  if (file.driveId) result += `   Drive ID: ${file.driveId}\n`;
  result += `   Link: ${file.webViewLink}\n\n`;
  return result;
}

// --- Handlers ---

export async function handleListGoogleDocs(
  drive: drive_v3.Drive,
  args: { maxResults: number; query?: string; orderBy: 'name' | 'modifiedTime' | 'createdTime' } & SharedDriveArgs,
  log: Log
): Promise<string> {
  log.info(`Listing Google Docs. Query: ${args.query || 'none'}, Max: ${args.maxResults}, Order: ${args.orderBy}`);
  try {
    let queryString = "mimeType='application/vnd.google-apps.document' and trashed=false";
    if (args.query) {
      queryString += ` and (name contains '${args.query}' or fullText contains '${args.query}')`;
    }
    const response = await drive.files.list({
      q: queryString,
      pageSize: args.maxResults,
      orderBy: args.orderBy === 'name' ? 'name' : args.orderBy,
      fields: 'files(id,name,modifiedTime,createdTime,size,webViewLink,owners(displayName,emailAddress),driveId)',
      ...buildSharedDriveParams(args),
    });
    const files = response.data.files || [];
    if (files.length === 0) return "No Google Docs found matching your criteria.";
    let result = `Found ${files.length} Google Document(s):\n\n`;
    files.forEach((file, index) => { result += formatFileListEntry(file, index); });
    return result;
  } catch (error: any) {
    log.error(`Error listing Google Docs: ${error.message || error}`);
    if (error.code === 403) throw new UserError("Permission denied. Make sure you have granted Google Drive access to the application.");
    throw new UserError(`Failed to list documents: ${error.message || 'Unknown error'}`);
  }
}

export async function handleSearchGoogleDocs(
  drive: drive_v3.Drive,
  args: { searchQuery: string; searchIn: 'name' | 'content' | 'both'; maxResults: number; modifiedAfter?: string } & SharedDriveArgs,
  log: Log
): Promise<string> {
  log.info(`Searching Google Docs for: "${args.searchQuery}" in ${args.searchIn}`);
  try {
    let queryString = "mimeType='application/vnd.google-apps.document' and trashed=false";
    if (args.searchIn === 'name') {
      queryString += ` and name contains '${args.searchQuery}'`;
    } else if (args.searchIn === 'content') {
      queryString += ` and fullText contains '${args.searchQuery}'`;
    } else {
      queryString += ` and (name contains '${args.searchQuery}' or fullText contains '${args.searchQuery}')`;
    }
    if (args.modifiedAfter) queryString += ` and modifiedTime > '${args.modifiedAfter}'`;
    const response = await drive.files.list({
      q: queryString,
      pageSize: args.maxResults,
      orderBy: 'modifiedTime desc',
      fields: 'files(id,name,modifiedTime,createdTime,webViewLink,owners(displayName),parents,driveId)',
      ...buildSharedDriveParams(args),
    });
    const files = response.data.files || [];
    if (files.length === 0) return `No Google Docs found containing "${args.searchQuery}".`;
    let result = `Found ${files.length} document(s) matching "${args.searchQuery}":\n\n`;
    files.forEach((file, index) => { result += formatFileListEntry(file, index); });
    return result;
  } catch (error: any) {
    log.error(`Error searching Google Docs: ${error.message || error}`);
    if (error.code === 403) throw new UserError("Permission denied. Make sure you have granted Google Drive access to the application.");
    throw new UserError(`Failed to search documents: ${error.message || 'Unknown error'}`);
  }
}

export async function handleGetRecentGoogleDocs(
  drive: drive_v3.Drive,
  args: { maxResults: number; daysBack: number } & SharedDriveArgs,
  log: Log
): Promise<string> {
  log.info(`Getting recent Google Docs: ${args.maxResults} results, ${args.daysBack} days back`);
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - args.daysBack);
    const queryString = `mimeType='application/vnd.google-apps.document' and trashed=false and modifiedTime > '${cutoffDate.toISOString()}'`;
    const response = await drive.files.list({
      q: queryString,
      pageSize: args.maxResults,
      orderBy: 'modifiedTime desc',
      fields: 'files(id,name,modifiedTime,createdTime,webViewLink,owners(displayName),lastModifyingUser(displayName),driveId)',
      ...buildSharedDriveParams(args),
    });
    const files = response.data.files || [];
    if (files.length === 0) return `No Google Docs found that were modified in the last ${args.daysBack} days.`;
    let result = `${files.length} recently modified Google Document(s) (last ${args.daysBack} days):\n\n`;
    files.forEach((file, index) => {
      const lastModifier = file.lastModifyingUser?.displayName || 'Unknown';
      result += formatFileListEntry(file, index, { showModifiedFull: true, lastModifier });
    });
    return result;
  } catch (error: any) {
    log.error(`Error getting recent Google Docs: ${error.message || error}`);
    if (error.code === 403) throw new UserError("Permission denied. Make sure you have granted Google Drive access to the application.");
    throw new UserError(`Failed to get recent documents: ${error.message || 'Unknown error'}`);
  }
}

export async function handleGetDocumentInfo(
  drive: drive_v3.Drive,
  args: { documentId: string },
  log: Log
): Promise<string> {
  log.info(`Getting info for document: ${args.documentId}`);
  try {
    const response = await drive.files.get({
      fileId: args.documentId,
      supportsAllDrives: true,
      fields: 'id,name,description,mimeType,size,createdTime,modifiedTime,webViewLink,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress),shared,parents,version,driveId',
    });
    const file = response.data;
    if (!file) throw new UserError(`Document with ID ${args.documentId} not found.`);
    const createdDate = file.createdTime ? new Date(file.createdTime).toLocaleString() : 'Unknown';
    const modifiedDate = file.modifiedTime ? new Date(file.modifiedTime).toLocaleString() : 'Unknown';
    const owner = file.owners?.[0];
    const lastModifier = file.lastModifyingUser;
    let result = `**Document Information:**\n\n`;
    result += `**Name:** ${file.name}\n**ID:** ${file.id}\n**Type:** Google Document\n`;
    if (file.driveId) result += `**Location:** Shared Drive (ID: ${file.driveId})\n`;
    result += `**Created:** ${createdDate}\n**Last Modified:** ${modifiedDate}\n`;
    if (owner) result += `**Owner:** ${owner.displayName} (${owner.emailAddress})\n`;
    if (lastModifier) result += `**Last Modified By:** ${lastModifier.displayName} (${lastModifier.emailAddress})\n`;
    result += `**Shared:** ${file.shared ? 'Yes' : 'No'}\n**View Link:** ${file.webViewLink}\n`;
    if (file.description) result += `**Description:** ${file.description}\n`;
    return result;
  } catch (error: any) {
    if (error instanceof UserError) throw error;
    log.error(`Error getting document info: ${error.message || error}`);
    if (error.code === 404) throw new UserError(`Document not found (ID: ${args.documentId}).`);
    if (error.code === 403) throw new UserError("Permission denied. Make sure you have access to this document.");
    throw new UserError(`Failed to get document info: ${error.message || 'Unknown error'}`);
  }
}

export async function handleCreateFolder(
  drive: drive_v3.Drive,
  args: { name: string; parentFolderId?: string },
  log: Log
): Promise<string> {
  log.info(`Creating folder "${args.name}" ${args.parentFolderId ? `in parent ${args.parentFolderId}` : 'in root'}`);
  try {
    const folderMetadata: drive_v3.Schema$File = {
      name: args.name,
      mimeType: 'application/vnd.google-apps.folder',
    };
    if (args.parentFolderId) folderMetadata.parents = [args.parentFolderId];
    const response = await drive.files.create({
      requestBody: folderMetadata,
      supportsAllDrives: true,
      fields: 'id,name,parents,webViewLink,driveId',
    });
    const folder = response.data;
    const locationInfo = folder.driveId ? ` in shared drive (ID: ${folder.driveId})` : '';
    return `Successfully created folder "${folder.name}" (ID: ${folder.id})${locationInfo}\nLink: ${folder.webViewLink}`;
  } catch (error: any) {
    log.error(`Error creating folder: ${error.message || error}`);
    if (error.code === 404) throw new UserError("Parent folder not found. Check the parent folder ID.");
    if (error.code === 403) throw new UserError("Permission denied. Make sure you have write access to the parent folder.");
    throw new UserError(`Failed to create folder: ${error.message || 'Unknown error'}`);
  }
}

export async function handleListFolderContents(
  drive: drive_v3.Drive,
  args: { folderId: string; includeSubfolders: boolean; includeFiles: boolean; maxResults: number } & SharedDriveArgs,
  log: Log
): Promise<string> {
  log.info(`Listing contents of folder: ${args.folderId}`);
  if (!args.includeSubfolders && !args.includeFiles) {
    throw new UserError("At least one of includeSubfolders or includeFiles must be true.");
  }
  try {
    let queryString = `'${args.folderId}' in parents and trashed=false`;
    if (!args.includeSubfolders) queryString += ` and mimeType!='application/vnd.google-apps.folder'`;
    else if (!args.includeFiles) queryString += ` and mimeType='application/vnd.google-apps.folder'`;
    const response = await drive.files.list({
      q: queryString,
      pageSize: args.maxResults,
      orderBy: 'folder,name',
      fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,owners(displayName),driveId)',
      ...buildSharedDriveParams(args),
    });
    const items = response.data.files || [];
    if (items.length === 0) return "The folder is empty or you don't have permission to view its contents.";
    let result = `Contents of folder (${items.length} item${items.length !== 1 ? 's' : ''}):\n\n`;
    const folders = items.filter(i => i.mimeType === 'application/vnd.google-apps.folder');
    const files = items.filter(i => i.mimeType !== 'application/vnd.google-apps.folder');
    if (folders.length > 0 && args.includeSubfolders) {
      result += `**Folders (${folders.length}):**\n`;
      folders.forEach(folder => {
        const driveInfo = folder.driveId ? ' (Shared Drive)' : '';
        result += `📁 ${folder.name}${driveInfo} (ID: ${folder.id})\n`;
      });
      result += '\n';
    }
    if (files.length > 0 && args.includeFiles) {
      result += `**Files (${files.length}):\n`;
      files.forEach(file => {
        const fileType = file.mimeType === 'application/vnd.google-apps.document' ? '📄'
          : file.mimeType === 'application/vnd.google-apps.spreadsheet' ? '📊'
          : file.mimeType === 'application/vnd.google-apps.presentation' ? '📈' : '📎';
        const modifiedDate = file.modifiedTime ? new Date(file.modifiedTime).toLocaleDateString() : 'Unknown';
        const owner = file.owners?.[0]?.displayName || 'Unknown';
        const driveInfo = file.driveId ? ' (Shared Drive)' : '';
        result += `${fileType} ${file.name}${driveInfo}\n   ID: ${file.id}\n   Modified: ${modifiedDate} by ${owner}\n`;
        if (file.driveId) result += `   Drive ID: ${file.driveId}\n`;
        result += `   Link: ${file.webViewLink}\n\n`;
      });
    }
    return result;
  } catch (error: any) {
    if (error instanceof UserError) throw error;
    log.error(`Error listing folder contents: ${error.message || error}`);
    if (error.code === 404) throw new UserError("Folder not found. Check the folder ID.");
    if (error.code === 403) throw new UserError("Permission denied. Make sure you have access to this folder.");
    throw new UserError(`Failed to list folder contents: ${error.message || 'Unknown error'}`);
  }
}

export async function handleGetFolderInfo(
  drive: drive_v3.Drive,
  args: { folderId: string },
  log: Log
): Promise<string> {
  log.info(`Getting folder info: ${args.folderId}`);
  try {
    const response = await drive.files.get({
      fileId: args.folderId,
      supportsAllDrives: true,
      fields: 'id,name,description,createdTime,modifiedTime,webViewLink,owners(displayName,emailAddress),lastModifyingUser(displayName),shared,parents,driveId,mimeType',
    });
    const folder = response.data;
    if (folder.mimeType !== 'application/vnd.google-apps.folder') {
      throw new UserError("The specified ID does not belong to a folder.");
    }
    const createdDate = folder.createdTime ? new Date(folder.createdTime).toLocaleString() : 'Unknown';
    const modifiedDate = folder.modifiedTime ? new Date(folder.modifiedTime).toLocaleString() : 'Unknown';
    const owner = folder.owners?.[0];
    const lastModifier = folder.lastModifyingUser;
    let result = `**Folder Information:**\n\n**Name:** ${folder.name}\n**ID:** ${folder.id}\n`;
    if (folder.driveId) result += `**Location:** Shared Drive (ID: ${folder.driveId})\n`;
    result += `**Created:** ${createdDate}\n**Last Modified:** ${modifiedDate}\n`;
    if (owner) result += `**Owner:** ${owner.displayName} (${owner.emailAddress})\n`;
    if (lastModifier) result += `**Last Modified By:** ${lastModifier.displayName}\n`;
    result += `**Shared:** ${folder.shared ? 'Yes' : 'No'}\n**View Link:** ${folder.webViewLink}\n`;
    if (folder.description) result += `**Description:** ${folder.description}\n`;
    if (folder.parents && folder.parents.length > 0) result += `**Parent Folder ID:** ${folder.parents[0]}\n`;
    return result;
  } catch (error: any) {
    if (error instanceof UserError) throw error;
    log.error(`Error getting folder info: ${error.message || error}`);
    if (error.code === 404) throw new UserError(`Folder not found (ID: ${args.folderId}).`);
    if (error.code === 403) throw new UserError("Permission denied. Make sure you have access to this folder.");
    throw new UserError(`Failed to get folder info: ${error.message || 'Unknown error'}`);
  }
}

export async function handleMoveFile(
  drive: drive_v3.Drive,
  args: { fileId: string; newParentId: string; removeFromAllParents: boolean },
  log: Log
): Promise<string> {
  log.info(`Moving file ${args.fileId} to folder ${args.newParentId}`);
  try {
    const fileInfo = await drive.files.get({
      fileId: args.fileId,
      supportsAllDrives: true,
      fields: 'name,parents',
    });
    const fileName = fileInfo.data.name;
    const currentParents = fileInfo.data.parents || [];
    const updateParams: any = {
      fileId: args.fileId,
      addParents: args.newParentId,
      supportsAllDrives: true,
      fields: 'id,name,parents,driveId',
    };
    if (args.removeFromAllParents && currentParents.length > 0) {
      updateParams.removeParents = currentParents.join(',');
    }
    const response = await drive.files.update(updateParams);
    const action = args.removeFromAllParents ? 'moved' : 'copied';
    const locationInfo = response.data.driveId ? ` (in shared drive ID: ${response.data.driveId})` : '';
    return `Successfully ${action} "${fileName}" to new location${locationInfo}.\nFile ID: ${response.data.id}`;
  } catch (error: any) {
    log.error(`Error moving file: ${error.message || error}`);
    if (error.code === 404) throw new UserError("File or destination folder not found. Check the IDs.");
    if (error.code === 403) throw new UserError("Permission denied. Make sure you have write access to both source and destination.");
    throw new UserError(`Failed to move file: ${error.message || 'Unknown error'}`);
  }
}

export async function handleCopyFile(
  drive: drive_v3.Drive,
  args: { fileId: string; newName?: string; parentFolderId?: string },
  log: Log
): Promise<string> {
  log.info(`Copying file ${args.fileId} ${args.newName ? `as "${args.newName}"` : ''}`);
  try {
    const originalFile = await drive.files.get({
      fileId: args.fileId,
      supportsAllDrives: true,
      fields: 'name,parents',
    });
    const copyMetadata: drive_v3.Schema$File = {
      name: args.newName || `Copy of ${originalFile.data.name}`,
    };
    if (args.parentFolderId) copyMetadata.parents = [args.parentFolderId];
    else if (originalFile.data.parents) copyMetadata.parents = originalFile.data.parents;
    const response = await drive.files.copy({
      fileId: args.fileId,
      supportsAllDrives: true,
      requestBody: copyMetadata,
      fields: 'id,name,webViewLink,driveId',
    });
    const copiedFile = response.data;
    const locationInfo = copiedFile.driveId ? ` (in shared drive ID: ${copiedFile.driveId})` : '';
    return `Successfully created copy "${copiedFile.name}" (ID: ${copiedFile.id})${locationInfo}\nLink: ${copiedFile.webViewLink}`;
  } catch (error: any) {
    log.error(`Error copying file: ${error.message || error}`);
    if (error.code === 404) throw new UserError("Original file or destination folder not found. Check the IDs.");
    if (error.code === 403) throw new UserError("Permission denied. Make sure you have read access to the original file and write access to the destination.");
    throw new UserError(`Failed to copy file: ${error.message || 'Unknown error'}`);
  }
}

export async function handleRenameFile(
  drive: drive_v3.Drive,
  args: { fileId: string; newName: string },
  log: Log
): Promise<string> {
  log.info(`Renaming file ${args.fileId} to "${args.newName}"`);
  try {
    const response = await drive.files.update({
      fileId: args.fileId,
      supportsAllDrives: true,
      requestBody: { name: args.newName },
      fields: 'id,name,webViewLink',
    });
    const file = response.data;
    return `Successfully renamed to "${file.name}" (ID: ${file.id})\nLink: ${file.webViewLink}`;
  } catch (error: any) {
    log.error(`Error renaming file: ${error.message || error}`);
    if (error.code === 404) throw new UserError("File not found. Check the file ID.");
    if (error.code === 403) throw new UserError("Permission denied. Make sure you have write access to this file.");
    throw new UserError(`Failed to rename file: ${error.message || 'Unknown error'}`);
  }
}

export async function handleDeleteFile(
  drive: drive_v3.Drive,
  args: { fileId: string; skipTrash: boolean },
  log: Log
): Promise<string> {
  log.info(`Deleting file ${args.fileId} ${args.skipTrash ? '(permanent)' : '(to trash)'}`);
  try {
    const fileInfo = await drive.files.get({
      fileId: args.fileId,
      supportsAllDrives: true,
      fields: 'name,mimeType,driveId',
    });
    const fileName = fileInfo.data.name;
    const isFolder = fileInfo.data.mimeType === 'application/vnd.google-apps.folder';
    const isSharedDrive = !!fileInfo.data.driveId;
    if (args.skipTrash) {
      await drive.files.delete({ fileId: args.fileId, supportsAllDrives: true });
      return `Permanently deleted ${isFolder ? 'folder' : 'file'} "${fileName}"${isSharedDrive ? ' from shared drive' : ''}.`;
    }
    await drive.files.update({
      fileId: args.fileId,
      supportsAllDrives: true,
      requestBody: { trashed: true },
    });
    return `Moved ${isFolder ? 'folder' : 'file'} "${fileName}" to trash. It can be restored from the trash.`;
  } catch (error: any) {
    log.error(`Error deleting file: ${error.message || error}`);
    if (error.code === 404) throw new UserError("File not found. Check the file ID.");
    if (error.code === 403) throw new UserError("Permission denied. Make sure you have delete access to this file.");
    throw new UserError(`Failed to delete file: ${error.message || 'Unknown error'}`);
  }
}

export async function handleCreateDocument(
  drive: drive_v3.Drive,
  docsGetter: () => docs_v1.Docs,
  args: { title: string; parentFolderId?: string; initialContent?: string },
  log: Log
): Promise<string> {
  log.info(`Creating new document "${args.title}"`);
  try {
    const documentMetadata: drive_v3.Schema$File = {
      name: args.title,
      mimeType: 'application/vnd.google-apps.document',
    };
    if (args.parentFolderId) documentMetadata.parents = [args.parentFolderId];
    const response = await drive.files.create({
      requestBody: documentMetadata,
      supportsAllDrives: true,
      fields: 'id,name,webViewLink,driveId',
    });
    const document = response.data;
    const locationInfo = document.driveId ? ` (in shared drive ID: ${document.driveId})` : '';
    let result = `Successfully created document "${document.name}" (ID: ${document.id})${locationInfo}\nView Link: ${document.webViewLink}`;
    if (args.initialContent) {
      try {
        const docs = docsGetter();
        await docs.documents.batchUpdate({
          documentId: document.id!,
          requestBody: {
            requests: [{ insertText: { location: { index: 1 }, text: args.initialContent } }],
          },
        });
        result += `\n\nInitial content added to document.`;
      } catch (contentError: any) {
        log.warn(`Document created but failed to add initial content: ${contentError.message}`);
        result += `\n\nDocument created but failed to add initial content. You can add content manually.`;
      }
    }
    return result;
  } catch (error: any) {
    log.error(`Error creating document: ${error.message || error}`);
    if (error.code === 404) throw new UserError("Parent folder not found. Check the folder ID.");
    if (error.code === 403) throw new UserError("Permission denied. Make sure you have write access to the destination folder.");
    throw new UserError(`Failed to create document: ${error.message || 'Unknown error'}`);
  }
}

export async function handleCreateFromTemplate(
  drive: drive_v3.Drive,
  docsGetter: () => docs_v1.Docs,
  args: { templateId: string; newTitle: string; parentFolderId?: string; replacements?: Record<string, string> },
  log: Log
): Promise<string> {
  log.info(`Creating document from template ${args.templateId} with title "${args.newTitle}"`);
  try {
    const copyMetadata: drive_v3.Schema$File = { name: args.newTitle };
    if (args.parentFolderId) copyMetadata.parents = [args.parentFolderId];
    const response = await drive.files.copy({
      fileId: args.templateId,
      supportsAllDrives: true,
      requestBody: copyMetadata,
      fields: 'id,name,webViewLink,driveId',
    });
    const document = response.data;
    const locationInfo = document.driveId ? ` (in shared drive ID: ${document.driveId})` : '';
    let result = `Successfully created document "${document.name}" from template (ID: ${document.id})${locationInfo}\nView Link: ${document.webViewLink}`;
    if (args.replacements && Object.keys(args.replacements).length > 0) {
      try {
        const docs = docsGetter();
        const requests: docs_v1.Schema$Request[] = [];
        for (const [searchText, replaceText] of Object.entries(args.replacements)) {
          requests.push({
            replaceAllText: {
              containsText: { text: searchText, matchCase: false },
              replaceText,
            },
          });
        }
        await docs.documents.batchUpdate({
          documentId: document.id!,
          requestBody: { requests },
        });
        const count = Object.keys(args.replacements).length;
        result += `\n\nApplied ${count} text replacement${count !== 1 ? 's' : ''} to the document.`;
      } catch (replacementError: any) {
        log.warn(`Document created but failed to apply replacements: ${replacementError.message}`);
        result += `\n\nDocument created but failed to apply text replacements. You can make changes manually.`;
      }
    }
    return result;
  } catch (error: any) {
    log.error(`Error creating document from template: ${error.message || error}`);
    if (error.code === 404) throw new UserError("Template document or parent folder not found. Check the IDs.");
    if (error.code === 403) throw new UserError("Permission denied. Make sure you have read access to the template and write access to the destination folder.");
    throw new UserError(`Failed to create document from template: ${error.message || 'Unknown error'}`);
  }
}

export async function handleListSharedDrives(
  drive: drive_v3.Drive,
  args: { maxResults: number; query?: string },
  log: Log
): Promise<string> {
  log.info(`Listing shared drives. Query: ${args.query || 'none'}, Max: ${args.maxResults}`);
  try {
    const response = await drive.drives.list({
      pageSize: args.maxResults,
      q: args.query ? `name contains '${args.query}'` : undefined,
      fields: 'drives(id,name,createdTime,capabilities)',
    });
    const drives = response.data.drives || [];
    if (drives.length === 0) {
      return args.query
        ? `No shared drives found matching "${args.query}".`
        : "No shared drives found. You may not have access to any shared drives.";
    }
    let result = `Found ${drives.length} Shared Drive(s):\n\n`;
    drives.forEach((sharedDrive, index) => {
      const createdDate = sharedDrive.createdTime ? new Date(sharedDrive.createdTime).toLocaleDateString() : 'Unknown';
      const capabilities = sharedDrive.capabilities || {};
      result += `${index + 1}. **${sharedDrive.name}**\n   ID: ${sharedDrive.id}\n   Created: ${createdDate}\n`;
      result += `   Can Edit: ${capabilities.canEdit ? 'Yes' : 'No'}\n   Can Manage Members: ${capabilities.canManageMembers ? 'Yes' : 'No'}\n\n`;
    });
    result += `\nUse a Drive ID with other tools (e.g., listFolderContents, listGoogleDocs) to browse shared drive contents.`;
    return result;
  } catch (error: any) {
    log.error(`Error listing shared drives: ${error.message || error}`);
    if (error.code === 403) throw new UserError("Permission denied. Make sure you have granted Google Drive access to the application.");
    throw new UserError(`Failed to list shared drives: ${error.message || 'Unknown error'}`);
  }
}

export async function handleExportDocToPdf(
  drive: drive_v3.Drive,
  args: { documentId: string; pdfFilename?: string; folderId?: string },
  log: Log
): Promise<string> {
  log.info(`Exporting doc ${args.documentId} to PDF`);
  const fileInfo = await drive.files.get({
    fileId: args.documentId,
    supportsAllDrives: true,
    fields: 'mimeType,name',
  });
  if (fileInfo.data.mimeType !== 'application/vnd.google-apps.document') {
    throw new UserError(`File is not a Google Doc (mimeType: ${fileInfo.data.mimeType}). Only Google Docs can be exported to PDF with this tool.`);
  }
  const docTitle = fileInfo.data.name || 'Untitled';
  const pdfName = (args.pdfFilename || docTitle) + '.pdf';
  const exportResponse = await drive.files.export({
    fileId: args.documentId,
    mimeType: 'application/pdf',
  }, { responseType: 'arraybuffer' });
  const pdfBuffer = Buffer.from(exportResponse.data as ArrayBuffer);
  const { Readable } = await import('stream');
  const fileMetadata: any = { name: pdfName, mimeType: 'application/pdf' };
  if (args.folderId) fileMetadata.parents = [args.folderId];
  const uploadResponse = await drive.files.create({
    requestBody: fileMetadata,
    media: { mimeType: 'application/pdf', body: Readable.from(pdfBuffer) },
    supportsAllDrives: true,
    fields: 'id,name,webViewLink,size',
  });
  const pdf = uploadResponse.data;
  return `PDF exported successfully:\n  File ID: ${pdf.id}\n  Name: ${pdf.name}\n  Size: ${pdf.size} bytes\n  Link: ${pdf.webViewLink}`;
}

export async function handleDownloadDriveFile(
  drive: drive_v3.Drive,
  args: { fileId: string; exportFormat?: 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'csv'; folderId?: string },
  log: Log
): Promise<string> {
  log.info(`Downloading/exporting file ${args.fileId} (format: ${args.exportFormat || 'auto'})`);
  try {
    const fileInfo = await drive.files.get({
      fileId: args.fileId,
      supportsAllDrives: true,
      fields: 'id,name,mimeType,webContentLink,webViewLink,size',
    });
    const file = fileInfo.data;
    const mime = file.mimeType || '';
    const fileName = file.name || 'Untitled';
    const resolved = resolveExportFormat(mime, args.exportFormat);
    if (resolved) {
      const exportResponse = await drive.files.export({
        fileId: args.fileId,
        mimeType: resolved.exportMime,
      }, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(exportResponse.data as ArrayBuffer);
      const { Readable } = await import('stream');
      const fileMetadata: any = { name: `${fileName}.${resolved.format}`, mimeType: resolved.exportMime };
      if (args.folderId) fileMetadata.parents = [args.folderId];
      const uploadResponse = await drive.files.create({
        requestBody: fileMetadata,
        media: { mimeType: resolved.exportMime, body: Readable.from(buffer) },
        supportsAllDrives: true,
        fields: 'id,name,webViewLink,size',
      });
      return formatExportResult(fileName, uploadResponse.data);
    }
    return formatBinaryFileInfo(file);
  } catch (error: any) {
    if (error instanceof UserError) throw error;
    log.error(`Error downloading/exporting file: ${error.message || error}`);
    handleDriveError(error, 'download/export', args.fileId);
  }
}

export async function handleGetFilePermissions(
  drive: drive_v3.Drive,
  args: { fileId: string },
  log: Log
): Promise<string> {
  log.info(`Getting permissions for file ${args.fileId}`);
  try {
    const { file, permissions } = await getFileAndPermissions(
      drive, args.fileId,
      'id,name,mimeType,shared,webViewLink',
      'permissions(id,type,role,emailAddress,displayName,expirationTime,deleted)',
    );
    return formatPermissionsList(file, permissions);
  } catch (error: any) {
    log.error(`Error getting permissions: ${error.message || error}`);
    handleDriveError(error, 'view permissions for', args.fileId);
  }
}

export async function handleShareDriveFile(
  drive: drive_v3.Drive,
  args: {
    fileId: string;
    role: 'reader' | 'writer' | 'commenter';
    type: 'user' | 'group' | 'domain' | 'anyone';
    emailAddress?: string;
    domain?: string;
    sendNotification?: boolean;
    expirationTime?: string;
  },
  log: Log
): Promise<string> {
  log.info(`Sharing file ${args.fileId} as ${args.role} to ${args.type}${args.emailAddress ? ` (${args.emailAddress})` : ''}`);
  validateShareArgs(args);
  const isUserOrGroup = args.type === 'user' || args.type === 'group';
  try {
    const permissionBody: any = { role: args.role, type: args.type };
    if (args.emailAddress) permissionBody.emailAddress = args.emailAddress;
    if (args.domain) permissionBody.domain = args.domain;
    if (isUserOrGroup && args.expirationTime) permissionBody.expirationTime = args.expirationTime;
    const createParams: any = {
      fileId: args.fileId,
      supportsAllDrives: true,
      requestBody: permissionBody,
    };
    if (isUserOrGroup) createParams.sendNotificationEmail = args.sendNotification ?? true;
    await drive.permissions.create(createParams);
    const fileInfo = await drive.files.get({
      fileId: args.fileId,
      supportsAllDrives: true,
      fields: 'name,webViewLink',
    });
    const target = formatShareTarget(args.type, args.emailAddress, args.domain);
    return `Shared successfully:\n  File: ${fileInfo.data.name}\n  Access: ${args.role} granted to ${target}\n  Link: ${fileInfo.data.webViewLink || 'N/A'}`;
  } catch (error: any) {
    if (error instanceof UserError) throw error;
    log.error(`Error sharing file: ${error.message || error}`);
    handleDriveError(error, 'share', args.fileId);
  }
}

export async function handleCheckPublicAccess(
  drive: drive_v3.Drive,
  args: { fileId: string },
  log: Log
): Promise<string> {
  log.info(`Checking public access for file ${args.fileId}`);
  try {
    const { file, permissions } = await getFileAndPermissions(
      drive, args.fileId,
      'id,name,mimeType,shared,webViewLink,webContentLink',
      'permissions(id,type,role)',
    );
    return formatPublicAccessResult(file, permissions);
  } catch (error: any) {
    log.error(`Error checking public access: ${error.message || error}`);
    handleDriveError(error, 'check public access for', args.fileId);
  }
}
