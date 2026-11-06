// Inventory of the tools these checks can target, and what each one is allowed
// to do.
//
// DOCS IN FULL, plus the most-used tools elsewhere (SERVICE_TOOLS). The repo registers 352 tools across 16 servers (see
// docs/MCP_TOOLS.md, which is generated -- do not hand-maintain this count); this file
// covers the 30 on the google-docs server as the proving ground. The `kind`
// column is NOT hand-maintained guesswork -- it is read off each addTool's
// `annotations` in src/google-docs/server.ts (readOnlyHint / destructiveHint),
// which is the same thing an MCP client uses to decide whether to ask the user
// first. Extending this to the other servers should be a generator over those
// annotations rather than more typing; see scripts/generateToolsInventory.ts
// when it exists.
//
// `shapes` is which of the three fixture shapes are worth running for that tool:
//
//   needle  frozen content, exact-substring assertion. Reads only -- a write
//           tool has no frozen output to match, and its equivalent is the marker
//           it writes, asserted by the sandbox check.
//   volume  enough data for caps, paging and truncation to show up.
//   zero    the empty-state answer. Worth running for every read tool: "no
//           results" is the half of the contract that silently reads as "that
//           thing does not exist".

import type { ServiceName } from './accounts.ts';
import type { Shape } from './runToolCheck.ts';

export type ToolKind = 'read' | 'write' | 'destructive';

export interface ToolEntry {
  name: string;
  service: ServiceName;
  kind: ToolKind;
  shapes: Shape[];
}

/**
 * Registered but not actually usable -- src/google-docs/CLAUDE.md lists
 * these as unimplemented or unreliable. Scaffolding checks for them produces
 * red that nobody can fix, so they are excluded rather than skipped.
 */
export const NOT_IMPLEMENTED = ['editTableCell', 'fixListFormatting', 'findElement'] as const;

export const DOCS_TOOLS: ToolEntry[] = [
  { name: 'listGoogleDocs', service: 'google-docs', kind: 'read', shapes: ['needle', 'volume', 'zero'] },
  { name: 'searchGoogleDocs', service: 'google-docs', kind: 'read', shapes: ['needle', 'volume', 'zero'] },
  { name: 'getRecentGoogleDocs', service: 'google-docs', kind: 'read', shapes: ['needle', 'volume', 'zero'] },
  { name: 'exportDocToPdf', service: 'google-docs', kind: 'write', shapes: ['volume', 'zero'] },
  { name: 'readGoogleDoc', service: 'google-docs', kind: 'read', shapes: ['needle', 'volume', 'zero'] },
  { name: 'listDocumentTabs', service: 'google-docs', kind: 'read', shapes: ['needle', 'volume', 'zero'] },
  { name: 'appendToGoogleDoc', service: 'google-docs', kind: 'write', shapes: ['volume', 'zero'] },
  { name: 'insertText', service: 'google-docs', kind: 'write', shapes: ['volume', 'zero'] },
  { name: 'deleteRange', service: 'google-docs', kind: 'destructive', shapes: ['volume', 'zero'] },
  { name: 'applyTextStyle', service: 'google-docs', kind: 'write', shapes: ['volume', 'zero'] },
  { name: 'applyParagraphStyle', service: 'google-docs', kind: 'write', shapes: ['volume', 'zero'] },
  { name: 'insertTable', service: 'google-docs', kind: 'write', shapes: ['volume', 'zero'] },
  { name: 'insertPageBreak', service: 'google-docs', kind: 'write', shapes: ['volume', 'zero'] },
  { name: 'insertImageFromUrl', service: 'google-docs', kind: 'write', shapes: ['volume', 'zero'] },
  { name: 'insertLocalImage', service: 'google-docs', kind: 'write', shapes: ['volume', 'zero'] },
  { name: 'listComments', service: 'google-docs', kind: 'read', shapes: ['needle', 'volume', 'zero'] },
  { name: 'getComment', service: 'google-docs', kind: 'read', shapes: ['needle', 'volume', 'zero'] },
  { name: 'addComment', service: 'google-docs', kind: 'write', shapes: ['volume', 'zero'] },
  { name: 'replyToComment', service: 'google-docs', kind: 'write', shapes: ['volume', 'zero'] },
  { name: 'resolveComment', service: 'google-docs', kind: 'destructive', shapes: ['volume', 'zero'] },
  { name: 'reopenComment', service: 'google-docs', kind: 'write', shapes: ['volume', 'zero'] },
  { name: 'assignComment', service: 'google-docs', kind: 'write', shapes: ['volume', 'zero'] },
  { name: 'updateCommentPost', service: 'google-docs', kind: 'destructive', shapes: ['volume', 'zero'] },
  { name: 'deleteComment', service: 'google-docs', kind: 'destructive', shapes: ['volume', 'zero'] },
  { name: 'deleteCommentReply', service: 'google-docs', kind: 'destructive', shapes: ['volume', 'zero'] },
  { name: 'listSuggestions', service: 'google-docs', kind: 'read', shapes: ['needle', 'volume', 'zero'] },
  { name: 'acceptSuggestion', service: 'google-docs', kind: 'write', shapes: ['volume', 'zero'] },
  { name: 'rejectSuggestion', service: 'google-docs', kind: 'destructive', shapes: ['volume', 'zero'] },
  { name: 'deleteSuggestion', service: 'google-docs', kind: 'destructive', shapes: ['volume', 'zero'] },
  { name: 'formatMatchingText', service: 'google-docs', kind: 'write', shapes: ['volume', 'zero'] },
  { name: 'findAndReplace', service: 'google-docs', kind: 'write', shapes: ['volume', 'zero'] },
  { name: 'inspectDocStructure', service: 'google-docs', kind: 'read', shapes: ['needle', 'volume', 'zero'] },
  { name: 'importDocx', service: 'google-docs', kind: 'write', shapes: ['volume', 'zero'] },
  { name: 'batchUpdateDoc', service: 'google-docs', kind: 'write', shapes: ['volume', 'zero'] },
  { name: 'importToGoogleDoc', service: 'google-docs', kind: 'write', shapes: ['volume', 'zero'] },
];

/**
 * Outside Docs, only the most-used tools per service so far -- picked from the
 * Admin MCP's listToolUsage over 30 days (November 2026), not the whole surface.
 * `kind` is still read off each tool's annotations. `shapes` is what was
 * scaffolded: needle + zero for reads, zero for writes; volume waits on a rich
 * tenant per service.
 */
export const SERVICE_TOOLS: ToolEntry[] = [
  { name: 'listFolderContents', service: 'google-drive', kind: 'read', shapes: ['needle', 'zero'] },
  { name: 'getDocumentInfo', service: 'google-drive', kind: 'read', shapes: ['needle', 'zero'] },
  { name: 'getPresentation', service: 'google-slides', kind: 'read', shapes: ['needle', 'zero'] },
  { name: 'readSpreadsheet', service: 'google-sheets', kind: 'read', shapes: ['needle', 'zero'] },
  { name: 'getSpreadsheetInfo', service: 'google-sheets', kind: 'read', shapes: ['needle', 'zero'] },
  { name: 'writeSpreadsheet', service: 'google-sheets', kind: 'write', shapes: ['zero'] },
  { name: 'searchEmails', service: 'google-gmail', kind: 'read', shapes: ['needle', 'zero'] },
  { name: 'readEmail', service: 'google-gmail', kind: 'read', shapes: ['needle', 'zero'] },
  { name: 'listEvents', service: 'google-calendar', kind: 'read', shapes: ['needle', 'zero'] },
  { name: 'getEvent', service: 'google-calendar', kind: 'read', shapes: ['needle', 'zero'] },
  { name: 'createEvent', service: 'google-calendar', kind: 'write', shapes: ['zero'] },
  { name: 'searchMessages', service: 'slack', kind: 'read', shapes: ['needle', 'zero'] },
  { name: 'readChannelHistory', service: 'slack', kind: 'read', shapes: ['needle', 'zero'] },
  { name: 'readThreadReplies', service: 'slack', kind: 'read', shapes: ['needle', 'zero'] },
  { name: 'readChannelHistory', service: 'slack-bot', kind: 'read', shapes: ['needle', 'zero'] },
  // users.list always includes the installer, so there is no empty state to seed.
  { name: 'listUsers', service: 'slack-bot', kind: 'read', shapes: ['needle'] },
  { name: 'getTask', service: 'clickup', kind: 'read', shapes: ['needle', 'zero'] },
  { name: 'filterTeamTasks', service: 'clickup', kind: 'read', shapes: ['needle', 'zero'] },
  { name: 'listTasks', service: 'clickup', kind: 'read', shapes: ['needle', 'zero'] },
  { name: 'listTimeEntries', service: 'redmine', kind: 'read', shapes: ['needle', 'zero'] },
  { name: 'getProject', service: 'redmine', kind: 'read', shapes: ['needle', 'zero'] },
  { name: 'getEmployee', service: 'peopleforce', kind: 'read', shapes: ['needle', 'zero'] },
  // Only `page` and a `status` enum: no filter can match nothing.
  { name: 'listEmployees', service: 'peopleforce', kind: 'read', shapes: ['needle'] },
  { name: 'listLeaveRequests', service: 'peopleforce', kind: 'read', shapes: ['needle', 'zero'] },
  { name: 'searchDocuments', service: 'outline', kind: 'read', shapes: ['needle', 'zero'] },
  { name: 'getDocument', service: 'outline', kind: 'read', shapes: ['needle', 'zero'] },
  { name: 'searchCompanies', service: 'hubspot', kind: 'read', shapes: ['needle', 'zero'] },
  { name: 'getDeal', service: 'hubspot', kind: 'read', shapes: ['needle', 'zero'] },
  { name: 'getCompanyDeals', service: 'hubspot', kind: 'read', shapes: ['needle', 'zero'] },
];

export function toolsByKind(kind: ToolKind): ToolEntry[] {
  return DOCS_TOOLS.filter((t) => t.kind === kind);
}

/** Tools that have at least one check file, for gap reporting. */
export function expectedCheckCount(): number {
  return DOCS_TOOLS.reduce((n, t) => n + t.shapes.length, 0);
}
