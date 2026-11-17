import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// getDocumentInfo is on the drive server, not docs -- it reads Drive file
// metadata, so it is the one place a caller sees owner and sharing state for a
// doc. Field labels are copied from handleGetDocumentInfo in
// src/google-drive/toolHandlers.ts.

const env = serviceEnv('google-drive', ['E2E_FIXTURE_DOC_ID', 'E2E_FIXTURE_DOC_TITLE']);

test('getDocumentInfo describes the fixture doc', { timeout: 30_000, skip: env.skip }, async () => {
  const DOC_ID = env.get('E2E_FIXTURE_DOC_ID');
  const DOC_TITLE = env.get('E2E_FIXTURE_DOC_TITLE');
  await runToolCheck({
    tool: 'getDocumentInfo',
    service: 'google-drive',
    account: 'fixture',
    shape: 'needle',
    args: { documentId: DOC_ID },
    invariants: {
      includes: [
        `**Name:** ${DOC_TITLE}\n`,
        `**ID:** ${DOC_ID}\n`,
        `**View Link:** https://docs.google.com/document/d/${DOC_ID}/`,
      ],
      // Dates fall back to the word "Unknown" when Drive omits them, which would
      // mean the `fields` mask stopped asking for them.
      matches: [/\*\*Created:\*\* (?!Unknown)/, /\*\*Last Modified:\*\* (?!Unknown)/, /\*\*Shared:\*\* (Yes|No)\n/],
      excludes: ['undefined'],
    },
  });
});
