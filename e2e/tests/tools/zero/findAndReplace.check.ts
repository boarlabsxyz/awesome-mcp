import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { createScratchDoc, trashFile } from '../../../setup/docsScratch.ts';
import { scratchClients } from '../../../setup/clients.ts';

// findAndReplace is a write: findAndReplaceSchema (src/google-docs/writeSchemas.ts)
// has no count-only or dry-run mode, so every call is a replaceAllText
// batchUpdate. Both checks therefore run in sandbox scratch docs, never on the
// fixture.
//
// The two halves of its contract:
//
//   1. Every occurrence is replaced, and nothing else is touched -- asserted on
//      a read-back, because the reply's count is the tool's own claim (which
//      is checked as well).
//   2. A replace that matches nothing is a success reporting 0, not an error
//      (src/google-docs/CLAUDE.md: "returns occurrencesChanged: 0 as success").
//      performFindAndReplace (writeOps.ts) only increments the count when the
//      reply carries one, so a missing reply also reads as 0 -- this pins that
//      the 0 is at least true of a document that has nothing to match.

test('findAndReplace replaces every occurrence and leaves the rest alone', { timeout: 90_000 }, async () => {
  await runToolCheck<{ documentId: string; oldToken: string; newToken: string }>({
    tool: 'findAndReplace',
    service: 'google-docs',
    account: 'sandbox',
    shape: 'zero',
    variant: 'replaces',
    writes: true,
    setup: async (c) => {
      const stamp = Date.now();
      const oldToken = `FAR-OLD-${stamp}`;
      const newToken = `FAR-NEW-${stamp}`;
      // Two occurrences, so a replace that stops after the first is visible, and
      // a fixed sentence around them, so a replace that eats its neighbours is too.
      const seed = `Keep this line.\n${oldToken} first.\nMiddle line stays.\n${oldToken} second.`;
      return {
        oldToken,
        newToken,
        documentId: await createScratchDoc(await scratchClients(c), 'findAndReplace-zero', seed),
      };
    },
    args: ({ documentId, oldToken, newToken }) => ({ documentId, findText: oldToken, replaceText: newToken }),
    readback: async (c, { documentId }) =>
      (await c.mcp.callTool('readGoogleDoc', { documentId, format: 'text' })).text,
    // The reply's count is still the tool's claim, but a wrong one misleads a
    // caller just as surely, so it is pinned too (findAndReplace execute,
    // src/google-docs/server.ts).
    replyInvariants: ({ oldToken, newToken }) => ({
      includes: [`Replaced 2 occurrence(s) of "${oldToken}" with "${newToken}".`],
    }),
    invariants: ({ oldToken, newToken }) => ({
      excludes: [oldToken],
      transportSafe: true,
      // The whole body, in order: separate substrings would also accept
      // reordered lines or text appended after them. readGoogleDoc prints
      // "Content (N characters):\n---\n<text>" then the revisionId footer; the
      // text is compared trimmed, since how many newlines the empty doc and the
      // append leave at either end is Docs' business, not findAndReplace's.
      predicate: (body) => {
        const expected = `Keep this line.\n${newToken} first.\nMiddle line stays.\n${newToken} second.`;
        const text = body.match(/^Content \(\d+ characters\):\n---\n([^]*?)(?:\n\n\[revisionId: [^\]]*\])?$/)?.[1];
        if (text === undefined) return 'readGoogleDoc did not answer in its "Content (N characters):" text shape';
        return text.trim() === expected ? undefined : `expected the document to read ${JSON.stringify(expected)}, got ${JSON.stringify(text.trim())}`;
      },
    }),
    teardown: async (c, { documentId }) => trashFile(await c.service('google-drive'), documentId),
  });
});

test('findAndReplace reports zero replacements in an empty document', { timeout: 60_000 }, async () => {
  const findText = 'zzz-no-such-text-zzz-9f3a1c7b';
  const replaceText = 'FAR-ZERO-REPLACEMENT';
  await runToolCheck<{ documentId: string }>({
    tool: 'findAndReplace',
    service: 'google-docs',
    account: 'sandbox',
    shape: 'zero',
    variant: 'empty-doc',
    writes: true,
    setup: async (c) => ({ documentId: await createScratchDoc(await scratchClients(c), 'findAndReplace-zero-empty') }),
    args: ({ documentId }) => ({ documentId, findText, replaceText }),
    // No readback: the count IS the answer under test here, and the document has
    // nothing in it for a read-back to contradict. Verbatim from the
    // findAndReplace execute in src/google-docs/server.ts.
    invariants: {
      includes: [`Replaced 0 occurrence(s) of "${findText}" with "${replaceText}".`],
      excludes: ['Error', 'undefined'],
    },
    teardown: async (c, { documentId }) => trashFile(await c.service('google-drive'), documentId),
  });
});
