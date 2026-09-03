import { test, after } from 'node:test';
import { runSmokeTest } from '../../runSmokeTest.ts';
import { outputContract } from '../../promptTemplates.ts';
import { scratchChannelId, cleanupScratchChannel } from '../../setup/slackScratch.ts';
import { scratchMarker, scratchName } from '../../setup/scratchNaming.ts';
import { CLIENT } from '../fixtureEnv.ts';

// src/slack-user/ — the user OAuth token server. Its twin (src/slack/) posts as a
// different identity, so it gets its own token and its own test file.
const SERVICE = 'slack-user' as const;

after(async () => {
  await cleanupScratchChannel(SERVICE);
});

test(`postMessage posts to the scratch channel — slack-user (${CLIENT})`, { timeout: 240_000 }, async () => {
  await runSmokeTest({
    name: 'postMessage.slack-user',
    service: SERVICE,
    client: CLIENT,
    mode: 'full',
    setup: async () => {
      const marker = scratchMarker('slack');
      return {
        channelId: scratchChannelId(),
        marker,
        text: scratchName(`slack write ${marker}`),
      };
    },
    prompt: ({ channelId, text }) =>
      [
        `Call the postMessage MCP tool with channelId "${channelId}" and text "${text}".`,
        `Then call the readChannelHistory MCP tool with channelId "${channelId}" and limit 20.`,
        outputContract('the verbatim text of every message readChannelHistory returned, one per line'),
      ].join('\n'),
    assertions: ({ marker }) => ({
      containsBetween: ['OUTPUT_BEGIN', 'OUTPUT_END'],
      includes: [marker],
    }),
    // The posted text carries the `[e2e]` prefix, so the channel sweep is the
    // teardown. It runs as the same identity the connector posted with —
    // Slack's chat.delete refuses to delete another token's messages.
    teardown: async () => {
      await cleanupScratchChannel(SERVICE);
    },
  });
});
