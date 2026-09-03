// Shared env plumbing for the smoke tests.
//
// Read smokes assert against fixtures that live in the readonly test identity
// for their service; the ids and needles arrive as env vars set from GHA repo
// variables. Every read test needs the same two-line boilerplate, so it lives
// here — and the error message points at the per-service fixture doc rather
// than a generic "missing env var".

import type { ClientName } from '../drivers/driver.ts';
import type { ServiceName } from '../tools/index.ts';

/** Which live client this run drives. Set per-job in the GHA workflows. */
export const CLIENT = (process.env.CLIENT || 'claude-desktop') as ClientName;

export function fixtureEnv(name: string, service: ServiceName): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required env var ${name} (service: ${service}). See e2e/fixtures/read.md.`,
    );
  }
  return value;
}
