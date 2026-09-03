import { test } from 'node:test';
import { runSmokeTest } from '../../runSmokeTest.ts';
import { outputContract } from '../../promptTemplates.ts';
import { CLIENT, fixtureEnv } from '../fixtureEnv.ts';

// src/slack-user/ — the user OAuth token server. Its twin (src/slack/) exposes the
// same tool names against a different identity, so the two get separate
// connectors, separate fixture channels, and separate test files.
const FIXTURE_CHANNEL_ID = fixtureEnv('E2E_FIXTURE_SLACK_USER_CHANNEL_ID', 'slack-user');
const FIXTURE_NEEDLE = fixtureEnv('E2E_FIXTURE_SLACK_USER_NEEDLE', 'slack-user');

test(`readChannelHistory returns fixture messages — slack-user (${CLIENT})`, { timeout: 180_000 }, async () => {
  await runSmokeTest({
    name: 'readChannelHistory.slack-user',
    service: 'slack-user',
    client: CLIENT,
    mode: 'readonly',
    prompt: [
      `Call the readChannelHistory MCP tool with channelId "${FIXTURE_CHANNEL_ID}" and limit 50.`,
      outputContract('the verbatim text of every message the tool returned, one per line'),
    ].join('\n'),
    assertions: {
      containsBetween: ['OUTPUT_BEGIN', 'OUTPUT_END'],
      includes: [FIXTURE_NEEDLE],
    },
  });
});
