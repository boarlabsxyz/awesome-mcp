import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { fetchSlackFileBytes, isSlackHost } from '../../slack/fileDownload.js';

// ---------------------------------------------------------------------------
// fetch mock modelled on src/__tests__/clickup/docImageStore.test.ts, extended
// to capture each call's headers — the whole point of this module is *which*
// hops receive the workspace token.
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

interface RespSpec {
  status: number;
  headers?: Record<string, string>;
  bytes?: Uint8Array;
  noBody?: boolean;
  throwError?: any;
}

function makeResponse(spec: RespSpec) {
  const headers = spec.headers || {};
  let read = false;
  const body = spec.noBody
    ? null
    : {
        getReader: () => ({
          read: async () => {
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
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  globalThis.fetch = (async (input: any, init: any) => {
    calls.push({ url: String(input), auth: init?.headers?.Authorization });
    const spec = specs[i] || specs[specs.length - 1];
    i++;
    if (spec.throwError) throw spec.throwError;
    return makeResponse(spec) as any;
  }) as any;
  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const PNG = new TextEncoder().encode('PNG_BYTES');
const TOKEN = 'xoxp-test-token';

describe('isSlackHost', () => {
  it('accepts slack.com and its subdomains', () => {
    assert.equal(isSlackHost('slack.com'), true);
    assert.equal(isSlackHost('files.slack.com'), true);
    assert.equal(isSlackHost('FILES.SLACK.COM'), true);
    assert.equal(isSlackHost('files.slack.com.'), true); // trailing dot
  });

  it('rejects lookalike hosts', () => {
    assert.equal(isSlackHost('slack.com.evil.example'), false);
    assert.equal(isSlackHost('notslack.com'), false);
    assert.equal(isSlackHost('files.slack.com.attacker.net'), false);
    assert.equal(isSlackHost('s3.amazonaws.com'), false);
  });
});

describe('fetchSlackFileBytes', () => {
  it('sends the bearer token to files.slack.com', async () => {
    const calls = mockFetchQueue([{ status: 200, headers: { 'content-type': 'image/png' }, bytes: PNG }]);
    const result = await fetchSlackFileBytes('https://files.slack.com/files-pri/T1-F1/shot.png', TOKEN);

    assert.equal(result.buffer.toString(), 'PNG_BYTES');
    assert.equal(result.contentType, 'image/png');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].auth, `Bearer ${TOKEN}`);
  });

  it('drops the bearer token on a redirect off Slack', async () => {
    // Slack really does redirect downloads to signed S3 URLs. The token must
    // not follow — this is the leak this module exists to prevent.
    const calls = mockFetchQueue([
      { status: 302, headers: { location: 'https://s3.amazonaws.com/bucket/signed-object' } },
      { status: 200, headers: { 'content-type': 'image/png' }, bytes: PNG },
    ]);
    const result = await fetchSlackFileBytes('https://files.slack.com/files-pri/T1-F1/shot.png', TOKEN);

    assert.equal(result.buffer.toString(), 'PNG_BYTES');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].auth, `Bearer ${TOKEN}`);
    assert.equal(calls[1].auth, undefined, 'token must not be sent to the redirect target');
  });

  it('keeps the token across a same-host redirect', async () => {
    const calls = mockFetchQueue([
      { status: 302, headers: { location: 'https://files.slack.com/files-pri/T1-F1/shot.png?t=2' } },
      { status: 200, headers: { 'content-type': 'image/png' }, bytes: PNG },
    ]);
    await fetchSlackFileBytes('https://files.slack.com/files-pri/T1-F1/shot.png', TOKEN);

    assert.equal(calls[1].auth, `Bearer ${TOKEN}`);
  });

  it('refuses a non-Slack initial host', async () => {
    const calls = mockFetchQueue([{ status: 200, bytes: PNG }]);
    await assert.rejects(
      () => fetchSlackFileBytes('https://evil.example/steal', TOKEN),
      { message: /non-Slack host/ },
    );
    assert.equal(calls.length, 0, 'must not issue a request at all');
  });

  it('rejects an HTML sign-in page and names the missing scope', async () => {
    // A token without files:read gets 200 + HTML, not a 401. Storing those
    // bytes would silently produce a "screenshot" that is a login page.
    mockFetchQueue([{ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, bytes: PNG }]);
    await assert.rejects(
      () => fetchSlackFileBytes('https://files.slack.com/files-pri/T1-F1/shot.png', TOKEN),
      { message: /files:read/ },
    );
  });

  it('rejects a redirect to a private address', async () => {
    mockFetchQueue([
      { status: 302, headers: { location: 'http://127.0.0.1/admin' } },
      { status: 200, bytes: PNG },
    ]);
    await assert.rejects(
      () => fetchSlackFileBytes('https://files.slack.com/files-pri/T1-F1/shot.png', TOKEN),
      { message: /private\/internal address/ },
    );
  });

  it('rejects a redirect to cloud metadata', async () => {
    mockFetchQueue([
      { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } },
      { status: 200, bytes: PNG },
    ]);
    await assert.rejects(
      () => fetchSlackFileBytes('https://files.slack.com/files-pri/T1-F1/shot.png', TOKEN),
      { message: /private\/internal address/ },
    );
  });

  it('rejects an oversized Content-Length before streaming', async () => {
    mockFetchQueue([{
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(50 * 1024 * 1024) },
      bytes: PNG,
    }]);
    await assert.rejects(
      () => fetchSlackFileBytes('https://files.slack.com/files-pri/T1-F1/big.png', TOKEN),
      { message: /too large/ },
    );
  });

  it('enforces maxBytes mid-stream when Content-Length is absent', async () => {
    const big = new Uint8Array(4096);
    mockFetchQueue([{ status: 200, headers: { 'content-type': 'image/png' }, bytes: big }]);
    await assert.rejects(
      () => fetchSlackFileBytes('https://files.slack.com/files-pri/T1-F1/big.png', TOKEN, { maxBytes: 1024 }),
      { message: /exceeds the maximum size/ },
    );
  });

  it('surfaces HTTP errors in the shape slackErrorMapper parses', async () => {
    mockFetchQueue([{ status: 403, headers: {} }]);
    await assert.rejects(
      () => fetchSlackFileBytes('https://files.slack.com/files-pri/T1-F1/shot.png', TOKEN),
      { message: /Slack API HTTP error \(403\)/ },
    );
  });

  it('stops after too many redirects', async () => {
    mockFetchQueue([
      { status: 302, headers: { location: 'https://files.slack.com/hop' } },
    ]);
    await assert.rejects(
      () => fetchSlackFileBytes('https://files.slack.com/files-pri/T1-F1/shot.png', TOKEN),
      { message: /Too many redirects/ },
    );
  });
});
