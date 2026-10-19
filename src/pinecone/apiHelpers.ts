// src/pinecone/apiHelpers.ts
// PineconeClient — the HTTP surface of the Pinecone connector.
//
// Three planes, one client. Pinecone splits its API across three bases and
// this class addresses all of them through a single request(), because they
// differ only in the host:
//
//   control   https://api.pinecone.io        indexes: list, describe, create
//   inference https://api.pinecone.io        /rerank
//   data      https://{index.host}           per-index: stats, search, upsert
//
// THE DATA PLANE IS PER-INDEX, which is the fact that shapes everything else
// here and in indexCatalog.ts: `host` is not configuration, it is a property of
// the index that only GET /indexes/{name} will tell you. Every search, stat and
// upsert therefore costs a describe first — see indexCatalog.ts for the cache
// and for why that cache is allowed when mcpProxyClient's session cache is not.
//
// X-Pinecone-Api-Version IS REQUIRED ON EVERY CALL. It is not a "default to
// latest" header — omitting it is a rejection. It is pinned here rather than
// taken from the environment: a connector that silently follows whatever
// version an operator typed would change its own wire format under the tests
// that validate it.
//
// Wire format is snake_case (top_k, rank_fields, top_n) while the tool
// parameters are camelCase. Pinecone's own MCP server gets that translation
// from the SDK; this connector carries no SDK dependency (the same reasoning
// as src/mailer.ts using plain fetch), so the translation is written out in
// the request builders below and is ours to get wrong.

import { UserError } from 'fastmcp';

import type { UserSession } from '../userSession.js';
import { jsonApiRequest } from '../util/jsonApiRequest.js';

/** Control and inference plane. A constant, never an env var: it is where a credential goes. */
export const PINECONE_CONTROL_BASE_URL = 'https://api.pinecone.io';

/**
 * The pinned API version.
 *
 * 2026-07 is current at the time of writing. Changing it is a deliberate
 * migration, not a config change: it alters the shape of `schema.fields`,
 * which src/pinecone/indexKind.ts classifies on.
 */
export const PINECONE_API_VERSION = '2026-07';

const REQUEST_TIMEOUT_MS = 30_000;
/** An upsert body may be up to 2 MB of text; give it longer than a metadata read. */
const UPSERT_TIMEOUT_MS = 60_000;

/** The slice of FastMCP's log the ops use. Matches BrowserbaseToolLog's shape. */
export type PineconeToolLog = {
  info: (msg: string) => void;
  error: (msg: string) => void;
};

export interface PineconeIndexSummary {
  name: string;
  host?: string;
  dimension?: number;
  metric?: string;
  status?: { ready?: boolean; state?: string };
  schema?: { fields?: Record<string, any> };
  embed?: { model?: string; field_map?: { text?: string } };
  tags?: Record<string, string> | null;
  [key: string]: unknown;
}

export interface PineconeIndexStats {
  namespaces?: Record<string, { recordCount?: number; vectorCount?: number }>;
  totalRecordCount?: number;
  totalVectorCount?: number;
  dimension?: number;
  [key: string]: unknown;
}

export interface PineconeSearchHit {
  _id: string;
  _score?: number;
  fields?: Record<string, unknown>;
}

export interface PineconeSearchResponse {
  result?: { hits?: PineconeSearchHit[] };
  usage?: Record<string, unknown>;
}

export interface PineconeRerankRow {
  index: number;
  score: number;
  document?: Record<string, unknown> | string;
}

export interface PineconeRerankResponse {
  model?: string;
  data?: PineconeRerankRow[];
  usage?: Record<string, unknown>;
}

/** camelCase as the tools take it; translated to snake_case on the way out. */
export interface SearchQueryInput {
  topK: number;
  inputs: { text: string };
  filter?: Record<string, unknown>;
}

export interface RerankInput {
  model: string;
  topN?: number;
  rankFields: string[];
  query?: string;
}

export interface CreateIndexForModelInput {
  name: string;
  cloud: string;
  region: string;
  embed: { model: string; fieldMap: { text: string } };
}

/**
 * Thin client over the Pinecone REST API. One instance per tool call — it
 * holds only a key, so construction is free.
 */
export class PineconeClient {
  constructor(
    private readonly apiKey: string,
    public readonly controlBaseUrl: string = PINECONE_CONTROL_BASE_URL,
    /** Injected in tests. */
    private readonly fetchImpl?: typeof fetch,
  ) {}

  /**
   * One REST call against an absolute base.
   *
   * The redirect guard, the deadline, the `.status` tagging and the empty-body
   * handling all live in jsonApiRequest — see its header for why each matters.
   * The status landing on `.status` is the detail worth knowing here: it is
   * what lets a REST handler answer a real 404 with no translation step,
   * unlike ClickUp's symbol-tagged status.
   */
  private call<T>(
    base: string,
    method: string,
    path: string,
    opts: { body?: unknown; rawBody?: string; contentType?: string; timeoutMs?: number } = {},
  ): Promise<T> {
    return jsonApiRequest<T>({
      url: `${base}${path}`,
      method,
      headers: {
        'Api-Key': this.apiKey,
        // Required on every call. See the header: this is not optional and
        // not version-negotiated.
        'X-Pinecone-Api-Version': PINECONE_API_VERSION,
      },
      body: opts.body,
      rawBody: opts.rawBody,
      contentType: opts.contentType,
      timeoutMs: opts.timeoutMs ?? REQUEST_TIMEOUT_MS,
      serviceLabel: 'Pinecone API',
      target: `${method} ${path}`,
      fetchImpl: this.fetchImpl,
    }) as Promise<T>;
  }

  /** A call against the control/inference plane. */
  request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.call<T>(this.controlBaseUrl, method, path, { body });
  }

  /**
   * A call against one index's own host.
   *
   * `host` arrives from a describe and is used as the authority of a URL we
   * then send the API key to, so it is checked rather than interpolated: a
   * payload field that reaches `new URL()` unvalidated is how a credential
   * ends up somewhere Pinecone did not name.
   */
  dataRequest<T>(
    host: string,
    method: string,
    path: string,
    opts: { body?: unknown; rawBody?: string; contentType?: string; timeoutMs?: number } = {},
  ): Promise<T> {
    return this.call<T>(dataBaseUrl(host), method, path, opts);
  }

  // ---- control plane ----

  async listIndexes(): Promise<PineconeIndexSummary[]> {
    const res = await this.request<{ indexes?: PineconeIndexSummary[] }>('GET', '/indexes');
    return Array.isArray(res?.indexes) ? res.indexes : [];
  }

  describeIndex(name: string): Promise<PineconeIndexSummary> {
    return this.request<PineconeIndexSummary>('GET', `/indexes/${encodeURIComponent(name)}`);
  }

  /**
   * POST /indexes/create-for-model.
   *
   * `field_map` is snake_case on the wire while the tool takes `fieldMap`.
   * The `source: mcp` tag matches what Pinecone's own MCP server writes, so an
   * index created through either route is recognisable in the console.
   */
  createIndexForModel(input: CreateIndexForModelInput): Promise<PineconeIndexSummary> {
    return this.request<PineconeIndexSummary>('POST', '/indexes/create-for-model', {
      name: input.name,
      cloud: input.cloud,
      region: input.region,
      embed: {
        model: input.embed.model,
        field_map: { text: input.embed.fieldMap.text },
      },
      tags: { source: 'mcp', embedding_model: input.embed.model },
    });
  }

  // ---- inference plane ----

  rerank(input: {
    model: string;
    query: string;
    documents: Array<Record<string, unknown>> | string[];
    topN?: number;
    rankFields?: string[];
  }): Promise<PineconeRerankResponse> {
    return this.request<PineconeRerankResponse>('POST', '/rerank', {
      model: input.model,
      query: input.query,
      // Pinecone's Document schema is an object; a bare string is lifted into
      // the `text` field its default rank_fields (["text"]) looks at, which is
      // what makes an array of plain strings work at all.
      documents: input.documents.map(d => (typeof d === 'string' ? { text: d } : d)),
      ...(input.topN !== undefined ? { top_n: input.topN } : {}),
      ...(input.rankFields?.length ? { rank_fields: input.rankFields } : {}),
    });
  }

  // ---- data plane ----

  describeIndexStats(host: string): Promise<PineconeIndexStats> {
    return this.dataRequest<PineconeIndexStats>(host, 'POST', '/describe_index_stats', { body: {} });
  }

  /**
   * POST /records/namespaces/{namespace}/search.
   *
   * The namespace goes through encodeURIComponent, and the DEFAULT NAMESPACE
   * IS THE EMPTY STRING — which encodes to nothing, leaving `/namespaces//
   * search`. That double slash is the correct address for it; collapsing the
   * path would silently retarget the call at a namespace literally named
   * "search".
   */
  searchRecords(
    host: string,
    namespace: string,
    query: SearchQueryInput,
    rerank?: RerankInput,
    fields?: string[],
  ): Promise<PineconeSearchResponse> {
    const body: Record<string, unknown> = {
      query: {
        top_k: query.topK,
        inputs: query.inputs,
        ...(query.filter ? { filter: query.filter } : {}),
      },
      ...(fields?.length ? { fields } : {}),
    };
    if (rerank) {
      body.rerank = {
        model: rerank.model,
        rank_fields: rerank.rankFields,
        ...(rerank.topN !== undefined ? { top_n: rerank.topN } : {}),
        ...(rerank.query ? { query: rerank.query } : {}),
      };
    }
    return this.dataRequest<PineconeSearchResponse>(
      host,
      'POST',
      `/records/namespaces/${encodeURIComponent(namespace)}/search`,
      { body },
    );
  }

  /**
   * POST /records/namespaces/{namespace}/upsert.
   *
   * The body is application/x-ndjson, NOT a JSON array. Sending
   * application/json yields a 400 that reads like a schema error and sends the
   * caller hunting the wrong bug, which is why the content type is passed
   * explicitly here rather than left to jsonApiRequest's default.
   *
   * Answers 201 with an empty body, so there is nothing to return — the
   * caller synthesizes its report. See opUpsertRecords for what that report
   * may and may not claim.
   */
  async upsertRecords(host: string, namespace: string, ndjson: string): Promise<void> {
    await this.dataRequest<void>(host, 'POST', `/records/namespaces/${encodeURIComponent(namespace)}/upsert`, {
      rawBody: ndjson,
      contentType: 'application/x-ndjson',
      timeoutMs: UPSERT_TIMEOUT_MS,
    });
  }
}

/**
 * Is this a plain, multi-label hostname?
 *
 * Checked label by label rather than with one regex. The natural pattern for
 * this — `^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.…)+$` — nests a quantifier inside a
 * repeated group, which is the classic catastrophic-backtracking shape; V8
 * happens to handle it, but a validator standing between a payload field and
 * the host an API key is sent to is the wrong place to depend on that. Each
 * check below is linear.
 *
 * It also enforces the two length limits the regex did not: 63 octets per
 * label and 253 overall.
 */
function isPlainHostname(value: string): boolean {
  if (!value || value.length > 253) return false;
  const labels = value.split('.');
  // A single label is not an index host — Pinecone always returns an FQDN, and
  // accepting a bare word would let a payload redirect us to an internal name.
  if (labels.length < 2) return false;
  return labels.every(label =>
    label.length >= 1 &&
    label.length <= 63 &&
    /^[a-z0-9-]+$/i.test(label) &&
    !label.startsWith('-') &&
    !label.endsWith('-'),
  );
}

/**
 * Turn an index `host` from a describe payload into a base URL.
 *
 * Pinecone returns a bare hostname (`idx-abc123.svc.us-east1-gcp.pinecone.io`).
 * It is validated rather than interpolated because this is the authority of a
 * URL the API key is then sent to: a payload that carried `evil.test/x` or a
 * scheme would otherwise redirect the credential, and `new URL` on a bare
 * hostname does not parse, so there is no accidental safety here.
 */
export function dataBaseUrl(host: string): string {
  const raw = String(host ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!isPlainHostname(raw)) {
    throw new UserError(
      `Pinecone returned an index host this connector will not call ("${String(host).slice(0, 80)}"). ` +
        `Expected a plain hostname. Nothing was sent.`,
    );
  }
  return `https://${raw}`;
}

/** Build a client from the session. */
export function getPineconeClient(session?: UserSession): PineconeClient {
  if (!session?.pineconeAccessToken) {
    throw new UserError(
      'Pinecone not connected. Visit the dashboard to connect your Pinecone account with an API key from https://app.pinecone.io/organizations/-/keys.',
    );
  }
  return new PineconeClient(session.pineconeAccessToken);
}

/**
 * Map a REST failure to a message that says what to do.
 *
 * The `undefined` branch matters most on upsert-records: undici reports every
 * transport failure as a bare "fetch failed" with no status, and claiming a
 * write did not happen is as wrong as claiming it did.
 */
export function mapPineconeError(prefix: string, error: any, log?: PineconeToolLog): never {
  const status: number | undefined = error?.status;
  log?.error(`${prefix}: ${error?.message ?? error} (status ${status ?? 'none'})`);

  if (status === 401) {
    throw new UserError(
      `${prefix}: Pinecone rejected the API key. Reconnect from the dashboard with a current key from https://app.pinecone.io/organizations/-/keys.`,
    );
  }
  if (status === 403) {
    throw new UserError(
      `${prefix}: the Pinecone API key is valid but is not allowed to do this. An API key is scoped to one project, so an index in a different project reads as forbidden rather than missing.`,
    );
  }
  if (status === 404) {
    throw new UserError(
      `${prefix}: Pinecone has no index by that name in this key's project. Run list-indexes to see what exists — and note an index in another project is invisible to this key rather than listed.`,
    );
  }
  if (status === 429) {
    throw new UserError(`${prefix}: Pinecone rate-limited the request. Retry in a few seconds.`);
  }
  if (status === undefined) {
    throw new UserError(
      `${prefix}: could not reach the Pinecone API (${error?.message ?? 'network error'}). The request may or may not have been received.`,
    );
  }
  throw new UserError(`${prefix}: Pinecone API error (${status}). ${error?.message ?? ''}`.trim());
}

/** Wrap a tool body with the standard client-fetch + error-mapping pattern. */
export async function withPineconeClient<T>(
  prefix: string,
  session: UserSession | undefined,
  log: PineconeToolLog,
  fn: (client: PineconeClient) => Promise<T>,
): Promise<T> {
  // getPineconeClient runs BEFORE the callback so a missing token surfaces
  // verbatim rather than being re-wrapped as an upstream failure.
  const client = getPineconeClient(session);
  try {
    return await fn(client);
  } catch (error: any) {
    if (error instanceof UserError) throw error;
    mapPineconeError(prefix, error, log);
  }
}
