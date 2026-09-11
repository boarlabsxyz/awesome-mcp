import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';

// The no-results answer, asserted verbatim against the string in
// src/google-drive/toolHandlers.ts. Worth pinning exactly: this sentence is the
// whole contract for "nothing matched", and the repo has been bitten before by a
// bare no-results line reading as "that thing does not exist" (CLAUDE.md,
// ClickUp searchDocs, ticket 86cb5r680).
//
// The query is deliberately impossible rather than merely unlikely, so this does
// not start failing the day someone creates a doc with a plausible name.
const IMPOSSIBLE_QUERY = 'zzz-no-such-document-zzz-9f3a1c7b';

test('listGoogleDocs says nothing matched, and does not read as an error', { timeout: 30_000 }, async () => {
  await runToolCheck({
    tool: 'listGoogleDocs',
    service: 'google-docs',
    account: 'sandbox',
    shape: 'zero',
    args: { query: IMPOSSIBLE_QUERY, maxResults: 10 },
    invariants: {
      includes: ['No Google Docs found matching your criteria.'],
      excludes: ['Error', 'Permission denied', 'Found '],
    },
  });
});
