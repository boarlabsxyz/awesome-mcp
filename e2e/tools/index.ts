// Barrel for the per-service tool classifications.
//
// One module per `src/<service>/server.ts`. Everything downstream (prompt
// prefaces, the deploy gate manifest, the runbook's "uncheck these on the
// readonly connector" step) keys off `ServiceName`, so adding a service is:
// drop in `tools/<service>.ts`, add one line to TOOLS, and TypeScript will
// point at every place that now needs a decision.

import * as googleDocs from './google-docs.ts';
import * as googleDrive from './google-drive.ts';
import * as googleGmail from './google-gmail.ts';
import * as googleCalendar from './google-calendar.ts';
import * as googleSheets from './google-sheets.ts';
import * as googleSlides from './google-slides.ts';
import * as clickup from './clickup.ts';
import * as slack from './slack.ts';
import * as slackUser from './slack-user.ts';

export const TOOLS = {
  'google-docs': googleDocs,
  'google-drive': googleDrive,
  'google-gmail': googleGmail,
  'google-calendar': googleCalendar,
  'google-sheets': googleSheets,
  'google-slides': googleSlides,
  'clickup': clickup,
  'slack': slack,
  'slack-user': slackUser,
} as const;

export type ServiceName = keyof typeof TOOLS;

export const SERVICES = Object.keys(TOOLS) as ServiceName[];

/**
 * Services with at least one mutating tool. These are the ones that need a
 * `-full` connector, a scratch-resource factory, and a write smoke in the
 * deploy gate. Computed from the tool lists rather than hand-maintained, so a
 * service that grows its first write tool is caught at compile time by
 * `tests/gate.manifest.ts`, which is keyed on this type.
 */
export type WriteTestedService = {
  [S in ServiceName]: typeof TOOLS[S]['WRITE_TOOLS']['length'] extends 0 ? never : S;
}[ServiceName];

export function readTools(service: ServiceName): readonly string[] {
  return TOOLS[service].READ_TOOLS;
}

export function writeTools(service: ServiceName): readonly string[] {
  return TOOLS[service].WRITE_TOOLS;
}

export function notImplementedTools(service: ServiceName): ReadonlySet<string> {
  return TOOLS[service].NOT_IMPLEMENTED;
}

export function hasWriteTools(service: ServiceName): boolean {
  return TOOLS[service].WRITE_TOOLS.length > 0;
}

/** Every tool the service exposes, read and write, in server declaration order. */
export function allTools(service: ServiceName): readonly string[] {
  return [...TOOLS[service].READ_TOOLS, ...TOOLS[service].WRITE_TOOLS];
}
