// src/sandbox/server.ts
// The Sandbox MCP: a place for Claude to run code when the client has no
// shell. Each user gets one hosted sandbox (E2B), kept between calls until it
// sits idle, and every run carries a short-lived bearer for this platform's
// REST plane, so a script can pull and push data in bulk and Claude sees only
// what the script prints.
import { FastMCP } from 'fastmcp';
import { instrumentServer } from '../usage/instrumentServer.js';
import { UserSession } from '../userSession.js';
import { createMcpAuthenticateHandler } from '../mcpAuthenticate.js';
import { registerListRestEndpoints } from '../sharedTools/listRestEndpoints.js';
import {
  listFilesSchema,
  readFileSchema,
  resetSandboxSchema,
  runCodeSchema,
  sandboxStatusSchema,
  writeFileSchema,
} from './schemas.js';
import {
  opListFiles,
  opReadFile,
  opResetSandbox,
  opRunCode,
  opSandboxStatus,
  opWriteFile,
  type ToolOutput,
} from './ops.js';

export const sandboxServer = instrumentServer(new FastMCP<UserSession>({
  name: 'Sandbox MCP',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'sandbox'),
}), 'sandbox');

// Scripts call the REST plane, so the route list is what Claude writes them
// against. No mintRestBearerForCurl: every run already carries its own bearer.
registerListRestEndpoints(sandboxServer);

/** JSON text, plus any images a run produced or a file held. */
function respond(out: ToolOutput) {
  const text = JSON.stringify(out.json, null, 2);
  if (out.images.length === 0) return text;
  return {
    content: [
      { type: 'text' as const, text },
      ...out.images.map((img) => ({ type: 'image' as const, data: img.data, mimeType: img.mimeType })),
    ],
  };
}

// Descriptions are plain string literals: scripts/buildMcpToolsDoc.mjs reads them from source.

sandboxServer.addTool({
  name: 'runCode',
  annotations: { readOnlyHint: false, openWorldHint: true },
  description:
    'Run Python (default), JavaScript or a bash command in your own cloud sandbox and get stdout, stderr, errors and results (plots come back as images). ' +
    'Variables and files persist between calls while the sandbox is in use; it stops after some idle minutes (see sandboxStatus) and the next call starts a fresh one, which the response says. Keep anything worth keeping in the Storage MCP. ' +
    'Each run can call this platform\'s REST API as you: in Python, `from awesome import api` then `api(\'GET\', \'/api/v1/storage/collections\')` or `api(\'POST\', path, body)`; the token is in AWESOME_API_TOKEN and the base URL in AWESOME_API_BASE, valid only during the run. Use listRestEndpoints to see the routes for your connected services. ' +
    'Process data inside the script and print only a summary: output is capped at 20,000 characters per stream. ' +
    'The network reaches only this platform\'s API and the PyPI and npm registries (pip install works). Runs stop after timeoutSec (max 300).',
  parameters: runCodeSchema,
  execute: async (args, { session }) => respond(await opRunCode(session?.userId, session?.instanceId, args)),
});

sandboxServer.addTool({
  name: 'writeFile',
  annotations: { readOnlyHint: false },
  description:
    'Write a text file (up to 1 MB) into your sandbox, e.g. a CSV you already have, for runCode to process. Starts the sandbox if none is running. ' +
    'For larger data, have a script fetch it over the REST API instead of passing it through this call.',
  parameters: writeFileSchema,
  execute: async (args, { session }) => respond(await opWriteFile(session?.userId, args)),
});

sandboxServer.addTool({
  name: 'listFiles',
  annotations: { readOnlyHint: true },
  description: 'List a directory in your running sandbox (default /home/user, the working directory): name, path, type and size of each entry.',
  parameters: listFilesSchema,
  execute: async (args, { session }) => respond(await opListFiles(session?.userId, args)),
});

sandboxServer.addTool({
  name: 'readFile',
  annotations: { readOnlyHint: true },
  description:
    'Read a file from your running sandbox. Text comes back capped at maxChars (the response gives the total); PNG, JPEG, GIF and WebP images up to 1.5 MB come back as images. ' +
    'Other binary files are described, not returned: process them in runCode.',
  parameters: readFileSchema,
  execute: async (args, { session }) => respond(await opReadFile(session?.userId, args)),
});

sandboxServer.addTool({
  name: 'sandboxStatus',
  annotations: { readOnlyHint: true },
  description: 'Whether your sandbox is running and when it stops if left idle, plus today\'s usage against your daily limits (runs and seconds of run time, reset at midnight UTC).',
  parameters: sandboxStatusSchema,
  execute: async (_args, { session }) => respond(await opSandboxStatus(session?.userId)),
});

sandboxServer.addTool({
  name: 'resetSandbox',
  annotations: { readOnlyHint: false, destructiveHint: true },
  description: 'Stop your sandbox now, discarding its files and variables. The next runCode starts a fresh one. Use it to clear a stuck state.',
  parameters: resetSandboxSchema,
  execute: async (_args, { session }) => respond(await opResetSandbox(session?.userId)),
});
