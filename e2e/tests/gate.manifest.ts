// THE DEPLOY GATE. These are the tests that block a prod promotion.
//
// The gate is deliberately the MINIMUM proof that each service's connector is
// alive end to end: one read smoke and one write smoke per service that has
// write tools. It is not a glob — `npm run test:full` and the nightly
// e2e-regression.yml workflow are where breadth lives. A glob here would mean
// every regression test silently becomes deploy-blocking, and the gate's
// runtime would grow without anyone deciding it should.
//
// Adding a service to `tools/index.ts` makes this file a type error until its
// two gate tests are listed: GATE is keyed on `WriteTestedService`, which is
// computed from the WRITE_TOOLS arrays. That's the point — a new write-capable
// connector should not be able to ship ungated.

import type { WriteTestedService } from '../tools/index.ts';

export interface GateEntry {
  /** Path relative to e2e/, as passed to `node --test`. */
  read: string;
  write: string;
}

export const GATE: Record<WriteTestedService, GateEntry> = {
  'google-docs': {
    read: 'tests/read/readGoogleDoc.smoke.ts',
    write: 'tests/write/appendToGoogleDoc.smoke.ts',
  },
  'google-drive': {
    read: 'tests/read/listFolderContents.smoke.ts',
    write: 'tests/write/createFolder.smoke.ts',
  },
  'google-gmail': {
    read: 'tests/read/searchEmails.smoke.ts',
    write: 'tests/write/draftEmail.smoke.ts',
  },
  'google-calendar': {
    read: 'tests/read/listEvents.smoke.ts',
    write: 'tests/write/createEvent.smoke.ts',
  },
  'google-sheets': {
    read: 'tests/read/readSpreadsheet.smoke.ts',
    write: 'tests/write/appendSpreadsheetRows.smoke.ts',
  },
  'google-slides': {
    read: 'tests/read/getPresentation.smoke.ts',
    write: 'tests/write/batchUpdatePresentation.smoke.ts',
  },
  'clickup': {
    read: 'tests/read/listTasks.smoke.ts',
    write: 'tests/write/createTask.smoke.ts',
  },
  'slack': {
    read: 'tests/read/readChannelHistory.slack.smoke.ts',
    write: 'tests/write/postMessage.slack.smoke.ts',
  },
  'slack-user': {
    read: 'tests/read/readChannelHistory.slack-user.smoke.ts',
    write: 'tests/write/postMessage.slack-user.smoke.ts',
  },
};

/** Flat list in gate order: all reads first, then all writes. */
export function gateFiles(): string[] {
  const entries = Object.values(GATE) as GateEntry[];
  return [...entries.map((e) => e.read), ...entries.map((e) => e.write)];
}
