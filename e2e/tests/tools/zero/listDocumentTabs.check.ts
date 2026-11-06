import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';

// A well-formed ID that names no document. The handler maps a Docs 404 to
// `Document not found (ID: <id>).` (src/google-docs/server.ts, listDocumentTabs
// catch block); without that mapping the caller gets "Failed to list tabs:
// Requested entity was not found." or a 403-shaped message, and cannot tell a
// wrong ID from a sharing problem. Observed live on dev: the 404 path is taken.
//
// The ID is the length and alphabet of a real Docs ID, so this exercises the
// not-found branch rather than an upstream "invalid argument" 400.
const NO_SUCH_DOC = '1zzzNoSuchDocumentZzz9f3a1c7bQqQqQqQqQqQqQqQ';

test('listDocumentTabs says a nonexistent document was not found', { timeout: 30_000 }, async () => {
  await runToolCheck({
    tool: 'listDocumentTabs',
    service: 'google-docs',
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
