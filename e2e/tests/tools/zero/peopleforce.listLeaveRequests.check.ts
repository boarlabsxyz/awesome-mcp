import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// `state` is the only filter PeopleForce honours on leave requests (no employee
// or date range -- src/peopleforce/apiHelpers.ts:11-14), so the zero case is an
// impossible state. It is a free string (src/peopleforce/server.ts:282), and an
// upstream that ignored unknown values would answer with every request -- the
// failure CLAUDE.md records for the employee `status` filter -- so `## 1.`
// is banned.
//
// The empty answer comes from renderEmptyList (apiHelpers.ts:1103): with
// pagination present it is the `# Leave Requests` header, a `Page ...` line
// and `No leave requests on this page.`, not `No leave requests found.`
// Observed live: `Page 1 of 1 (0 total, 0 per page)`. `0 total` is what tells a
// caller the filter matched nothing rather than that it paged past the end.

const IMPOSSIBLE_STATE = 'zzz-no-such-state-zzz-9f3a1c7b';

const env = serviceEnv('peopleforce');

test('listLeaveRequests says nothing matched an impossible state', { timeout: 30_000, skip: env.skip }, async () => {
  await runToolCheck({
    tool: 'listLeaveRequests',
    service: 'peopleforce',
    account: 'sandbox',
    shape: 'zero',
    args: { page: 1, state: IMPOSSIBLE_STATE },
    invariants: {
      includes: ['# Leave Requests', '(0 total,', 'No leave requests on this page.'],
      excludes: ['## 1.', 'Failed to list leave requests', 'not authorized'],
    },
  });
});
