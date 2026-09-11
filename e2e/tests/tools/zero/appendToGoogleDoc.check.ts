import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { createScratchDoc, trashFile } from '../../../setup/docsScratch.ts';

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
      documentId: await createScratchDoc(await c.service('google-drive'), 'appendToGoogleDoc-zero'),
    }),
    args: ({ documentId, marker }) => ({ documentId, textToAppend: marker }),
    readback: async (c, { documentId }) =>
      (await c.mcp.callTool('readGoogleDoc', { documentId, format: 'text' })).text,
    invariants: ({ marker }) => ({
      includes: [marker],
      transportSafe: true,
      predicate: (body) =>
        body.trimStart() === body || body.trim() === marker
          ? undefined
          : `appended into an empty doc but the body starts with whitespace: ${JSON.stringify(body.slice(0, 40))}`,
    }),
    teardown: async (c, { documentId }) => trashFile(await c.service('google-drive'), documentId),
  });
});
