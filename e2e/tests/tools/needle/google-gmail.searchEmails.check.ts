import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// The most-called tool on the platform, against one frozen fixture email. The
// message ID is the assertion that matters: the needle alone would also be
// satisfied by a second message someone sent with the same subject -- and
// "Found 1" is asserted so that a second one shows up as a fixture problem
// rather than as a pass.

const env = serviceEnv('google-gmail', ['E2E_FIXTURE_GMAIL_MESSAGE_ID', 'E2E_FIXTURE_GMAIL_NEEDLE']);

test('searchEmails finds the fixture email by subject', { timeout: 30_000, skip: env.skip }, async () => {
  const MESSAGE_ID = env.get('E2E_FIXTURE_GMAIL_MESSAGE_ID');
  const NEEDLE = env.get('E2E_FIXTURE_GMAIL_NEEDLE');

  await runToolCheck({
    tool: 'searchEmails',
    service: 'google-gmail',
    account: 'fixture',
    shape: 'needle',
    args: { query: `subject:"${NEEDLE}"`, maxResults: 10 },
    invariants: {
      // Entry format from formatEmailList (src/google-gmail/apiHelpers.ts):
      // "N. **<subject>**" then "   ID: <id>".
      includes: [NEEDLE, `   ID: ${MESSAGE_ID}\n`],
      transportSafe: true,
      predicate: (body) =>
        body.startsWith('Found 1 email(s):')
          ? undefined
          : `expected exactly one match for the needle, got ${JSON.stringify(body.slice(0, 40))}. ` +
            'E2E_FIXTURE_GMAIL_NEEDLE must be in the subject of one message only (a reply counts).',
    },
  });
});

// The capped half of the contract, on frozen data: with maxResults 1 any mailbox
// holding two messages has more than the page, and searchEmails must say so --
// it appends "**Next page token:** <token>" when Gmail returns one
// (src/google-gmail/toolHandlers.ts:121-123). Without that line "Found 1
// email(s)" reads as the whole mailbox.
const capped = serviceEnv('google-gmail');

test('searchEmails hands back a page token when the result is capped', { timeout: 30_000, skip: capped.skip }, async () => {
  await runToolCheck({
    tool: 'searchEmails',
    service: 'google-gmail',
    account: 'fixture',
    shape: 'needle',
    args: { query: 'in:anywhere', maxResults: 1 },
    invariants: {
      matches: [/^\*\*Next page token:\*\* \S+$/m],
      predicate: (body) =>
        body.startsWith('Found 1 email(s):')
          ? undefined
          : `expected one email on the page, got ${JSON.stringify(body.slice(0, 40))}. ` +
            'The fixture mailbox needs at least two messages for this check to mean anything.',
    },
  });
});
