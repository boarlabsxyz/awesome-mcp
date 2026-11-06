import { test } from 'node:test';
import { runToolCheck } from '../../../runToolCheck.ts';
import { serviceEnv } from '../../../env.ts';

// A well-formed but nonexistent deal id. HubSpot's CRM v3 object GET answers
// 404, which mapHubSpotError (src/hubspot/apiHelpers.ts:781) turns into
// `${prefix}: not found.` with getDeal's prefix `Failed to get deal`
// (src/hubspot/server.ts:1125). The excludes pin the two wrong turns: a 404
// misread as the 401/403 branch's "click Reconnect", which sends a caller to
// rebuild a working connection, and the raw `HubSpot API GET ...` text from the
// generic branch. UNVERIFIED live.

const NONEXISTENT_DEAL_ID = '9999999999999';

const env = serviceEnv('hubspot');

test('getDeal says a nonexistent deal id was not found', { timeout: 30_000, skip: env.skip }, async () => {
  await runToolCheck({
    tool: 'getDeal',
    service: 'hubspot',
    account: 'sandbox',
    shape: 'zero',
    args: { dealId: NONEXISTENT_DEAL_ID },
    expectToolError: true,
    invariants: {
      includes: ['Failed to get deal: not found.'],
      excludes: ['Reconnect', 'HubSpot API', 'undefined', '    at '],
    },
  });
});
