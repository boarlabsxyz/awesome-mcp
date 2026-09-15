// Which account a tool check runs against, and how to reach its MCP endpoint.
//
// The three accounts are the whole point of this layer. A single test account
// cannot answer the three questions worth asking about a tool:
//
//   fixture  frozen content, never written to. Exact-substring assertions are
//            only deterministic here.
//   rich     a tenant with a lot of real data. READ-ONLY BY POLICY -- this is
//            where paging, caps and truncation become observable, and a stray
//            write would silently change what every other check asserts.
//   sandbox  a tenant we are allowed to mutate. Writes, deletes, and zero-state
//            reads live here.
//
// `assertWritable` is what keeps that policy from being a comment: a check that
// declares `writes: true` cannot resolve fixture or rich credentials at all.

export type AccountName = 'fixture' | 'rich' | 'sandbox';

/**
 * Catalog slugs, which are the real service identifiers.
 *
 * Each MCP is deployed as its own Railway service on its own host, all serving
 * `/mcp` -- google-docs-mcp-development.up.railway.app/mcp,
 * google-drive-mcp-development.up.railway.app/mcp, and so on. An earlier version
 * of this file assumed one host with per-service path prefixes (`/drive`), which
 * is what webServer.ts's addMcpProxy builds in the single-service "all" mode.
 * Both layouts exist in the code; the deployment decides, so nothing here may
 * hard-code either. URLs come from the catalog instead.
 */
export type ServiceName =
  | 'google-docs'
  | 'google-drive'
  | 'google-sheets'
  | 'google-calendar'
  | 'google-gmail'
  | 'google-slides'
  | 'clickup'
  | 'slack'
  | 'slack-bot'
  | 'outline'
  | 'peopleforce'
  | 'hubspot';

export interface Endpoint {
  url: string;
  apiKey: string;
  account: AccountName;
  service: ServiceName;
}

const ENV_PREFIX: Record<AccountName, string> = {
  fixture: 'E2E_FIXTURE',
  rich: 'E2E_RICH',
  sandbox: 'E2E_SANDBOX',
};

/**
 * One catalog per base URL, not one per process.
 *
 * A single shared promise was wrong the moment two accounts point at different
 * deployments: whichever resolved first would hand its URLs to the other, and
 * the second account's checks would run against the first account's services
 * while reporting the right account name.
 */
const catalogCache = new Map<string, Promise<Map<string, string>>>();

/**
 * Reject any endpoint that would carry an API key in the clear.
 *
 * These bearers authenticate as a dashboard user to every MCP they have
 * connected, so a mistyped `http://` base URL does not just fail, it leaks the
 * credential to anything on the path. Loopback is allowed because a local
 * deployment has no network hop to intercept.
 */
function assertSecure(url: string, source: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${source} is not a valid URL: ${JSON.stringify(url)}`);
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !loopback) {
    throw new Error(
      `${source} must be https (got ${parsed.protocol}//${parsed.hostname}). These checks send an ` +
        'account API key as a bearer token; only loopback may use http.',
    );
  }
  return url;
}

/**
 * slug -> mcpUrl, from the deployment's own public catalog.
 *
 * `GET /api/v1/catalogs` is unauthenticated and is what the dashboard itself
 * renders from, so it is the same list a user copies a connector URL out of.
 * Reading it here means a service moving hosts does not need an env-var change,
 * and that a typo'd slug fails with the list of real ones rather than a 404.
 */
async function catalogUrls(baseUrl: string): Promise<Map<string, string>> {
  const key = baseUrl.replace(/\/+$/, '');
  const cached = catalogCache.get(key);
  if (cached) return cached;

  const pending = (async () => {
    const res = await fetch(`${key}/api/v1/catalogs`);
    if (!res.ok) {
      throw new Error(`GET ${key}/api/v1/catalogs returned ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { catalogs?: Array<{ slug: string; mcpUrl: string }> };
    const map = new Map<string, string>();
    for (const entry of body.catalogs ?? []) {
      if (entry.slug && entry.mcpUrl) map.set(entry.slug, entry.mcpUrl);
    }
    if (map.size === 0) throw new Error(`${key}/api/v1/catalogs listed no MCPs`);
    return map;
  })();

  // Cache the promise, not the result, so concurrent checks share one fetch --
  // but drop it on failure so a transient outage is not remembered for the rest
  // of the run.
  catalogCache.set(key, pending);
  pending.catch(() => catalogCache.delete(key));
  return pending;
}

/**
 * Resolve the MCP endpoint + bearer for one (account, service) pair.
 *
 * The bearer is the account's dashboard API key. `/mcp` accepts it directly
 * (mcpOnlyMiddleware falls back to getUserByApiKey when the Auth0 JWT check
 * fails), which is why these checks need no browser and no OAuth dance -- the
 * three accounts are three dashboard users on the same dev deployment.
 *
 * A bare key is enough: with no instance in the token and none in the query,
 * mcpAuthenticate resolves the user's connection for that slug. Pass the
 * compound `<key>.<instanceId>` form, or an override URL carrying
 * `?instanceId=`, only when an account has more than one connection for the
 * same MCP.
 *
 * Overrides are looked up account-first (`E2E_FIXTURE_MCP_URL_GOOGLE_DOCS`)
 * before the shared form (`E2E_MCP_URL_GOOGLE_DOCS`), because an override that
 * names an instance names *one account's* instance -- sharing it across accounts
 * points every check at whichever account owns that connection.
 */
export async function endpointFor(account: AccountName, service: ServiceName): Promise<Endpoint> {
  const apiKey = required(`${ENV_PREFIX[account]}_API_KEY`);
  const suffix = `MCP_URL_${service.toUpperCase().replace(/-/g, '_')}`;
  const scoped = process.env[`${ENV_PREFIX[account]}_${suffix}`];
  const shared = process.env[`E2E_${suffix}`];

  let url = scoped ?? shared;
  let source = scoped ? `${ENV_PREFIX[account]}_${suffix}` : `E2E_${suffix}`;

  if (!url) {
    const baseName = `${ENV_PREFIX[account]}_BASE_URL`;
    const base = assertSecure(required(baseName, process.env.E2E_BASE_URL), baseName);
    const catalog = await catalogUrls(base);
    url = catalog.get(service);
    if (!url) {
      throw new Error(
        `${base} does not publish an MCP called '${service}'. It publishes: ` +
          `${[...catalog.keys()].join(', ')}.`,
      );
    }
    source = `${base}/api/v1/catalogs`;
  }

  return { url: assertSecure(url, source), apiKey, account, service };
}

/**
 * Refuse to hand a mutating check anything but sandbox credentials.
 *
 * Called before setup runs, not after: a write check that resolved the rich
 * account would already have corrupted it by the time an assertion failed, and
 * the damage is invisible -- it shows up weeks later as another check's "Found
 * 341 documents" quietly becoming 342.
 */
export function assertWritable(account: AccountName, tool: string): void {
  if (account !== 'sandbox') {
    throw new Error(
      `${tool} declares writes: true but resolved the '${account}' account. ` +
        'Write and delete checks may only run against sandbox -- fixture content is ' +
        'frozen for exact-substring assertions and rich is read-only by policy.',
    );
  }
}

/**
 * Turn a provider's own error text into something that names the account and the
 * fix.
 *
 * The Drive 403 case is the reason this exists, and the message has been wrong
 * twice, so the evidence is recorded here rather than re-derived.
 *
 * `listGoogleDocs` renders every Drive 403 as "Permission denied. Make sure you
 * have granted Google Drive access to the application." Measured against three
 * separate accounts, including one connected minutes earlier:
 *
 *   listGoogleDocs, no query                      -> ok
 *   listGoogleDocs, any query                     -> 403, every account
 *   listGoogleDocs, query, includeSharedDrives:false / corpora:user / every
 *     orderBy                                     -> 403
 *   searchGoogleDocs, same term, searchIn 'name' | 'content' | 'both'
 *                                                 -> ok
 *
 * searchIn defaults to 'both', so searchGoogleDocs builds the *identical* query
 * string and succeeds. That rules out scopes (a fresh token fails too), shared-
 * drive parameters, orderBy, and `fullText contains` itself. The two calls now
 * differ only in their `fields` projection. So a 403 here is a bug in
 * listGoogleDocs, not a fault in the caller's connection, and the message must
 * not send anyone off to reconnect an account that is already fine.
 */
export function explainToolError(account: AccountName, tool: string, text: string): string {
  if (text.includes('granted Google Drive access')) {
    return (
      `${tool} got a 403 from Drive on the '${account}' account.\n` +
      'Do not take the wording at face value, and do not reconnect on account of it. ' +
      'listGoogleDocs 403s on ANY query, for every account tested including freshly ' +
      'connected ones, while an unqueried listGoogleDocs and searchGoogleDocs with the ' +
      'same term both succeed -- so the connection is not the problem.\n' +
      (tool.startsWith('listGoogleDocs')
        ? 'Workaround: use searchGoogleDocs, which takes the same term and works.\n'
        : 'That evidence is about listGoogleDocs specifically. For this tool, first ' +
          `check whether Drive is connected at all: npm run check:auth -- ${account} google-drive\n`) +
      `Original error: ${text}`
    );
  }
  return `${tool} failed on the '${account}' account: ${text}`;
}

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required env var: ${name}. See e2e/accounts.md.`);
  }
  return value;
}
