import { test } from 'node:test';
import { runSmokeTest } from '../../runSmokeTest.ts';
import { preface } from '../../promptTemplates.ts';
import type { ClientName } from '../../drivers/driver.ts';

const FIXTURE_DOC_ID = required('E2E_FIXTURE_DOC_ID');
const FIXTURE_DOC_NEEDLE = required('E2E_FIXTURE_DOC_NEEDLE');
const CLIENT = (process.env.CLIENT ?? 'claude-desktop') as ClientName;

test(`readGoogleDoc returns fixture content (${CLIENT})`, { timeout: 180_000 }, async () => {
  await runSmokeTest({
    name: 'readGoogleDoc',
    client: CLIENT,
    mode: 'readonly',
    prompt: [
      preface('readonly') +
        `Call the readGoogleDoc MCP tool with documentId "${FIXTURE_DOC_ID}" and format "text".`,
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
    throw new Error(`Missing required env var: ${name}. See e2e/fixtures/read.md.`);
  }
  return value;
}
