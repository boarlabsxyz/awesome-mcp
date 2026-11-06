import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// The fixture task, found workspace-wide by narrowing to its home list.
// filterTeamTasks has no name search, and listIds is the one filter that pins a
// single task without seeding a tag. It is also the filter most at risk: the
// endpoint silently DROPS an array filter sent as `list_ids[]=X` and 400s on a
// lone `list_ids=X` (appendArrayFilter, src/clickup/apiHelpers.ts:7-27, which
// sends a single id twice), so the zero twin of this
// check is what catches a dropped filter; this one catches a filter that
// excludes what it should match.
//
// The header is `Found ${n} task(s):` (src/clickup/server.ts:1147).

const env = serviceEnv('clickup', [
  'E2E_FIXTURE_CLICKUP_WORKSPACE_ID',
  'E2E_FIXTURE_CLICKUP_TASK_ID',
  'E2E_FIXTURE_CLICKUP_LIST_ID',
  'E2E_FIXTURE_CLICKUP_NEEDLE',
]);

test('filterTeamTasks finds the fixture task by its home list', { timeout: 30_000, skip: env.skip }, async () => {
  const WORKSPACE_ID = env.get('E2E_FIXTURE_CLICKUP_WORKSPACE_ID');
  const TASK_ID = env.get('E2E_FIXTURE_CLICKUP_TASK_ID');
  const LIST_ID = env.get('E2E_FIXTURE_CLICKUP_LIST_ID');
  const NEEDLE = env.get('E2E_FIXTURE_CLICKUP_NEEDLE');

  await runToolCheck({
    tool: 'filterTeamTasks',
    service: 'clickup',
    account: 'fixture',
    shape: 'needle',
    args: { workspaceId: WORKSPACE_ID, listIds: [LIST_ID], includeClosed: true },
    invariants: {
      matches: [/^Found \d+ task\(s\):/],
      includes: [NEEDLE, `  ID: ${TASK_ID}\n`, `(${LIST_ID})`],
      transportSafe: true,
    },
  });
});

// `Found N task(s):` says nothing about the page: no page number, no next page,
// and ClickUp's `last_page` is dropped (src/clickup/server.ts:1145-1147). The
// description tells the caller to iterate until a page returns fewer than 100,
// so the caller has to count rows to learn the scan extent, and a page past the
// end answers `No tasks found matching filters.` (server.ts:1146), the same
// sentence as a filter that matches nothing.
test(
  'filterTeamTasks reports the page it returned and whether more exist',
  { todo: 'no page / last_page in the output; past-the-end page reads as no matches (src/clickup/server.ts:1146-1147)' },
  () => {},
);
