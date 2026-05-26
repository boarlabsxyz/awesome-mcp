import { test } from 'node:test';
import { runSmokeTest } from '../runSmokeTest.ts';
import type { ClientName } from '../drivers/driver.ts';

const FIXTURE_DOC_TITLE = required('E2E_FIXTURE_DOC_TITLE');
const FIXTURE_DOC_NEEDLE = required('E2E_FIXTURE_DOC_NEEDLE');
const CLIENT = (process.env.CLIENT ?? 'claude-desktop') as ClientName;

test(`readGoogleDoc returns fixture content (${CLIENT})`, { timeout: 180_000 }, async () => {
  await runSmokeTest({
    name: 'readGoogleDoc',
    client: CLIENT,
    prompt: [
      `Use the readGoogleDoc MCP tool to read the Google Doc titled "${FIXTURE_DOC_TITLE}".`,
      'After the tool returns, reply with exactly this format and nothing else:',
      'OUTPUT_BEGIN<verbatim text content of the doc>OUTPUT_END',
      'Do not paraphrase, summarize, or add commentary. Do not use markdown formatting.',
    ].join('\n'),
    assertions: {
      containsBetween: ['OUTPUT_BEGIN', 'OUTPUT_END'],
      includes: [FIXTURE_DOC_NEEDLE],
    },
  });
});

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}. See e2e/fixtures.md.`);
  }
  return value;
}
