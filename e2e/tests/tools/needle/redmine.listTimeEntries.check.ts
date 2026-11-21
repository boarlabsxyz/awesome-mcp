import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// The fixture time entry, found by its project and its one-day date range.
// formatTimeEntryList (src/redmine/apiHelpers.ts:1049) heads each row
// `## <i>. <hours>h on <spent_on>`, then `ID: <id>` and `Comments: <text>` as
// their own lines, so the needle (in the comment) is pinned to this entry id.
//
// It also claims its extent, and that claim is asserted: renderPageLine prints
// `Showing N-M of TOTAL.` (apiHelpers.ts:673), and a single page labels its sum
// `Hours on this page` with the allPages pointer (apiHelpers.ts:1092) so a page
// total never reads as a grand total.
//
// If /time_entries.json is blocked on the instance, the named project lets the
// tool retry /projects/{id}/time_entries.json and say so; the needle still
// comes back, plus a ⚠ note, and this still passes.

const env = serviceEnv('redmine', [
  'E2E_FIXTURE_REDMINE_PROJECT_ID',
  'E2E_FIXTURE_REDMINE_TIME_ENTRY_ID',
  'E2E_FIXTURE_REDMINE_TIME_ENTRY_DATE',
  'E2E_FIXTURE_REDMINE_NEEDLE',
]);

test('listTimeEntries finds the fixture entry and reports its page', { timeout: 30_000, skip: env.skip }, async () => {
  const PROJECT_ID = env.get('E2E_FIXTURE_REDMINE_PROJECT_ID');
  const ENTRY_ID = env.get('E2E_FIXTURE_REDMINE_TIME_ENTRY_ID');
  const DATE = env.get('E2E_FIXTURE_REDMINE_TIME_ENTRY_DATE');
  const NEEDLE = env.get('E2E_FIXTURE_REDMINE_NEEDLE');

  await runToolCheck({
    tool: 'listTimeEntries',
    service: 'redmine',
    account: 'fixture',
    shape: 'needle',
    args: { projectId: PROJECT_ID, from: DATE, to: DATE, limit: 100 },
    invariants: {
      includes: [
        `h on ${DATE}\n`,
        `\nID: ${ENTRY_ID}\n`,
        'Hours on this page: ',
        'Note: that sum is this page only. Set allPages=true to total the whole result set.',
      ],
      matches: [/^# Time entries\n\nShowing \d+-\d+ of \d+\./],
      transportSafe: true,
      // In the fixture entry's own block ("## N. ..." up to the next "## "):
      // another entry on that day could carry the needle too.
      predicate: (body) => {
        const lines = body.split('\n');
        const at = lines.indexOf(`ID: ${ENTRY_ID}`);
        if (at === -1) return `no entry has ID ${ENTRY_ID}`;
        const next = lines.findIndex((line, i) => i > at && line.startsWith('## '));
        return lines.slice(at, next === -1 ? undefined : next).some((line) => line.startsWith('Comments: ') && line.includes(NEEDLE))
          ? undefined
          : `entry ${ENTRY_ID} has no "Comments:" line containing ${JSON.stringify(NEEDLE)}. The fixture entry on ${DATE} must carry the needle in its comment.`;
      },
    },
  });
});
