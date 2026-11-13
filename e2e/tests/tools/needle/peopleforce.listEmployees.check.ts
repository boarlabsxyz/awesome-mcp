import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// listEmployees has no search or email filter -- only `page` and `status`
// (src/peopleforce/server.ts:221) -- so the needle is the designated test
// employee appearing on page 1 of the default (active-only) list. formatEmployeeList
// (src/peopleforce/apiHelpers.ts:1159) prints one `## n. <name>` block per
// employee with `ID:` and `Email:` lines; the email is asserted inside the block
// that carries the employee's ID, so a second record with the same email, or the
// ID and email landing in different records, does not pass.
//
// There is no zero shape for this tool: with no filter, nothing makes an empty
// result deterministic.

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const env = serviceEnv('peopleforce', ['E2E_FIXTURE_PF_EMPLOYEE_ID', 'E2E_FIXTURE_PF_EMPLOYEE_NEEDLE']);

test('listEmployees lists the designated test employee on page 1', { timeout: 30_000, skip: env.skip }, async () => {
  const EMPLOYEE_ID = env.get('E2E_FIXTURE_PF_EMPLOYEE_ID');
  const NEEDLE = env.get('E2E_FIXTURE_PF_EMPLOYEE_NEEDLE');

  await runToolCheck({
    tool: 'listEmployees',
    service: 'peopleforce',
    account: 'fixture',
    shape: 'needle',
    args: { page: 1 },
    invariants: {
      matches: [/^# Employees\n/, /^Page 1 of \d+/m],
      transportSafe: true,
      predicate: (body) => {
        const idLine = new RegExp(`^ID: ${escape(EMPLOYEE_ID)}$`, 'm');
        const block = body.split(/^## \d+\. /m).find((b) => idLine.test(b));
        if (!block) {
          const pages = body.match(/^Page 1 of (\d+)/m)?.[1];
          return (
            `employee ${EMPLOYEE_ID} is not on page 1 of ${pages ?? '?'}. It must be ACTIVE (the default ` +
            'cohort) and on the first page, which this tool cannot search past -- point ' +
            'E2E_FIXTURE_PF_EMPLOYEE_ID at an active employee of a fixture tenant with at most 50 active employees.'
          );
        }
        return new RegExp(`^Email: ${escape(NEEDLE)}$`, 'm').test(block)
          ? undefined
          : `employee ${EMPLOYEE_ID}'s block lacks "Email: ${NEEDLE}": ${JSON.stringify(block.slice(0, 300))}`;
      },
    },
  });
});
