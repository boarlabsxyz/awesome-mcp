import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// formatDeal (src/hubspot/apiHelpers.ts:484, via fmtObject at :465) prints
// `Deal:`, `  ID: <id>` and one `  <prop>: <value>` line per non-empty
// property HubSpot returned. With no
// `properties` argument HubSpot's default deal set includes `dealname`, so the
// needle is pinned to the dealname line of this deal id, not merely present.

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const env = serviceEnv('hubspot', ['E2E_FIXTURE_HUBSPOT_DEAL_ID', 'E2E_FIXTURE_HUBSPOT_DEAL_NEEDLE']);

test('getDeal returns the frozen fixture deal', { timeout: 30_000, skip: env.skip }, async () => {
  const DEAL_ID = env.get('E2E_FIXTURE_HUBSPOT_DEAL_ID');
  const NEEDLE = env.get('E2E_FIXTURE_HUBSPOT_DEAL_NEEDLE');

  await runToolCheck({
    tool: 'getDeal',
    service: 'hubspot',
    account: 'fixture',
    shape: 'needle',
    args: { dealId: DEAL_ID },
    invariants: {
      matches: [
        /^Deal:\n/,
        new RegExp(`^  ID: ${escape(DEAL_ID)}$`, 'm'),
        new RegExp(`^  dealname: .*${escape(NEEDLE)}`, 'm'),
      ],
      transportSafe: true,
    },
  });
});
