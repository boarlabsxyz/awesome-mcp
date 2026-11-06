import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// The fixture task, found by listing its HOME list. Asserting `(${LIST_ID})`
// beside the ID and excluding sharedTaskNote's sentence (src/clickup/server.ts:224)
// pins that it came back as a native member of the list, not shared in through
// include_timl -- which listTasks turns on by default.
//
// includeClosed so the check does not depend on the fixture task's status. The
// list must stay under 100 tasks: listTasks returns ClickUp's first page only.

const env = serviceEnv('clickup', [
  'E2E_FIXTURE_CLICKUP_TASK_ID',
  'E2E_FIXTURE_CLICKUP_LIST_ID',
  'E2E_FIXTURE_CLICKUP_NEEDLE',
]);

test('listTasks finds the fixture task in its home list', { timeout: 30_000, skip: env.skip }, async () => {
  const TASK_ID = env.get('E2E_FIXTURE_CLICKUP_TASK_ID');
  const LIST_ID = env.get('E2E_FIXTURE_CLICKUP_LIST_ID');
  const NEEDLE = env.get('E2E_FIXTURE_CLICKUP_NEEDLE');

  await runToolCheck({
    tool: 'listTasks',
    service: 'clickup',
    account: 'fixture',
    shape: 'needle',
    args: { listId: LIST_ID, includeClosed: true },
    invariants: {
      includes: [NEEDLE, `  ID: ${TASK_ID}\n`, `(${LIST_ID})`],
      excludes: ['appear here through Tasks in Multiple Lists', 'No tasks found.'],
      transportSafe: true,
    },
  });
});

// The reply carries no page number and no "more may exist" line: formatTaskList
// (src/clickup/formatHelpers.ts:110) joins the rows and nothing else, and the
// handler ignores ClickUp's `last_page` (src/clickup/server.ts:289-300). A list
// of exactly 100 and a list of 5,000 render identically, which reads as "that is
// everything". Becomes a volume check once the page and its extent are reported.
test(
  'listTasks reports which page it returned and whether more exist',
  { todo: 'no page / last_page in the output (src/clickup/server.ts:300, formatHelpers.ts:110)' },
  () => {},
);
