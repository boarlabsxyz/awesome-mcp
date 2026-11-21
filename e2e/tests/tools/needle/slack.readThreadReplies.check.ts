import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// conversations.replies returns the thread parent first, and the fixture parent
// carries the needle too -- so a bare `includes: [NEEDLE]` would pass on a
// response holding only the parent, which is exactly what a broken reply read
// looks like. The predicate requires the needle on a line whose ts is NOT the
// parent's.

const env = serviceEnv('slack', [
  'E2E_FIXTURE_SLACK_CHANNEL_ID',
  'E2E_FIXTURE_SLACK_THREAD_TS',
  'E2E_FIXTURE_SLACK_NEEDLE',
]);

test('readThreadReplies returns the frozen fixture reply', { timeout: 30_000, skip: env.skip }, async () => {
  const CHANNEL_ID = env.get('E2E_FIXTURE_SLACK_CHANNEL_ID');
  const THREAD_TS = env.get('E2E_FIXTURE_SLACK_THREAD_TS');
  const NEEDLE = env.get('E2E_FIXTURE_SLACK_NEEDLE');

  await runToolCheck({
    tool: 'readThreadReplies',
    service: 'slack',
    account: 'fixture',
    shape: 'needle',
    args: { channelId: CHANNEL_ID, threadTs: THREAD_TS, limit: 50 },
    invariants: {
      includes: [`(ts: ${THREAD_TS})`, NEEDLE],
      excludes: ['Access denied', 'No replies found in this thread.'],
      transportSafe: true,
      predicate: (body) => {
        // formatMessage: `[time] (ts: <ts>) who: text ...`, one per message.
        const reply = body
          .split('\n')
          .find((line) => line.includes(NEEDLE) && /\(ts: [\d.]+\)/.test(line) && !line.includes(`(ts: ${THREAD_TS})`));
        return reply
          ? undefined
          : `no reply line carries the needle -- only the parent did. Point E2E_FIXTURE_SLACK_THREAD_TS ` +
              'at a message with a reply containing E2E_FIXTURE_SLACK_NEEDLE.';
      },
    },
  });
});
