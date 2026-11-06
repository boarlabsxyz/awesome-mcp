import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// A well-formed but nonexistent document id: a valid v4 UUID nobody holds.
// documents.info answers 404, which mapOutlineError (src/outline/apiHelpers.ts:765)
// turns into `${prefix}: not found.` with getDocument's prefix `Failed to read
// document` (src/outline/server.ts:59). UNVERIFIED live -- if this goes red with
// `not authorized. Check that your Outline token has access.`, Outline answered
// 403 for a missing id, and that message would send a caller to reconnect a
// working token: a finding, not an assertion to relax.

const NONEXISTENT_DOC_ID = '00000000-0000-4000-8000-000000000000';

const env = serviceEnv('outline');

test('getDocument says a nonexistent document id was not found', { timeout: 30_000, skip: env.skip }, async () => {
  await runToolCheck({
    tool: 'getDocument',
    service: 'outline',
    account: 'sandbox',
    shape: 'zero',
    args: { documentId: NONEXISTENT_DOC_ID },
    expectToolError: true,
    invariants: {
      includes: ['Failed to read document: not found.'],
      excludes: ['not authorized', 'Outline API', 'undefined', '    at '],
    },
  });
});
