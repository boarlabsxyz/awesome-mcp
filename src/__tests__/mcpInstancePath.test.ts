// /mcp/<instanceId> exists because a query string does not survive the connector
// list Claude Code gets from Anthropic: two instances told apart only by
// ?instanceId= look like one server, and the second is dropped without an error.
//
// The rewrite is the easy half. What breaks a connector silently is OAuth
// discovery on the new URL, so those tests go through the MCP SDK's own client
// functions, and the end-to-end suite runs a real FastMCP server behind the real
// proxy: FastMCP answers 404 to anything but its exact endpoint, which an echo
// server would not show.
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { FastMCP } from 'fastmcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  discoverOAuthProtectedResourceMetadata,
  extractWWWAuthenticateParams,
  selectResourceURL,
} from '@modelcontextprotocol/sdk/client/auth.js';

if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: {
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:8080/auth/callback'],
    },
  });
}

import { createMcpOnlyApp, createWebApp } from '../website/webServer.js';
import { instanceIdFromPath, instancePathToQuery, resourceMetadataUrl } from '../mcpInstancePath.js';
import { createOrUpdateUser, getUserByGoogleId } from '../userStore.js';

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** Set env vars for the suite; returns the undo. */
function withEnv(values: Record<string, string>): () => void {
  const previous = Object.keys(values).map((k) => [k, process.env[k]] as const);
  Object.assign(process.env, values);
  return () => {
    for (const [k, v] of previous) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

async function testApiKey(tag: string): Promise<string> {
  const googleId = `google-instance-path-${tag}`;
  await createOrUpdateUser(
    { email: `instance-path-${tag}@example.com`, googleId, name: 'Instance Path' },
    { access_token: 'a', refresh_token: 'r', scope: 'email', token_type: 'Bearer', expiry_date: Date.now() + 3600_000 },
  );
  return (await getUserByGoogleId(googleId))!.apiKey;
}

describe('instanceIdFromPath', () => {
  it('reads nanoid and legacy ids', () => {
    assert.equal(instanceIdFromPath('/mcp/exampleId01', '/mcp'), 'exampleId01');
    assert.equal(instanceIdFromPath('/mcp/example_Id2', '/mcp'), 'example_Id2');
    assert.equal(instanceIdFromPath('/mcp/google-docs-legacy', '/mcp'), 'google-docs-legacy');
    assert.equal(instanceIdFromPath('/calendar/abc', '/calendar'), 'abc');
  });

  it('tolerates a trailing slash, which clients normalise freely', () => {
    assert.equal(instanceIdFromPath('/mcp/abc/', '/mcp'), 'abc');
  });

  it('rejects everything else', () => {
    for (const pathname of ['/mcp', '/mcp/', '/mcp/a/b', '/mcpx/abc', '/sse/abc', '/mcp/a"b', '/mcp/a%0d%0ab', '/mcp/..']) {
      assert.equal(instanceIdFromPath(pathname, '/mcp'), null, pathname);
    }
  });

  it('does not treat a root-mounted path as an instance', () => {
    assert.equal(instanceIdFromPath('/mcp', ''), null);
  });
});

describe('instancePathToQuery', () => {
  it('moves the id into the query', () => {
    assert.equal(instancePathToQuery('/mcp/abc'), '/mcp?instanceId=abc');
  });

  it('keeps the rest of the query', () => {
    assert.equal(instancePathToQuery('/mcp/abc?apiKey=k.abc'), '/mcp?apiKey=k.abc&instanceId=abc');
  });

  it('lets the path win over a stray ?instanceId=', () => {
    assert.equal(instancePathToQuery('/mcp/abc?instanceId=other'), '/mcp?instanceId=abc');
  });

  it('leaves the existing URL forms alone', () => {
    for (const url of ['/mcp', '/mcp?instanceId=abc', '/mcp?apiKey=k.abc', '/sse', '/mcp/a/b']) {
      assert.equal(instancePathToQuery(url), url);
    }
  });

  it('always targets FastMCP\'s /mcp, whatever the public mount', () => {
    assert.equal(instancePathToQuery('/calendar/abc', '/calendar'), '/mcp?instanceId=abc');
  });
});

describe('resourceMetadataUrl', () => {
  const root = 'https://h.test/.well-known/oauth-protected-resource';

  it('points the path form at its own document', () => {
    assert.equal(resourceMetadataUrl('https://h.test', '/mcp', '/abc'), `${root}/mcp/abc`);
    assert.equal(resourceMetadataUrl('https://h.test', '/calendar', '/abc'), `${root}/calendar/abc`);
  });

  it('points everything else at the root document', () => {
    assert.equal(resourceMetadataUrl('https://h.test', '/mcp', '/'), root);
    assert.equal(resourceMetadataUrl('https://h.test', '/sse', '/abc'), root);
    assert.equal(resourceMetadataUrl('https://h.test', '/calendar-sse', '/abc'), root);
    assert.equal(resourceMetadataUrl('https://h.test', '', ''), root);
  });
});

describe('what the proxy forwards to the MCP server', () => {
  let echo: http.Server;
  let echoPort: number;
  let apiKey: string;
  let received: string[] = [];

  before(async () => {
    echo = http.createServer((req, res) => {
      received.push(req.url!);
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
    echoPort = (echo.address() as AddressInfo).port;
    apiKey = await testApiKey('forward');
  });

  after(() => new Promise<void>((r) => echo.close(() => r())));

  const forwardedFor = async (app: any, url: string) => {
    received = [];
    await request(app).post(url).set('authorization', `Bearer ${apiKey}`).send({});
    return received[received.length - 1];
  };

  it('MCP-only app: /mcp/<id> arrives as ?instanceId=<id>', async () => {
    const app = createMcpOnlyApp(echoPort);
    assert.equal(await forwardedFor(app, '/mcp/abc'), '/mcp?instanceId=abc');
  });

  it('MCP-only app: the existing URL forms arrive unchanged', async () => {
    const app = createMcpOnlyApp(echoPort);
    assert.equal(await forwardedFor(app, '/mcp'), '/mcp');
    assert.equal(await forwardedFor(app, '/mcp?instanceId=abc'), '/mcp?instanceId=abc');
  });

  it('all-in-one app: every mount keeps its prefix rewrite and gains the path form', async () => {
    const app = createWebApp(echoPort, echoPort, echoPort, echoPort, echoPort, echoPort, echoPort, echoPort, echoPort);
    assert.equal(await forwardedFor(app, '/mcp/abc'), '/mcp?instanceId=abc');
    assert.equal(await forwardedFor(app, '/calendar/abc'), '/mcp?instanceId=abc');
    assert.equal(await forwardedFor(app, '/slack-bot/abc'), '/mcp?instanceId=abc');
    assert.equal(await forwardedFor(app, '/slack/abc'), '/mcp?instanceId=abc');
    assert.equal(await forwardedFor(app, '/calendar'), '/mcp');
    assert.equal(await forwardedFor(app, '/calendar?instanceId=abc'), '/mcp?instanceId=abc');
    assert.equal(await forwardedFor(app, '/calendar-sse'), '/sse');
  });
});

describe('OAuth discovery on the path form', () => {
  let server: http.Server;
  let origin: string;
  let undoEnv: () => void;

  before(async () => {
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    undoEnv = withEnv({ AUTH0_DOMAIN: 'https://test.auth0.com', MCP_BASE_URL: origin, MCP_SLUG: 'slack' });
    const app = createMcpOnlyApp(1);
    await new Promise<void>((r) => { server = app.listen(port, '127.0.0.1', () => r()); });
  });

  after(async () => {
    undoEnv();
    await new Promise<void>((r) => server.close(() => r()));
  });

  /** The steps an MCP client takes after a 401, using the SDK's own functions. */
  async function discover(serverUrl: string) {
    const unauthorized = await fetch(serverUrl, { method: 'POST' });
    assert.equal(unauthorized.status, 401);
    const { resourceMetadataUrl: pointer } = extractWWWAuthenticateParams(unauthorized);
    assert.ok(pointer, 'the 401 names no resource_metadata');
    const metadata = await discoverOAuthProtectedResourceMetadata(serverUrl, { resourceMetadataUrl: pointer });
    return { pointer, metadata, resource: await selectResourceURL(serverUrl, {} as any, metadata) };
  }

  it('the 401 names a document whose resource is exactly the URL called (RFC 9728 §3.3)', async () => {
    const serverUrl = `${origin}/mcp/exampleId01`;
    const { pointer, metadata, resource } = await discover(serverUrl);
    assert.equal(pointer.href, `${origin}/.well-known/oauth-protected-resource/mcp/exampleId01`);
    assert.equal(metadata.resource, serverUrl);
    assert.equal(resource?.href, serverUrl);
  });

  it('the authorization server stays the bare origin', async () => {
    // Clients build the AS metadata URL from this value, and only the bare
    // origin has one: /mcp/<id> here would send them to a 404.
    const { metadata } = await discover(`${origin}/mcp/exampleId01`);
    assert.deepEqual(metadata.authorization_servers, [origin]);
    assert.deepEqual(metadata.scopes_supported, ['mcp:slack']);
  });

  it('two instances of one tool are two resources', async () => {
    const one = await discover(`${origin}/mcp/instanceOne`);
    const two = await discover(`${origin}/mcp/instanceTwo`);
    assert.notEqual(one.metadata.resource, two.metadata.resource);
  });

  it('the URL existing connectors use still resolves to the root document', async () => {
    const { pointer, metadata } = await discover(`${origin}/mcp?instanceId=exampleId01`);
    assert.equal(pointer.href, `${origin}/.well-known/oauth-protected-resource`);
    assert.equal(metadata.resource, origin);
  });

  it('answers path-suffixed discovery, which clients try when no header helps', async () => {
    const res = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp/exampleId01`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).resource, `${origin}/mcp/exampleId01`);
  });

  it('refuses an id that could not be one, rather than reflecting it', async () => {
    const res = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp/a%22b`);
    assert.equal(res.status, 404);
  });

  it('does not reflect a bad id into the 401 header', async () => {
    const res = await fetch(`${origin}/mcp/a%22b`, { method: 'POST' });
    assert.equal(res.status, 401);
    assert.equal(
      res.headers.get('www-authenticate'),
      `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    );
  });

  it('only exists under a mount this service serves', async () => {
    const res = await fetch(`${origin}/.well-known/oauth-protected-resource/calendar/abc`);
    assert.equal(res.status, 404);
  });

  it('all-in-one app: a prefixed mount gets its own document', async () => {
    const undo = withEnv({ AUTH0_DOMAIN: 'https://test.auth0.com' });
    try {
      const app = createWebApp(1, 1, 1);
      const unauthorized = await request(app).post('/calendar/abc').send({});
      assert.equal(unauthorized.status, 401);
      const header = unauthorized.headers['www-authenticate'];
      const pointer = /resource_metadata="https?:\/\/[^/]+([^"]+)"/.exec(header)?.[1];
      assert.equal(pointer, '/.well-known/oauth-protected-resource/calendar/abc');
      const metadata = await request(app).get(pointer!);
      assert.equal(metadata.status, 200);
      assert.match(metadata.body.resource, /\/calendar\/abc$/);
    } finally {
      undo();
    }
  });
});

describe('two instances through a real FastMCP server', () => {
  type Session = { instanceId: string | null };

  let fastMcp: FastMCP<Session>;
  let proxy: http.Server;
  let origin: string;
  let apiKey: string;
  let authenticatedUrls: string[] = [];

  before(async () => {
    apiKey = await testApiKey('fastmcp');
    const internalPort = await freePort();
    fastMcp = new FastMCP<Session>({
      name: 'instance-path-test',
      version: '1.0.0',
      // Reads the instance the way authenticateRequest does.
      authenticate: async (req) => {
        authenticatedUrls.push(req.url!);
        return { instanceId: new URL(req.url!, 'http://localhost').searchParams.get('instanceId') };
      },
    });
    fastMcp.addTool({
      name: 'whichInstance',
      description: 'Echo the instance this session resolved to',
      execute: async (_args, { session }) => String(session?.instanceId),
    });
    await fastMcp.start({ transportType: 'httpStream', httpStream: { port: internalPort, host: '127.0.0.1' } });

    const app = createMcpOnlyApp(internalPort);
    await new Promise<void>((r) => { proxy = app.listen(0, '127.0.0.1', () => r()); });
    origin = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  });

  after(async () => {
    await fastMcp.stop();
    await new Promise<void>((r) => { proxy.close(() => r()); proxy.closeAllConnections(); });
  });

  async function connect(url: string): Promise<Client> {
    const client = new Client({ name: 'instance-path-test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
    }));
    return client;
  }

  const whichInstance = async (client: Client) => {
    const result = await client.callTool({ name: 'whichInstance', arguments: {} });
    return (result.content as Array<{ text: string }>)[0].text;
  };

  it('each path URL is its own session on its own instance', async () => {
    const one = await connect(`${origin}/mcp/instanceOne`);
    const two = await connect(`${origin}/mcp/instanceTwo`);
    try {
      assert.equal(await whichInstance(one), 'instanceOne');
      assert.equal(await whichInstance(two), 'instanceTwo');
      // Twice: the second call is on an established session, not initialize.
      assert.equal(await whichInstance(one), 'instanceOne');
    } finally {
      await one.close();
      await two.close();
    }
  });

  it('every request of a session reached FastMCP with its instance', async () => {
    authenticatedUrls = [];
    const client = await connect(`${origin}/mcp/instanceOne`);
    await whichInstance(client);
    await client.close();
    assert.ok(authenticatedUrls.length > 0);
    for (const url of authenticatedUrls) assert.equal(url, '/mcp?instanceId=instanceOne');
  });

  it('a connector added with the old URL behaves as before', async () => {
    const client = await connect(`${origin}/mcp?instanceId=instanceOne`);
    try {
      assert.equal(await whichInstance(client), 'instanceOne');
    } finally {
      await client.close();
    }
  });
});

describe('dashboard Copy URL', () => {
  const html = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'dashboard.html'),
    'utf8',
  );
  const source = html.match(/function getMcpUrl\(mcpSlug, instanceId\) \{[\s\S]*?\n {4}\}/);

  function getMcpUrl(authMode: string, mcpUrl: string, instanceId = 'exampleId01'): string {
    assert.ok(source, 'getMcpUrl not found in dashboard.html — was it renamed?');
    return new Function(`
      const catalogs = [{ slug: 'slack', mcpUrl: ${JSON.stringify(mcpUrl)} }];
      const baseUrl = 'https://app.test';
      const authMode = ${JSON.stringify(authMode)};
      const currentUser = { apiKey: 'key' };
      ${source[0]}
      return getMcpUrl('slack', ${JSON.stringify(instanceId)});
    `)() as string;
  }

  it('gives the path form with no query in jwt mode', () => {
    assert.equal(
      getMcpUrl('jwt', 'https://slack-user.awesome-mcp.xyz/mcp'),
      'https://slack-user.awesome-mcp.xyz/mcp/exampleId01',
    );
  });

  it('gives the path form in dual mode too: ?apiKey= is a query as well', () => {
    assert.equal(
      getMcpUrl('dual', 'https://slack-user.awesome-mcp.xyz/mcp'),
      'https://slack-user.awesome-mcp.xyz/mcp/exampleId01?apiKey=key.exampleId01',
    );
  });

  it('builds on a relative catalog URL (MCP_MODE=all)', () => {
    assert.equal(getMcpUrl('jwt', '/calendar'), 'https://app.test/calendar/exampleId01');
  });

  it('does not double a slash from the catalog URL', () => {
    assert.equal(getMcpUrl('jwt', 'https://h.test/mcp/'), 'https://h.test/mcp/exampleId01');
  });

  it('two instances still differ once the query is gone, in either auth mode', () => {
    for (const authMode of ['jwt', 'dual']) {
      const withoutQuery = (id: string) => getMcpUrl(authMode, 'https://h.test/mcp', id).split('?')[0];
      assert.notEqual(withoutQuery('one'), withoutQuery('two'));
    }
  });
});
