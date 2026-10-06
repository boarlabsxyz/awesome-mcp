import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UserError } from 'fastmcp';

import {
  BrowserbaseClient,
  getBrowserbaseClient,
  mapBrowserbaseError,
  sessionDashboardUrl,
  withBrowserbaseClient,
} from '../../browserbase/apiHelpers.js';

const silentLog = { info: () => {}, error: () => {} };

/** Collects the log lines so the error-mapping assertions can read them. */
function recordingLog() {
  const lines: string[] = [];
  return { log: { info: (m: string) => lines.push(m), error: (m: string) => lines.push(m) }, lines };
}

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

describe('BrowserbaseClient.request', () => {
  it('sends the key as x-bb-api-key and refuses redirects', async () => {
    const { fetchImpl, calls } = stub(() => response([]));
    await new BrowserbaseClient('bb_secret', undefined, fetchImpl).listProjects();
    assert.equal(calls[0].init.headers['x-bb-api-key'], 'bb_secret');
    // Node's fetch keeps custom headers across a redirect, so following one
    // would hand the key to whatever host the Location names.
    assert.equal(calls[0].init.redirect, 'error');
    assert.equal(calls[0].url, 'https://api.browserbase.com/v1/projects');
  });

  it('tags the upstream status on .status, which is what sendUpstreamError reads', async () => {
    const { fetchImpl } = stub(() => response('no such session', { status: 404, contentType: 'text/plain' }));
    await assert.rejects(
      () => new BrowserbaseClient('k', undefined, fetchImpl).getSession('gone'),
      (err: any) => {
        // NOT a Symbol. ClickUpClient hides its status on one, which is why
        // every ClickUp REST read still answers 500 for a 404.
        assert.equal(err.status, 404);
        assert.equal(err.body, 'no such session');
        assert.match(err.message, /Browserbase API GET \/sessions\/gone failed: 404/);
        return true;
      },
    );
  });

  it('resolves undefined for 204 and for a non-JSON body', async () => {
    for (const res of [response('', { status: 204 }), response('<html/>', { contentType: 'text/html' })]) {
      const { fetchImpl } = stub(() => res);
      assert.equal(await new BrowserbaseClient('k', undefined, fetchImpl).getSession('s'), undefined);
    }
  });

  it('names the service and the call on a timeout', async () => {
    const { fetchImpl } = stub(() => {
      const err: any = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    });
    await assert.rejects(
      () => new BrowserbaseClient('k', undefined, fetchImpl).listSessions(),
      // A bare AbortError reads as "The operation was aborted", naming neither.
      /Browserbase API GET \/sessions timed out after \d+ms/,
    );
  });

  it('url-encodes an id so it cannot truncate the path', async () => {
    const { fetchImpl, calls } = stub(() => response({ id: 'x' }));
    await new BrowserbaseClient('k', undefined, fetchImpl).getSession('a/b?c#d');
    assert.equal(calls[0].url, 'https://api.browserbase.com/v1/sessions/a%2Fb%3Fc%23d');
  });
});

describe('BrowserbaseClient methods', () => {
  it('filters listSessions by status, and omits the param otherwise', async () => {
    const { fetchImpl, calls } = stub(() => response([{ id: 'a' }]));
    const client = new BrowserbaseClient('k', undefined, fetchImpl);
    await client.listSessions('RUNNING');
    await client.listSessions();
    assert.match(calls[0].url, /\/sessions\?status=RUNNING$/);
    assert.match(calls[1].url, /\/sessions$/);
  });

  it('coerces a non-array list payload to an empty array', async () => {
    // A shape change upstream must not make `.filter` throw inside a formatter.
    const { fetchImpl } = stub(() => response({ unexpected: true }));
    const client = new BrowserbaseClient('k', undefined, fetchImpl);
    assert.deepEqual(await client.listSessions(), []);
    assert.deepEqual(await client.listProjects(), []);
  });

  it('releases a session by POSTing REQUEST_RELEASE', async () => {
    // Browserbase models the close as an update, not a DELETE, and documents it
    // as the way to avoid usage charges — so the body matters.
    const { fetchImpl, calls } = stub(() => response({ id: 's1', status: 'REQUEST_RELEASE' }));
    await new BrowserbaseClient('k', undefined, fetchImpl).releaseSession('s1');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), { status: 'REQUEST_RELEASE' });
  });

  it('reads project usage by id', async () => {
    const { fetchImpl, calls } = stub(() => response({ browserMinutes: 12 }));
    const usage = await new BrowserbaseClient('k', undefined, fetchImpl).getProjectUsage('p 1');
    assert.equal(usage?.browserMinutes, 12);
    assert.match(calls[0].url, /\/projects\/p%201\/usage$/);
  });
});

describe('getBrowserbaseClient', () => {
  it('refuses a session with no stored key, pointing at the dashboard', () => {
    for (const session of [undefined, {} as any, { browserbaseAccessToken: '' } as any]) {
      assert.throws(() => getBrowserbaseClient(session), (err: any) => {
        assert.ok(err instanceof UserError);
        assert.match(err.message, /Browserbase not connected/);
        return true;
      });
    }
  });

  it('builds a client from the session token', () => {
    const client = getBrowserbaseClient({ browserbaseAccessToken: 'bb_k' } as any);
    assert.ok(client instanceof BrowserbaseClient);
    assert.equal(client.baseUrl, 'https://api.browserbase.com/v1');
  });
});

describe('mapBrowserbaseError', () => {
  const cases: Array<[number | undefined, RegExp]> = [
    [401, /rejected the API key/],
    [403, /rejected the API key/],
    [404, /has no record of that id/],
    [429, /rate-limited/],
    [500, /Browserbase API error \(500\)/],
  ];

  for (const [status, expected] of cases) {
    it(`maps ${status} to an actionable message`, () => {
      assert.throws(
        () => mapBrowserbaseError('Failed to do thing', { status, message: 'upstream said no' }, silentLog),
        (err: any) => {
          assert.ok(err instanceof UserError);
          assert.match(err.message, /^Failed to do thing: /);
          assert.match(err.message, expected);
          return true;
        },
      );
    });
  }

  it('does not claim Browserbase answered when there is no status', () => {
    // undici reports every transport failure as "fetch failed" with no status,
    // so the honest statement is that the request may not have arrived.
    assert.throws(
      () => mapBrowserbaseError('Failed', { message: 'fetch failed' }, silentLog),
      /could not reach the Browserbase API \(fetch failed\)\. The request may or may not have been received/,
    );
  });

  it('logs the status alongside the message', () => {
    const { log, lines } = recordingLog();
    assert.throws(() => mapBrowserbaseError('Failed', { status: 404, message: 'nope' }, log));
    assert.match(lines[0], /Failed: nope \(status 404\)/);
  });

  it('works with no log at all', () => {
    assert.throws(() => mapBrowserbaseError('Failed', { status: 404 }), UserError);
  });
});

describe('withBrowserbaseClient', () => {
  it('passes a client through and returns the result', async () => {
    const result = await withBrowserbaseClient(
      'Failed',
      { browserbaseAccessToken: 'k' } as any,
      silentLog,
      async client => {
        assert.ok(client instanceof BrowserbaseClient);
        return 'done';
      },
    );
    assert.equal(result, 'done');
  });

  it('surfaces a missing connection verbatim, not as an upstream failure', async () => {
    // getBrowserbaseClient runs before the callback precisely so this message
    // is not re-wrapped as "Failed: Browserbase API error".
    await assert.rejects(
      () => withBrowserbaseClient('Failed to list', undefined, silentLog, async () => 'x'),
      /^UserError: Browserbase not connected/,
    );
  });

  it('maps an upstream error but lets a UserError through untouched', async () => {
    await assert.rejects(
      () => withBrowserbaseClient('Failed to list', { browserbaseAccessToken: 'k' } as any, silentLog, async () => {
        throw Object.assign(new Error('nope'), { status: 404 });
      }),
      /Failed to list: Browserbase has no record of that id/,
    );

    await assert.rejects(
      () => withBrowserbaseClient('Failed to list', { browserbaseAccessToken: 'k' } as any, silentLog, async () => {
        throw new UserError('a message the tool wrote on purpose');
      }),
      /^UserError: a message the tool wrote on purpose$/,
    );
  });
});

describe('sessionDashboardUrl', () => {
  it('builds the dashboard link and encodes the id', () => {
    assert.equal(sessionDashboardUrl('s1'), 'https://www.browserbase.com/sessions/s1');
    assert.equal(sessionDashboardUrl('a/b'), 'https://www.browserbase.com/sessions/a%2Fb');
  });
});
