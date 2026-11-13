import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// searchGoogleDocs builds a different Drive query per `searchIn` (name contains
// / fullText contains / both, src/google-drive/toolHandlers.ts), so the name and
// content paths are checked separately: either can break while the other, and
// listGoogleDocs, stay green.

const env = serviceEnv('google-docs', [
  'E2E_FIXTURE_DOC_ID',
  'E2E_FIXTURE_DOC_TITLE',
  'E2E_FIXTURE_DOC_NEEDLE',
]);

test('searchGoogleDocs finds the fixture doc by name', { timeout: 30_000, skip: env.skip }, async () => {
  const DOC_ID = env.get('E2E_FIXTURE_DOC_ID');
  const DOC_TITLE = env.get('E2E_FIXTURE_DOC_TITLE');
  await runToolCheck({
    tool: 'searchGoogleDocs',
    service: 'google-docs',
    account: 'fixture',
    shape: 'needle',
    args: { searchQuery: DOC_TITLE, searchIn: 'name', maxResults: 10 },
    invariants: {
      // The ID is the assertion that matters: a title match alone would also be
      // satisfied by a second doc someone named the same thing.
      includes: [`**${DOC_TITLE}**`, `ID: ${DOC_ID}`, `matching "${DOC_TITLE}":`],
      matches: [/^Found \d+ document\(s\) matching /],
    },
  });
});

test('searchGoogleDocs finds the fixture doc by its body text', { timeout: 30_000, skip: env.skip }, async () => {
  const DOC_ID = env.get('E2E_FIXTURE_DOC_ID');
  const NEEDLE = env.get('E2E_FIXTURE_DOC_NEEDLE');
  await runToolCheck({
    tool: 'searchGoogleDocs',
    service: 'google-docs',
    account: 'fixture',
    shape: 'needle',
    // The needle is in the body, not the title, so only the fullText branch can
    // find it -- a name-only query regression shows up here and nowhere else.
    args: { searchQuery: NEEDLE, searchIn: 'content', maxResults: 10 },
    invariants: {
      includes: [`ID: ${DOC_ID}`, `matching "${NEEDLE}":`],
      matches: [/^Found \d+ document\(s\) matching /],
    },
  });
});
