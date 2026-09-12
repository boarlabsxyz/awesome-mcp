import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { required } from '../../../env.ts';

const DOC_ID = required('E2E_FIXTURE_DOC_ID');
const DOC_TITLE = required('E2E_FIXTURE_DOC_TITLE');

test('listGoogleDocs finds the fixture doc by title', { timeout: 30_000 }, async () => {
  await runToolCheck({
    tool: 'listGoogleDocs',
    service: 'google-docs',
    account: 'fixture',
    shape: 'needle',
    args: { query: DOC_TITLE, maxResults: 10 },
    invariants: {
      // The ID is the assertion that matters: a title match alone would also be
      // satisfied by a second doc someone named the same thing.
      includes: [DOC_TITLE, DOC_ID],
      matches: [/Found \d+ Google Document\(s\)/],
    },
  });
});
