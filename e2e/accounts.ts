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

let catalogCache: Promise<Map<string, string>> | null = null;

/**
 * slug -> mcpUrl, from the deployment's own public catalog.
 *
 * `GET /api/v1/catalogs` is unauthenticated and is what the dashboard itself
 * renders from, so it is the same list a user copies a connector URL out of.
 * Reading it here means a service moving hosts does not need an env-var change,
 * and that a typo'd slug fails with the list of real ones rather than a 404.
 */
async function catalogUrls(baseUrl: string): Promise<Map<string, string>> {
  if (!catalogCache) {
    catalogCache = (async () => {
      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/v1/catalogs`);
      if (!res.ok) {
        throw new Error(`GET ${baseUrl}/api/v1/catalogs returned ${res.status} ${res.statusText}`);
      }
      const body = (await res.json()) as { catalogs?: Array<{ slug: string; mcpUrl: string }> };
      const map = new Map<string, string>();
      for (const entry of body.catalogs ?? []) {
        if (entry.slug && entry.mcpUrl) map.set(entry.slug, entry.mcpUrl);
      }
      if (map.size === 0) throw new Error(`${baseUrl}/api/v1/catalogs listed no MCPs`);
      return map;
    })();
  }
  return catalogCache;
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
 */
export async function endpointFor(account: AccountName, service: ServiceName): Promise<Endpoint> {
  const apiKey = required(`${ENV_PREFIX[account]}_API_KEY`);
  const override = process.env[`E2E_MCP_URL_${service.toUpperCase().replace(/-/g, '_')}`];

  let url = override;
  if (!url) {
    const base = required(`${ENV_PREFIX[account]}_BASE_URL`, process.env.E2E_BASE_URL);
    const catalog = await catalogUrls(base);
    url = catalog.get(service);
    if (!url) {
      throw new Error(
        `${base} does not publish an MCP called '${service}'. It publishes: ` +
          `${[...catalog.keys()].join(', ')}.`,
      );
    }
  }

  return { url, apiKey, account, service };
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
 * The case this exists for, observed live: Google Drive answers 403 and the tool
 * renders it as "Permission denied. Make sure you have granted Google Drive
 * access to the application." That sentence is misleading in the common case.
 * On a connection where Drive IS granted, an unfiltered `listGoogleDocs`
 * succeeds and returns 100 documents while the same call *with* a query 403s --
 * because the query uses `fullText contains`, which needs the full
 * `auth/drive` scope the catalog requests today, and the stored token was minted
 * before that. A token is frozen at the scopes it was minted with, so the fix is
 * a reconnect, never a retry, and never re-seeding fixtures.
 *
 * The two cases are worth separating because they lead to different actions, and
 * the tool's own wording points at the wrong one.
 */
export function explainToolError(account: AccountName, tool: string, text: string): string {
  if (text.includes('granted Google Drive access')) {
    return (
      `${tool} got a 403 from Drive on the '${account}' account.\n` +
      "The tool renders every Drive 403 as \"grant Google Drive access\", but that is only " +
      'one of two causes:\n' +
      "  - Drive was never connected -> connect it on the dashboard.\n" +
      '  - Drive IS connected but the token predates the current scope set -> reconnect and ' +
      're-consent. A token keeps the scopes it was minted with.\n' +
      'Tell them apart: `listGoogleDocs` with no query succeeding while the same call with a ' +
      "query 403s means the second case -- queries use `fullText contains`, which needs the " +
      'full auth/drive scope.\n' +
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
