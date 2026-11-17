import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// The frozen fixture email, read by ID. The needle is asserted AFTER the
// "**Body:**" marker, not just anywhere: it is also in the subject, and a
// subject match alone would pass with extractBody returning nothing -- the
// MIME walk (src/google-gmail/apiHelpers.ts) is the part of readEmail that can
// actually break, and renderEmail omits the Body section entirely when it finds
// no text.

const env = serviceEnv('google-gmail', ['E2E_FIXTURE_GMAIL_MESSAGE_ID', 'E2E_FIXTURE_GMAIL_NEEDLE']);

test('readEmail returns the frozen fixture email, body included', { timeout: 30_000, skip: env.skip }, async () => {
  const MESSAGE_ID = env.get('E2E_FIXTURE_GMAIL_MESSAGE_ID');
  const NEEDLE = env.get('E2E_FIXTURE_GMAIL_NEEDLE');

  await runToolCheck({
    tool: 'readEmail',
    service: 'google-gmail',
    account: 'fixture',
    shape: 'needle',
    args: { messageId: MESSAGE_ID, format: 'full' },
    invariants: {
      // Lines from renderEmail (src/google-gmail/apiHelpers.ts).
      includes: [`**Message ID:** ${MESSAGE_ID}\n`, '**Body:**'],
      transportSafe: true,
      predicate: (body) => {
        const bodyAt = body.indexOf('**Body:**');
        if (bodyAt === -1) return undefined; // includes already reported it
        return body.indexOf(NEEDLE, bodyAt) === -1
          ? 'the needle is not in the rendered body. E2E_FIXTURE_GMAIL_NEEDLE must appear in the ' +
              'fixture email\'s text, not only its subject.'
          : undefined;
      },
    },
  });
});
