// src/__tests__/jsonApiRequest.test.ts
// The shared authenticated-JSON request used by BrowserbaseClient and
// RedmineClient. Each rule here exists because getting it wrong is either a
// security problem or an undiagnosable one, so each gets its own assertion.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { jsonApiRequest, RedirectRefusedError } from '../util/jsonApiRequest.js';

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

/** A 3xx with a Location, which `response` cannot express (it has no headers). */
function redirect(location: string | null, status = 302): any {
  return {
    ok: false,
    status,
    statusText: 'Found',
    headers: {
      get: (n: string) => (n.toLowerCase() === 'location' ? location : null),
    },
    json: async () => ({}),
    text: async () => '',
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

  it('never lets fetch follow a redirect itself', async () => {
    // Node's fetch strips Authorization across an origin change but KEEPS
    // custom headers, so letting IT follow one would hand an API-key header to
    // whatever host the Location names. 'manual' rather than 'error' so the
    // Location can be read before the call is refused — 'error' produced a bare
    // "fetch failed" naming neither the status nor the target.
    const { fetchImpl, calls } = stub(() => response({}));
    await jsonApiRequest({ ...base, fetchImpl });
    assert.equal(calls[0].init.redirect, 'manual');
  });

  describe('redirects', () => {
    it('refuses by default and names the status and target', async () => {
      const { fetchImpl, calls } = stub(() => redirect('/time_entries.json?page=2'));
      await assert.rejects(
        () => jsonApiRequest({ ...base, fetchImpl }),
        (err: any) => {
          assert.ok(err instanceof RedirectRefusedError);
          assert.match(err.message, /HTTP 302/);
          assert.match(err.message, /\/time_entries\.json\?page=2/);
          return true;
        },
      );
      assert.equal(calls.length, 1, 'refusing must not spend a second request');
    });

    it('answers .status 502, not the 3xx', async () => {
      // sendUpstreamError passes .status straight to res.status(). A 302 there
      // would make our own REST client try to FOLLOW a Location we deliberately
      // did not follow — and never sent it.
      const { fetchImpl } = stub(() => redirect('/elsewhere'));
      await assert.rejects(
        () => jsonApiRequest({ ...base, fetchImpl }),
        (err: any) => {
          assert.equal(err.status, 502);
          assert.equal(err.redirect.status, 302);
          return true;
        },
      );
    });

    it('follows a same-origin hop when the caller opts in', async () => {
      const { fetchImpl, calls } = stub((url) =>
        url.endsWith('/v1/things') ? redirect('/v2/things') : response({ ok: true }),
      );
      const out = await jsonApiRequest<any>({ ...base, followSameOriginRedirects: 3, fetchImpl });
      assert.deepEqual(out, { ok: true });
      assert.equal(calls[1].url, 'https://api.example.test/v2/things');
      // The credential rides along on a same-origin hop — that is the point of
      // following it at all.
      assert.equal(calls[1].init.headers['x-api-key'], 'secret');
    });

    it('never follows a cross-origin hop, however many are allowed', async () => {
      // The one case that is a credential leak rather than an inconvenience.
      const { fetchImpl, calls } = stub(() => redirect('https://sso.elsewhere.test/login'));
      await assert.rejects(
        () => jsonApiRequest({ ...base, followSameOriginRedirects: 3, fetchImpl }),
        (err: any) => {
          assert.equal(err.redirect.sameOrigin, false);
          assert.equal(err.redirect.host, 'sso.elsewhere.test');
          assert.match(err.message, /DIFFERENT origin \(sso\.elsewhere\.test\)/);
          return true;
        },
      );
      assert.equal(calls.length, 1);
    });

    it('compares each hop against the ORIGINAL origin, not the previous one', async () => {
      // Hop-to-hop comparison would let a chain walk off-origin one
      // same-origin-looking step at a time.
      const { fetchImpl, calls } = stub((url) =>
        url.includes('/v1/things') ? redirect('/step2') : redirect('https://evil.test/take-the-key'),
      );
      await assert.rejects(
        () => jsonApiRequest({ ...base, followSameOriginRedirects: 3, fetchImpl }),
        (err: any) => {
          assert.equal(err.redirect.host, 'evil.test');
          return true;
        },
      );
      assert.equal(calls.length, 2, 'stopped at the off-origin hop');
    });

    it('refuses a non-idempotent method even when following is allowed', async () => {
      // A 301/302 on a POST is replayable as a GET by the spec and as the same
      // POST by 307/308; neither is worth risking a duplicate write over.
      const { fetchImpl, calls } = stub(() => redirect('/moved'));
      await assert.rejects(
        () => jsonApiRequest({ ...base, method: 'POST', body: { a: 1 }, followSameOriginRedirects: 3, fetchImpl }),
        /not idempotent/,
      );
      assert.equal(calls.length, 1);
    });

    it('does not follow a login bounce, and says it was one', async () => {
      // Following it would answer 200 with an HTML form, which has no JSON
      // content type and so resolves to undefined — a sign-in page reported as
      // an empty result.
      const { fetchImpl, calls } = stub(() => redirect('/login?back_url=%2Fv1%2Fthings'));
      await assert.rejects(
        () => jsonApiRequest({
          ...base,
          followSameOriginRedirects: 3,
          isLoginPath: (p) => p === '/login',
          fetchImpl,
        }),
        (err: any) => {
          assert.equal(err.redirect.loginBounce, true);
          assert.match(err.message, /sign-in page/);
          return true;
        },
      );
      assert.equal(calls.length, 1);
    });

    it('stops a redirect loop at the hop budget', async () => {
      const { fetchImpl, calls } = stub(() => redirect('/loop'));
      await assert.rejects(
        () => jsonApiRequest({ ...base, followSameOriginRedirects: 2, fetchImpl }),
        /redirect loop/,
      );
      assert.equal(calls.length, 3, 'original plus two followed hops');
    });

    it('caps the hop budget however many the caller asks for', async () => {
      const { fetchImpl, calls } = stub(() => redirect('/loop'));
      await assert.rejects(() => jsonApiRequest({ ...base, followSameOriginRedirects: 99, fetchImpl }), /redirect loop/);
      assert.equal(calls.length, 4, 'original plus the 3-hop ceiling');
    });

    it('reports a missing Location rather than throwing on it', async () => {
      const { fetchImpl } = stub(() => redirect(null));
      await assert.rejects(
        () => jsonApiRequest({ ...base, followSameOriginRedirects: 3, fetchImpl }),
        /Location header was missing or unparseable/,
      );
    });

    it('treats 304 as a response, not a relocation', async () => {
      // 304 is a cache answer and carries no Location; classifying it as a
      // redirect would turn a conditional GET into an error.
      const { fetchImpl } = stub(() => response('', { status: 304, contentType: 'text/plain' }));
      await assert.rejects(() => jsonApiRequest({ ...base, fetchImpl }), /failed: 304/);
    });

    it('redacts the credential out of a Location that echoes it back', async () => {
      // Redmine's bounce puts the whole original URL in back_url, so once a
      // caller has retried with the key as a query parameter the Location
      // itself carries it — into the error text, the server log and the model
      // transcript.
      const key = 'super-secret-api-key-value';
      const { fetchImpl } = stub(() => redirect(`/login?back_url=%2Fthings%3Fkey%3D${encodeURIComponent(key)}`));
      await assert.rejects(
        () => jsonApiRequest({ ...base, secrets: [key], fetchImpl }),
        (err: any) => {
          assert.ok(!err.message.includes(key), 'credential leaked into the message');
          assert.ok(!err.redirect.path.includes(key), 'credential leaked into .redirect');
          assert.match(err.redirect.path, /\[redacted\]/);
          return true;
        },
      );
    });

    it('redacts the credential out of .redirect.resolved too', async () => {
      // `resolved` is reachable as RedirectRefusedError.redirect.resolved from
      // every caller, so a caller logging or serialising the error would print
      // whatever a back_url echoed back. Redacting only `location` and `path`
      // left this one open.
      const key = 'super-secret-api-key-value';
      const { fetchImpl } = stub(() => redirect(`/login?back_url=%2Fthings%3Fkey%3D${encodeURIComponent(key)}`));
      await assert.rejects(
        () => jsonApiRequest({ ...base, secrets: [key], fetchImpl }),
        (err: any) => {
          assert.ok(!JSON.stringify(err.redirect).includes(key), 'credential leaked via .redirect');
          assert.ok(!err.redirect.resolved.includes(key));
          return true;
        },
      );
    });

    it('follows the RAW url, not the redacted one', async () => {
      // Redacting `resolved` on the record is what keeps the credential out of
      // the error; the follow has to use the unredacted URL or it would request
      // a path with "[redacted]" spliced into it.
      const key = 'super-secret-api-key-value';
      const { fetchImpl, calls } = stub((url) =>
        url.includes('/v1/things') ? redirect(`/v2/things?token=${key}`) : response({ ok: true }),
      );
      const out = await jsonApiRequest<any>({
        ...base,
        secrets: [key],
        followSameOriginRedirects: 1,
        fetchImpl,
      });
      assert.deepEqual(out, { ok: true });
      assert.equal(calls[1].url, `https://api.example.test/v2/things?token=${key}`);
    });

    it('shares one deadline across followed hops', async () => {
      // A fresh timer per hop would let three hops take 3x the configured
      // timeout, so a call could quietly outlive its own deadline.
      let hops = 0;
      const { fetchImpl } = stub(() => {
        hops += 1;
        if (hops > 1) {
          const err: any = new Error('The operation was aborted');
          err.name = 'AbortError';
          throw err;
        }
        return redirect('/next');
      });
      await assert.rejects(
        () => jsonApiRequest({ ...base, followSameOriginRedirects: 3, fetchImpl }),
        /Example API GET \/things timed out after 5000ms/,
      );
    });
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

  it('redacts the credential out of `target`, which prefixes every message', async () => {
    // `target` is built by callers from the request path, and Redmine's
    // login-bounce fallback retries with the key as a query parameter — so that
    // path carries the credential, and a 403 or a timeout on that attempt put it
    // in the message, the log, and the text shown to the model. Redacting the
    // body and the Location while leaving this alone defeated the point of
    // `secrets`.
    const key = 'super-secret-api-key-value';
    const target = `GET /time_entries.json?key=${key}`;

    const rejected = stub(() => response('Forbidden', { status: 403, contentType: 'text/plain' }));
    await assert.rejects(
      () => jsonApiRequest({ ...base, target, secrets: [key], fetchImpl: rejected.fetchImpl }),
      (err: any) => {
        assert.ok(!err.message.includes(key), `credential leaked: ${err.message}`);
        assert.match(err.message, /\[redacted\]/);
        return true;
      },
    );

    // Same for the timeout message, which is built from `target` as well.
    const timing = stub(() => {
      const err: any = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    await assert.rejects(
      () => jsonApiRequest({ ...base, target, secrets: [key], fetchImpl: timing.fetchImpl }),
      (err: any) => {
        assert.ok(!err.message.includes(key), `credential leaked on timeout: ${err.message}`);
        return true;
      },
    );
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
