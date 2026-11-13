import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// The empty answer versus the refused one. On the user server a channel the
// access rules deny throws `Access denied: ...` (SlackAccessDenied,
// src/slack-user/accessControl.ts) as a tool error; a channel with nothing in
// range answers `No messages found in this channel.` (handleReadChannelHistory,
// src/slack/helpers.ts) as a success. The two must never collapse into one
// another: an agent told "no messages" stops looking, an agent told "denied"
// asks for access.
//
// A Slack channel is never truly empty -- creating one posts a channel_join --
// so the empty state is a window before the workspace could have existed
// (2001-09-09, a few seconds after Unix time 1e9).
const BEFORE_ANY_WORKSPACE = { oldest: '1000000000', latest: '1000000060' };

const env = serviceEnv('slack', ['E2E_SANDBOX_SLACK_CHANNEL_ID']);

test('readChannelHistory answers an empty window calmly, and not as a denial', { timeout: 30_000, skip: env.skip }, async () => {
  const CHANNEL_ID = env.get('E2E_SANDBOX_SLACK_CHANNEL_ID');

  await runToolCheck({
    tool: 'readChannelHistory',
    service: 'slack',
    account: 'sandbox',
    shape: 'zero',
    args: { channelId: CHANNEL_ID, ...BEFORE_ANY_WORKSPACE, limit: 20 },
    invariants: {
      includes: ['No messages found in this channel.'],
      excludes: ['Access denied', 'Error', '(ts: ', 'More messages available', 'undefined'],
    },
  });
});

test(
  'readChannelHistory says an empty answer is empty for the oldest/latest window, not the channel',
  {
    todo:
      'src/slack/helpers.ts:280 answers every empty text page with "No messages found in this ' +
      'channel." even when oldest/latest narrowed the read, so an empty window reads as an empty ' +
      'channel. helpers.ts:247 also returns that sentence before looking at next_cursor, so an ' +
      'empty page that still has a cursor would drop it. Flip to a check asserting the window is ' +
      'named once the sentence says it.',
  },
  () => {},
);
