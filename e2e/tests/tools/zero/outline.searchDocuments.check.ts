import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// The no-results answer, asserted verbatim against formatSearchResults
// (src/outline/apiHelpers.ts:388). One token rather than the usual hyphenated
// form: Outline's full-text search tokenises on hyphens, and `no`, `such` and
// `document` on their own are all plausible words in a real wiki.

const IMPOSSIBLE_QUERY = 'zzznosuchdocumentzzz9f3a1c7b';

const env = serviceEnv('outline');

test('searchDocuments says nothing matched, and does not read as an error', { timeout: 30_000, skip: env.skip }, async () => {
  await runToolCheck({
    tool: 'searchDocuments',
    service: 'outline',
    account: 'sandbox',
    shape: 'zero',
    args: { query: IMPOSSIBLE_QUERY, limit: 25 },
    invariants: {
      includes: ['No documents found matching your search.'],
      excludes: ['# Search Results', 'Failed to search documents', 'not authorized'],
    },
  });
});
