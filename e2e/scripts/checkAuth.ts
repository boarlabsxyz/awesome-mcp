// Is this account's API key right, and can it reach the MCP?
//
//   E2E_BASE_URL=... E2E_FIXTURE_API_KEY=... npm run check:auth -- fixture
//
// Exists because every other failure mode in the harness looks the same from the
// outside: a missing scope, a wrong key, a service that moved hosts and a genuine
// tool bug all surface as a red test. This isolates the credential, resolves the
// URL the same way the checks do, and lists the tool surface -- two seconds, no
// fixtures, nothing written.

import { endpointFor, type AccountName, type ServiceName } from '../accounts.ts';
import { connectMcp } from '../transports/mcpHttp.ts';

const account = (process.argv[2] ?? 'fixture') as AccountName;
const service = (process.argv[3] ?? 'google-docs') as ServiceName;

if (!['fixture', 'rich', 'sandbox'].includes(account)) {
  console.error(`Usage: npm run check:auth -- <fixture|rich|sandbox> [service-slug]`);
  process.exit(1);
}

const endpoint = await endpointFor(account, service);
console.log(`account: ${account}\nservice: ${service}\nurl:     ${endpoint.url}`);

// A stack trace is noise here: this script's whole job is to answer one question
// in one line, and the message already says what to do.
try {
  const mcp = await connectMcp(endpoint);
  try {
    const tools = await mcp.listTools();
    console.log(`\nAuthenticated. ${tools.length} tools:\n  ${tools.join(', ')}`);
  } finally {
    await mcp.close();
  }
} catch (err) {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
