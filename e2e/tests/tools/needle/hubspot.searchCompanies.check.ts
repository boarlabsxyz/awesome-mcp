import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// The most-called HubSpot tool. formatObjectList (src/hubspot/apiHelpers.ts:506)
// prints `n. <name>` then indented `   ID: <id>` and one `   <prop>: <value>`
// line per requested property -- with no `properties` argument, the defaults
// (COMPANY_SEARCH_PROPERTIES, apiHelpers.ts:403) include `name`. So the needle
// is asserted on the `name:` line of the record carrying the fixture company's
// ID: a second company someone named the same thing carries a different ID.
//
// HubSpot's free-text `query` matches whole tokens, so the needle must be one
// alphanumeric word in the company name.

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const env = serviceEnv('hubspot', ['E2E_FIXTURE_HUBSPOT_COMPANY_ID', 'E2E_FIXTURE_HUBSPOT_COMPANY_NEEDLE']);

test('searchCompanies finds the fixture company by its name needle', { timeout: 30_000, skip: env.skip }, async () => {
  const COMPANY_ID = env.get('E2E_FIXTURE_HUBSPOT_COMPANY_ID');
  const NEEDLE = env.get('E2E_FIXTURE_HUBSPOT_COMPANY_NEEDLE');

  await runToolCheck({
    tool: 'searchCompanies',
    service: 'hubspot',
    account: 'fixture',
    shape: 'needle',
    args: { query: NEEDLE, limit: 10 },
    invariants: {
      matches: [/^Found \d+ companies:\n/],
      excludes: ['Requested properties not returned by HubSpot'],
      transportSafe: true,
      predicate: (body) => {
        const idLine = new RegExp(`^   ID: ${escape(COMPANY_ID)}$`, 'm');
        const block = body.split(/^\d+\. /m).find((b) => idLine.test(b));
        if (!block) return `fixture company ${COMPANY_ID} is not among the matches for ${JSON.stringify(NEEDLE)}`;
        return new RegExp(`^   name: .*${escape(NEEDLE)}`, 'm').test(block)
          ? undefined
          : `company ${COMPANY_ID}'s name line does not contain the needle: ${JSON.stringify(block.slice(0, 300))}`;
      },
    },
  });
});
