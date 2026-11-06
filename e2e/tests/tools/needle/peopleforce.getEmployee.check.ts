import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// The most-called PeopleForce tool. formatEmployee
// (src/peopleforce/apiHelpers.ts:1290) prints `# <name>`, `ID: <id>` and
// `Email: <email>` on lines of their own, so the needle is pinned to the
// designated test employee's ID AND their email line -- never a real person's
// data in source; both values come from the fixture tenant's env.

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const env = serviceEnv('peopleforce', ['E2E_FIXTURE_PF_EMPLOYEE_ID', 'E2E_FIXTURE_PF_EMPLOYEE_NEEDLE']);

test('getEmployee returns the designated test employee', { timeout: 30_000, skip: env.skip }, async () => {
  const EMPLOYEE_ID = env.get('E2E_FIXTURE_PF_EMPLOYEE_ID');
  const NEEDLE = env.get('E2E_FIXTURE_PF_EMPLOYEE_NEEDLE');

  await runToolCheck({
    tool: 'getEmployee',
    service: 'peopleforce',
    account: 'fixture',
    shape: 'needle',
    args: { employeeId: EMPLOYEE_ID },
    invariants: {
      // Whole lines: `ID: 12` alone is also a prefix of `ID: 123`.
      matches: [
        /^# \S/,
        new RegExp(`^ID: ${escape(EMPLOYEE_ID)}$`, 'm'),
        new RegExp(`^Email: ${escape(NEEDLE)}$`, 'm'),
      ],
      transportSafe: true,
    },
  });
});
