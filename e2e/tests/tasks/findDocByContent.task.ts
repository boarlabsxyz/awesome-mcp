import { test } from 'node:test';
import { runSmokeTest } from '../../runSmokeTest.ts';
import { required } from '../../env.ts';
import type { ClientName } from '../../drivers/driver.ts';

// THE test this tier exists for.
//
// "Find my doc about X" is the most ordinary request anyone makes of a Docs
// connector, and it is the one that was broken for months. A model answering it
// reaches for listGoogleDocs with a query -- and listGoogleDocs sent an orderBy
// with every call, which Drive rejects on any query carrying a fullText term.
// Every search 403'd.
//
// Nothing else in the suite would have found that. The tool checks assert the
// argument combinations someone thought to write down; a model picks its own,
// and the failing combination here was the DEFAULT one. That is the whole
// argument for driving a real client: it explores the parameter space the way
// users actually do.
//
// Note what the model does with the failure, which is the second reason this
// tier matters: it does not crash. It says "I don't have permission to search
// your Drive", or silently retries with searchGoogleDocs and answers correctly.
// Both look like success to anything watching the transport, and neither gets
// reported as a bug, because the assistant sounds like it is working.

const NEEDLE = required('E2E_FIXTURE_DOC_NEEDLE');
const TITLE = required('E2E_FIXTURE_DOC_TITLE');
const CLIENT = (process.env.CLIENT ?? 'claude-web') as ClientName;

test(`find a document by its content (${CLIENT})`, { timeout: 240_000 }, async () => {
  await runSmokeTest({
    name: 'task-findDocByContent',
    client: CLIENT,
    // No tool named, no parameters given. That is the point.
    prompt: [
      `I have a Google Doc somewhere that mentions ${NEEDLE}. Find it and tell me its title.`,
      'Reply with exactly this and nothing else:',
      'OUTPUT_BEGIN<the document title>OUTPUT_END',
    ].join('\n'),
    assertions: {
      mustNotReportFailure: true,
      containsBetween: ['OUTPUT_BEGIN', 'OUTPUT_END'],
      includes: [TITLE],
    },
  });
});
