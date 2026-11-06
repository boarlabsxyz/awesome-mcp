import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// getDocument (src/outline/server.ts:51) renders `# <title>`, a blank line, the
// markdown body, and a trailing `URL: <url>`. It prints no ID -- the URL carries
// the short slug, not the UUID -- so the id cannot be asserted from the output;
// the needle has to come from the body, and the URL line pins that the whole
// record came back rather than a bare title.

const env = serviceEnv('outline', ['E2E_FIXTURE_OUTLINE_DOC_ID', 'E2E_FIXTURE_OUTLINE_NEEDLE']);

test('getDocument returns the frozen fixture doc body', { timeout: 30_000, skip: env.skip }, async () => {
  const DOC_ID = env.get('E2E_FIXTURE_OUTLINE_DOC_ID');
  const NEEDLE = env.get('E2E_FIXTURE_OUTLINE_NEEDLE');

  await runToolCheck({
    tool: 'getDocument',
    service: 'outline',
    account: 'fixture',
    shape: 'needle',
    args: { documentId: DOC_ID },
    invariants: {
      includes: [NEEDLE],
      matches: [/^# \S/, /\nURL: \S+$/],
      transportSafe: true,
    },
  });
});
