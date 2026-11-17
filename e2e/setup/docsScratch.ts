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
 * Content is written through the DOCS server, not through createDocument's
 * `initialContent`. Observed live: the drive server creates the file and then
 * fails to insert the content, reporting it only in the prose of a successful
 * reply ("Document created but failed to add initial content"). A caller that
 * does not parse that sentence gets an empty document and an assertion failure
 * three steps later, pointing at the wrong thing.
 *
 * So: create empty on drive, fill on docs, then read it back. The read-back is
 * not paranoia -- it is the only thing that distinguishes "seeded" from "created
 * and silently empty", which is exactly the failure this path already produced
 * once.
 */
export async function createScratchDoc(
  clients: { docs: McpClient; drive: McpClient },
  tool: string,
  initialContent?: string,
): Promise<string> {
  const args: Record<string, unknown> = { title: scratchTitle(tool) };
  const parentFolderId = process.env.E2E_SANDBOX_FOLDER_ID;
  if (parentFolderId) args.parentFolderId = parentFolderId;

  const created = await clients.drive.callTool('createDocument', args);
  if (created.isError) throw new Error(explainToolError('sandbox', 'createDocument', created.text));

  const id = created.text.match(/\(ID: ([^)]+)\)/)?.[1];
  if (!id) throw new Error(`Could not parse a document ID out of createDocument's reply: ${created.text}`);
  if (initialContent === undefined) return id;

  const filled = await clients.docs.callTool('appendToGoogleDoc', {
    documentId: id,
    textToAppend: initialContent,
  });
  if (filled.isError) throw new Error(explainToolError('sandbox', 'appendToGoogleDoc', filled.text));

  const readBack = await clients.docs.callTool('readGoogleDoc', { documentId: id, format: 'text' });
  if (readBack.isError || readBack.text.length < initialContent.length / 2) {
    throw new Error(
      `Scratch doc ${id} was created but reads back as ${readBack.text.length} chars ` +
        `after seeding ${initialContent.length}. The seed did not stick.`,
    );
  }
  return id;
}

/** Trash (not permanently delete) -- recoverable if a check deleted the wrong thing. */
export async function trashFile(drive: McpClient, fileId: string): Promise<void> {
  const { text, isError } = await drive.callTool('deleteFile', { fileId, skipTrash: false });
  if (isError) throw new Error(explainToolError('sandbox', `deleteFile(${fileId})`, text));
}

/** The epoch-ms a scratch title was stamped with, or undefined for any other title. */
export function scratchStamp(title: string): number | undefined {
  const stamp = Number(title.match(/^e2e-(\d+)-/)?.[1]);
  return Number.isFinite(stamp) ? stamp : undefined;
}

/**
 * A non-negative age in hours, or a throw. A negative or NaN age puts the cutoff
 * in the future, which would trash every scratch resource including the ones a
 * run in flight is still asserting against. SWEEP_MAX_AGE_HOURS comes from the
 * environment, so a typo reaches here.
 */
export function sweepCutoff(maxAgeHours: number, now = Date.now()): number {
  if (!Number.isFinite(maxAgeHours) || maxAgeHours < 0) {
    throw new Error(`maxAgeHours must be a non-negative number, got ${JSON.stringify(maxAgeHours)}`);
  }
  return now - maxAgeHours * 60 * 60 * 1000;
}

/** Pages of 100 the sweep reads before stopping; it says so when it stops early. */
const SWEEP_MAX_PAGES = 20;

/**
 * Trash scratch files left behind by runs that died before teardown: docs,
 * spreadsheets and folders alike, wherever they sit (the Drive root included).
 *
 * Without this the sandbox account accumulates, and the zero-state checks -- the
 * ones that assert "this account has nothing" -- start failing for reasons that
 * have nothing to do with the code under test. Run it on a schedule, not in-band:
 * `maxAgeHours` defaults to 24 so it can never race a run still in flight.
 *
 * Both halves are on the drive server: `searchDriveFiles` (any file type, by
 * name) and `deleteFile`. A file is trashed only when its title carries an
 * `e2e-<epochMs>-` stamp older than the cutoff -- a human-named file that merely
 * contains "e2e-" is kept. Folders are trashed after files, so a file inside a
 * scratch folder is trashed by itself rather than found already gone.
 */
export async function sweepScratch(
  drive: McpClient,
  { maxAgeHours = 24, dryRun = false }: { maxAgeHours?: number; dryRun?: boolean } = {},
): Promise<{ trashed: string[]; kept: number; capped: boolean }> {
  const cutoff = sweepCutoff(maxAgeHours);
  const stale: Array<{ title: string; id: string; folder: boolean }> = [];
  let kept = 0;
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const { text, isError } = await drive.callTool('searchDriveFiles', {
      query: TITLE_PREFIX,
      searchIn: 'name',
      maxResults: 100,
      ...(pageToken ? { pageToken } : {}),
    });
    // Silence here would be indistinguishable from a clean account: the sweep
    // would report "trashed 0, kept 0" and the leak it exists to prevent would
    // keep growing.
    if (isError) throw new Error(explainToolError('sandbox', 'searchDriveFiles', text));
    pages++;

    // Entries render as "N. **<name>** (<mimeType>)" then "   ID: <id> · modified ..."
    // (fileLine in src/google-drive/server.ts).
    for (const [, title, mimeType, id] of text.matchAll(/^\d+\. \*\*(.+?)\*\* \(([^)]*)\)\n\s+ID: (\S+)/gm)) {
      const stamp = scratchStamp(title);
      if (stamp === undefined || stamp >= cutoff) {
        kept++;
        continue;
      }
      stale.push({ title, id, folder: mimeType === 'application/vnd.google-apps.folder' });
    }
    pageToken = text.match(/call again with pageToken "([^"]+)"/)?.[1];
  } while (pageToken && pages < SWEEP_MAX_PAGES);

  stale.sort((a, b) => Number(a.folder) - Number(b.folder));
  const trashed: string[] = [];
  for (const { title, id } of stale) {
    if (!dryRun) await trashFile(drive, id);
    trashed.push(`${title} (${id})`);
  }
  return { trashed, kept, capped: pageToken !== undefined };
}

/** Paragraphs of filler, for seeding a document large enough to be interesting. */
export function bulkText(paragraphs: number, marker: string): string {
  const lines: string[] = [];
  for (let i = 1; i <= paragraphs; i++) {
    lines.push(`${marker} paragraph ${i} of ${paragraphs}. ${'lorem ipsum dolor sit amet. '.repeat(4)}`);
  }
  return lines.join('\n');
}
