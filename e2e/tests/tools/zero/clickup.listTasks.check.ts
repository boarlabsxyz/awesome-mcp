import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// An empty list. formatTaskList answers `No tasks found.` verbatim
// (src/clickup/formatHelpers.ts:111) and sharedTaskNote adds nothing for zero
// rows (src/clickup/server.ts:223). includeClosed so a closed task left behind
// by another check fails this loudly instead of hiding behind the default
// open-only filter.

const env = serviceEnv('clickup', ['E2E_SANDBOX_CLICKUP_EMPTY_LIST_ID']);

test('listTasks says an empty list has no tasks, and does not read as an error', { timeout: 30_000, skip: env.skip }, async () => {
  const LIST_ID = env.get('E2E_SANDBOX_CLICKUP_EMPTY_LIST_ID');

  await runToolCheck({
    tool: 'listTasks',
    service: 'clickup',
    account: 'sandbox',
    shape: 'zero',
    args: { listId: LIST_ID, includeClosed: true },
    invariants: {
      includes: ['No tasks found.'],
      excludes: ['ClickUp API error', 'Task: ', 'Tasks in Multiple Lists', 'undefined'],
    },
  });
});
