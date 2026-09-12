// Both MCP clients a scratch fixture needs, from one check context.
//
// Scratch documents straddle two services on purpose: the file is created and
// trashed on the drive server, and its content is written and read on the docs
// server. Every write check needs the pair, so resolving them lives here rather
// than being spelled out in each test's setup.

import type { CheckContext } from '../runToolCheck.ts';
import type { McpClient } from '../transports/mcpHttp.ts';

export async function scratchClients(c: CheckContext): Promise<{ docs: McpClient; drive: McpClient }> {
  const [docs, drive] = await Promise.all([c.service('google-docs'), c.service('google-drive')]);
  return { docs, drive };
}
