# Pinecone — notes for Claude

## Rules and limitations

### API surface
- **Reimplements Pinecone's Developer MCP over Pinecone's REST API** — the upstream server is STDIO-only (the remote Assistant MCP serves no indexes). The 9 tools keep `pinecone-io/pinecone-mcp`'s names and shapes, except `llm_provider`/`llm_model`, which are deliberately not ported. Spec: `https://docs.pinecone.io/llms.txt` → `pinecone-api@main/2026-07/*.oas.yaml`, read raw.
- **`X-Pinecone-Api-Version` is required on every call** — omitting it is rejected. Pinned in `apiHelpers.ts`, not env: it changes the `schema.fields` shape the classifier reads.
- **Data plane is a per-index host** (`https://{index.host}/…`), learnable only via `GET /indexes/{name}`. `indexCatalog.ts` caches host+kind for 10 min (index properties, unlike `mcpProxyClient`'s uncached sessions).
- **Upsert body is `application/x-ndjson`**, max 1000 records / 2 MB; `application/json` 400s like a schema error.
- **The Records API is labelled LEGACY in 2026-07** — `create-for-model` and `/records/namespaces/{ns}/{search,upsert}` still work (not `deprecated: true`), but Pinecone points new work at the Documents API (`/namespaces/{ns}/documents/*`), deliberately not called. Re-check before extending.
- **Index kind is classified from `schema.fields`** (`indexKind.ts`): `semantic_text` = legacy integrated (supported, tested first so it is never misclassified); `string` with `embed`/`sparse_embed` = document index (refused); only `_values`/`_sparse_values` = vectors index (refused). Refusals name the evidence and the right API. **`unknown` proceeds** — failing closed would break on Pinecone's next schema change.
- **`upsert-records` refuses >1000 records rather than chunking** — the upsert is not atomic across the NDJSON body, so chunking could leave a partial write. The per-record `_id` and `field_map` text-field check runs locally before any byte is sent.
- **Never report upserts as "indexed"** — 201 with empty body, embedding is async.
- **A 403 from `/rerank` is about the model** (`cohere-rerank-*` is plan-gated), not the key or an index.
- **`search-docs` sends no credential** — proxies the public docs MCP at `prod-1-data.ke.pinecone.io` (tool `get_context`); works when the connection is broken.
- **Hidden behind `PINECONE_ENABLED`** — strict `=== 'true'`; restart, not deploy.

### Namespaces
- **The default namespace is `__default__`, not `""`** — Pinecone requires 1–512 chars and 400s on `""`. `wireNamespace` (single wire boundary in `apiHelpers.ts`) translates `""` → `__default__` for every surface; `""` stays accepted (shipped docs told callers to use it), so descriptions must not say it is rejected.
- **Access rules canonicalise via `canonicalNamespace`** so rules already saved as `""` still match; `toNamespaceList` must not drop that entry (unlike the domain-rules `toList`), or the user's checkbox un-ticks.

### Access rules (`accessRules.ts`)
- **A real boundary for the tools, not a guardrail** — every data tool names its index and namespace, so rules bind all nine. They do not limit the API key itself.
- **`getRules` returns `{loaded | unavailable}`, not `rules | undefined`** — index/namespace rules fail **open** (default is unrestricted), but `assertWriteAllowed` fails **closed** (a DB blip must not un-flip read-only; the message says it is temporary). Both write tools call `assertWriteAllowed` as their **first statement**; `PINECONE_WRITE_TOOLS` is exported so a test catches a new write tool without it.
- **Matching:** index names exact and lowercased (no suffix match — `prod` must not match `not-prod`); namespaces exact and **case-sensitive**.
- **`cascading-search` refuses the whole call if any target is denied** — a partial fused ranking cannot be labelled honestly.
- **`list-indexes` hides denied rows but says they exist; `describe-index` answers a hidden name with the denial, not a 404** (decided from rules before any API call; leaks nothing).
- **`create-index-for-model` takes the ordinary index assert** — add the name to the allowlist first. `rerank-documents` and `search-docs` are exempt (no index).

### Search results
- **An unreadable answer must never count as "found nothing"** — `jsonApiRequest` returns `undefined` for 204 or any non-JSON 2xx. `readSearchHits` (shared MCP/REST `searchOne`) accepts only `result` with a `hits` array (`hits: []` is a real zero), else throws naming what arrived. Never reintroduce `?? []`.
- **Cascading reports per-target contribution** (`Per-target contribution:` hits/kept/duplicates); an empty target is named with its possible causes; a failed target is `NOT SEARCHED` under `PARTIAL RESULT`. REST: `targets[]`, `emptyTargets[]`. "Reached none" throws only when **every** target failed.
- **Cascading dedup key is `(index, namespace, _id)`**, never `_id` alone (ids are unique only per namespace). Rows carry `_index`/`_namespace`; output is a numbered list, not the raw rerank payload.
- **`resolveIndexes` uses `allSettled`** and names each unresolvable index with its reason (404 vs 403 = index in another project).
- **`rerank.topN` above the actual candidate pool is reported**, naming `query.topK`; no `topN <= topK` rule is enforced, so descriptions must not claim one.
- **`formatScore`**: 4 decimals at ≥ 0.001, 3-significant-digit exponential below, exact zero as `0` (rerank tails are ~1e-5).
- **`create-index-for-model` warns (never refuses) when an existing index's model or field differs** — neither can change after creation. REST: `configDrift[]`.

### REST plane (`/api/v1/pinecone/*`)
- **7 reads + 2 writes from `restRoutes.ts`, validated with the tools' Zod schemas and the same `perform*` guards, including `assertWriteAllowed`** — the permanent dashboard API key works here, so read-only must refuse curl too.
- **Status:** rules denial 403 naming the rule; connector-decided refusals (index kind, missing text field, over cap) 400.
- **`search-records`/`cascading-search` are POSTs** (filter + rerank bodies). **Namespace is always in the body, never the path** — moving it breaks callers.
- **`upsert-records` exposed with explicit sign-off**; `/api/v1/pinecone/indexes` is in `REST_LARGE_BODY_PREFIXES` (5 MB). Answers `accepted`, never `indexed`. `create-index-for-model` answers 200 `created: false` if it already existed.
- **`public/openapi-pinecone.json` is generated from the Zod schemas** — don't hand-edit.

## Source Files

| File | Contains |
|------|----------|
| `src/pinecone/server.ts` | The 9 tools |
| `src/pinecone/apiHelpers.ts` | `PineconeClient` (control/inference at `api.pinecone.io` + per-index host), `wireNamespace`, `readSearchHits` |
| `src/pinecone/indexKind.ts` | Pure classifier, refusals, per-record checks, capped NDJSON builder |
| `src/pinecone/indexCatalog.ts` | Host/kind TTL cache and `resolveIndex` |
| `src/pinecone/accessRules.ts` | Index/namespace allow-deny + read-only switch |
| `src/pinecone/docsProxy.ts` | `search-docs` via the shared MCP proxy client, no credential |
| `src/pinecone/restRoutes.ts` | REST descriptors, looped in `webServer.ts` |
| `src/pinecone/restOps.ts` | `perform*` per route (data), same asserts |
