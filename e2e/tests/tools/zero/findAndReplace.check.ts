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
//      a read-back, because the reply's count is the tool's own claim.
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
    invariants: ({ oldToken, newToken }) => ({
      includes: ['Keep this line.', `${newToken} first.`, 'Middle line stays.', `${newToken} second.`],
      excludes: [oldToken],
      transportSafe: true,
      predicate: (body) => {
        const count = body.split(newToken).length - 1;
        return count === 2 ? undefined : `expected the replacement exactly twice, found it ${count} time(s)`;
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
