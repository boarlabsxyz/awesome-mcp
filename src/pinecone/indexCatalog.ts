// src/pinecone/indexCatalog.ts
// Resolve an index name to the two facts every data-plane call needs: its
// `host`, and what kind of index it is.
//
// Both come from one GET /indexes/{name}, so this is where that call is made
// and cached. Kept out of apiHelpers.ts (stateless transport) and out of
// indexKind.ts (pure classifier) for the reason src/slack-user/teamNames.ts
// states: a stateful TTL cache does not belong in either.
//
// ---------------------------------------------------------------------------
// WHY A CACHE IS ALLOWED HERE WHEN src/util/mcpProxyClient.ts REFUSES ONE.
//
// That module refuses to cache an Mcp-Session-Id because that value is
// REPLICA-AFFINE: it names state held by one upstream transport, so a sibling
// replica serving the next call holds no such session and the cache would
// manufacture the exact failure it was meant to avoid.
//
// `host` and `kind` are the opposite. They are properties of the INDEX, not of
// a connection, a transport or a replica. Every replica that computes them
// computes the same values, so N replicas cost at most N cold describes per
// TTL window and can never disagree. The two rulings are consistent; they are
// about different kinds of fact.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

import { UserError } from 'fastmcp';

import type { PineconeClient, PineconeIndexSummary } from './apiHelpers.js';
import { type IndexKindVerdict, classifyIndex } from './indexKind.js';

/**
 * Ten minutes, POSITIVE ONLY.
 *
 * `host` is assigned at index creation and does not change; `kind` cannot
 * change at all, since an index cannot be converted between types. The only
 * thing that goes stale is EXISTENCE, and a deleted index's cached host
 * degrades to a data-plane error that is reported as "may have been deleted"
 * — a clear wrong answer rather than a quiet one.
 */
const INDEX_TTL_MS = 10 * 60 * 1000;

/** Bounded the same way the Slack caches are. */
const INDEX_CACHE_MAX = 500;

export interface ResolvedIndex {
  name: string;
  host: string;
  ready: boolean;
  verdict: IndexKindVerdict;
  /** The describe payload, so a caller that wants to render it need not re-fetch. */
  raw: PineconeIndexSummary;
}

const indexCache = new Map<string, { value: ResolvedIndex; expiresAt: number }>();

/** Test seam. Nothing in the request path calls this. */
export function clearPineconeIndexCache(): void {
  indexCache.clear();
}

/**
 * Keyed by a HASH of the API key, never the key itself.
 *
 * A Map key holding a live credential ends up in every heap dump, and in any
 * future debug dump of this cache. Keyed by credential rather than by
 * instanceId so the MCP tools and a future REST plane share entries
 * legitimately — they are the same facts read with the same key.
 */
function cacheKey(apiKey: string, indexName: string): string {
  return `${createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}:${indexName.toLowerCase()}`;
}

function prune(now: number): void {
  for (const [key, entry] of indexCache) {
    if (entry.expiresAt <= now) indexCache.delete(key);
  }
  // Still oversized after dropping expired entries — evict oldest-inserted.
  // Map preserves insertion order, so the first keys are the stalest.
  if (indexCache.size > INDEX_CACHE_MAX) {
    const excess = indexCache.size - INDEX_CACHE_MAX;
    let dropped = 0;
    for (const key of indexCache.keys()) {
      indexCache.delete(key);
      if (++dropped >= excess) break;
    }
  }
}

/**
 * Turn a describe payload into a ResolvedIndex, or explain why it cannot be one.
 *
 * An index with no `host` is not an error to pass through: it is what an index
 * still building looks like, and "Cannot read properties of undefined" is not
 * an answer to that.
 */
export function toResolvedIndex(name: string, payload: PineconeIndexSummary): ResolvedIndex {
  const ready = payload?.status?.ready === true;
  const host = typeof payload?.host === 'string' ? payload.host.trim() : '';
  if (!host) {
    const state = payload?.status?.state ? ` (state: ${payload.status.state})` : '';
    throw new UserError(
      `Index "${name}" has no host yet${state}, so it cannot serve searches or upserts. ` +
        `A newly created index takes a few seconds to come up — call describe-index until status.ready is true.`,
    );
  }
  return { name, host, ready, verdict: classifyIndex(payload), raw: payload };
}

function remember(apiKey: string, resolved: ResolvedIndex): void {
  // NOT cached when the index is not ready: an initializing index has a host
  // that does not serve yet, and pinning that for ten minutes converts a
  // two-second wait into a ten-minute outage.
  if (!resolved.ready) return;
  indexCache.set(cacheKey(apiKey, resolved.name), { value: resolved, expiresAt: Date.now() + INDEX_TTL_MS });
  prune(Date.now());
}

/**
 * Seed the cache from a payload we already hold.
 *
 * create-index-for-model calls this with its own response, which is what
 * removes the need for negative caching: create-then-upsert is the obvious
 * sequence, and a cached miss would make it fail for minutes.
 */
export function primeIndexCache(apiKey: string, name: string, payload: PineconeIndexSummary): void {
  try {
    remember(apiKey, toResolvedIndex(name, payload));
  } catch {
    // A payload with no host yet is simply not cacheable. Priming is an
    // optimisation; failing it must never fail the create that succeeded.
  }
}

/**
 * Resolve one index, from cache when warm.
 *
 * There is deliberately NO negative caching. The failure modes it would cover
 * (a typo'd name) are cheap to re-ask, while the one it would break
 * (create-then-use) is the common path.
 */
export async function resolveIndex(client: PineconeClient, apiKey: string, name: string): Promise<ResolvedIndex> {
  const key = cacheKey(apiKey, name);
  const hit = indexCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const payload = await client.describeIndex(name);
  const resolved = toResolvedIndex(name, payload);
  remember(apiKey, resolved);
  return resolved;
}

/**
 * Resolve several at once, de-duplicated. Used by cascading-search.
 *
 * Settled rather than `Promise.all`, for one reason: **the failure has to name
 * the index**. `Promise.all` rejects with whichever describe lost the race,
 * and that error has no index name on it — a cascading call naming four
 * indexes, one of them typo'd, answered "Pinecone has no index by that name in
 * this key's project" without ever saying WHICH name, which is the one fact
 * needed to fix it. It also hid the second failure entirely.
 *
 * Every name is therefore resolved, every failure is collected, and the
 * message lists each unresolvable index with its own reason — a 404 and an
 * index that is still building are different problems with different fixes.
 */
export async function resolveIndexes(
  client: PineconeClient,
  apiKey: string,
  names: readonly string[],
): Promise<Map<string, ResolvedIndex>> {
  const unique = [...new Set(names)];
  const settled = await Promise.allSettled(unique.map(n => resolveIndex(client, apiKey, n)));

  const resolved = new Map<string, ResolvedIndex>();
  const failures: Array<{ name: string; reason: string }> = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === 'fulfilled') resolved.set(unique[i], outcome.value);
    else failures.push({ name: unique[i], reason: describeResolveFailure(outcome.reason) });
  });

  if (failures.length) {
    const lines = failures.map(f => `  - "${f.name}": ${f.reason}`).join('\n');
    const ok = [...resolved.keys()];
    throw new UserError(
      `${failures.length} of the ${unique.length} index(es) named could not be resolved, so nothing was searched:\n${lines}` +
        (ok.length ? `\n\nThese resolved fine: ${ok.map(n => `"${n}"`).join(', ')}.` : '') +
        `\n\nRun list-indexes to see the index names this connection can reach. An index in another Pinecone project is invisible to this API key rather than listed.`,
    );
  }
  return resolved;
}

/**
 * Why one index would not resolve, in the terms that distinguish the causes.
 *
 * A 404 and a 403 mean different things here and a reader cannot tell them
 * apart from a status alone: a key is scoped to ONE project, so an index that
 * exists in another project reads as forbidden rather than missing.
 */
function describeResolveFailure(error: any): string {
  if (error instanceof UserError) return error.message;
  const status: number | undefined = error?.status;
  if (status === 404) return 'no index by that name exists in this API key\'s project (check the spelling with list-indexes)';
  if (status === 403) {
    return 'Pinecone refused access to it — an API key is scoped to one project, so an index in a different project reads as forbidden rather than missing';
  }
  if (status === 401) return 'Pinecone rejected the API key; reconnect from the dashboard';
  if (status === undefined) return `could not reach the Pinecone API (${error?.message ?? 'network error'})`;
  return `Pinecone answered ${status}${error?.message ? ` (${error.message})` : ''}`;
}

/**
 * Drop a cached entry so the next call re-resolves it.
 *
 * Called when a data-plane request against a cached host answers 404/403/410,
 * which is what a deleted or recreated index looks like from down there. The
 * caller retries EXACTLY ONCE — a retry loop against a genuinely dead index is
 * worse than the error.
 */
export function forgetIndex(apiKey: string, name: string): void {
  indexCache.delete(cacheKey(apiKey, name));
}

/** Does this status mean "the host we had is no longer the right one"? */
export function isStaleHostStatus(status: unknown): boolean {
  return status === 404 || status === 403 || status === 410;
}

/**
 * Run a data-plane call, re-resolving once if the cached host turns out stale.
 *
 * The single retry is the whole contract: it covers an index that was deleted
 * and recreated (new host, same name) without turning a genuinely missing
 * index into a loop.
 */
export async function withResolvedIndex<T>(
  client: PineconeClient,
  apiKey: string,
  name: string,
  fn: (resolved: ResolvedIndex) => Promise<T>,
): Promise<T> {
  const resolved = await resolveIndex(client, apiKey, name);
  try {
    return await fn(resolved);
  } catch (error: any) {
    if (error instanceof UserError || !isStaleHostStatus(error?.status)) throw error;
    forgetIndex(apiKey, name);
    const fresh = await resolveIndex(client, apiKey, name);
    if (fresh.host === resolved.host) throw error;
    return fn(fresh);
  }
}
