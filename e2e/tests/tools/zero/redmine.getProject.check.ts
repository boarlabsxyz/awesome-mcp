import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// A well-formed identifier that names no project. withRedmineClient routes
// Redmine's 404 through mapRedmineError, which answers with the tool's prefix
// ('Failed to fetch project', src/redmine/server.ts:260) and the sentence at
// src/redmine/apiHelpers.ts:1580 -- including that a 404 also means "not
// allowed to see", which is true on Redmine and the reason it is pinned whole.
// The 401 branch's "rejected the credential" would send the caller to
// reconnect a connection that works.
const NO_SUCH_PROJECT = 'zzz-no-such-project-zzz-9f3a1c7b';

const env = serviceEnv('redmine');

test('getProject says a nonexistent project was not found', { timeout: 30_000, skip: env.skip }, async () => {
  await runToolCheck({
    tool: 'getProject',
    service: 'redmine',
    account: 'sandbox',
    shape: 'zero',
    expectToolError: true,
    args: { projectId: NO_SUCH_PROJECT },
    invariants: {
      includes: [
        'Failed to fetch project: not found. Check the ID or identifier — Redmine also answers 404 for records you are not allowed to see.',
      ],
      excludes: ['rejected the credential', 'Redmine answered 403', 'undefined', 'Traceback', 'at Object.<anonymous>'],
    },
  });
});
