import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OutlineClient, diffLines } from '../../outline/apiHelpers.js';
import {
  performAddComment,
  performCommentResolution,
  performCompareRevisions,
  performImportHtmlDocument,
  performUpdateDocument,
  performUploadAttachment,
} from '../../outline/restOps.js';

// What these assert is what reaches Outline (and storage), which a caller of the
// tools cannot see: which endpoint, which body, and whether our bearer went along.

type Call = { url: string; init: RequestInit; body: any };
let calls: Call[] = [];
let respond: (call: Call) => Response | Promise<Response>;
const originalFetch = globalThis.fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    const call = { url, init, body };
    calls.push(call);
    return respond(call);
  }) as typeof globalThis.fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; OutlineClient.resolveHost = originalResolve; });

const originalResolve = OutlineClient.resolveHost;
// No real DNS in tests: every storage host resolves to a public address unless a test says otherwise.
beforeEach(() => { OutlineClient.resolveHost = async () => ['52.216.0.1']; });

const client = () => new OutlineClient('tok', 'https://wiki.example.com');
const path = (c: Call) => new URL(c.url).pathname;

describe('passage edit (findText)', () => {
  const original = '# Plan\n\nIntro line.\n\nThe **old** passage.\n\nOutro.';

  test('reads first, then sends editMode patch with findText', async () => {
    respond = (c) => path(c) === '/api/documents.info'
      ? json({ data: { id: 'd1', text: original } })
      : json({ data: { id: 'd1', text: original.replace('The **old** passage.', 'The new passage.') } });
    await performUpdateDocument(client(), 'd1', { findText: 'The **old** passage.', text: 'The new passage.', append: false });
    const update = calls.find((c) => path(c) === '/api/documents.update')!;
    assert.deepEqual(
      { editMode: update.body.editMode, findText: update.body.findText, text: update.body.text, append: update.body.append },
      { editMode: 'patch', findText: 'The **old** passage.', text: 'The new passage.', append: undefined },
    );
  });

  test('a successful patch echoed re-serialised (escapes, list markers) is verified, not mistaken for a wipe', async () => {
    respond = (c) => path(c) === '/api/documents.info'
      ? json({ data: { id: 'd1', text: original } })
      : json({ data: { id: 'd1', text: '# Plan\n\nIntro line\\.\n\n* The new\\_passage.\n\nOutro.' } });
    const doc = await performUpdateDocument(client(), 'd1', { findText: 'The **old** passage.', text: '- The new_passage.', append: false });
    assert.equal(doc.passageEditVerified, true);
    assert.equal(calls.filter((c) => path(c) === '/api/documents.update').length, 1);
  });

  test('re-reads when the answer carries no text, and reports null when that fails too', async () => {
    let infos = 0;
    respond = (c) => {
      if (path(c) === '/api/documents.info') {
        infos += 1;
        return infos === 1 ? json({ data: { id: 'd1', text: original } }) : json({ error: 'boom' }, 500);
      }
      return json({ data: { id: 'd1' } });
    };
    const doc = await performUpdateDocument(client(), 'd1', { findText: 'The **old** passage.', text: 'x', append: false });
    assert.equal(doc.passageEditVerified, null);
    assert.equal(infos, 2);
  });

  test('refuses a passage that does not occur, writing nothing', async () => {
    respond = () => json({ data: { id: 'd1', text: original } });
    await assert.rejects(
      () => performUpdateDocument(client(), 'd1', { findText: 'not there', text: 'x', append: false }),
      (e: any) => e.name === 'UserError' && /does not occur/.test(e.message),
    );
    assert.equal(calls.some((c) => path(c) === '/api/documents.update'), false);
  });

  test('refuses findText without text, and with append', async () => {
    respond = () => json({ data: { id: 'd1', text: original } });
    await assert.rejects(() => performUpdateDocument(client(), 'd1', { findText: 'Intro', append: false }), /needs text/);
    await assert.rejects(() => performUpdateDocument(client(), 'd1', { findText: 'Intro', text: 'x', append: true }), /append/);
    assert.equal(calls.length, 0);
  });

  test('an Outline that ignored patch and replaced the body gets the original written back, and the call fails', async () => {
    let updates = 0;
    respond = (c) => {
      if (path(c) === '/api/documents.info') return json({ data: { id: 'd1', text: original } });
      updates += 1;
      // First update: the old server replaced everything with the replacement.
      return json({ data: { id: 'd1', text: updates === 1 ? 'The new passage.' : original } });
    };
    await assert.rejects(
      () => performUpdateDocument(client(), 'd1', { findText: 'The **old** passage.', text: 'The new passage.', append: false }),
      (e: any) => e.status === 502 && /original text was written back/.test(e.message),
    );
    const restore = calls.filter((c) => path(c) === '/api/documents.update')[1];
    assert.deepEqual(restore.body, { id: 'd1', text: original });
  });
});

describe('uploadAttachment', () => {
  const created = (upload: Record<string, unknown>) => json({ data: { attachment: { id: 'att-1', url: '/api/attachments.redirect?id=att-1' }, ...upload } });

  test('posts the signed form to cloud storage without our bearer', async () => {
    respond = (c) => path(c) === '/api/attachments.create'
      ? created({ mode: 'post', uploadUrl: 'https://bucket.s3.amazonaws.com', form: { key: 'k1', policy: 'p' } })
      : new Response(null, { status: 204 });
    const r = await performUploadAttachment(client(), { fileName: 'a.png', contentType: 'image/png', contentBase64: 'iVBORw0KGgo=' });
    const upload = calls[1];
    assert.equal(upload.url, 'https://bucket.s3.amazonaws.com');
    assert.equal((upload.init.headers as any).Authorization, undefined);
    assert.ok(upload.body instanceof FormData);
    assert.equal((upload.body as FormData).get('key'), 'k1');
    assert.equal(r.markdown, '![a.png](/api/attachments.redirect?id=att-1)');
    assert.equal(calls[0].body.size, 8);
  });

  test('local storage (relative URL) goes to the Outline host with the bearer', async () => {
    respond = (c) => path(c) === '/api/attachments.create'
      ? created({ uploadUrl: '/api/files.create', form: { key: 'k' } })
      : json({ ok: true });
    await performUploadAttachment(client(), { fileName: 'notes.txt', contentType: 'text/plain', textContent: 'hi' });
    assert.equal(calls[1].url, 'https://wiki.example.com/api/files.create');
    assert.equal((calls[1].init.headers as any).Authorization, 'Bearer tok');
  });

  test('PUT mode sends raw bytes with the given headers', async () => {
    respond = (c) => path(c) === '/api/attachments.create'
      ? created({ mode: 'put', url: 'https://storage.example.net/obj?sig=1', headers: { 'Content-Type': 'text/plain', 'x-amz-acl': 'private' } })
      : new Response('', { status: 200 });
    await performUploadAttachment(client(), { fileName: 'n.txt', contentType: 'text/plain', textContent: 'hi' });
    assert.equal(calls[1].init.method, 'PUT');
    assert.equal((calls[1].init.headers as any)['x-amz-acl'], 'private');
  });

  test('refuses a public-looking storage host that resolves to a private address', async () => {
    OutlineClient.resolveHost = async () => ['169.254.169.254'];
    respond = () => created({ mode: 'put', url: 'https://metadata.example.com/obj' });
    await assert.rejects(
      () => performUploadAttachment(client(), { fileName: 'n.txt', contentType: 'text/plain', textContent: 'hi' }),
      /not reachable from here/,
    );
    assert.equal(calls.length, 1);
  });

  test('refuses a storage URL on a private address', async () => {
    respond = () => created({ mode: 'put', url: 'https://10.0.0.5/obj' });
    await assert.rejects(
      () => performUploadAttachment(client(), { fileName: 'n.txt', contentType: 'text/plain', textContent: 'hi' }),
      /not reachable from here/,
    );
    assert.equal(calls.length, 1);
  });

  test('refuses both or neither content field, and bad base64', async () => {
    respond = () => json({});
    await assert.rejects(() => performUploadAttachment(client(), { fileName: 'a', contentType: 'x/y' }), /exactly one/);
    await assert.rejects(() => performUploadAttachment(client(), { fileName: 'a', contentType: 'x/y', contentBase64: 'no*pe' }), /not valid base64/);
    assert.equal(calls.length, 0);
  });
});

describe('importHtmlDocument', () => {
  test('sends the HTML as a multipart file to documents.import', async () => {
    respond = () => json({ data: { id: 'd9', title: 'Imported' } });
    await performImportHtmlDocument(client(), { html: '<h1>Hi</h1>', title: 'Q3/plan', collectionId: 'col', publish: true });
    const form = calls[0].body as FormData;
    assert.equal(path(calls[0]), '/api/documents.import');
    assert.equal((calls[0].init.headers as any)['Content-Type'], undefined);
    assert.equal((form.get('file') as File).name, 'Q3 plan.html');
    assert.equal(form.get('collectionId'), 'col');
    assert.equal(form.get('publish'), 'true');
  });

  test('needs a destination', async () => {
    respond = () => json({});
    await assert.rejects(() => performImportHtmlDocument(client(), { html: '<p>x</p>', publish: true }), /collectionId or parentDocumentId/);
  });
});

describe('comments', () => {
  test('forwards anchors, and refuses a prefix without anchorText or an anchored reply', async () => {
    respond = () => json({ data: { id: 'c1', anchorText: 'deadline' } });
    await performAddComment(client(), 'd1', { text: 'Too soon?', anchorText: 'deadline', anchorPrefix: 'the ' });
    assert.deepEqual(
      { anchorText: calls[0].body.anchorText, anchorPrefix: calls[0].body.anchorPrefix },
      { anchorText: 'deadline', anchorPrefix: 'the ' },
    );
    await assert.rejects(() => performAddComment(client(), 'd1', { text: 'x', anchorSuffix: '.' }), /give anchorText/);
    await assert.rejects(() => performAddComment(client(), 'd1', { text: 'x', anchorText: 'a', parentCommentId: 'p' }), /reply/);
  });

  test('resolution is confirmed from resolvedAt, and unknown when Outline omits it', async () => {
    respond = () => json({ data: { id: 'c1', resolvedAt: '2026-01-01' } });
    assert.equal((await performCommentResolution(client(), 'resolve', 'c1')).confirmed, true);
    respond = () => json({ data: { id: 'c1', resolvedAt: '2026-01-01' } });
    assert.equal((await performCommentResolution(client(), 'unresolve', 'c1')).confirmed, false);
    respond = () => json({ data: { id: 'c1' } });
    assert.equal((await performCommentResolution(client(), 'resolve', 'c1')).confirmed, null);
  });
});

describe('revisions', () => {
  test('diffLines marks added and removed lines and collapses unchanged runs', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n');
    const after = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'H'].join('\n');
    const d = diffLines(before, after);
    assert.equal(d.added, 1);
    assert.equal(d.removed, 1);
    assert.match(d.text, /- h\n\+ H/);
    assert.match(d.text, /… \d unchanged line/);
    assert.equal(diffLines('same', 'same').text, 'No differences.');
  });

  test('a small edit in a very long document is diffed exactly, not summarised', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    const changed = [...lines];
    changed[2500] = 'edited';
    const d = diffLines(lines.join('\n'), changed.join('\n'));
    assert.equal(d.summarized, false);
    assert.deepEqual([d.added, d.removed], [1, 1]);
  });

  test('compare refuses a revision from another document', async () => {
    respond = () => json({ data: { id: 'r1', documentId: 'other', text: 'x' } });
    await assert.rejects(() => performCompareRevisions(client(), 'd1', 'r1'), /belongs to another document/);
  });

  test('compare defaults the newer side to the current document', async () => {
    respond = (c) => path(c) === '/api/revisions.info'
      ? json({ data: { id: 'r1', documentId: 'd1', text: 'one\ntwo', createdBy: { name: 'Ann' } } })
      : json({ data: { id: 'd1', text: 'one\nthree' } });
    const r = await performCompareRevisions(client(), 'd1', 'r1');
    assert.equal(r.to, 'current');
    assert.match(r.header, /by Ann.*to the current document: 1 line\(s\) added, 1 removed/);
  });
});
