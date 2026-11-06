import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// Tab IDs are what every tab-aware tool takes (`tabId`), and this is the tool a
// caller gets them from. The header and line formats below are copied from the
// listDocumentTabs handler in src/google-docs/server.ts.
//
// includeContent: true because it switches the Docs `fields` projection from
// 'title,tabs(tabProperties,childTabs)' to 'title,tabs' -- the content count is
// only right if that projection actually carries the body. "Empty" on the
// fixture doc, which holds the needle text, means the projection dropped it.

const env = serviceEnv('google-docs', ['E2E_FIXTURE_DOC_ID', 'E2E_FIXTURE_DOC_TITLE']);

test('listDocumentTabs lists the fixture doc and a usable tab ID', { timeout: 30_000, skip: env.skip }, async () => {
  const DOC_ID = env.get('E2E_FIXTURE_DOC_ID');
  const DOC_TITLE = env.get('E2E_FIXTURE_DOC_TITLE');
  await runToolCheck({
    tool: 'listDocumentTabs',
    service: 'google-docs',
    account: 'fixture',
    shape: 'needle',
    args: { documentId: DOC_ID, includeContent: true },
    invariants: {
      includes: [`**Document:** "${DOC_TITLE}"`],
      matches: [
        /\*\*Total tabs:\*\* [1-9]\d*/,
        // "Tab ID:" on a single-tab doc, "ID:" per tab otherwise. Either way the
        // value must be real -- the handler falls back to the word "Unknown".
        /(?:Tab ID|- ID): (?!Unknown)\S+/,
        /- Content: [\d,]+ characters/,
      ],
      excludes: ['appears to have no tabs', '- Content: Empty'],
      transportSafe: true,
    },
  });
});
