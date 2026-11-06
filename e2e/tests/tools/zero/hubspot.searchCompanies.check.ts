import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// The no-results answer, asserted verbatim against formatObjectList
// (src/hubspot/apiHelpers.ts:507) with label `companies`. One token rather
// than the usual hyphenated form: HubSpot's free-text query matches on tokens,
// and `no` / `such` / `company` are each plausible in a real CRM.

const IMPOSSIBLE_QUERY = 'zzznosuchcompanyzzz9f3a1c7b';

const env = serviceEnv('hubspot');

test('searchCompanies says nothing matched, and does not read as an error', { timeout: 30_000, skip: env.skip }, async () => {
  await runToolCheck({
    tool: 'searchCompanies',
    service: 'hubspot',
    account: 'sandbox',
    shape: 'zero',
    args: { query: IMPOSSIBLE_QUERY, limit: 10 },
    invariants: {
      includes: ['No companies found.'],
      excludes: ['Found ', 'Failed to search companies', 'not authorized'],
    },
  });
});
