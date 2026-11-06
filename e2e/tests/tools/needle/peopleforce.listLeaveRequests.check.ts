import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// PeopleForce's public API filters leave requests by `state` only -- employee
// and date-range filters do not work upstream (src/peopleforce/apiHelpers.ts:11-14)
// and the tool does not expose them. So the needle is one
// frozen, approved leave request of the designated test employee, found on
// page 1 of state=approved: formatLeaveRequestList (apiHelpers.ts:1344) prints
// `ID:`, `Employee ID:`, `State:` and `Comment:` lines per `## n.` block, and
// all four are asserted inside the block carrying the request's ID.
//
// The state filter is asserted too: every `State:` line must be `approved`.
// src/peopleforce/CLAUDE.md records the employee `status` filter failing open
// on an unknown value; this catches the same thing happening to `state`.

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const env = serviceEnv('peopleforce', [
  'E2E_FIXTURE_PF_EMPLOYEE_ID',
  'E2E_FIXTURE_PF_LEAVE_REQUEST_ID',
  'E2E_FIXTURE_PF_LEAVE_NEEDLE',
]);

test('listLeaveRequests lists the test employee\'s frozen approved request', { timeout: 30_000, skip: env.skip }, async () => {
  const EMPLOYEE_ID = env.get('E2E_FIXTURE_PF_EMPLOYEE_ID');
  const REQUEST_ID = env.get('E2E_FIXTURE_PF_LEAVE_REQUEST_ID');
  const NEEDLE = env.get('E2E_FIXTURE_PF_LEAVE_NEEDLE');

  await runToolCheck({
    tool: 'listLeaveRequests',
    service: 'peopleforce',
    account: 'fixture',
    shape: 'needle',
    args: { page: 1, state: 'approved' },
    invariants: {
      matches: [/^# Leave Requests\n/, /^Page 1 of \d+/m],
      transportSafe: true,
      predicate: (body) => {
        const states = [...body.matchAll(/^State: (.*)$/gm)].map((m) => m[1]);
        const stray = states.filter((s) => s !== 'approved');
        if (stray.length > 0) {
          return `state=approved returned ${stray.length} request(s) in other states (${[...new Set(stray)].join(', ')}): the filter failed open`;
        }
        const idLine = new RegExp(`^ID: ${escape(REQUEST_ID)}$`, 'm');
        const block = body.split(/^## \d+\. /m).find((b) => idLine.test(b));
        if (!block) {
          const pages = body.match(/^Page 1 of (\d+)/m)?.[1];
          return (
            `leave request ${REQUEST_ID} is not on page 1 of ${pages ?? '?'} of approved requests. Point ` +
            'E2E_FIXTURE_PF_LEAVE_REQUEST_ID at an APPROVED request in a fixture tenant with at most 100 approved requests.'
          );
        }
        const want = [
          new RegExp(`^Employee ID: ${escape(EMPLOYEE_ID)}$`, 'm'),
          /^State: approved$/m,
          new RegExp(`^Comment: ${escape(NEEDLE)}$`, 'm'),
        ];
        const missing = want.filter((re) => !re.test(block));
        return missing.length === 0
          ? undefined
          : `request ${REQUEST_ID}'s block does not match ${missing.join(', ')}: ${JSON.stringify(block.slice(0, 300))}`;
      },
    },
  });
});
