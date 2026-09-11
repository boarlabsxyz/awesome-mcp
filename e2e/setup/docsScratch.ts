// Creates and destroys the throwaway documents that write and zero-state checks
// run against.
//
// Two decisions worth knowing:
//
// 1. Setup goes through the MCP tools themselves (createDocument / deleteFile on
//    the drive server) rather than a second Google API credential path. The cost
//    is that a broken createDocument fails every write check for a reason that
//    has nothing to do with the tool under test -- acceptable, and cheap to spot
//    because they all fail at once. The benefit is that the sandbox account needs
//    exactly one credential: its dashboard API key.
//
// 2. "Empty account" is not something you can maintain, so it is not what this
//    guarantees. The first write makes it non-empty, and one failed teardown
//    leaks forever. What holds instead is that every resource lives under a
//    run-scoped, self-dating title, so zero-state checks can assert on a
//    freshly-made empty doc and `sweepScratch` can clean up after any run that
//    died before its teardown -- including one killed by CI timeout.

import { explainToolError } from '../accounts.ts';
import type { McpClient } from '../transports/mcpHttp.ts';

/** e2e-<epochMs>-<run>-<tool>. The epoch is first so the sweeper can date it. */
const TITLE_PREFIX = 'e2e-';

const RUN_LABEL = process.env.GITHUB_RUN_ID ?? 'local';

export function scratchTitle(tool: string, startedAt = Date.now()): string {
  return `${TITLE_PREFIX}${startedAt}-${RUN_LABEL}-${tool}`;
}

/**
 * Create a scratch doc and return its ID.
 *
 * `initialContent` is not optional-by-omission: createDocument reports partial
 * success in prose when the content insert fails after the file is made, and a
 * check that then asserts on seeded content fails with a confusing diff instead
 * of the real cause. So the partial-success wording is treated as an error here.
 */
export async function createScratchDoc(
  drive: McpClient,
  tool: string,
  initialContent?: string,
): Promise<string> {
  const args: Record<string, unknown> = { title: scratchTitle(tool) };
  if (initialContent !== undefined) args.initialContent = initialContent;

  const parentFolderId = process.env.E2E_SANDBOX_FOLDER_ID;
  if (parentFolderId) args.parentFolderId = parentFolderId;

  const { text, isError } = await drive.callTool('createDocument', args);
  if (isError) throw new Error(explainToolError('sandbox', 'createDocument', text));
  if (initialContent !== undefined && text.includes('failed to add initial content')) {
    throw new Error(`createScratchDoc created the file but not its content: ${text}`);
  }

  const id = text.match(/\(ID: ([^)]+)\)/)?.[1];
  if (!id) throw new Error(`Could not parse a document ID out of createDocument's reply: ${text}`);
  return id;
}

/** Trash (not permanently delete) -- recoverable if a check deleted the wrong thing. */
export async function trashFile(drive: McpClient, fileId: string): Promise<void> {
  const { text, isError } = await drive.callTool('deleteFile', { fileId, skipTrash: false });
  if (isError) throw new Error(explainToolError('sandbox', `deleteFile(${fileId})`, text));
}

/**
 * Trash scratch docs left behind by runs that died before teardown.
 *
 * Without this the sandbox account accumulates, and the zero-state checks -- the
 * ones that assert "this account has nothing" -- start failing for reasons that
 * have nothing to do with the code under test. Run it on a schedule, not in-band:
 * `maxAgeHours` defaults to 24 so it can never race a run still in flight.
 */
export async function sweepScratch(
  drive: McpClient,
  { maxAgeHours = 24, dryRun = false }: { maxAgeHours?: number; dryRun?: boolean } = {},
): Promise<{ trashed: string[]; kept: number }> {
  const { text } = await drive.callTool('listGoogleDocs', {
    query: TITLE_PREFIX,
    maxResults: 100,
    orderBy: 'createdTime',
  });

  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
  const trashed: string[] = [];
  let kept = 0;

  // Entries render as "N. **<title>**" followed by "   ID: <id>" (see
  // formatFileListEntry in src/google-drive/toolHandlers.ts).
  const entries = [...text.matchAll(/^\d+\. \*\*(.+?)\*\*.*\n\s+ID: (\S+)/gm)];
  for (const [, title, id] of entries) {
    const stamp = Number(title.match(/^e2e-(\d+)-/)?.[1]);
    if (!Number.isFinite(stamp) || stamp >= cutoff) {
      kept++;
      continue;
    }
    if (!dryRun) await trashFile(drive, id);
    trashed.push(`${title} (${id})`);
  }

  return { trashed, kept };
}

/** Paragraphs of filler, for seeding a document large enough to be interesting. */
export function bulkText(paragraphs: number, marker: string): string {
  const lines: string[] = [];
  for (let i = 1; i <= paragraphs; i++) {
    lines.push(`${marker} paragraph ${i} of ${paragraphs}. ${'lorem ipsum dolor sit amet. '.repeat(4)}`);
  }
  return lines.join('\n');
}
