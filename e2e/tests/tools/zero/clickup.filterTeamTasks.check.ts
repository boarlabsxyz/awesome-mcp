import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// A workspace-wide query narrowed to an empty list. The no-results sentence is
// `No tasks found matching filters.` (src/clickup/server.ts:1146).
//
// Narrowing by list rather than by an impossible tag on purpose: ClickUp drops
// a malformed array filter silently and returns unfiltered results
// (appendArrayFilter, src/clickup/apiHelpers.ts:7-27). A dropped `list_ids` here
// returns the sandbox workspace's tasks under `Found N task(s):`, so this check
// goes red on exactly the regression that would otherwise read as a real answer.

const env = serviceEnv('clickup', ['E2E_SANDBOX_CLICKUP_WORKSPACE_ID', 'E2E_SANDBOX_CLICKUP_EMPTY_LIST_ID']);

test('filterTeamTasks says nothing matched, and does not read as an error', { timeout: 30_000, skip: env.skip }, async () => {
  const WORKSPACE_ID = env.get('E2E_SANDBOX_CLICKUP_WORKSPACE_ID');
  const LIST_ID = env.get('E2E_SANDBOX_CLICKUP_EMPTY_LIST_ID');

  await runToolCheck({
    tool: 'filterTeamTasks',
    service: 'clickup',
    account: 'sandbox',
    shape: 'zero',
    args: { workspaceId: WORKSPACE_ID, listIds: [LIST_ID], includeClosed: true },
    invariants: {
      includes: ['No tasks found matching filters.'],
      excludes: ['Found ', 'Task: ', 'ClickUp API error', 'undefined'],
    },
  });
});
