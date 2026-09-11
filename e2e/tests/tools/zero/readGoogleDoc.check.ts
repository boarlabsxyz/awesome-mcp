import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { createScratchDoc, trashFile } from '../../../setup/docsScratch.ts';

// Reading a document with no content at all. Nothing in the repo specifies what
// this should say, which is exactly why it is worth pinning: an empty body that
// comes back as "undefined", as a stack trace, or as a paragraph of apology all
// look identical to a caller deciding whether the read failed.
//
// The invariants below encode the intended contract -- a short, calm, non-error
// answer. If this goes red on first run, read the recorded response before
// touching the assertion: a surprising zero-state answer is a finding.

test('readGoogleDoc answers calmly for an empty document', { timeout: 60_000 }, async () => {
  await runToolCheck<{ documentId: string }>({
    tool: 'readGoogleDoc',
    service: 'google-docs',
    account: 'sandbox',
    shape: 'zero',
    writes: true, // creates a scratch doc, so it must resolve sandbox credentials
    setup: async (c) => ({ documentId: await createScratchDoc(await c.service('google-drive'), 'readGoogleDoc-zero') }),
    args: ({ documentId }) => ({ documentId, format: 'text' }),
    invariants: {
      transportSafe: true,
      excludes: ['undefined', 'Traceback', 'at Object.<anonymous>'],
      predicate: (body) =>
        body.length > 400
          ? `expected a short empty-state answer, got ${body.length} chars`
          : undefined,
    },
    teardown: async (c, { documentId }) => trashFile(await c.service('google-drive'), documentId),
  });
});
