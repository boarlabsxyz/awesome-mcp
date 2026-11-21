import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// The frozen fixture project. formatProject (src/redmine/apiHelpers.ts:884)
// prints `# Project: <name>`, then `ID: <n>` and `Identifier: <slug>` as their
// own lines, then the description. The schema takes either form of the id, so
// whichever one E2E_FIXTURE_REDMINE_PROJECT_ID holds must come back as a WHOLE
// line -- `ID: 4` is a substring of `ID: 42`.

const env = serviceEnv('redmine', ['E2E_FIXTURE_REDMINE_PROJECT_ID', 'E2E_FIXTURE_REDMINE_NEEDLE']);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('getProject returns the frozen fixture project', { timeout: 30_000, skip: env.skip }, async () => {
  const PROJECT_ID = env.get('E2E_FIXTURE_REDMINE_PROJECT_ID');
  const NEEDLE = env.get('E2E_FIXTURE_REDMINE_NEEDLE');

  await runToolCheck({
    tool: 'getProject',
    service: 'redmine',
    account: 'fixture',
    shape: 'needle',
    args: { projectId: PROJECT_ID },
    invariants: {
      includes: [NEEDLE],
      matches: [/^# Project: /, new RegExp(`^(ID|Identifier): ${escapeRegExp(PROJECT_ID)}$`, 'm')],
      transportSafe: true,
    },
  });
});
