// The one place the scratch-resource naming convention lives.
//
// Every resource any scratch factory creates is named `[e2e] <label> <ISO>`,
// so an orphan left behind by a crashed run is recognizable at a glance in the
// Drive UI / ClickUp list / Slack channel, and `isScratchName()` lets the
// cleanup safety nets sweep by prefix in backends that have no folder to scope
// to (Gmail, Calendar, Slack, ClickUp).

export const SCRATCH_PREFIX = '[e2e]';

export function scratchName(label: string): string {
  return `${SCRATCH_PREFIX} ${label} ${new Date().toISOString()}`;
}

export function isScratchName(name: string | null | undefined): boolean {
  return typeof name === 'string' && name.startsWith(SCRATCH_PREFIX);
}

/**
 * Unique marker embedded in write-test payloads and asserted on in the client's
 * reply. Distinct from the resource name: the name proves cleanup scoping, the
 * marker proves the MCP write actually landed.
 */
export function scratchMarker(tag: string): string {
  return `BANANA-${tag.toUpperCase()}-${Date.now()}`;
}

export function required(name: string, doc: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}. See ${doc} for the setup procedure.`);
  }
  return value;
}
