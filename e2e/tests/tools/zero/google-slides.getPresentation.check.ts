import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// A well-formed ID that names no presentation. handleSlidesError
// (src/google-slides/toolHandlers.ts) maps the Slides 404 to
// `Presentation not found (ID: <id>).`; the 403 branch's "Permission denied for
// this presentation." would send the caller to fix sharing on a deck that does
// not exist, and the 400 branch would mean the ID was not even well-formed.
const NO_SUCH_PRESENTATION = '1zzzNoSuchDeckZzzZzz9f3a1c7bQqQqQqQqQqQqQqQq';

const env = serviceEnv('google-slides');

test('getPresentation says a nonexistent presentation was not found', { timeout: 30_000, skip: env.skip }, async () => {
  await runToolCheck({
    tool: 'getPresentation',
    service: 'google-slides',
    account: 'sandbox',
    shape: 'zero',
    expectToolError: true,
    args: { presentationId: NO_SUCH_PRESENTATION },
    invariants: {
      includes: [`Presentation not found (ID: ${NO_SUCH_PRESENTATION}).`],
      excludes: ['Permission denied', 'Invalid request', 'undefined', 'Traceback', 'at Object.<anonymous>'],
    },
  });
});
