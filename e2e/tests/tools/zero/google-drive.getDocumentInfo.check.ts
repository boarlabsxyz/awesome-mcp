import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';

// A well-formed ID that names no file. handleGetDocumentInfo
// (src/google-drive/toolHandlers.ts) maps Drive's 404 to
// `Document not found (ID: <id>).`; anything else -- the 403 branch's "Make sure
// you have access", or the generic "Failed to get document info" -- would send
// the caller to fix sharing on a document that does not exist.
const NO_SUCH_DOC = '1zzzNoSuchDocumentZzz9f3a1c7bQqQqQqQqQqQqQqQ';

test('getDocumentInfo says a nonexistent document was not found', { timeout: 30_000 }, async () => {
  await runToolCheck({
    tool: 'getDocumentInfo',
    service: 'google-drive',
    account: 'sandbox',
    shape: 'zero',
    expectToolError: true,
    args: { documentId: NO_SUCH_DOC },
    invariants: {
      includes: [`Document not found (ID: ${NO_SUCH_DOC}).`],
      excludes: ['Permission denied', 'undefined', 'Traceback', 'at Object.<anonymous>'],
    },
  });
});
