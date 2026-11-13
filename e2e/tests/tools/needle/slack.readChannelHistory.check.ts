import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// The user-token read, behind enforceAccess (src/slack-user/server.ts). A
// refused channel throws `Access denied: ...` as a tool error, so a fixture
// account whose rules stop allowing the channel fails loudly here rather than
// reading as an empty channel.
//
// The read is windowed to a few seconds around the needle message. A Slack
// channel is visible to people, and one stray post would otherwise push the
// needle past `limit` and turn a frozen fixture into a flaky one.

const env = serviceEnv('slack', [
  'E2E_FIXTURE_SLACK_CHANNEL_ID',
  'E2E_FIXTURE_SLACK_THREAD_TS',
  'E2E_FIXTURE_SLACK_NEEDLE',
]);

test('readChannelHistory returns the frozen fixture message', { timeout: 30_000, skip: env.skip }, async () => {
  const CHANNEL_ID = env.get('E2E_FIXTURE_SLACK_CHANNEL_ID');
  const THREAD_TS = env.get('E2E_FIXTURE_SLACK_THREAD_TS');
  const NEEDLE = env.get('E2E_FIXTURE_SLACK_NEEDLE');
  const second = Math.floor(Number(THREAD_TS));

  await runToolCheck({
    tool: 'readChannelHistory',
    service: 'slack',
    account: 'fixture',
    shape: 'needle',
    args: { channelId: CHANNEL_ID, oldest: String(second - 1), latest: String(second + 2), limit: 20 },
    invariants: {
      // formatMessage: `[time] (ts: <ts>) who: text [N replies] <permalink>`.
      // The replies marker proves the parent is the threaded fixture message,
      // not a copy of the needle.
      includes: [NEEDLE, `(ts: ${THREAD_TS})`],
      matches: [/ \[\d+ replies\]/],
      excludes: ['No messages found in this channel.', 'Access denied'],
      transportSafe: true,
    },
  });
});
