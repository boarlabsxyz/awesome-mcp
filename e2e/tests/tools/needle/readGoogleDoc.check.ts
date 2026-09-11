import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { required } from '../../../env.ts';

// The direct-transport twin of tests/readGoogleDoc.smoke.ts. Same account, same
// fixture, same needle -- what differs is that the smoke test proves a real
// client can reach the tool, and this one proves the tool's own output, in about
// a second rather than a two-minute conversation. Keep both: when the smoke test
// goes red, whichever of the two is still green tells you which half broke.

const DOC_ID = required('E2E_FIXTURE_DOC_ID');
const NEEDLE = required('E2E_FIXTURE_DOC_NEEDLE');

test('readGoogleDoc returns the frozen fixture text', { timeout: 30_000 }, async () => {
  await runToolCheck({
    tool: 'readGoogleDoc',
    service: 'google-docs',
    account: 'fixture',
    shape: 'needle',
    args: { documentId: DOC_ID, format: 'text' },
    invariants: { includes: [NEEDLE], transportSafe: true },
  });
});
