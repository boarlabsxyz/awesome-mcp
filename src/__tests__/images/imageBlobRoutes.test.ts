import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';
import sharp from 'sharp';
import { registerImageBlobRoutes } from '../../website/webServer.js';
import { __setImageBlobPoolForTests } from '../../images/imageBlobStore.js';

const TOKEN = 'test-upload-token';

// In-memory pg stand-in (INSERT ON CONFLICT + SELECT), shared by store()/fetch().
function makeFakePool() {
  const rows = new Map<string, { data: Buffer; content_type: string }>();
  return {
    rows,
    query: async (text: string, params: any[] = []) => {
      if (/INSERT INTO image_blobs/.test(text)) {
        const [key, data, content_type] = params;
        if (rows.has(key)) return { rows: [], rowCount: 0 };
        rows.set(key, { data, content_type });
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT data, content_type FROM image_blobs/.test(text)) {
        const r = rows.get(params[0]);
        return { rows: r ? [{ data: r.data, content_type: r.content_type }] : [] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

let server: ReturnType<express.Express['listen']>;
let base: string;
let png: Buffer;

before(async () => {
  process.env.IMAGE_PUBLIC_BASE_URL = 'https://host.example';
  process.env.IMAGE_UPLOAD_TOKEN = TOKEN;
  __setImageBlobPoolForTests(makeFakePool());
  png = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .png().toBuffer();

  const app = express();
  registerImageBlobRoutes(app);
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server?.close();
  __setImageBlobPoolForTests(null);
});

function upload(body: Buffer, token: string | null = TOKEN) {
  const headers: Record<string, string> = { 'content-type': 'application/octet-stream' };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}/images/upload`, { method: 'POST', headers, body });
}

describe('POST /images/upload', () => {
  it('201s with url/key/bytes/contentType/deduped for a valid image', async () => {
    const res = await upload(png);
    assert.equal(res.status, 201);
    const body: any = await res.json();
    assert.match(body.key, /^[0-9a-f]{64}\.webp$/);
    assert.equal(body.url, `https://host.example/images/${body.key}`);
    assert.equal(body.contentType, 'image/webp');
    assert.equal(body.deduped, false);
    assert.ok(body.bytes > 0);
  });

  it('reports deduped=true on the second identical upload', async () => {
    const first: any = await (await upload(png)).json();
    const res = await upload(png);
    const second: any = await res.json();
    assert.equal(res.status, 201);
    assert.equal(second.key, first.key);
    assert.equal(second.deduped, true);
  });

  it('401s with no token', async () => {
    assert.equal((await upload(png, null)).status, 401);
  });

  it('401s with a wrong token', async () => {
    assert.equal((await upload(png, 'nope')).status, 401);
  });

  it('415s a text file (magic-byte validation, not Content-Type)', async () => {
    const res = await upload(Buffer.from('not an image'));
    assert.equal(res.status, 415);
  });

  it('413s a body over the 20MB input cap, before decode', async () => {
    // No image fixture needed — the raw-body limit rejects this pre-decode.
    const res = await upload(Buffer.alloc(21_000_000));
    assert.equal(res.status, 413);
  });

  it('401s (not 413) an oversized body with no token — auth runs before buffering', async () => {
    const res = await upload(Buffer.alloc(21_000_000), null);
    assert.equal(res.status, 401);
  });
});

describe('GET /images/:key', () => {
  it('streams bytes with webp type, nosniff, immutable cache, and an ETag', async () => {
    const { key }: any = await (await upload(png)).json();
    const res = await fetch(`${base}/images/${key}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/webp');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('cache-control') || '', /immutable/);
    assert.equal(res.headers.get('etag'), `"${key}"`);
    assert.ok((await res.arrayBuffer()).byteLength > 0);
  });

  it('304s when If-None-Match matches the key', async () => {
    const { key }: any = await (await upload(png)).json();
    const res = await fetch(`${base}/images/${key}`, { headers: { 'if-none-match': `"${key}"` } });
    assert.equal(res.status, 304);
  });

  it('404s an unknown key', async () => {
    assert.equal((await fetch(`${base}/images/does-not-exist.webp`)).status, 404);
  });
});
