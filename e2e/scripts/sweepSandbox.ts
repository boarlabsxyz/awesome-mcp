// Trash scratch documents left behind by runs that died before their teardown.
//
// Run on a schedule, not in-band with the checks. The zero-state checks assert
// that the sandbox account has nothing matching a query, so leaked scratch docs
// eventually make them fail for reasons unrelated to the code under test -- and
// by then the failure looks like a regression in the tool.
//
//   npm run sweep:sandbox           # trash anything older than 24h
//   SWEEP_MAX_AGE_HOURS=1 npm run sweep:sandbox
//   SWEEP_DRY_RUN=1 npm run sweep:sandbox

import { endpointFor } from '../accounts.ts';
import { connectMcp } from '../transports/mcpHttp.ts';
import { sweepScratch } from '../setup/docsScratch.ts';

const maxAgeHours = Number(process.env.SWEEP_MAX_AGE_HOURS ?? 24);
const dryRun = process.env.SWEEP_DRY_RUN === '1';

const drive = await connectMcp(await endpointFor('sandbox', 'google-drive'));
try {
  const { trashed, kept } = await sweepScratch(drive, { maxAgeHours, dryRun });
  console.log(
    `${dryRun ? '[dry run] would trash' : 'trashed'} ${trashed.length}, kept ${kept} ` +
      `(cutoff: ${maxAgeHours}h)`,
  );
  for (const entry of trashed) console.log(`  - ${entry}`);
} finally {
  await drive.close();
}
