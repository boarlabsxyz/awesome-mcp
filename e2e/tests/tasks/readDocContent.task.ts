import { test } from 'node:test';
import { runSmokeTest } from '../../runSmokeTest.ts';
import { required } from '../../env.ts';
import type { ClientName } from '../../drivers/driver.ts';
import { taskTimeoutMs } from '../../budget.ts';

// The chain canary: client → connector → OAuth → tool → render, with an id the
// user pasted. Unlike tests/readGoogleDoc.smoke.ts it does not name the tool or
// its parameters, so it also covers the model choosing the right one from the
// connector's surface -- which is a tool-description problem when it goes wrong,
// not a server problem.

const DOC_ID = required('E2E_FIXTURE_DOC_ID');
const NEEDLE = required('E2E_FIXTURE_DOC_NEEDLE');
const CLIENT = (process.env.CLIENT ?? 'claude-web') as ClientName;

test(`read a document the user names by id (${CLIENT})`, { timeout: taskTimeoutMs() }, async () => {
  await runSmokeTest({
    name: 'task-readDocContent',
    client: CLIENT,
    prompt: `What does this Google Doc say? https://docs.google.com/document/d/${DOC_ID}/edit`,
    assertions: {
      mustNotReportFailure: true,
      includes: [NEEDLE],
    },
  });
});
