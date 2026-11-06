import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// Search is the one Slack read that reaches past the caller's access rules and
// is filtered afterwards (buildChannelFilter in src/slack-user/server.ts, which
// fails closed). So this proves two things at once: search.messages finds the
// frozen needle, and the filter lets an allowed channel's match through. If the
// fixture account's rules stop allowing the channel, the answer turns into
// "No messages you can access match ..." -- read that as a rules problem on the
// fixture account, not a search bug.
//
// The ts and the channel's permalink path are the assertions that matter: the
// needle alone would also be satisfied by a copy of it posted anywhere else.

const env = serviceEnv('slack', [
  'E2E_FIXTURE_SLACK_CHANNEL_ID',
  'E2E_FIXTURE_SLACK_THREAD_TS',
  'E2E_FIXTURE_SLACK_NEEDLE',
]);

test('searchMessages finds the frozen fixture message', { timeout: 30_000, skip: env.skip }, async () => {
  const CHANNEL_ID = env.get('E2E_FIXTURE_SLACK_CHANNEL_ID');
  const THREAD_TS = env.get('E2E_FIXTURE_SLACK_THREAD_TS');
  const NEEDLE = env.get('E2E_FIXTURE_SLACK_NEEDLE');

  await runToolCheck({
    tool: 'searchMessages',
    service: 'slack',
    account: 'fixture',
    shape: 'needle',
    args: { query: NEEDLE, count: 20 },
    invariants: {
      // formatSearchMatch: `[time] #name (ts: <ts>) who: text <permalink>`, and
      // the permalink is /archives/<channel>/p<ts without the dot>.
      includes: [NEEDLE, `(ts: ${THREAD_TS})`, `/archives/${CHANNEL_ID}/p${THREAD_TS.replace('.', '')}`],
      matches: [/^Found \d+ message\(s\) for "/],
      excludes: ['hidden by your access rules'],
      transportSafe: true,
    },
  });
});
