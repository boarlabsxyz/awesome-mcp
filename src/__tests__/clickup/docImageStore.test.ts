import assert from 'node:assert/strict';
import { describe, it, afterEach, beforeEach } from 'node:test';
import { UserError } from 'fastmcp';
import {
  fetchRemoteImage,
  assertDocImagesReady,
  storeDocImage,
  getDocImage,
  deleteDocImage,
  __setDocImagePoolForTests,
} from '../../clickup/docImageStore.js';

// ---------------------------------------------------------------------------
// fetch mock: a queue of response specs, one dequeued per fetch() call, so we
// can exercise the manual redirect loop. Each spec carries headers + body bytes
// (or a readError / no body) shaped like the WHATWG Response fetchRemoteImage
// consumes: headers.get(), body.getReader(), body.cancel().
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

describe('fetchRemoteImage', () => {
  it('fetches a raster image and returns bytes + mime', async () => {
    mockFetchQueue([{ status: 200, headers: { 'content-type': 'image/png' }, bytes: PNG }]);
    const { bytes, mime } = await fetchRemoteImage('https://example.com/pic.png');
    assert.equal(mime, 'image/png');
    assert.ok(Buffer.isBuffer(bytes));
    assert.equal(bytes.toString(), 'PNG_BYTES');
  });

  it('prefers the declared image Content-Type over the URL extension', async () => {
    // .png path but server declares gif → header wins
    mockFetchQueue([{ status: 200, headers: { 'content-type': 'image/gif' }, bytes: PNG }]);
    const { mime } = await fetchRemoteImage('https://example.com/pic.png');
    assert.equal(mime, 'image/gif');
  });

  it('falls back to the extension when the header is generic (octet-stream)', async () => {
    mockFetchQueue([{ status: 200, headers: { 'content-type': 'application/octet-stream' }, bytes: PNG }]);
    const { mime } = await fetchRemoteImage('https://example.com/pic.png');
    assert.equal(mime, 'image/png');
  });

  it('strips charset params from the Content-Type', async () => {
    mockFetchQueue([{ status: 200, headers: { 'content-type': 'image/jpeg; charset=binary' }, bytes: PNG }]);
    const { mime } = await fetchRemoteImage('https://example.com/no-ext');
    assert.equal(mime, 'image/jpeg');
  });

  it('rejects SVG declared via Content-Type', async () => {
    mockFetchQueue([{ status: 200, headers: { 'content-type': 'image/svg+xml' }, bytes: PNG }]);
    await assert.rejects(
      () => fetchRemoteImage('https://example.com/logo'),
      (e: any) => { assert.ok(e instanceof UserError); assert.match(e.message, /SVG images are not supported/); return true; },
    );
  });

  it('rejects a non-image response', async () => {
    mockFetchQueue([{ status: 200, headers: { 'content-type': 'text/html' }, bytes: PNG }]);
    await assert.rejects(
      () => fetchRemoteImage('https://example.com/page'),
      (e: any) => { assert.match(e.message, /did not return an image/); return true; },
    );
  });

  it('rejects a non-OK status', async () => {
    mockFetchQueue([{ status: 404, headers: {}, bytes: new Uint8Array(0) }]);
    await assert.rejects(
      () => fetchRemoteImage('https://example.com/missing.png'),
      (e: any) => { assert.match(e.message, /Failed to fetch image from URL \(404\)/); return true; },
    );
  });

  it('rejects when Content-Length exceeds the max', async () => {
    mockFetchQueue([{ status: 200, headers: { 'content-type': 'image/png', 'content-length': String(21 * 1024 * 1024) }, bytes: PNG }]);
    await assert.rejects(
      () => fetchRemoteImage('https://example.com/big.png'),
      (e: any) => { assert.match(e.message, /Image too large/); return true; },
    );
  });

  it('rejects when the streamed body exceeds the max size', async () => {
    const huge = new Uint8Array(21 * 1024 * 1024); // no content-length header → caught while streaming
    mockFetchQueue([{ status: 200, headers: { 'content-type': 'image/png' }, bytes: huge }]);
    await assert.rejects(
      () => fetchRemoteImage('https://example.com/huge.png'),
      (e: any) => { assert.match(e.message, /exceeds max size/); return true; },
    );
  });

  it('rejects when there is no response body', async () => {
    mockFetchQueue([{ status: 200, headers: { 'content-type': 'image/png' }, noBody: true }]);
    await assert.rejects(
      () => fetchRemoteImage('https://example.com/empty.png'),
      (e: any) => { assert.match(e.message, /No response body/); return true; },
    );
  });

  it('follows a redirect to a public image and re-validates each hop', async () => {
    const { urls } = mockFetchQueue([
      { status: 302, headers: { location: 'https://example.com/final.png' } },
      { status: 200, headers: { 'content-type': 'image/png' }, bytes: PNG },
    ]);
    const { mime } = await fetchRemoteImage('https://example.com/start');
    assert.equal(mime, 'image/png');
    assert.equal(urls.length, 2);
    assert.equal(urls[1], 'https://example.com/final.png');
  });

  it('resolves a relative redirect Location against the current URL', async () => {
    const { urls } = mockFetchQueue([
      { status: 301, headers: { location: '/moved/final.png' } },
      { status: 200, headers: { 'content-type': 'image/png' }, bytes: PNG },
    ]);
    await fetchRemoteImage('https://example.com/a/b');
    assert.equal(urls[1], 'https://example.com/moved/final.png');
  });

  it('blocks a redirect that points at a private/internal address (SSRF)', async () => {
    mockFetchQueue([
      { status: 302, headers: { location: 'http://127.0.0.1/x.png' } },
      { status: 200, headers: { 'content-type': 'image/png' }, bytes: PNG },
    ]);
    await assert.rejects(
      () => fetchRemoteImage('https://example.com/start'),
      (e: any) => { assert.match(e.message, /private\/internal address/); return true; },
    );
  });

  it('rejects after too many redirects', async () => {
    const loop: RespSpec[] = Array.from({ length: 7 }, () => ({ status: 302, headers: { location: 'https://example.com/again' } }));
    mockFetchQueue(loop);
    await assert.rejects(
      () => fetchRemoteImage('https://example.com/start'),
      (e: any) => { assert.match(e.message, /Too many redirects/); return true; },
    );
  });

  it('maps a fetch AbortError to a timeout UserError', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    mockFetchQueue([{ status: 200, throwError: abort }]);
    await assert.rejects(
      () => fetchRemoteImage('https://example.com/pic.png'),
      (e: any) => { assert.match(e.message, /timed out/); return true; },
    );
  });

  it('wraps a generic fetch failure', async () => {
    mockFetchQueue([{ status: 200, throwError: new Error('ECONNREFUSED') }]);
    await assert.rejects(
      () => fetchRemoteImage('https://example.com/pic.png'),
      (e: any) => { assert.match(e.message, /Failed to fetch image from URL: ECONNREFUSED/); return true; },
    );
  });

  it('maps an AbortError during body streaming to a timeout UserError', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    mockFetchQueue([{ status: 200, headers: { 'content-type': 'image/png' }, readError: abort }]);
    await assert.rejects(
      () => fetchRemoteImage('https://example.com/pic.png'),
      (e: any) => { assert.match(e.message, /timed out/); return true; },
    );
  });

  it('propagates a non-abort streaming error unchanged', async () => {
    mockFetchQueue([{ status: 200, headers: { 'content-type': 'image/png' }, readError: new Error('stream boom') }]);
    await assert.rejects(
      () => fetchRemoteImage('https://example.com/pic.png'),
      (e: any) => { assert.match(e.message, /stream boom/); return true; },
    );
  });

  it('rejects invalid URLs before any fetch', async () => {
    await assert.rejects(
      () => fetchRemoteImage('not-a-url'),
      (e: any) => { assert.match(e.message, /Invalid image URL/); return true; },
    );
  });
});

// ---------------------------------------------------------------------------
// DB-backed helpers: with no DATABASE_URL configured in the test process,
// isDatabaseAvailable() is false, so each guarded helper throws the same
// clear UserError before touching a pool.
// ---------------------------------------------------------------------------

describe('doc image store DB guards (no Postgres)', () => {
  it('assertDocImagesReady throws when Postgres is unavailable', () => {
    assert.throws(() => assertDocImagesReady(), (e: any) => {
      assert.ok(e instanceof UserError);
      assert.match(e.message, /require Postgres/);
      return true;
    });
  });

  it('storeDocImage throws when Postgres is unavailable', async () => {
    await assert.rejects(() => storeDocImage(Buffer.from('x'), 'image/png'), /require Postgres/);
  });

  it('getDocImage throws when Postgres is unavailable', async () => {
    await assert.rejects(() => getDocImage('some-id'), /require Postgres/);
  });

  it('deleteDocImage throws when Postgres is unavailable', async () => {
    await assert.rejects(() => deleteDocImage('some-id'), /require Postgres/);
  });
});

describe('doc image store DB helpers (fake pool)', () => {
  const queries: Array<{ text: string; params?: any[] }> = [];
  let nextRows: any[] = [];

  beforeEach(() => {
    queries.length = 0;
    nextRows = [];
    __setDocImagePoolForTests({
      query: async (text: string, params?: any[]) => {
        queries.push({ text, params });
        return { rows: nextRows };
      },
    });
  });

  afterEach(() => {
    __setDocImagePoolForTests(null);
  });

  it('assertDocImagesReady passes when a pool is present', () => {
    assert.doesNotThrow(() => assertDocImagesReady());
  });

  it('storeDocImage inserts and returns a generated id', async () => {
    const { id } = await storeDocImage(Buffer.from('abc'), 'image/png', '42');
    assert.match(id, /[0-9a-f-]{36}/);
    assert.equal(queries.length, 1);
    assert.match(queries[0].text, /INSERT INTO clickup_doc_images/);
    // id, bytes, mime, byte_size, created_by
    assert.equal(queries[0].params?.[0], id);
    assert.equal(queries[0].params?.[2], 'image/png');
    assert.equal(queries[0].params?.[3], 3);
    assert.equal(queries[0].params?.[4], '42');
  });

  it('storeDocImage passes null created_by when omitted', async () => {
    await storeDocImage(Buffer.from('abc'), 'image/png');
    assert.equal(queries[0].params?.[4], null);
  });

  it('getDocImage returns the row bytes + mime', async () => {
    nextRows = [{ bytes: Buffer.from('img'), mime: 'image/gif' }];
    const result = await getDocImage('some-id');
    assert.ok(result);
    assert.equal(result!.mime, 'image/gif');
    assert.equal(result!.bytes.toString(), 'img');
    assert.match(queries[0].text, /SELECT bytes, mime FROM clickup_doc_images/);
  });

  it('getDocImage returns null when no row matches', async () => {
    nextRows = [];
    const result = await getDocImage('missing');
    assert.equal(result, null);
  });

  it('deleteDocImage issues a delete for the id', async () => {
    await deleteDocImage('doomed');
    assert.match(queries[0].text, /DELETE FROM clickup_doc_images/);
    assert.equal(queries[0].params?.[0], 'doomed');
  });
});
