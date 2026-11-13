import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// A well-formed message ID that does not exist. Gmail IDs are 16 hex digits;
// one of that shape gets a 404, which handleReadEmail maps to "Email not found"
// (src/google-gmail/toolHandlers.ts:88). A malformed ID gets a 400 "Invalid id
// value" instead, which falls through to the generic "Failed to reading email:"
// branch and would test the wrong mapping. UNVERIFIED live: if this goes red with
// that 400 text, Gmail has tightened what it calls well-formed -- change the ID,
// not the assertion.

const env = serviceEnv('google-gmail');
const NO_SUCH_MESSAGE = '18f0e2e0deadbeef';

test('readEmail says a nonexistent message was not found', { timeout: 30_000, skip: env.skip }, async () => {
  await runToolCheck({
    tool: 'readEmail',
    service: 'google-gmail',
    account: 'sandbox',
    shape: 'zero',
    args: { messageId: NO_SUCH_MESSAGE },
    expectToolError: true,
    invariants: {
      includes: [`Email not found (ID: ${NO_SUCH_MESSAGE}).`],
      excludes: ['undefined', 'Permission denied', 'Failed to', 'at Object.<anonymous>'],
    },
  });
});
