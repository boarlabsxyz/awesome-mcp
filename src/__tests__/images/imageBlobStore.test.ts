import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach, before } from 'node:test';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import {
  store,
  fetch as fetchBlob,
  UnsupportedFormatError,
  ImageTooLargeError,
  getImagePublicBaseUrl,
  assertImagePublicBaseUrlConfigured,
  __setImageBlobPoolForTests,
} from '../../images/imageBlobStore.js';

// In-memory stand-in for the pg pool, emulating the two queries the store runs:
// INSERT ... ON CONFLICT (key) DO NOTHING (rowCount 1 new / 0 dup) and SELECT.
function makeFakePool() {
  const rows = new Map<string, { data: Buffer; content_type: string; bytes: number }>();
  const calls: string[] = [];
  return {
    rows,
    calls,
    query: async (text: string, params: any[] = []) => {
      calls.push(text.trim().split('\n')[0]);
      if (/INSERT INTO image_blobs/.test(text)) {
        const [key, data, content_type, bytes] = params;
        if (rows.has(key)) return { rows: [], rowCount: 0 };
        rows.set(key, { data, content_type, bytes });
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT data, content_type FROM image_blobs/.test(text)) {
        const [key] = params;
        const r = rows.get(key);
        return { rows: r ? [{ data: r.data, content_type: r.content_type }] : [] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

let pngSmall: Buffer;

before(async () => {
  process.env.IMAGE_PUBLIC_BASE_URL = 'https://host.example';
  pngSmall = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).png().toBuffer();
});

describe('IMAGE_PUBLIC_BASE_URL config', () => {
  const saved = process.env.IMAGE_PUBLIC_BASE_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.IMAGE_PUBLIC_BASE_URL;
    else process.env.IMAGE_PUBLIC_BASE_URL = saved;
    delete process.env.BASE_URL;
  });

  it('getImagePublicBaseUrl throws when unset', () => {
    delete process.env.IMAGE_PUBLIC_BASE_URL;
    assert.throws(() => getImagePublicBaseUrl(), /IMAGE_PUBLIC_BASE_URL is not set/);
  });

  it('getImagePublicBaseUrl throws when empty', () => {
    process.env.IMAGE_PUBLIC_BASE_URL = '';
    assert.throws(() => getImagePublicBaseUrl(), /IMAGE_PUBLIC_BASE_URL is not set/);
  });

  it('strips a trailing slash', () => {
    process.env.IMAGE_PUBLIC_BASE_URL = 'https://img.example/';
    assert.equal(getImagePublicBaseUrl(), 'https://img.example');
  });

  it('assertImagePublicBaseUrlConfigured throws when unset, passes when set', () => {
    delete process.env.IMAGE_PUBLIC_BASE_URL;
    assert.throws(() => assertImagePublicBaseUrlConfigured(), /IMAGE_PUBLIC_BASE_URL/);
    process.env.IMAGE_PUBLIC_BASE_URL = 'https://img.example';
    assert.doesNotThrow(() => assertImagePublicBaseUrlConfigured());
  });

  it('does NOT read BASE_URL', () => {
    delete process.env.IMAGE_PUBLIC_BASE_URL;
    process.env.BASE_URL = 'https://should-not-be-used.example';
    assert.throws(() => getImagePublicBaseUrl(), /IMAGE_PUBLIC_BASE_URL/);
  });
});

describe('imageBlobStore.store', () => {
  let pool: ReturnType<typeof makeFakePool>;

  beforeEach(() => {
    pool = makeFakePool();
    __setImageBlobPoolForTests(pool);
    process.env.IMAGE_PUBLIC_BASE_URL = 'https://host.example';
    delete process.env.IMAGE_MAX_BYTES;
  });

  afterEach(() => {
    __setImageBlobPoolForTests(null);
    delete process.env.IMAGE_MAX_BYTES;
  });

  it('recompresses to webp, hashes the stored bytes, and builds the URL', async () => {
    const r = await store(pngSmall, 'image/png');
    assert.match(r.key, /^[0-9a-f]{64}\.webp$/);
    assert.equal(r.url, `https://host.example/images/${r.key}`);
    assert.equal(r.deduped, false);
    assert.ok(r.bytes > 0);
    // stored content type is always webp
    assert.equal(pool.rows.get(r.key)?.content_type, 'image/webp');
  });

  it('dedups: the same input yields the same key and deduped=true the 2nd time', async () => {
    const first = await store(pngSmall, 'image/png');
    const second = await store(pngSmall, 'image/png');
    assert.equal(first.key, second.key);
    assert.equal(first.deduped, false);
    assert.equal(second.deduped, true);
    assert.equal(pool.rows.size, 1); // only one row physically stored
  });

  it('rejects a text file renamed .png via magic-byte detection (not Content-Type)', async () => {
    const notAnImage = Buffer.from('this is definitely not an image, regardless of the .png name');
    await assert.rejects(
      () => store(notAnImage, 'image/png'),
      (e: any) => { assert.ok(e instanceof UnsupportedFormatError); assert.equal(e.httpStatus, 415); return true; },
    );
    assert.equal(pool.calls.length, 0, 'nothing should be written for an invalid image');
  });

  it('rejects animated input (pages > 1)', async () => {
    // Minimal hand-crafted 2-frame 1x1 GIF89a.
    const animatedGif = Buffer.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61,             // "GIF89a"
      0x01, 0x00, 0x01, 0x00, 0xf0, 0x00, 0x00,       // 1x1, global color table (2 colors)
      0x00, 0x00, 0x00, 0xff, 0xff, 0xff,             // GCT: black, white
      0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, // frame 1: graphic control ext
      0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // image descriptor
      0x02, 0x02, 0x44, 0x01, 0x00,                   // LZW data
      0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, // frame 2: graphic control ext
      0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      0x02, 0x02, 0x44, 0x01, 0x00,
      0x3b,                                           // trailer
    ]);
    // sanity: confirm the fixture really is multi-page before asserting rejection
    const meta = await sharp(animatedGif).metadata();
    assert.ok((meta.pages ?? 1) > 1, `fixture should be animated, got pages=${meta.pages}`);

    await assert.rejects(
      () => store(animatedGif, 'image/gif'),
      (e: any) => { assert.ok(e instanceof UnsupportedFormatError); assert.match(e.message, /Animated/); return true; },
    );
    assert.equal(pool.calls.length, 0);
  });

  it('[size-cap fast] rejects over IMAGE_MAX_BYTES (413) and writes nothing', async () => {
    process.env.IMAGE_MAX_BYTES = '10'; // absurdly small so any real image trips it
    await assert.rejects(
      () => store(pngSmall, 'image/png'),
      (e: any) => { assert.ok(e instanceof ImageTooLargeError); assert.equal(e.httpStatus, 413); return true; },
    );
    assert.equal(pool.calls.length, 0, 'oversized image must not be written to image_blobs');
  });

  it('[size-cap slow][codec] the real 2MB default is genuinely reachable', async () => {
    // Guards against a future "resize cap dropped to 1200px" change silently
    // turning the 2MB output cap into dead code. Random noise compresses poorly,
    // so a full-size 2000x2000 image clears 2MB at q80. No IMAGE_MAX_BYTES override.
    const noise = randomBytes(2000 * 2000 * 3);
    const noisePng = await sharp(noise, { raw: { width: 2000, height: 2000, channels: 3 } })
      .png().toBuffer();
    await assert.rejects(
      () => store(noisePng, 'image/png'),
      (e: any) => { assert.ok(e instanceof ImageTooLargeError); return true; },
    );
  });
});

describe('imageBlobStore.fetch', () => {
  let pool: ReturnType<typeof makeFakePool>;
  beforeEach(() => { pool = makeFakePool(); __setImageBlobPoolForTests(pool); process.env.IMAGE_PUBLIC_BASE_URL = 'https://host.example'; });
  afterEach(() => __setImageBlobPoolForTests(null));

  it('returns null for an unknown key', async () => {
    assert.equal(await fetchBlob('deadbeef.webp'), null);
  });

  it('round-trips stored bytes + content type', async () => {
    const r = await store(pngSmall, 'image/png');
    const got = await fetchBlob(r.key);
    assert.ok(got);
    assert.equal(got!.contentType, 'image/webp');
    assert.ok(Buffer.isBuffer(got!.buffer));
    assert.equal(got!.buffer.length, r.bytes);
  });
});
