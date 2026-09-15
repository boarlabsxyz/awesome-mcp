import { endpointFor } from '../accounts.ts';
import { connectMcp } from '../transports/mcpHttp.ts';
const mcp = await connectMcp(await endpointFor('sandbox', 'google-docs'));
for (let i = 1; i <= 3; i++) {
  const r = await mcp.callTool('listGoogleDocs', { query: 'zzz-nope', maxResults: 5 });
  console.log(`attempt ${i}: ${r.isError ? 'STILL 403' : 'FIXED'}`);
  if (!r.isError) break;
  await new Promise((res) => setTimeout(res, 45_000));
}
await mcp.close();
