import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// A well-formed but nonexistent employee id. PeopleForce answers 404, which
// mapPeopleForceError (src/peopleforce/apiHelpers.ts:2041) turns into
// `${prefix}: not found.` with getEmployee's prefix `Failed to fetch employee`
// (src/peopleforce/server.ts:255). Observed live for id 999999999. The excludes
// catch the two ways this has gone wrong elsewhere in the repo: a 404 reported
// as an auth failure, and the raw `PeopleForce API GET ... failed:` text leaking
// through the generic branch.

const env = serviceEnv('peopleforce');

test('getEmployee says a nonexistent employee id was not found', { timeout: 30_000, skip: env.skip }, async () => {
  await runToolCheck({
    tool: 'getEmployee',
    service: 'peopleforce',
    account: 'sandbox',
    shape: 'zero',
    args: { employeeId: 999999999 },
    expectToolError: true,
    invariants: {
      includes: ['Failed to fetch employee: not found.'],
      excludes: ['not authorized', 'PeopleForce API', 'undefined', '    at '],
    },
  });
});
