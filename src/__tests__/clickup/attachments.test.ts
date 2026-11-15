import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import {
  AttachmentUrlError,
  attachmentFileName,
  attachmentTotalSize,
  contentDisposition,
  isForwardableRange,
  openAttachment,
  parseAttachmentUrl,
  workspaceIsVisible,
} from '../../clickup/attachments.js';

const WS = '90151491867';
const HOST = `https://t${WS}.p.clickup-attachments.com`;
const MP4 = `${HOST}/t${WS}/7044da6f/7044da6f.mp4?view=open&filename=Dark-Factory%20demo.mp4`;

describe('parseAttachmentUrl', () => {
  it('accepts this workspace attachment URL', () => {
    assert.equal(parseAttachmentUrl(` ${MP4} `, WS).hostname, `t${WS}.p.clickup-attachments.com`);
  });

  // Each of these would make this server send the connection token somewhere
  // other than ClickUp's own attachments host.
  for (const [label, url] of [
    ['another host', 'https://evil.example.com/t90151491867/a.mp4'],
    ['a look-alike suffix', `https://t${WS}.p.clickup-attachments.com.evil.example/t${WS}/a.mp4`],
    ['plain http', `http://t${WS}.p.clickup-attachments.com/t${WS}/a.mp4`],
    ['credentials in the URL', `https://u:p@t${WS}.p.clickup-attachments.com/t${WS}/a.mp4`],
    ['an explicit port', `https://t${WS}.p.clickup-attachments.com:8443/t${WS}/a.mp4`],
    ['a foreign path prefix', `${HOST}/t123/a.mp4`],
    ['not a URL', 'not a url'],
  ] as const) {
    it(`refuses ${label}`, () => {
      assert.throws(() => parseAttachmentUrl(url, WS), AttachmentUrlError);
    });
  }

  it('names the right workspace when the URL belongs to another one', () => {
    assert.throws(
      () => parseAttachmentUrl('https://t42.p.clickup-attachments.com/t42/a.png', WS),
      /belongs to workspace 42/,
    );
  });

  it('refuses a non-numeric workspaceId, which would otherwise shape the host', () => {
    assert.throws(() => parseAttachmentUrl(MP4, 'evil.example#'), AttachmentUrlError);
  });
});

describe('small helpers', () => {
  it('workspaceIsVisible matches team ids as strings', () => {
    assert.equal(workspaceIsVisible({ teams: [{ id: 90151491867 }] }, WS), true);
    assert.equal(workspaceIsVisible({ teams: [{ id: '1' }] }, WS), false);
    assert.equal(workspaceIsVisible({}, WS), false);
  });

  it('attachmentFileName prefers the filename query param, else the last path segment', () => {
    assert.equal(attachmentFileName(new URL(MP4)), 'Dark-Factory demo.mp4');
    assert.equal(attachmentFileName(new URL(`${HOST}/t${WS}/x/report%20v2.pdf`)), 'report v2.pdf');
    assert.equal(attachmentFileName(new URL(`${HOST}/t${WS}/x/bad%E0.pdf`)), 'bad%E0.pdf');
  });

  it('contentDisposition keeps an ASCII fallback and the UTF-8 name', () => {
    assert.equal(
      contentDisposition('Демо 1.mp4'),
      `attachment; filename="_1.mp4"; filename*=UTF-8''${encodeURIComponent('Демо 1.mp4')}`,
    );
  });

  it('isForwardableRange accepts byte ranges only', () => {
    for (const ok of ['bytes=0-1023', 'bytes=100-', 'bytes=-500', 'bytes=0-1, 5-9']) assert.equal(isForwardableRange(ok), true, ok);
    for (const bad of ['bytes=-', 'items=0-1', 'bytes=a-b', '']) assert.equal(isForwardableRange(bad), false, bad);
  });

  it('attachmentTotalSize reads Content-Range, else a 200 Content-Length', () => {
    assert.equal(attachmentTotalSize(new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/9000' } })), 9000);
    assert.equal(attachmentTotalSize(new Response('abc', { status: 200, headers: { 'content-length': '3' } })), 3);
    assert.equal(attachmentTotalSize(new Response('x', { status: 206 })), null);
  });
});

describe('openAttachment', () => {
  const realFetch = globalThis.fetch;
  let seen: Array<{ url: string; headers: Record<string, string> }> = [];
  afterEach(() => { globalThis.fetch = realFetch; seen = []; });

  /** Answer each request with the next canned response, recording what was sent. */
  function stub(...responses: Array<() => Response>): void {
    globalThis.fetch = (async (input: any, init: any = {}) => {
      seen.push({ url: String(input), headers: { ...(init.headers ?? {}) } });
      const next = responses.shift();
      if (!next) throw new Error('unexpected extra fetch');
      return next();
    }) as typeof fetch;
  }

  const url = () => parseAttachmentUrl(MP4, WS);

  it('returns the response, sending the token and the Range header', async () => {
    stub(() => new Response('0123', { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-3/10' } }));
    const r = await openAttachment('tok', url(), { range: 'bytes=0-3' });
    assert.equal(r.ok, true);
    assert.equal(seen[0].headers.Authorization, 'Bearer tok');
    assert.equal(seen[0].headers.Range, 'bytes=0-3');
  });

  it('follows a redirect within the attachments domain', async () => {
    stub(
      () => new Response(null, { status: 302, headers: { location: 'https://cdn2.clickup-attachments.com/x.mp4' } }),
      () => new Response('ok', { status: 200, headers: { 'content-type': 'video/mp4' } }),
    );
    const r = await openAttachment('tok', url());
    assert.equal(r.ok, true);
    assert.equal(seen[1].url, 'https://cdn2.clickup-attachments.com/x.mp4');
  });

  // The reported bug: the sign-in flow was saved as the "recording".
  it('reports a redirect into the ClickUp sign-in flow as token not accepted, without following it', async () => {
    stub(() => new Response(null, {
      status: 302,
      headers: { location: `https://id.app.clickup.com/attachments/v1/data/workspaces/${WS}/utils/authz_token` },
    }));
    const r = await openAttachment('tok', url());
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 403);
    assert.match(!r.ok ? r.error : '', /did not accept this connection's token/);
    assert.equal(seen.length, 1);
  });

  it('refuses a login page served as 200 HTML', async () => {
    stub(() => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
    const r = await openAttachment('tok', url());
    assert.equal(!r.ok && r.status, 403);
  });

  it('lets an attachment that is itself an .html file through', async () => {
    stub(() => new Response('<html/>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const r = await openAttachment('tok', parseAttachmentUrl(`${HOST}/t${WS}/x/page.html`, WS));
    assert.equal(r.ok, true);
  });

  it('does not send the token to a host outside ClickUp', async () => {
    stub(() => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/x' } }));
    const r = await openAttachment('tok', url());
    assert.equal(!r.ok && r.status, 502);
    assert.equal(seen.length, 1);
  });

  it('stops after too many redirects', async () => {
    const hop = () => new Response(null, { status: 302, headers: { location: 'https://a.clickup-attachments.com/x' } });
    stub(hop, hop, hop, hop);
    const r = await openAttachment('tok', url());
    assert.equal(!r.ok && r.status, 502);
    assert.match(!r.ok ? r.error : '', /Too many redirects/);
  });

  // Never 401: on the REST plane that would read as a bad bearer.
  for (const [upstream, expected] of [[401, 403], [403, 403], [404, 404], [429, 429], [500, 502]] as const) {
    it(`maps upstream ${upstream} to ${expected}`, async () => {
      stub(() => new Response('no', { status: upstream }));
      const r = await openAttachment('tok', url());
      assert.equal(!r.ok && r.status, expected);
    });
  }

  it('passes a 416 through with its Content-Range', async () => {
    stub(() => new Response(null, { status: 416, headers: { 'content-range': 'bytes */10' } }));
    const r = await openAttachment('tok', url(), { range: 'bytes=50-60' });
    assert.equal(!r.ok && r.status, 416);
    assert.equal(!r.ok && r.contentRange, 'bytes */10');
  });

  it('reports a network failure as 502 and a caller abort as 504', async () => {
    globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    const failed = await openAttachment('tok', url());
    assert.equal(!failed.ok && failed.status, 502);

    globalThis.fetch = ((_: any, init: any) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })) as typeof fetch;
    const controller = new AbortController();
    const pending = openAttachment('tok', url(), { signal: controller.signal });
    controller.abort();
    const aborted = await pending;
    assert.equal(!aborted.ok && aborted.status, 504);
  });
});
