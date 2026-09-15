// Inventory of the tools these checks can target, and what each one is allowed
// to do.
//
// DOCS ONLY for now. The repo registers 227 tools across 12 servers; this file
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
 * Registered but not actually usable -- CLAUDE.md's "Known Limitations" lists
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
  { name: 'resolveComment', service: 'google-docs', kind: 'write', shapes: ['volume', 'zero'] },
  { name: 'deleteComment', service: 'google-docs', kind: 'destructive', shapes: ['volume', 'zero'] },
  { name: 'formatMatchingText', service: 'google-docs', kind: 'write', shapes: ['volume', 'zero'] },
  { name: 'findAndReplace', service: 'google-docs', kind: 'write', shapes: ['volume', 'zero'] },
  { name: 'inspectDocStructure', service: 'google-docs', kind: 'read', shapes: ['needle', 'volume', 'zero'] },
  { name: 'importDocx', service: 'google-docs', kind: 'write', shapes: ['volume', 'zero'] },
  { name: 'batchUpdateDoc', service: 'google-docs', kind: 'write', shapes: ['volume', 'zero'] },
  { name: 'importToGoogleDoc', service: 'google-docs', kind: 'write', shapes: ['volume', 'zero'] },
];

export function toolsByKind(kind: ToolKind): ToolEntry[] {
  return DOCS_TOOLS.filter((t) => t.kind === kind);
}

/** Tools that have at least one check file, for gap reporting. */
export function expectedCheckCount(): number {
  return DOCS_TOOLS.reduce((n, t) => n + t.shapes.length, 0);
}
