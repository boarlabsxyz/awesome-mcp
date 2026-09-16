import { test } from 'node:test';
import { runSmokeTest } from '../../runSmokeTest.ts';
import type { ClientName } from '../../drivers/driver.ts';

// Ordering, asked for in the way a person asks for it.
//
// There is no way to assert WHICH document comes back -- the fixture account is
// shared and changes -- so this asserts the two things that are stable: that a
// title came back at all, and that the model did not have to explain a failure
// instead. That is enough to catch a whole class of regression, because the
// sorting parameters are exactly what Drive is fussy about, and "which changed
// most recently" is the request that exercises them.
//
// A test that can only fail loudly is still worth having when the failure it
// catches is otherwise invisible.

const CLIENT = (process.env.CLIENT ?? 'claude-web') as ClientName;

test(`name the most recently changed document (${CLIENT})`, { timeout: 240_000 }, async () => {
  await runSmokeTest({
    name: 'task-mostRecentDoc',
    client: CLIENT,
    prompt: [
      'Which of my Google Docs was changed most recently?',
      'Reply with exactly this and nothing else:',
      'OUTPUT_BEGIN<the document title>OUTPUT_END',
    ].join('\n'),
    assertions: {
      mustNotReportFailure: true,
      containsBetween: ['OUTPUT_BEGIN', 'OUTPUT_END'],
      // Some title, any title. An empty envelope means the model produced the
      // shape without an answer, which is a pass for containsBetween alone.
      matchesBody: /\S{3,}/,
    },
  });
});
