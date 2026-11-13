import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// The no-results answer, asserted verbatim against handleSearchEmails in
// src/google-gmail/toolHandlers.ts. The query is impossible rather than merely
// unlikely, so this does not start failing the day a real email mentions
// something plausible.

const env = serviceEnv('google-gmail');
const IMPOSSIBLE_QUERY = 'subject:"zzz-no-such-email-zzz-9f3a1c7b"';

test('searchEmails says nothing matched, and does not read as an error', { timeout: 30_000, skip: env.skip }, async () => {
  await runToolCheck({
    tool: 'searchEmails',
    service: 'google-gmail',
    account: 'sandbox',
    shape: 'zero',
    args: { query: IMPOSSIBLE_QUERY, maxResults: 10 },
    invariants: {
      includes: ['No emails found matching your search.'],
      excludes: ['Found ', 'Failed to', 'Permission denied', 'Next page token'],
    },
  });
});
