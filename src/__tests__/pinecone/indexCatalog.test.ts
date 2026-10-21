import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { UserError } from 'fastmcp';

import type { PineconeClient } from '../../pinecone/apiHelpers.js';
import {
  clearPineconeIndexCache,
  forgetIndex,
  isStaleHostStatus,
  primeIndexCache,
  resolveIndex,
  resolveIndexes,
  toResolvedIndex,
  withResolvedIndex,
} from '../../pinecone/indexCatalog.js';

const KEY = 'pcsk_test_key';

function readyPayload(name: string, host = `${name}-abc123.svc.us-east1-gcp.pinecone.io`) {
  return {
    name,
    host,
    status: { ready: true, state: 'Ready' },
    schema: { fields: { chunk_text: { type: 'semantic_text' } } },
    embed: { model: 'multilingual-e5-large', field_map: { text: 'chunk_text' } },
  };
}

/** A client stub that only answers describeIndex, and counts the calls. */
function stubClient(payloads: Record<string, any>): PineconeClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async describeIndex(name: string) {
      calls.push(name);
      const p = payloads[name];
      if (!p) {
        const err: any = new Error('not found');
        err.status = 404;
        throw err;
      }
      return p;
    },
  } as any;
}

beforeEach(() => clearPineconeIndexCache());

describe('toResolvedIndex', () => {
  it('classifies and carries the host', () => {
    const r = toResolvedIndex('docs', readyPayload('docs') as any);
    assert.equal(r.host, 'docs-abc123.svc.us-east1-gcp.pinecone.io');
    assert.equal(r.ready, true);
    assert.equal(r.verdict.kind, 'legacy-integrated');
  });

  it('explains a missing host rather than throwing a property error', () => {
    // This is what an index still building looks like; "Cannot read properties
    // of undefined" is not an answer to it.
    try {
      toResolvedIndex('new', { name: 'new', status: { ready: false, state: 'Initializing' } } as any);
      assert.fail('expected a UserError');
    } catch (err: any) {
      assert.ok(err instanceof UserError);
      assert.match(err.message, /no host yet/);
      assert.match(err.message, /Initializing/);
    }
  });
});

describe('resolveIndex caching', () => {
  it('describes once and serves the rest from cache', async () => {
    const client = stubClient({ docs: readyPayload('docs') });
    await resolveIndex(client, KEY, 'docs');
    await resolveIndex(client, KEY, 'docs');
    await resolveIndex(client, KEY, 'docs');
    assert.deepEqual(client.calls, ['docs']);
  });

  it('scopes the cache by API key, so two connections cannot share an entry', async () => {
    const client = stubClient({ docs: readyPayload('docs') });
    await resolveIndex(client, KEY, 'docs');
    await resolveIndex(client, 'pcsk_other_key', 'docs');
    assert.deepEqual(client.calls, ['docs', 'docs']);
  });

  it('does NOT cache an index that is not ready', async () => {
    // Pinning a host that does not serve yet would turn a two-second wait into
    // a ten-minute outage.
    const notReady = { ...readyPayload('new'), status: { ready: false, state: 'Initializing' } };
    const client = stubClient({ new: notReady });
    await resolveIndex(client, KEY, 'new');
    await resolveIndex(client, KEY, 'new');
    assert.deepEqual(client.calls, ['new', 'new']);
  });

  it('does NOT cache a miss — create-then-use must not be blocked for minutes', async () => {
    const client = stubClient({});
    await assert.rejects(() => resolveIndex(client, KEY, 'later'));
    await assert.rejects(() => resolveIndex(client, KEY, 'later'));
    assert.deepEqual(client.calls, ['later', 'later']);
  });
});

describe('primeIndexCache', () => {
  it('lets a create-then-use sequence skip the describe entirely', async () => {
    const client = stubClient({ fresh: readyPayload('fresh') });
    primeIndexCache(KEY, 'fresh', readyPayload('fresh') as any);
    await resolveIndex(client, KEY, 'fresh');
    assert.deepEqual(client.calls, []);
  });

  it('never throws when the payload has no host — priming is an optimisation', () => {
    assert.doesNotThrow(() => primeIndexCache(KEY, 'building', { name: 'building' } as any));
  });
});

describe('resolveIndexes', () => {
  it('de-duplicates the names it is given', async () => {
    const client = stubClient({ a: readyPayload('a'), b: readyPayload('b') });
    const map = await resolveIndexes(client, KEY, ['a', 'b', 'a']);
    assert.deepEqual(client.calls.sort(), ['a', 'b']);
    assert.equal(map.size, 2);
  });
});

describe('isStaleHostStatus', () => {
  it('treats 404/403/410 as "the cached host is no longer right"', () => {
    assert.equal(isStaleHostStatus(404), true);
    assert.equal(isStaleHostStatus(403), true);
    assert.equal(isStaleHostStatus(410), true);
    assert.equal(isStaleHostStatus(500), false);
    assert.equal(isStaleHostStatus(undefined), false);
  });
});

describe('withResolvedIndex', () => {
  it('re-resolves exactly once when a cached host turns out stale', async () => {
    let payload = readyPayload('docs', 'old-host.svc.pinecone.io');
    const client = {
      calls: [] as string[],
      async describeIndex(name: string) {
        client.calls.push(name);
        return payload;
      },
    } as any;

    await resolveIndex(client, KEY, 'docs'); // warm the cache with the old host

    payload = readyPayload('docs', 'new-host.svc.pinecone.io');
    const seen: string[] = [];
    const out = await withResolvedIndex(client, KEY, 'docs', async resolved => {
      seen.push(resolved.host);
      if (resolved.host === 'old-host.svc.pinecone.io') {
        const err: any = new Error('gone');
        err.status = 404;
        throw err;
      }
      return 'ok';
    });

    assert.equal(out, 'ok');
    assert.deepEqual(seen, ['old-host.svc.pinecone.io', 'new-host.svc.pinecone.io']);
  });

  it('gives up rather than looping when the host has not changed', async () => {
    const client = stubClient({ docs: readyPayload('docs') });
    let attempts = 0;
    await assert.rejects(() =>
      withResolvedIndex(client, KEY, 'docs', async () => {
        attempts += 1;
        const err: any = new Error('gone');
        err.status = 404;
        throw err;
      }),
    );
    // One attempt, one re-resolve, same host -> rethrow. Never a loop.
    assert.equal(attempts, 1);
  });

  it('does not retry a non-stale status', async () => {
    const client = stubClient({ docs: readyPayload('docs') });
    let attempts = 0;
    await assert.rejects(() =>
      withResolvedIndex(client, KEY, 'docs', async () => {
        attempts += 1;
        const err: any = new Error('boom');
        err.status = 500;
        throw err;
      }),
    );
    assert.equal(attempts, 1);
  });
});

describe('forgetIndex', () => {
  it('makes the next resolve go back to the API', async () => {
    const client = stubClient({ docs: readyPayload('docs') });
    await resolveIndex(client, KEY, 'docs');
    forgetIndex(KEY, 'docs');
    await resolveIndex(client, KEY, 'docs');
    assert.deepEqual(client.calls, ['docs', 'docs']);
  });
});

describe('resolveIndexes names the index that failed', () => {
  it('lists every unresolvable name with its own reason', async () => {
    // Promise.all rejected with whichever describe lost the race, and that
    // error carries no index name at all — so a cascading call naming four
    // indexes, one typo'd, reported "no index by that name" without saying
    // which, and hid any second failure entirely.
    const client: any = {
      async describeIndex(name: string) {
        if (name === 'good') return { name, host: 'good.svc.pinecone.io', status: { ready: true } };
        const e: any = new Error('nope');
        e.status = name === 'forbidden' ? 403 : 404;
        throw e;
      },
    };
    await assert.rejects(
      () => resolveIndexes(client, 'k', ['good', 'missing', 'forbidden']),
      (err: Error) => {
        assert.match(err.message, /2 of the 3 index\(es\) named could not be resolved/);
        assert.match(err.message, /- "missing": no index by that name exists/);
        assert.match(err.message, /- "forbidden": Pinecone refused access to it/);
        assert.match(err.message, /scoped to one project/);
        assert.match(err.message, /These resolved fine: "good"/);
        return true;
      },
    );
  });

  it('de-duplicates names before describing them', async () => {
    const seen: string[] = [];
    const client: any = {
      async describeIndex(name: string) {
        seen.push(name);
        return { name, host: `${name}.svc.pinecone.io`, status: { ready: true } };
      },
    };
    const map = await resolveIndexes(client, 'k2', ['a', 'a', 'b']);
    assert.deepEqual(seen.sort(), ['a', 'b']);
    assert.deepEqual([...map.keys()], ['a', 'b']);
  });

  it('keeps a UserError verbatim — an index with no host yet is its own message', async () => {
    const client: any = {
      async describeIndex(name: string) {
        return { name, status: { ready: false, state: 'Initializing' } };
      },
    };
    await assert.rejects(() => resolveIndexes(client, 'k3', ['building']), /has no host yet/);
  });
});
