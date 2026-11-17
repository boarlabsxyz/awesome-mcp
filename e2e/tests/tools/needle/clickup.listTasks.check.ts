import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';
import { checkFixtureTaskRow } from '../clickupTaskRow.ts';

// The fixture task, found by listing its HOME list. Its row must name the list,
// and sharedTaskNote (src/clickup/server.ts) must not list it among the tasks
// shared in through include_timl -- which listTasks turns on by default. Other
// tasks shared into the list are fine; the note naming them is not a failure.
//
// includeClosed so the check does not depend on the fixture task's status, and
// subtasks so a fixture that is a subtask is not silently omitted. The list
// must stay under 100 tasks: listTasks returns ClickUp's first page only.

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
    args: { listId: LIST_ID, includeClosed: true, subtasks: true },
    invariants: {
      excludes: [`${TASK_ID} (home:`, 'No tasks found.'],
      transportSafe: true,
      predicate: (body) => checkFixtureTaskRow(body, { taskId: TASK_ID, listId: LIST_ID, needle: NEEDLE }),
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
