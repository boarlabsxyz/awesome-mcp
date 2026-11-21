import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { trashFile } from '../../../setup/docsScratch.ts';
import { createScratchFolder } from '../../../setup/driveScratch.ts';

// Listing a folder that is really empty: created in setup, so nothing about the
// account's state can make it non-empty. Writes (the folder), so sandbox only.
//
// The expected sentence is verbatim from handleListFolderContents in
// src/google-drive/toolHandlers.ts -- and it is a weak contract: it says "empty
// OR you don't have permission", so a caller cannot tell an empty folder from an
// unreadable one. Pinned as-is here; the gap is the todo below.

const EMPTY_ANSWER = "The folder is empty or you don't have permission to view its contents.";

test('listFolderContents answers calmly for an empty folder', { timeout: 60_000 }, async () => {
  await runToolCheck<{ folderId: string }>({
    tool: 'listFolderContents',
    service: 'google-drive',
    account: 'sandbox',
    shape: 'zero',
    writes: true, // creates a scratch folder, so it must resolve sandbox credentials
    setup: async (c) => ({ folderId: await createScratchFolder(c.mcp, 'listFolderContents-zero') }),
    args: ({ folderId }) => ({ folderId }),
    invariants: {
      includes: [EMPTY_ANSWER],
      excludes: ['Contents of folder', 'Folder not found', 'Error', 'undefined'],
    },
    teardown: async (c, { folderId }) => trashFile(c.mcp, folderId),
  });
});

// Recorded as a todo, not a red assertion: it is a gap in the tool. The handler
// lists with `'<folderId>' in parents` (src/google-drive/toolHandlers.ts:315),
// which answers an empty list for a folder the caller cannot see -- and, unless
// Drive 404s the query, for one that does not exist -- so all three collapse
// into the one sentence above (toolHandlers.ts:326), and the 404 "Folder not
// found" branch is likely unreachable. The same "No X found reads as X does not
// exist" shape CLAUDE.md calls out. Fix by a files.get on folderId first (404 /
// 403 / not-a-folder), then flip this to a nonexistent-ID check expecting
// "Folder not found. Check the folder ID."
test('listFolderContents tells an empty folder apart from a missing or unreadable one', {
  todo: 'empty, unreadable and (probably) nonexistent folders all return the same sentence',
}, () => {});
