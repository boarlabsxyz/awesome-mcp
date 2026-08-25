// The single implementation behind BOTH listGoogleSheets (MCP) and
// GET /api/v1/sheets (REST).
//
// These used to be two hand-written Drive queries that had drifted apart
// (ClickUp 86cb89z8q): the MCP path added `fullText contains` and `trashed=false`
// and forgot to escape the user's query; the REST path matched on name only and
// escaped quotes. Same account, same `session.googleDrive` object, different
// results — and on the reporter's account the MCP query 403'd while the REST one
// returned 12 files.
//
// Parity is now structural rather than maintained by hand: there is one query
// builder and one list call, so the two surfaces cannot diverge again without
// someone deleting this module. Presentation still differs (markdown vs JSON) —
// that's the only thing each caller is allowed to decide.

import type { drive_v3 } from 'googleapis';
import { buildSharedDriveParams, escapeDriveQueryLiteral } from '../google-drive/toolHandlers.js';

export const SPREADSHEET_MIME_TYPE = 'application/vnd.google-apps.spreadsheet';

/** Scope required to list spreadsheets, named in errors instead of "grant Drive access". */
export const LIST_SPREADSHEETS_SCOPE = 'https://www.googleapis.com/auth/drive';

/**
 * Fields both surfaces request — deliberately the UNION of what each asked for
 * before, never an intersection. REST used to return whole `owners` objects and
 * MCP only `owners(displayName,emailAddress)`; narrowing to the MCP projection
 * would have silently stripped fields from existing REST consumers, so the full
 * `owners` object wins. MCP renders only displayName, so it loses nothing.
 */
export const SPREADSHEET_LIST_FIELDS =
  'files(id,name,modifiedTime,createdTime,webViewLink,owners,driveId)';

export type SpreadsheetOrderBy = 'name' | 'modifiedTime' | 'createdTime';

export interface ListSpreadsheetsArgs {
  query?: string;
  maxResults?: number;
  orderBy?: SpreadsheetOrderBy;
  /**
   * Also match spreadsheet CONTENT, not just the title.
   *
   * Defaults to false, which is the behaviour the REST endpoint always had and
   * the one observed working on the account in 86cb89z8q. The MCP tool used to
   * force `fullText contains` on with no way to turn it off; that is the clause
   * the working path did not have, so it is now opt-in rather than mandatory.
   */
  searchContent?: boolean;
  includeSharedDrives?: boolean;
  driveId?: string;
  corpora?: 'user' | 'drive' | 'allDrives' | 'domain';
}

/**
 * Drive `q` for a spreadsheet listing. Exported so tests can assert the two
 * surfaces produce byte-identical queries without reaching for a live account.
 */
export function buildSpreadsheetQuery(args: ListSpreadsheetsArgs): string {
  let q = `mimeType='${SPREADSHEET_MIME_TYPE}' and trashed=false`;

  if (args.query) {
    // Escaping is not optional: an apostrophe in the query (`Client's Forecast`)
    // terminates the Drive string literal early and produces a syntax error.
    // The MCP path interpolated raw, the REST path escaped only quotes and not
    // backslashes; escapeDriveQueryLiteral handles both.
    const term = escapeDriveQueryLiteral(args.query);
    q += args.searchContent
      ? ` and (name contains '${term}' or fullText contains '${term}')`
      : ` and name contains '${term}'`;
  }

  return q;
}

/**
 * Drive `orderBy`. `desc` on modifiedTime/createdTime because "most recent
 * first" is what both surfaces meant; the MCP path omitted it and silently
 * returned oldest-first.
 */
export function buildSpreadsheetOrderBy(orderBy: SpreadsheetOrderBy = 'modifiedTime'): string {
  return orderBy === 'name' ? 'name' : `${orderBy} desc`;
}

/**
 * List spreadsheets. Returns raw Drive file records; callers format them.
 * Errors propagate untouched so each caller can wrap them with
 * describeDriveError and its own error type.
 */
export async function listSpreadsheetFiles(
  drive: drive_v3.Drive,
  args: ListSpreadsheetsArgs = {},
): Promise<drive_v3.Schema$File[]> {
  const response = await drive.files.list({
    q: buildSpreadsheetQuery(args),
    pageSize: args.maxResults ?? 20,
    orderBy: buildSpreadsheetOrderBy(args.orderBy),
    fields: SPREADSHEET_LIST_FIELDS,
    ...buildSharedDriveParams(args),
  });

  return response.data.files ?? [];
}

/** Markdown rendering for the MCP tool. REST returns the raw records instead. */
export function formatSpreadsheetList(files: drive_v3.Schema$File[]): string {
  if (files.length === 0) {
    return 'No Google Spreadsheets found matching your criteria.';
  }

  let result = `Found ${files.length} Google Spreadsheet(s):\n\n`;
  files.forEach((file, index) => {
    const modifiedDate = file.modifiedTime
      ? new Date(file.modifiedTime).toLocaleDateString()
      : 'Unknown';
    const owner = file.owners?.[0]?.displayName || 'Unknown';
    const driveInfo = file.driveId ? ' (Shared Drive)' : '';
    result += `${index + 1}. **${file.name}**${driveInfo}\n`;
    result += `   ID: ${file.id}\n`;
    result += `   Modified: ${modifiedDate}\n`;
    result += `   Owner: ${owner}\n`;
    if (file.driveId) {
      result += `   Drive ID: ${file.driveId}\n`;
    }
    result += `   Link: ${file.webViewLink}\n\n`;
  });

  return result;
}
