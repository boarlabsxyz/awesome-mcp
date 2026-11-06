import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// The company -> deals hop (src/hubspot/server.ts:1094): associations v4 for
// the IDs, then a batch read for the records, rendered by renderCompanyDeals
// (server.ts:585). The fixture company has a known, small number of deals, one
// of them the fixture deal, which makes both halves of the cap contract exact:
//
//   - with a limit above the count, every deal is listed (`Found <count> deals:`)
//     and there is no `Showing` note;
//   - with limit 1, the note reads `Showing 1 of <count> associated deals —
//     raise `limit` to see the rest.` with a bare count, because the
//     association scan was not truncated. The `<count>+` floor only appears
//     past ASSOCIATION_MAX_PAGES x 500 = 5,000 associated deals
//     (src/hubspot/apiHelpers.ts:31, server.ts:588), which no fixture can hold
//     -- recorded as a todo below rather than faked.

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const env = serviceEnv('hubspot', [
  'E2E_FIXTURE_HUBSPOT_COMPANY_ID',
  'E2E_FIXTURE_HUBSPOT_COMPANY_DEAL_COUNT',
  'E2E_FIXTURE_HUBSPOT_DEAL_ID',
  'E2E_FIXTURE_HUBSPOT_DEAL_NEEDLE',
]);

function dealCount(): number {
  const raw = env.get('E2E_FIXTURE_HUBSPOT_COMPANY_DEAL_COUNT');
  const n = Number(raw);
  // At least 2, or the limit-1 case below has nothing to cap and asserts nothing.
  if (!Number.isInteger(n) || n < 2 || n > 100) {
    throw new Error(`E2E_FIXTURE_HUBSPOT_COMPANY_DEAL_COUNT must be an integer from 2 to 100, got ${JSON.stringify(raw)}`);
  }
  return n;
}

test('getCompanyDeals lists every deal of the fixture company', { timeout: 30_000, skip: env.skip }, async () => {
  const COMPANY_ID = env.get('E2E_FIXTURE_HUBSPOT_COMPANY_ID');
  const DEAL_ID = env.get('E2E_FIXTURE_HUBSPOT_DEAL_ID');
  const NEEDLE = env.get('E2E_FIXTURE_HUBSPOT_DEAL_NEEDLE');
  const COUNT = dealCount();

  await runToolCheck({
    tool: 'getCompanyDeals',
    service: 'hubspot',
    account: 'fixture',
    shape: 'needle',
    args: { companyId: COMPANY_ID, limit: 100 },
    invariants: {
      includes: [`Found ${COUNT} deals:\n`],
      excludes: ['Showing ', 'Requested properties not returned by HubSpot'],
      transportSafe: true,
      predicate: (body) => {
        const idLine = new RegExp(`^   ID: ${escape(DEAL_ID)}$`, 'm');
        const block = body.split(/^\d+\. /m).find((b) => idLine.test(b));
        if (!block) return `fixture deal ${DEAL_ID} is not among company ${COMPANY_ID}'s deals`;
        return new RegExp(`^   dealname: .*${escape(NEEDLE)}`, 'm').test(block)
          ? undefined
          : `deal ${DEAL_ID}'s dealname line does not contain the needle: ${JSON.stringify(block.slice(0, 300))}`;
      },
    },
  });
});

test('getCompanyDeals reports the exact total when limit caps the list', { timeout: 30_000, skip: env.skip }, async () => {
  const COMPANY_ID = env.get('E2E_FIXTURE_HUBSPOT_COMPANY_ID');
  const COUNT = dealCount();

  await runToolCheck({
    tool: 'getCompanyDeals',
    service: 'hubspot',
    account: 'fixture',
    shape: 'needle',
    args: { companyId: COMPANY_ID, limit: 1 },
    invariants: {
      // Verbatim from renderCompanyDeals (src/hubspot/server.ts:590), em dash and
      // backticks included.
      includes: ['Found 1 deals:\n', `\n\nShowing 1 of ${COUNT} associated deals — raise \`limit\` to see the rest.`],
      // A bare count, never the floor form: this scan was not truncated.
      excludes: [`of ${COUNT}+ associated`],
    },
  });
});

test(
  'getCompanyDeals renders a truncated association scan as a floor ("of N+")',
  { todo: 'needs a company with more than 5,000 associated deals (ASSOCIATION_MAX_PAGES x 500, src/hubspot/apiHelpers.ts:31); the `${associatedCount}+` branch at src/hubspot/server.ts:588 is unit-test territory, not seedable in a fixture portal' },
  () => {},
);
