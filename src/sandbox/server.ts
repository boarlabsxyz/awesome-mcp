// src/sandbox/server.ts
// The Sandbox MCP: a place for Claude to run code when the client has no
// shell. Each user gets one sandbox (Pyodide under Deno, on the runner
// service: src/sandbox/runner/), kept between calls until it sits idle, and
// every run carries a short-lived bearer for this platform's
// REST plane, so a script can pull and push data in bulk and Claude sees only
// what the script prints.
import { FastMCP } from 'fastmcp';
import { instrumentServer } from '../usage/instrumentServer.js';
import { requireAdminForEveryTool } from '../admin-mcp/adminGuard.js';
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

// Admins only (ADMIN_ONLY_MCPS, src/auth/admin.ts): the guard re-checks the
// caller on every call, since FastMCP authenticates once per session.
export const sandboxServer = requireAdminForEveryTool(instrumentServer(new FastMCP<UserSession>({
  name: 'Sandbox MCP',
  version: '1.0.0',
  authenticate: createMcpAuthenticateHandler(process.env.MCP_SLUG || 'sandbox'),
}), 'sandbox'), 'The Sandbox MCP is for administrators only. Your account is not in ADMIN_EMAILS.');

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
    'Run Python (default; Python 3.14 on Pyodide) or JavaScript in your own sandbox and get stdout, stderr, errors and results (matplotlib figures left open come back as images). ' +
    'Python returns its last expression; JavaScript runs as the body of an async function, so `return` a value. Variables persist between calls while the interpreter lives (JavaScript: on globalThis); files in /home/user, the working directory, persist until the sandbox stops some idle minutes after the last runCode (file calls do not extend it; see sandboxStatus), and the next call starts a fresh one, which the response says. Keep anything worth keeping in the Storage MCP. ' +
    'Each run can call this platform\'s REST API as you: in Python, `from awesome import api` then `api(\'GET\', \'/api/v1/storage/collections\')` or `api(\'POST\', path, body)`; in JavaScript, `await api(\'GET\', path)`. The token is revoked when the run ends (if revoking fails, the sandbox is stopped instead, and the token lasts until it expires minutes later). Use listRestEndpoints to see the routes for your connected services. ' +
    'Process data inside the script and print only a summary: output is capped at 20,000 characters each for stdout, stderr and results. ' +
    'Bundled packages, loaded on import: numpy, pandas, matplotlib, scipy, scikit-learn, pyarrow, duckdb, requests, beautifulsoup4, lxml, pyyaml, xlrd, regex, pillow. Pure-Python packages install from PyPI with `import micropip; await micropip.install(\'name\')`; other packages with native code cannot be installed, and there is no shell. ' +
    'The network reaches only this platform\'s API and PyPI. Python\'s memory is capped (MemoryError past it). Runs stop after timeoutSec (max 300, and no more than what is left of your daily run time); a run that times out stops its interpreter, so variables are lost but files are kept, and the next run starts a new one.',
  parameters: runCodeSchema,
  execute: async (args, { session }) => respond(await opRunCode(session?.userId, session?.instanceId, args)),
});

sandboxServer.addTool({
  name: 'writeFile',
  annotations: { readOnlyHint: false },
  description:
    'Write a text file (up to 1 MB) under /home/user in your sandbox, e.g. a CSV you already have, for runCode to process. Starts the sandbox if none is running. ' +
    'For larger data, have a script fetch it over the REST API instead of passing it through this call.',
  parameters: writeFileSchema,
  execute: async (args, { session }) => respond(await opWriteFile(session?.userId, args)),
});

sandboxServer.addTool({
  name: 'listFiles',
  annotations: { readOnlyHint: true },
  description: 'List a directory under /home/user in your running sandbox (default /home/user, the working directory): name, path, type and size of each entry, at most 500.',
  parameters: listFilesSchema,
  execute: async (args, { session }) => respond(await opListFiles(session?.userId, args)),
});

sandboxServer.addTool({
  name: 'readFile',
  annotations: { readOnlyHint: true },
  description:
    'Read a file under /home/user in your running sandbox. Text comes back capped at maxChars, and only that much is read (the response gives the file size); PNG, JPEG, GIF and WebP images up to 1.5 MB come back as images. ' +
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
