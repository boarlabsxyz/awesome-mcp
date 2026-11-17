// Trash scratch files and calendar events left behind by runs that died before
// their teardown.
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
import { serviceEnv } from '../env.ts';
import { connectMcp } from '../transports/mcpHttp.ts';
import { sweepScratch } from '../setup/docsScratch.ts';
import { sweepScratchEvents } from '../setup/calendarScratch.ts';

const maxAgeHours = Number(process.env.SWEEP_MAX_AGE_HOURS ?? 24);
const dryRun = process.env.SWEEP_DRY_RUN === '1';
const verb = dryRun ? '[dry run] would ' : '';
const capNote = (capped: boolean) => (capped ? ' -- listing CAPPED, run again for the rest' : '');

// Docs, spreadsheets and folders: searchDriveFiles and deleteFile are both on the drive server.
const drive = await connectMcp(await endpointFor('sandbox', 'google-drive'));
try {
  const { trashed, kept, capped } = await sweepScratch(drive, { maxAgeHours, dryRun });
  console.log(`files: ${verb}trash${dryRun ? '' : 'ed'} ${trashed.length}, kept ${kept} (cutoff: ${maxAgeHours}h)${capNote(capped)}`);
  for (const entry of trashed) console.log(`  - ${entry}`);
} finally {
  await drive.close();
}

// Calendar events only where the createEvent check can have made them.
const calendarEnv = serviceEnv('google-calendar');
if (calendarEnv.skip) {
  console.log(`calendar: skipped (${calendarEnv.skip})`);
} else {
  const calendar = await connectMcp(await endpointFor('sandbox', 'google-calendar'));
  try {
    const { deleted, kept, capped } = await sweepScratchEvents(calendar, { maxAgeHours, dryRun });
    console.log(`calendar: ${verb}delete${dryRun ? '' : 'd'} ${deleted.length}, kept ${kept} (cutoff: ${maxAgeHours}h)${capNote(capped)}`);
    for (const entry of deleted) console.log(`  - ${entry}`);
  } finally {
    await calendar.close();
  }
}
