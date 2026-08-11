import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { UserError } from 'fastmcp';
import {
  fetchImageBytes,
  getDocImage,
  __setDocImagePoolForTests,
} from '../../clickup/docImageStore.js';

// ---------------------------------------------------------------------------
// fetch mock: a queue of response specs, one dequeued per fetch() call, so we
// can exercise the manual redirect loop. fetchImageBytes returns raw bytes only
// (format validation / WebP / size cap live in the storage module now), so these
// tests assert the safe-outbound-fetch behaviour: SSRF, timeout, size, redirects.
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

interface RespSpec {
  status: number;
  headers?: Record<string, string>;
  bytes?: Uint8Array;
  noBody?: boolean;
  readError?: any;
  throwError?: any; // makes fetch() itself reject
}

function makeResponse(spec: RespSpec) {
  const headers = spec.headers || {};
  let read = false;
  const body = spec.noBody
    ? null
    : {
        getReader: () => ({
          read: async () => {
            if (spec.readError) throw spec.readError;
            if (!read) {
              read = true;
              return { done: false, value: spec.bytes ?? new Uint8Array(0) };
            }
            return { done: true, value: undefined };
          },
          cancel: async () => {},
          releaseLock: () => {},
        }),
        cancel: async () => {},
      };
  return {
    ok: spec.status >= 200 && spec.status < 300,
    status: spec.status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    body,
  };
}

function mockFetchQueue(specs: RespSpec[]) {
  let i = 0;
  const urls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    urls.push(String(input));
    const spec = specs[i] || specs[specs.length - 1];
    i++;
    if (spec.throwError) throw spec.throwError;
    return makeResponse(spec) as any;
  }) as any;
  return { urls };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const PNG = new TextEncoder().encode('PNG_BYTES');

describe('fetchImageBytes', () => {
  it('returns the fetched bytes as a Buffer', async () => {
    mockFetchQueue([{ status: 200, headers: { 'content-type': 'image/png' }, bytes: PNG }]);
    const bytes = await fetchImageBytes('https://example.com/pic.png');
    assert.ok(Buffer.isBuffer(bytes));
    assert.equal(bytes.toString(), 'PNG_BYTES');
  });

  it('does not inspect Content-Type (validation is the storage module\'s job)', async () => {
    // A body the server labels text/html still comes back as bytes here — the
    // storage module rejects non-images via magic bytes, not this fetch.
    mockFetchQueue([{ status: 200, headers: { 'content-type': 'text/html' }, bytes: PNG }]);
    const bytes = await fetchImageBytes('https://example.com/page');
    assert.equal(bytes.toString(), 'PNG_BYTES');
  });

  it('rejects a non-OK status', async () => {
    mockFetchQueue([{ status: 404, headers: {}, bytes: new Uint8Array(0) }]);
    await assert.rejects(
      () => fetchImageBytes('https://example.com/missing.png'),
      (e: any) => { assert.match(e.message, /Failed to fetch image from URL \(404\)/); return true; },
    );
  });

  it('rejects when Content-Length exceeds the max', async () => {
    mockFetchQueue([{ status: 200, headers: { 'content-type': 'image/png', 'content-length': String(21 * 1024 * 1024) }, bytes: PNG }]);
    await assert.rejects(
      () => fetchImageBytes('https://example.com/big.png'),
      (e: any) => { assert.match(e.message, /Image too large/); return true; },
    );
  });

  it('rejects when the streamed body exceeds the max size', async () => {
    const huge = new Uint8Array(21 * 1024 * 1024); // no content-length header → caught while streaming
    mockFetchQueue([{ status: 200, headers: { 'content-type': 'image/png' }, bytes: huge }]);
    await assert.rejects(
      () => fetchImageBytes('https://example.com/huge.png'),
      (e: any) => { assert.match(e.message, /exceeds max size/); return true; },
    );
  });

  it('rejects when there is no response body', async () => {
    mockFetchQueue([{ status: 200, headers: { 'content-type': 'image/png' }, noBody: true }]);
    await assert.rejects(
      () => fetchImageBytes('https://example.com/empty.png'),
      (e: any) => { assert.match(e.message, /No response body/); return true; },
    );
  });

  it('follows a redirect to a public image and re-validates each hop', async () => {
    const { urls } = mockFetchQueue([
      { status: 302, headers: { location: 'https://example.com/final.png' } },
      { status: 200, headers: { 'content-type': 'image/png' }, bytes: PNG },
    ]);
    const bytes = await fetchImageBytes('https://example.com/start');
    assert.equal(bytes.toString(), 'PNG_BYTES');
    assert.equal(urls.length, 2);
    assert.equal(urls[1], 'https://example.com/final.png');
  });

  it('resolves a relative redirect Location against the current URL', async () => {
    const { urls } = mockFetchQueue([
      { status: 301, headers: { location: '/moved/final.png' } },
      { status: 200, headers: { 'content-type': 'image/png' }, bytes: PNG },
    ]);
    await fetchImageBytes('https://example.com/a/b');
    assert.equal(urls[1], 'https://example.com/moved/final.png');
  });

  it('blocks a redirect that points at a private/internal address (SSRF)', async () => {
    mockFetchQueue([
      { status: 302, headers: { location: 'http://127.0.0.1/x.png' } },
      { status: 200, headers: { 'content-type': 'image/png' }, bytes: PNG },
    ]);
    await assert.rejects(
      () => fetchImageBytes('https://example.com/start'),
      (e: any) => { assert.match(e.message, /private\/internal address/); return true; },
    );
  });

  it('rejects after too many redirects', async () => {
    const loop: RespSpec[] = Array.from({ length: 7 }, () => ({ status: 302, headers: { location: 'https://example.com/again' } }));
    mockFetchQueue(loop);
    await assert.rejects(
      () => fetchImageBytes('https://example.com/start'),
      (e: any) => { assert.match(e.message, /Too many redirects/); return true; },
    );
  });

  it('maps a fetch AbortError to a timeout UserError', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    mockFetchQueue([{ status: 200, throwError: abort }]);
    await assert.rejects(
      () => fetchImageBytes('https://example.com/pic.png'),
      (e: any) => { assert.match(e.message, /timed out/); return true; },
    );
  });

  it('wraps a generic fetch failure', async () => {
    mockFetchQueue([{ status: 200, throwError: new Error('ECONNREFUSED') }]);
    await assert.rejects(
      () => fetchImageBytes('https://example.com/pic.png'),
      (e: any) => { assert.match(e.message, /Failed to fetch image from URL: ECONNREFUSED/); return true; },
    );
  });

  it('maps an AbortError during body streaming to a timeout UserError', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    mockFetchQueue([{ status: 200, headers: { 'content-type': 'image/png' }, readError: abort }]);
    await assert.rejects(
      () => fetchImageBytes('https://example.com/pic.png'),
      (e: any) => { assert.match(e.message, /timed out/); return true; },
    );
  });

  it('propagates a non-abort streaming error unchanged', async () => {
    mockFetchQueue([{ status: 200, headers: { 'content-type': 'image/png' }, readError: new Error('stream boom') }]);
    await assert.rejects(
      () => fetchImageBytes('https://example.com/pic.png'),
      (e: any) => { assert.match(e.message, /stream boom/); return true; },
    );
  });

  it('rejects invalid URLs before any fetch', async () => {
    await assert.rejects(
      () => fetchImageBytes('not-a-url'),
      (e: any) => { assert.match(e.message, /Invalid image URL/); return true; },
    );
  });
});

// ---------------------------------------------------------------------------
// getDocImage — the permanent READ path for legacy /images/clickup-doc/:id URLs.
// Nothing writes to clickup_doc_images anymore, but these rows must keep serving.
// ---------------------------------------------------------------------------

describe('getDocImage (legacy read path)', () => {
  afterEach(() => __setDocImagePoolForTests(null));

  it('throws when Postgres is unavailable', async () => {
    __setDocImagePoolForTests(null);
    await assert.rejects(() => getDocImage('some-id'), (e: any) => {
      assert.ok(e instanceof UserError);
      assert.match(e.message, /require Postgres/);
      return true;
    });
  });

  it('returns the row bytes + mime', async () => {
    const queries: Array<{ text: string; params?: any[] }> = [];
    __setDocImagePoolForTests({
      query: async (text: string, params?: any[]) => {
        queries.push({ text, params });
        return { rows: [{ bytes: Buffer.from('img'), mime: 'image/gif' }] };
      },
    });
    const result = await getDocImage('some-id');
    assert.ok(result);
    assert.equal(result!.mime, 'image/gif');
    assert.equal(result!.bytes.toString(), 'img');
    assert.match(queries[0].text, /SELECT bytes, mime FROM clickup_doc_images/);
  });

  it('returns null when no row matches', async () => {
    __setDocImagePoolForTests({ query: async () => ({ rows: [] }) });
    assert.equal(await getDocImage('missing'), null);
  });
});
