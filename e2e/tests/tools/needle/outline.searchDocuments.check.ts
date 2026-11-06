import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// The most-called Outline tool. formatSearchResults (src/outline/apiHelpers.ts:384)
// prints a `## n. <title>` block per hit with `ID: <uuid>` and a `Context:` line
// cut from the body around the match. The output never echoes the query, so the
// needle can only come from the fixture doc's body -- and it is asserted inside
// the block carrying that doc's ID, so a hit on some other doc that happens to
// mention it does not pass.
//
// Outline wraps matched terms in `<b>...</b>` inside Context, per word: a
// multi-word needle would come back split by tags. Keep the needle one token.

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const env = serviceEnv('outline', ['E2E_FIXTURE_OUTLINE_DOC_ID', 'E2E_FIXTURE_OUTLINE_NEEDLE']);

test('searchDocuments finds the frozen fixture doc by its body needle', { timeout: 30_000, skip: env.skip }, async () => {
  const DOC_ID = env.get('E2E_FIXTURE_OUTLINE_DOC_ID');
  const NEEDLE = env.get('E2E_FIXTURE_OUTLINE_NEEDLE');

  await runToolCheck({
    tool: 'searchDocuments',
    service: 'outline',
    account: 'fixture',
    shape: 'needle',
    args: { query: NEEDLE, limit: 25 },
    invariants: {
      matches: [/^# Search Results\n/, /^Showing results 1-\d+$/m],
      transportSafe: true,
      predicate: (body) => {
        const idLine = new RegExp(`^ID: ${escape(DOC_ID)}$`, 'm');
        const block = body.split(/^## \d+\. /m).find((b) => idLine.test(b));
        if (!block) {
          return (
            `fixture doc ${DOC_ID} is not among the hits. E2E_FIXTURE_OUTLINE_DOC_ID must be the document's ` +
            'UUID (search prints `document.id`, not the URL slug), and the doc must be published with the needle in its body.'
          );
        }
        return block.includes(NEEDLE)
          ? undefined
          : `the hit for ${DOC_ID} does not carry the needle in its Context: ${JSON.stringify(block.slice(0, 300))}`;
      },
    },
  });
});
