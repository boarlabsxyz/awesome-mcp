import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// A date range that cannot hold a time entry. renderList hands an empty page to
// renderEmptyList (src/redmine/apiHelpers.ts:691), which answers `No time
// entries found.` -- distinct from its past-the-end sentence, which only fires
// when total_count > 0 -- and formatTimeEntryList adds no hours line or note
// for zero rows without a scan (apiHelpers.ts:1073, 1090-1093).
//
// Workspace-wide on purpose: that is the default call. It has no per-project
// fallback on a single page (listTimeEntriesPage, src/redmine/ops.ts), so the
// sandbox account must be able to read /time_entries.json itself.
const EMPTY_RANGE = { from: '1970-01-01', to: '1970-01-02' };

const env = serviceEnv('redmine');

test('listTimeEntries says an empty date range has no entries, and does not read as an error', { timeout: 30_000, skip: env.skip }, async () => {
  await runToolCheck({
    tool: 'listTimeEntries',
    service: 'redmine',
    account: 'sandbox',
    shape: 'zero',
    args: { ...EMPTY_RANGE, limit: 10 },
    invariants: {
      includes: ['No time entries found.'],
      excludes: ['Failed to list time entries', 'Hours on this page', '## 1.', 'past the end', 'undefined'],
    },
  });
});
