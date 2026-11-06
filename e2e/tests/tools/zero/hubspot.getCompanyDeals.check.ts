import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// A real sandbox company with no deals associated. renderCompanyDeals
// (src/hubspot/server.ts:587) answers with one sentence and nothing else; the
// whole body is asserted, so a header, a `Showing` note or a stray record
// tacked on would fail. The sentence is about associations, not the company --
// see the report for why that matters for a nonexistent company id.

const env = serviceEnv('hubspot', ['E2E_SANDBOX_HUBSPOT_EMPTY_COMPANY_ID']);

test('getCompanyDeals says a company with no deals has none', { timeout: 30_000, skip: env.skip }, async () => {
  const COMPANY_ID = env.get('E2E_SANDBOX_HUBSPOT_EMPTY_COMPANY_ID');

  await runToolCheck({
    tool: 'getCompanyDeals',
    service: 'hubspot',
    account: 'sandbox',
    shape: 'zero',
    args: { companyId: COMPANY_ID },
    invariants: {
      predicate: (body) =>
        body.trim() === 'No deals are associated with this company.'
          ? undefined
          : `expected exactly "No deals are associated with this company.", got ${JSON.stringify(body.slice(0, 200))}`,
    },
  });
});
