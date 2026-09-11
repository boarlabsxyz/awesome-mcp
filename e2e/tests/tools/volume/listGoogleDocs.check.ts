import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { optionalNumber } from '../../../env.ts';

const MIN_DOCS = optionalNumber('E2E_RICH_MIN_DOCS', 50);

test('listGoogleDocs returns a full page on a busy account', { timeout: 30_000 }, async () => {
  await runToolCheck({
    tool: 'listGoogleDocs',
    service: 'google-docs',
    account: 'rich',
    shape: 'volume',
    args: { maxResults: 100, orderBy: 'modifiedTime' },
    invariants: {
      matches: [/Found \d+ Google Document\(s\)/],
      predicate: (body) => {
        const found = Number(body.match(/Found (\d+) Google Document\(s\)/)?.[1]);
        if (!Number.isFinite(found)) return 'could not parse the "Found N" header';
        if (found < MIN_DOCS) {
          return `only ${found} docs -- the rich account needs at least ${MIN_DOCS} for this tier to mean anything`;
        }
        return undefined;
      },
    },
  });
});

// Recorded as a todo rather than a failing assertion because it is a gap in the
// tool, not a regression: listGoogleDocs passes maxResults straight to Drive's
// pageSize, ignores the nextPageToken, and renders "Found N Google Document(s)"
// with no hint that N is a page rather than a total. On an account with 400 docs
// a caller asking for 20 is told, in the tool's own words, that it found 20 --
// the same silent-truncation shape CLAUDE.md calls out for ClickUp searchDocs
// ("always reports the scan extent") and HubSpot getCompanyDeals ("of N+").
// Flip this to a real assertion in the same commit that fixes the tool.
test('listGoogleDocs says when more documents exist beyond the page', { todo: 'tool does not report its scan extent yet' }, () => {});
