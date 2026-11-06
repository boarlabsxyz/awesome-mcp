import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';

// The no-results answer, asserted verbatim against handleSearchGoogleDocs in
// src/google-drive/toolHandlers.ts. It is a different sentence from
// listGoogleDocs' ("No Google Docs found matching your criteria."), so each
// needs its own pin: a refactor that unifies them would break callers matching
// on either one.
//
// searchIn 'both' on purpose: it is the default, and the only branch whose query
// ORs two terms, so it is the one that could match something unintended.
const IMPOSSIBLE_QUERY = 'zzz-no-such-document-zzz-9f3a1c7b';

test('searchGoogleDocs says nothing matched, and does not read as an error', { timeout: 30_000 }, async () => {
  await runToolCheck({
    tool: 'searchGoogleDocs',
    service: 'google-docs',
    account: 'sandbox',
    shape: 'zero',
    args: { searchQuery: IMPOSSIBLE_QUERY, searchIn: 'both', maxResults: 10 },
    invariants: {
      includes: [`No Google Docs found containing "${IMPOSSIBLE_QUERY}".`],
      excludes: ['Error', 'Permission denied', 'Found '],
    },
  });
});
