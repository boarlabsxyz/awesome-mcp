import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// The empty answer on the bot server, asserted verbatim against
// handleReadChannelHistory (src/slack/helpers.ts) -- the same sentence the user
// server gives, which is the point of sharing the handler, and this pins it from
// the other side. The bot has no access rules, so its failure modes are Slack's:
// `not_in_channel` when the bot was never /invited, `missing_scope` for a type
// its token cannot read. Both come back as tool errors, so neither can pass here.
//
// A Slack channel is never truly empty (creating one posts a channel_join), so
// the empty state is a window before any workspace existed.
const BEFORE_ANY_WORKSPACE = { oldest: '1000000000', latest: '1000000060' };

const env = serviceEnv('slack-bot', ['E2E_SANDBOX_SLACKBOT_CHANNEL_ID']);

test('slack-bot readChannelHistory answers an empty window calmly', { timeout: 30_000, skip: env.skip }, async () => {
  const CHANNEL_ID = env.get('E2E_SANDBOX_SLACKBOT_CHANNEL_ID');

  await runToolCheck({
    tool: 'readChannelHistory',
    service: 'slack-bot',
    account: 'sandbox',
    shape: 'zero',
    args: { channelId: CHANNEL_ID, ...BEFORE_ANY_WORKSPACE, limit: 20 },
    invariants: {
      includes: ['No messages found in this channel.'],
      excludes: ['Error', '(ts: ', 'More messages available', 'undefined'],
    },
  });
});
