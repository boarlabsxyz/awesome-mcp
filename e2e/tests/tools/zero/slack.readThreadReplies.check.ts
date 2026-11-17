import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// A well-formed thread ts that names no message, in a channel the sandbox's
// access rules allow. The access check runs first (enforceAccess,
// src/slack-user/server.ts), so this also proves the not-found answer is
// Slack's and not a denial: `Access denied: ...` here would mean the sandbox
// channel is not allowed, which is a seeding problem, not the contract.
//
// The error is SlackClient.request's (src/slack/apiHelpers.ts) passthrough of
// Slack's code -- observed in production on 2026-11-04. It names the thread as
// missing, which is what a caller needs to stop retrying.
//
// 2001-09-09, before any workspace existed, so this can never become a real ts.
const NO_SUCH_THREAD_TS = '1000000000.000001';

const env = serviceEnv('slack', ['E2E_SANDBOX_SLACK_CHANNEL_ID']);

test('readThreadReplies says a nonexistent thread was not found', { timeout: 30_000, skip: env.skip }, async () => {
  const CHANNEL_ID = env.get('E2E_SANDBOX_SLACK_CHANNEL_ID');

  await runToolCheck({
    tool: 'readThreadReplies',
    service: 'slack',
    account: 'sandbox',
    shape: 'zero',
    expectToolError: true,
    args: { channelId: CHANNEL_ID, threadTs: NO_SUCH_THREAD_TS, limit: 50 },
    invariants: {
      includes: ['Slack API error (conversations.replies): thread_not_found'],
      excludes: ['Access denied', 'undefined', 'Traceback', 'at Object.<anonymous>'],
    },
  });
});
