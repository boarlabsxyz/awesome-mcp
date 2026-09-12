import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { createScratchDoc, trashFile } from '../../../setup/docsScratch.ts';
import { scratchClients } from '../../../setup/clients.ts';

// Appending to a document with nothing in it. The interesting parameter is
// addNewlineIfNeeded, which defaults to true and asks "does the doc end with a
// newline" of a body that has no content to ask about -- an off-by-one here
// surfaces as a stray leading blank line, or as an index error from the Docs API.

test('appendToGoogleDoc writes into an empty document', { timeout: 90_000 }, async () => {
  await runToolCheck<{ documentId: string; marker: string }>({
    tool: 'appendToGoogleDoc',
    service: 'google-docs',
    account: 'sandbox',
    shape: 'zero',
    writes: true,
    setup: async (c) => ({
      marker: `APPEND-ZERO-${Date.now()}`,
      documentId: await createScratchDoc(await scratchClients(c), 'appendToGoogleDoc-zero'),
    }),
    args: ({ documentId, marker }) => ({ documentId, textToAppend: marker }),
    readback: async (c, { documentId }) =>
      (await c.mcp.callTool('readGoogleDoc', { documentId, format: 'text' })).text,
    invariants: ({ marker }) => ({
      includes: [marker],
      transportSafe: true,
      // No escape clause. An earlier version also passed when `body.trim()`
      // equalled the marker, which is true of "\n\nMARKER" -- exactly the
      // leading blank line this check exists to catch.
      predicate: (body) => {
        const content = body.replace(/^Content \(\d+ characters\):\n---\n/, '');
        return content.trimStart() === content
          ? undefined
          : `appended into an empty doc but the content starts with whitespace: ${JSON.stringify(content.slice(0, 40))}`;
      },
    }),
    teardown: async (c, { documentId }) => trashFile(await c.service('google-drive'), documentId),
  });
});
