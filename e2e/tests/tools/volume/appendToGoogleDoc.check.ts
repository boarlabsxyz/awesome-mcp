import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { createScratchDoc, trashFile, bulkText } from '../../../setup/docsScratch.ts';

// A write tool's volume case is seeded in the sandbox, not run against the rich
// account: volume is a property of the fixture, and the rich account is read-only
// by policy (accounts.ts enforces it -- writes: true cannot resolve it).
//
// What this is actually testing is that appendToGoogleDoc finds the end of a
// large document. It computes the end index itself, which is the part that can
// quietly be wrong on a body with hundreds of paragraphs and looks fine on the
// three-line fixture doc.

const PARAGRAPHS = 200;

test('appendToGoogleDoc lands at the end of a large document', { timeout: 120_000 }, async () => {
  await runToolCheck<{ documentId: string; marker: string; seed: string }>({
    tool: 'appendToGoogleDoc',
    service: 'google-docs',
    account: 'sandbox',
    shape: 'volume',
    writes: true,
    setup: async (c) => {
      const seed = bulkText(PARAGRAPHS, 'SEED');
      return {
        seed,
        marker: `APPEND-VOLUME-${Date.now()}`,
        documentId: await createScratchDoc(await c.service('google-drive'), 'appendToGoogleDoc-volume', seed),
      };
    },
    args: ({ documentId, marker }) => ({ documentId, textToAppend: marker }),
    // The tool's own reply is its claim that it worked; the read-back is the
    // evidence. Assert on the document, not on the confirmation message.
    readback: async (c, { documentId }) =>
      (await c.mcp.callTool('readGoogleDoc', { documentId, format: 'text' })).text,
    invariants: ({ marker }) => ({
      includes: [
        marker,
        'SEED paragraph 1 of 200',
        // Still present, so the append did not overwrite the tail it appended to.
        `SEED paragraph ${PARAGRAPHS} of ${PARAGRAPHS}`,
      ],
      transportSafe: true,
      predicate: (body) => {
        const markerAt = body.indexOf(marker);
        const lastSeedAt = body.indexOf(`SEED paragraph ${PARAGRAPHS} of ${PARAGRAPHS}`);
        return markerAt < lastSeedAt
          ? 'the appended text landed before the end of the document'
          : undefined;
      },
    }),
    teardown: async (c, { documentId }) => trashFile(await c.service('google-drive'), documentId),
  });
});
