import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// The no-results answer, asserted verbatim against handleSearchMessages in
// src/slack/helpers.ts. There are two empty answers and they mean different
// things: `No messages found for "<q>".` is Slack finding nothing, and
// `No messages you can access match "<q>".` is the access filter hiding
// everything Slack found. A caller deciding whether to widen its access rules
// depends on the two never being merged, so this pins the first and excludes the
// second.
//
// The query is impossible rather than merely unlikely.
const IMPOSSIBLE_QUERY = 'zzz-no-such-message-zzz-9f3a1c7b';

const env = serviceEnv('slack');

test('searchMessages says nothing matched, and does not read as an error', { timeout: 30_000, skip: env.skip }, async () => {
  await runToolCheck({
    tool: 'searchMessages',
    service: 'slack',
    account: 'sandbox',
    shape: 'zero',
    args: { query: IMPOSSIBLE_QUERY, count: 20 },
    invariants: {
      includes: [`No messages found for "${IMPOSSIBLE_QUERY}".`],
      excludes: ['Error', 'Access denied', 'Found ', 'you can access', 'hidden by your access rules'],
    },
  });
});

test(
  'searchMessages says when an empty page is past the last page, not that nothing matched',
  {
    todo:
      'src/slack/helpers.ts:403-404 returns `No messages found for "<q>".` whenever the page has no ' +
      'matches, before formatSearchTail runs -- so a page past the end drops Slack\'s total and ' +
      'paging and reads as "nothing matched" (CLAUDE.md: a capped or partial result must say so). ' +
      'UNVERIFIED live: assumes search.messages answers an out-of-range page with matches: [] and ' +
      'total > 0. Flip to a check with page: 9999 on a query that has matches once the tail is kept.',
  },
  () => {},
);
