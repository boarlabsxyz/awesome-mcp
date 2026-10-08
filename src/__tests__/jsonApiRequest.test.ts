// src/__tests__/jsonApiRequest.test.ts
// The shared authenticated-JSON request used by BrowserbaseClient and
// RedmineClient. Each rule here exists because getting it wrong is either a
// security problem or an undiagnosable one, so each gets its own assertion.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { jsonApiRequest } from '../util/jsonApiRequest.js';

function response(body: unknown, { status = 200, contentType = 'application/json' } = {}): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function stub(impl: (url: string, init: any) => any) {
  const calls: Array<{ url: string; init: any }> = [];
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return impl(String(url), init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const base = {
  url: 'https://api.example.test/v1/things',
  method: 'GET',
  headers: { 'x-api-key': 'secret' },
  timeoutMs: 5_000,
  serviceLabel: 'Example API',
  target: 'GET /things',
};

describe('jsonApiRequest', () => {
  it('merges the caller headers over the JSON defaults', async () => {
    const { fetchImpl, calls } = stub(() => response({ ok: true }));
    await jsonApiRequest({ ...base, fetchImpl });
    assert.equal(calls[0].init.headers['x-api-key'], 'secret');
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
    assert.equal(calls[0].init.headers.Accept, 'application/json');
  });

  it('lets the caller override a default header', async () => {
    const { fetchImpl, calls } = stub(() => response({}));
    await jsonApiRequest({ ...base, headers: { Accept: 'application/vnd.custom' }, fetchImpl });
    assert.equal(calls[0].init.headers.Accept, 'application/vnd.custom');
  });

  it('refuses to follow a redirect', async () => {
    // Node's fetch strips Authorization across an origin change but KEEPS
    // custom headers, so following one would hand an API-key header to
    // whatever host the Location names.
    const { fetchImpl, calls } = stub(() => response({}));
    await jsonApiRequest({ ...base, fetchImpl });
    assert.equal(calls[0].init.redirect, 'error');
  });

  it('serialises a body only when one is given', async () => {
    const { fetchImpl, calls } = stub(() => response({}));
    await jsonApiRequest({ ...base, method: 'POST', body: { a: 1 }, fetchImpl });
    await jsonApiRequest({ ...base, method: 'POST', fetchImpl });
    assert.equal(calls[0].init.body, '{"a":1}');
    assert.equal(calls[1].init.body, undefined);
  });

  it('names the service and the call on a timeout', async () => {
    // A bare AbortError reads as "The operation was aborted", which names
    // neither the service nor what was attempted.
    const { fetchImpl } = stub(() => {
      const err: any = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    });
    await assert.rejects(
      () => jsonApiRequest({ ...base, fetchImpl }),
      /Example API GET \/things timed out after 5000ms/,
    );
  });

  it('rethrows a non-abort transport failure unchanged', async () => {
    const { fetchImpl } = stub(() => { throw new Error('fetch failed'); });
    await assert.rejects(() => jsonApiRequest({ ...base, fetchImpl }), /^Error: fetch failed$/);
  });

  it('puts the upstream status on .status, where sendUpstreamError can read it', async () => {
    // It reads `err.code ?? err.response?.status ?? err.status`, so a status
    // stashed anywhere else is invisible and every 404 becomes a flat 500.
    const { fetchImpl } = stub(() => response('missing', { status: 404, contentType: 'text/plain' }));
    await assert.rejects(() => jsonApiRequest({ ...base, fetchImpl }), (err: any) => {
      assert.equal(err.status, 404);
      assert.equal(err.body, 'missing');
      assert.match(err.message, /Example API GET \/things failed: 404 missing/);
      return true;
    });
  });

  it('still throws with a status when the error body cannot be read', async () => {
    const { fetchImpl } = stub(() => ({
      ok: false, status: 500, statusText: 'Err',
      headers: { get: () => 'application/json' },
      text: async () => { throw new Error('stream broke'); },
    }));
    await assert.rejects(() => jsonApiRequest({ ...base, fetchImpl }), (err: any) => {
      assert.equal(err.status, 500);
      assert.equal(err.body, '');
      return true;
    });
  });

  it('resolves undefined for 204 and for a non-JSON body', async () => {
    // An empty body is a legitimate answer to a write; throwing out of
    // res.json() would turn a successful call into a failure.
    for (const res of [
      response('', { status: 204 }),
      response('<html/>', { contentType: 'text/html' }),
      response('', { contentType: '' }),
    ]) {
      const { fetchImpl } = stub(() => res);
      assert.equal(await jsonApiRequest({ ...base, fetchImpl }), undefined);
    }
  });

  it('parses a JSON body on success', async () => {
    const { fetchImpl } = stub(() => response({ items: [1, 2] }));
    assert.deepEqual(await jsonApiRequest<{ items: number[] }>({ ...base, fetchImpl }), { items: [1, 2] });
  });

  it('keeps the deadline armed while the error body is read', async () => {
    // fetch resolves as soon as the HEADERS arrive, so a timer cleared at that
    // point leaves a stalled body stream with no limit — the caller would then
    // outlive its own deadline. An abort during the body read is the deadline
    // firing and must surface as the timeout, not be swallowed into ''.
    const { fetchImpl } = stub(() => ({
      ok: false, status: 500, statusText: 'Err',
      headers: { get: () => 'application/json' },
      text: async () => {
        const err: any = new Error('aborted mid-body');
        err.name = 'AbortError';
        throw err;
      },
    }));
    await assert.rejects(
      () => jsonApiRequest({ ...base, fetchImpl }),
      /Example API GET \/things timed out after 5000ms/,
    );
  });

  it('keeps the deadline armed while a success body is parsed', async () => {
    const { fetchImpl } = stub(() => ({
      ok: true, status: 200, statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => {
        const err: any = new Error('aborted mid-body');
        err.name = 'AbortError';
        throw err;
      },
    }));
    await assert.rejects(() => jsonApiRequest({ ...base, fetchImpl }), /timed out after 5000ms/);
  });

  it('rethrows a non-abort JSON parse failure as itself', async () => {
    const { fetchImpl } = stub(() => ({
      ok: true, status: 200, statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => { throw new Error('invalid json'); },
    }));
    await assert.rejects(() => jsonApiRequest({ ...base, fetchImpl }), /^Error: invalid json$/);
  });

  it('caps the upstream text in the message but keeps the body whole', async () => {
    // The message is logged and, for several providers, shown to the user — so
    // a 500 answered with a megabyte of HTML must not land in both places.
    const huge = 'x'.repeat(5000);
    const { fetchImpl } = stub(() => response(huge, { status: 500, contentType: 'text/plain' }));
    await assert.rejects(() => jsonApiRequest({ ...base, fetchImpl }), (err: any) => {
      assert.ok(err.message.length < 700, `message was ${err.message.length} chars`);
      assert.match(err.message, /…\(truncated, 5000 chars\)/);
      // Callers that parse the body (Redmine's 422 mapper) still need all of it.
      assert.equal(err.body.length, 5000);
      return true;
    });
  });

  it('keeps .body off enumeration so logging the error cannot dump it', async () => {
    const { fetchImpl } = stub(() => response('secret-ish upstream payload', { status: 500, contentType: 'text/plain' }));
    await assert.rejects(() => jsonApiRequest({ ...base, fetchImpl }), (err: any) => {
      // Direct access still works...
      assert.equal(err.body, 'secret-ish upstream payload');
      // ...but console.error(err) / JSON.stringify do not reach it.
      assert.ok(!Object.keys(err).includes('body'));
      assert.ok(!JSON.stringify(err).includes('secret-ish'));
      return true;
    });
  });

  it('clears its timer on both the success and the failure path', async () => {
    // A leaked timer keeps the event loop alive; the test runner exiting
    // cleanly is the observable part.
    const ok = stub(() => response({}));
    await jsonApiRequest({ ...base, fetchImpl: ok.fetchImpl });
    const bad = stub(() => response('x', { status: 500 }));
    await assert.rejects(() => jsonApiRequest({ ...base, fetchImpl: bad.fetchImpl }));
  });
});
