import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// The most-called ClickUp tool. formatTask (src/clickup/formatHelpers.ts:35)
// prints `Task: <name>`, `  ID: <id>` and `  List: <name> (<listId>)`, so the
// needle in the name is pinned to this task id AND its home list -- a second
// task someone gave the same name would carry a different ID line.

const env = serviceEnv('clickup', [
  'E2E_FIXTURE_CLICKUP_TASK_ID',
  'E2E_FIXTURE_CLICKUP_LIST_ID',
  'E2E_FIXTURE_CLICKUP_NEEDLE',
]);

test('getTask returns the frozen fixture task', { timeout: 30_000, skip: env.skip }, async () => {
  const TASK_ID = env.get('E2E_FIXTURE_CLICKUP_TASK_ID');
  const LIST_ID = env.get('E2E_FIXTURE_CLICKUP_LIST_ID');
  const NEEDLE = env.get('E2E_FIXTURE_CLICKUP_NEEDLE');

  await runToolCheck({
    tool: 'getTask',
    service: 'clickup',
    account: 'fixture',
    shape: 'needle',
    args: { taskId: TASK_ID },
    invariants: {
      includes: [`  ID: ${TASK_ID}\n`, `(${LIST_ID})`],
      transportSafe: true,
      // In the NAME line, not merely somewhere: getTask prints the full
      // description, and a needle there would pass on a renamed task.
      predicate: (body) => {
        const first = body.split('\n', 1)[0];
        return first.startsWith('Task: ') && first.includes(NEEDLE)
          ? undefined
          : `expected the first line to be "Task: <name containing ${NEEDLE}>", got ${JSON.stringify(first)}`;
      },
    },
  });
});
