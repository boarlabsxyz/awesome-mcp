import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// The bot-token twin of needle/slack.readChannelHistory.check.ts: same handler
// (handleReadChannelHistory, src/slack/helpers.ts), no access rules, and a
// different reach -- the bot reads only channels it has been /invited to, and
// only the conversation types its token has a *:history scope for. Production's
// bot token has channels:history alone, so the fixture channel must be public.
//
// Windowed around the needle for the same reason as the user-server check: one
// stray post must not push it past `limit`.

const env = serviceEnv('slack-bot', [
  'E2E_FIXTURE_SLACKBOT_CHANNEL_ID',
  'E2E_FIXTURE_SLACKBOT_MESSAGE_TS',
  'E2E_FIXTURE_SLACKBOT_NEEDLE',
]);

test('slack-bot readChannelHistory returns the frozen fixture message', { timeout: 30_000, skip: env.skip }, async () => {
  const CHANNEL_ID = env.get('E2E_FIXTURE_SLACKBOT_CHANNEL_ID');
  const MESSAGE_TS = env.get('E2E_FIXTURE_SLACKBOT_MESSAGE_TS');
  const NEEDLE = env.get('E2E_FIXTURE_SLACKBOT_NEEDLE');
  const second = Math.floor(Number(MESSAGE_TS));

  await runToolCheck({
    tool: 'readChannelHistory',
    service: 'slack-bot',
    account: 'fixture',
    shape: 'needle',
    args: { channelId: CHANNEL_ID, oldest: String(second - 1), latest: String(second + 2), limit: 20 },
    invariants: {
      // formatMessage: `[time] (ts: <ts>) who: text ...`.
      includes: [NEEDLE, `(ts: ${MESSAGE_TS})`],
      excludes: ['No messages found in this channel.'],
      transportSafe: true,
    },
  });
});
