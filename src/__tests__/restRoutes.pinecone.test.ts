// src/__tests__/restRoutes.pinecone.test.ts
// Drives the Pinecone REST handlers with a real bearer, which is the only way
// to show the parts the auth-gate test cannot: that the index name in the path
// reaches the right upstream host, that the connection's access rules — index,
// namespace AND the read-only switch — are enforced on this plane too, that the
// namespace travels in the body so the DEFAULT namespace is addressable at all,
// that an upstream 404 comes back as a 404 rather than a flat 500, and that
// ?format=text renders the same thing the MCP tool does.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';

import { createMcpInstance, GoogleTokens } from '../mcpConnectionStore.js';
import { createMcpCatalog } from '../mcpCatalogStore.js';
import { clearPineconeIndexCache } from '../pinecone/indexCatalog.js';
import { createOrUpdateUser, getUserByGoogleId, UserTokens } from '../userStore.js';
import { createWebOnlyApp } from '../website/webServer.js';

if (!process.env.GOOGLE_CREDENTIALS) {
  process.env.GOOGLE_CREDENTIALS = JSON.stringify({
    web: {
      client_id: 'test-client-id.apps.googleusercontent.com',
      client_secret: 'test-client-secret',
      redirect_uris: ['http://localhost:8080/auth/callback'],
    },
  });
}

const dummyTokens: UserTokens = {
  access_token: 'acc', refresh_token: 'ref', scope: 'email',
  token_type: 'Bearer', expiry_date: Date.now() + 3600_000,
};
const emptyGoogleTokens: GoogleTokens = {
  access_token: '', refresh_token: '', scope: '', token_type: '', expiry_date: 0,
};

function jsonRes(body: unknown, status = 200): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    body: null,
  };
}

const INDEX = {
  name: 'docs',
  host: 'docs-abc.svc.us-east1-gcp.pinecone.io',
  status: { ready: true },
  schema: { fields: { chunk_text: { type: 'semantic_text' } } },
  embed: { model: 'multilingual-e5-large', field_map: { text: 'chunk_text' } },
};

/** Route by URL: control plane, per-index data host, or the docs assistant. */
function mockPinecone(opts: { indexes?: any[]; describeStatus?: number; hits?: any[]; stats?: any } = {}) {
  const calls: Array<{ url: string; method: string; body: any; headers: any }> = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    const raw = init?.body;
    let body: any;
    try { body = typeof raw === 'string' && raw.startsWith('{') ? JSON.parse(raw) : raw; } catch { body = raw; }
    calls.push({ url: u, method: init?.method ?? 'GET', body, headers: init?.headers ?? {} });

    if (u.endsWith('/indexes')) {
      if ((init?.method ?? 'GET') === 'POST') return jsonRes({ ...INDEX, name: body?.name }, 201);
      return jsonRes({ indexes: opts.indexes ?? [INDEX] });
    }
    if (u.includes('/indexes/')) {
      if (opts.describeStatus && opts.describeStatus >= 400) return jsonRes({ error: 'nope' }, opts.describeStatus);
      return jsonRes(INDEX);
    }
    if (u.endsWith('/describe_index_stats')) {
      return jsonRes(opts.stats ?? { namespaces: { '': { recordCount: 2 }, hr: { recordCount: 3 } }, totalRecordCount: 5 });
    }
    if (u.includes('/records/namespaces/') && u.endsWith('/search')) {
      return jsonRes({ result: { hits: opts.hits ?? [{ _id: 'r1', _score: 0.9, fields: { chunk_text: 'hello' } }] } });
    }
    if (u.includes('/records/namespaces/') && u.endsWith('/upsert')) return jsonRes(undefined, 201);
    if (u.endsWith('/rerank')) return jsonRes({ model: 'cohere-rerank-3.5', data: [{ index: 0, score: 0.5 }] });
    return jsonRes({}, 404);
  }) as any;
  return calls;
}

describe('REST data plane: Pinecone handlers', () => {
  const app = createWebOnlyApp();
  const realFetch = globalThis.fetch;
  let apiKey: string;
  let rulesApiKey: string;
  let readOnlyApiKey: string;

  before(async () => {
    await createMcpCatalog({
      slug: 'pinecone', name: 'Pinecone MCP', description: 'test',
      iconUrl: '', mcpUrl: '/pinecone', provider: 'pinecone', scopes: [],
      googleClientId: null, googleClientSecret: null, oauthScopes: [],
      isLocal: true, isActive: true,
    });

    // Three accounts: no rules, index/namespace rules, and read-only. The
    // denial paths need connections that actually carry those rules.
    await createOrUpdateUser({ email: 'pc-open@example.com', googleId: 'google-pc-open', name: 'PC Open' }, dummyTokens);
    const open = await getUserByGoogleId('google-pc-open');
    apiKey = (open as any).apiKey;
    await createMcpInstance((open as any).id, 'pinecone', 'PC Open', emptyGoogleTokens, null,
      'pinecone', { access_token: 'pcsk_k' } as any, null);

    await createOrUpdateUser({ email: 'pc-rules@example.com', googleId: 'google-pc-rules', name: 'PC Rules' }, dummyTokens);
    const restricted = await getUserByGoogleId('google-pc-rules');
    rulesApiKey = (restricted as any).apiKey;
    await createMcpInstance((restricted as any).id, 'pinecone', 'PC Rules', emptyGoogleTokens, null,
      'pinecone',
      { access_token: 'pcsk_k', accessRules: { allowedIndexes: ['docs'], allowedNamespaces: ['hr'] } } as any, null);

    await createOrUpdateUser({ email: 'pc-ro@example.com', googleId: 'google-pc-ro', name: 'PC RO' }, dummyTokens);
    const ro = await getUserByGoogleId('google-pc-ro');
    readOnlyApiKey = (ro as any).apiKey;
    await createMcpInstance((ro as any).id, 'pinecone', 'PC ReadOnly', emptyGoogleTokens, null,
      'pinecone', { access_token: 'pcsk_k', accessRules: { readOnly: true } } as any, null);
  });

  after(() => { globalThis.fetch = realFetch; });

  const get = (path: string, key = apiKey) => request(app).get(path).set('Authorization', `Bearer ${key}`);
  const post = (path: string, body: unknown = {}, key = apiKey) =>
    request(app).post(path).set('Authorization', `Bearer ${key}`).send(body as any);

  // ---- reads ----

  it('lists indexes and reports hiddenByRules explicitly', async () => {
    mockPinecone();
    clearPineconeIndexCache();
    const res = await get('/api/v1/pinecone/indexes');
    assert.equal(res.status, 200);
    assert.equal(res.body.indexes.length, 1);
    assert.equal(res.body.hiddenByRules, 0);
  });

  it('sends the required API-version header on every call', async () => {
    const calls = mockPinecone();
    clearPineconeIndexCache();
    await get('/api/v1/pinecone/indexes');
    // Omitting it is a rejection upstream, not a default-to-latest.
    assert.ok(calls[0].headers['X-Pinecone-Api-Version'], 'version header missing');
    assert.equal(calls[0].headers['Api-Key'], 'pcsk_k');
  });

  it('renders ?format=text with the same formatter the MCP tool uses', async () => {
    mockPinecone();
    clearPineconeIndexCache();
    const res = await get('/api/v1/pinecone/indexes?format=text');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/plain/);
    assert.match(res.text, /index\(es\)/);
  });

  it('describes an index and names the kind', async () => {
    mockPinecone();
    clearPineconeIndexCache();
    const res = await get('/api/v1/pinecone/indexes/docs');
    assert.equal(res.status, 200);
    assert.equal(res.body.kind, 'legacy-integrated');
    assert.equal(res.body.textField, 'chunk_text');
  });

  it('reaches the per-index DATA host for stats, not the control plane', async () => {
    const calls = mockPinecone();
    clearPineconeIndexCache();
    const res = await get('/api/v1/pinecone/indexes/docs/stats');
    assert.equal(res.status, 200);
    const statsCall = calls.find(c => c.url.endsWith('/describe_index_stats'));
    assert.ok(statsCall, 'no stats call was made');
    assert.match(statsCall.url, /^https:\/\/docs-abc\.svc\.us-east1-gcp\.pinecone\.io\//);
  });

  it('answers an upstream 404 as 404, not a flat 500', async () => {
    mockPinecone({ describeStatus: 404 });
    clearPineconeIndexCache();
    const res = await get('/api/v1/pinecone/indexes/missing');
    assert.equal(res.status, 404);
  });

  // ---- search is a POST, and the namespace is in the body ----

  it('searches with the index from the path and the namespace from the body', async () => {
    const calls = mockPinecone();
    clearPineconeIndexCache();
    const res = await post('/api/v1/pinecone/indexes/docs/search', {
      namespace: 'hr', query: { topK: 3, inputs: { text: 'vacation' } },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.hits.length, 1);
    const search = calls.find(c => c.url.endsWith('/search'));
    assert.match(search!.url, /\/records\/namespaces\/hr\/search$/);
    // camelCase in, snake_case out — the translation the SDK would have done.
    assert.equal(search!.body.query.top_k, 3);
  });

  it('addresses the DEFAULT namespace, which only works because it is in the body', async () => {
    const calls = mockPinecone();
    clearPineconeIndexCache();
    const res = await post('/api/v1/pinecone/indexes/docs/search', {
      namespace: '', query: { topK: 1, inputs: { text: 'q' } },
    });
    assert.equal(res.status, 200);
    const search = calls.find(c => c.url.endsWith('/search'));
    // The empty path segment is correct for the default namespace.
    assert.match(search!.url, /\/records\/namespaces\/\/search$/);
  });

  it('400s a malformed search body with the schema issues', async () => {
    mockPinecone();
    const res = await post('/api/v1/pinecone/indexes/docs/search', { namespace: 'hr' });
    assert.equal(res.status, 400);
    assert.ok(res.body.issues, 'the flattened Zod issues should be returned');
  });

  it('reranks documents the caller supplied, touching no index', async () => {
    const calls = mockPinecone();
    const res = await post('/api/v1/pinecone/rerank', {
      model: 'cohere-rerank-3.5', query: 'q', documents: ['a', 'b'],
    });
    assert.equal(res.status, 200);
    assert.ok(calls.every(c => !c.url.includes('/indexes')), 'rerank must not touch an index');
  });

  // ---- access rules on this plane ----

  it('403s an index the connection rules deny, naming the rule', async () => {
    mockPinecone();
    clearPineconeIndexCache();
    const res = await get('/api/v1/pinecone/indexes/secret', rulesApiKey);
    assert.equal(res.status, 403);
    assert.match(res.body.error, /allowed-indexes list/);
  });

  it('403s a namespace the connection rules deny', async () => {
    mockPinecone();
    clearPineconeIndexCache();
    const res = await post('/api/v1/pinecone/indexes/docs/search',
      { namespace: 'finance', query: { topK: 1, inputs: { text: 'q' } } }, rulesApiKey);
    assert.equal(res.status, 403);
    assert.match(res.body.error, /allowed-namespaces list/);
  });

  it('403s a write on a READ-ONLY connection — the whole point of exposing this plane carefully', async () => {
    mockPinecone();
    clearPineconeIndexCache();
    const res = await post('/api/v1/pinecone/indexes/docs/upsert',
      { namespace: 'hr', records: [{ _id: 'a', chunk_text: 'x' }] }, readOnlyApiKey);
    assert.equal(res.status, 403);
    assert.match(res.body.error, /read-only/);
  });

  it('still allows a READ on a read-only connection', async () => {
    mockPinecone();
    clearPineconeIndexCache();
    assert.equal((await get('/api/v1/pinecone/indexes', readOnlyApiKey)).status, 200);
  });

  // ---- writes ----

  it('upserts, reporting accepted rather than indexed', async () => {
    const calls = mockPinecone();
    clearPineconeIndexCache();
    const res = await post('/api/v1/pinecone/indexes/docs/upsert', {
      namespace: 'hr', records: [{ _id: 'a', chunk_text: 'hello' }, { _id: 'b', chunk_text: 'world' }],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.accepted, 2);
    assert.equal(res.body.textField, 'chunk_text');

    const upsert = calls.find(c => c.url.endsWith('/upsert'));
    // NDJSON, not a JSON array — application/json yields a 400 that reads
    // like a schema error.
    assert.equal(upsert!.headers['Content-Type'], 'application/x-ndjson');
    assert.equal(String(upsert!.body).trimEnd().split('\n').length, 2);
  });

  it('refuses a record missing the index text field, sending nothing', async () => {
    const calls = mockPinecone();
    clearPineconeIndexCache();
    const res = await post('/api/v1/pinecone/indexes/docs/upsert', {
      namespace: 'hr', records: [{ _id: 'a', text: 'wrong field name' }],
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /chunk_text/);
    assert.ok(!calls.some(c => c.url.endsWith('/upsert')), 'nothing should have been sent');
  });

  it('refuses a batch over the 1000-record cap at the schema, before any call', async () => {
    const calls = mockPinecone();
    clearPineconeIndexCache();
    const records = Array.from({ length: 1001 }, (_, i) => ({ _id: `r${i}`, chunk_text: 'x' }));
    const res = await post('/api/v1/pinecone/indexes/docs/upsert', { namespace: 'hr', records });
    assert.equal(res.status, 400);
    assert.ok(!calls.some(c => c.url.endsWith('/upsert')));
  });

  it('creates an index with 201, and answers 200 when it already existed', async () => {
    mockPinecone({ indexes: [] });
    clearPineconeIndexCache();
    const body = { name: 'fresh', embed: { model: 'multilingual-e5-large', fieldMap: { text: 'chunk_text' } } };
    const created = await post('/api/v1/pinecone/indexes', body);
    assert.equal(created.status, 201);
    assert.equal(created.body.created, true);

    mockPinecone({ indexes: [{ ...INDEX, name: 'fresh' }] });
    clearPineconeIndexCache();
    const again = await post('/api/v1/pinecone/indexes', body);
    // 200, not 201: nothing was created, and a 201 would claim otherwise.
    assert.equal(again.status, 200);
    assert.equal(again.body.created, false);
  });
});
