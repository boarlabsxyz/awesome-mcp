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
  pruneExpiredImageBlobs,
  imageRetentionDays,
} from '../../images/imageBlobStore.js';

// In-memory stand-in for the pg pool, emulating the queries the store runs:
// INSERT ... ON CONFLICT (key) DO NOTHING (rowCount 1 new / 0 dup), SELECT, the
// two expiry-reconciliation UPDATEs, and the retention DELETE.
type FakeRow = { data: Buffer; content_type: string; bytes: number; expires_at: Date | null };

function makeFakePool() {
  const rows = new Map<string, FakeRow>();
  const calls: string[] = [];
  return {
    rows,
    calls,
    query: async (text: string, params: any[] = []) => {
      calls.push(text.trim().split('\n')[0]);
      if (/INSERT INTO image_blobs/.test(text)) {
        const [key, data, content_type, bytes, expires_at] = params;
        if (rows.has(key)) return { rows: [], rowCount: 0 };
        rows.set(key, { data, content_type, bytes, expires_at: expires_at ?? null });
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE image_blobs SET expires_at = NULL/.test(text)) {
        const [key] = params;
        const r = rows.get(key);
        if (!r) return { rows: [], rowCount: 0 };
        r.expires_at = null;
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE image_blobs SET expires_at = \$2/.test(text)) {
        const [key, next] = params;
        const r = rows.get(key);
        // Mirrors the WHERE clause: only extends, never touches a permanent row.
        if (!r || r.expires_at === null || !(r.expires_at < next)) return { rows: [], rowCount: 0 };
        r.expires_at = next;
        return { rows: [], rowCount: 1 };
      }
      if (/DELETE FROM image_blobs WHERE expires_at IS NOT NULL/.test(text)) {
        const now = new Date();
        let deleted = 0;
        for (const [key, r] of [...rows.entries()]) {
          if (r.expires_at !== null && r.expires_at < now) { rows.delete(key); deleted++; }
        }
        return { rows: [], rowCount: deleted };
      }
      if (/SELECT data, content_type FROM image_blobs/.test(text)) {
        const [key] = params;
        const r = rows.get(key);
        // Mirrors the query's expiry guard: a lapsed row is not served.
        const live = r && (r.expires_at === null || r.expires_at > new Date());
        return { rows: live ? [{ data: r.data, content_type: r.content_type }] : [] };
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

// Retention. The invariant that matters: expiry is opt-in per call site,
// because ClickUp Doc images are re-fetched by ClickUp's renderer on every page
// view and must never be pruned, while a Slack image handed to
// insertImageFromUrl is fetched once and shouldn't linger publicly forever.
describe('image blob retention', () => {
  let pool: ReturnType<typeof makeFakePool>;
  const savedDays = process.env.IMAGE_RETENTION_DAYS;

  beforeEach(() => {
    pool = makeFakePool();
    __setImageBlobPoolForTests(pool);
    process.env.IMAGE_PUBLIC_BASE_URL = 'https://host.example';
    delete process.env.IMAGE_RETENTION_DAYS;
  });

  afterEach(() => {
    __setImageBlobPoolForTests(null);
    if (savedDays === undefined) delete process.env.IMAGE_RETENTION_DAYS;
    else process.env.IMAGE_RETENTION_DAYS = savedDays;
  });

  const only = () => [...pool.rows.values()][0];

  it('stores permanently by default, so existing callers are unaffected', async () => {
    const { key } = await store(pngSmall, 'image/png');
    assert.equal(pool.rows.get(key)!.expires_at, null);
  });

  it('sets an expiry when the caller opts in', async () => {
    const before = Date.now();
    await store(pngSmall, 'image/png', { ephemeral: true });
    const expiry = only().expires_at!;
    assert.ok(expiry instanceof Date);
    const days = (expiry.getTime() - before) / 86_400_000;
    assert.ok(days > 29.9 && days < 30.1, `expected ~30 days, got ${days}`);
  });

  it('honours IMAGE_RETENTION_DAYS', async () => {
    process.env.IMAGE_RETENTION_DAYS = '7';
    const before = Date.now();
    await store(pngSmall, 'image/png', { ephemeral: true });
    const days = (only().expires_at!.getTime() - before) / 86_400_000;
    assert.ok(days > 6.9 && days < 7.1, `expected ~7 days, got ${days}`);
  });

  it('treats IMAGE_RETENTION_DAYS=0 as "never expire"', async () => {
    process.env.IMAGE_RETENTION_DAYS = '0';
    await store(pngSmall, 'image/png', { ephemeral: true });
    assert.equal(only().expires_at, null);
  });

  it('a permanent use promotes an already-expiring blob to permanent', async () => {
    // The ClickUp-breaks-silently case: same bytes stored first by Slack, then
    // embedded in a ClickUp Doc. The doc must not 404 in 30 days.
    const { key } = await store(pngSmall, 'image/png', { ephemeral: true });
    assert.ok(pool.rows.get(key)!.expires_at instanceof Date);

    const again = await store(pngSmall, 'image/png');
    assert.equal(again.deduped, true);
    assert.equal(pool.rows.get(key)!.expires_at, null, 'permanent use must win');
  });

  it('an ephemeral use never demotes a permanent blob', async () => {
    const { key } = await store(pngSmall, 'image/png');
    await store(pngSmall, 'image/png', { ephemeral: true });
    assert.equal(pool.rows.get(key)!.expires_at, null, 'permanent must stay permanent');
  });

  it('extends an existing expiry rather than shortening it', async () => {
    process.env.IMAGE_RETENTION_DAYS = '1';
    const { key } = await store(pngSmall, 'image/png', { ephemeral: true });
    const short = pool.rows.get(key)!.expires_at!;

    process.env.IMAGE_RETENTION_DAYS = '30';
    await store(pngSmall, 'image/png', { ephemeral: true });
    const long = pool.rows.get(key)!.expires_at!;
    assert.ok(long > short, 'a later expiry should extend the row');

    process.env.IMAGE_RETENTION_DAYS = '1';
    await store(pngSmall, 'image/png', { ephemeral: true });
    assert.equal(pool.rows.get(key)!.expires_at!.getTime(), long.getTime(), 'must not shorten');
  });

  it('still reports dedup correctly with expiry reconciliation in play', async () => {
    const first = await store(pngSmall, 'image/png', { ephemeral: true });
    const second = await store(pngSmall, 'image/png', { ephemeral: true });
    assert.equal(first.deduped, false);
    assert.equal(second.deduped, true);
    assert.equal(first.key, second.key);
  });

  it('prunes only lapsed rows, leaving permanent and future ones alone', async () => {
    const permanent = { data: Buffer.from('a'), content_type: 'image/webp', bytes: 1, expires_at: null };
    const lapsed = { data: Buffer.from('b'), content_type: 'image/webp', bytes: 1, expires_at: new Date(Date.now() - 1000) };
    const future = { data: Buffer.from('c'), content_type: 'image/webp', bytes: 1, expires_at: new Date(Date.now() + 86_400_000) };
    pool.rows.set('perm.webp', permanent);
    pool.rows.set('lapsed.webp', lapsed);
    pool.rows.set('future.webp', future);

    const deleted = await pruneExpiredImageBlobs();
    assert.equal(deleted, 1);
    assert.ok(pool.rows.has('perm.webp'), 'permanent blobs must survive — ClickUp still renders them');
    assert.ok(pool.rows.has('future.webp'));
    assert.ok(!pool.rows.has('lapsed.webp'));
  });

  it('a pruned blob reads back as a miss, not a crash', async () => {
    process.env.IMAGE_RETENTION_DAYS = '1';
    const { key } = await store(pngSmall, 'image/png', { ephemeral: true });
    pool.rows.get(key)!.expires_at = new Date(Date.now() - 1000);
    await pruneExpiredImageBlobs();
    assert.equal(await fetchBlob(key), null);
  });
});

// Regressions from review of the retention PR. Each of these was a way the
// stated policy and the enforced behaviour could drift apart.
describe('image blob retention — config and enforcement edges', () => {
  let pool: ReturnType<typeof makeFakePool>;
  const savedDays = process.env.IMAGE_RETENTION_DAYS;

  beforeEach(() => {
    pool = makeFakePool();
    __setImageBlobPoolForTests(pool);
    process.env.IMAGE_PUBLIC_BASE_URL = 'https://host.example';
    delete process.env.IMAGE_RETENTION_DAYS;
  });

  afterEach(() => {
    __setImageBlobPoolForTests(null);
    if (savedDays === undefined) delete process.env.IMAGE_RETENTION_DAYS;
    else process.env.IMAGE_RETENTION_DAYS = savedDays;
  });

  it('treats a blank IMAGE_RETENTION_DAYS as unset, not as 0', () => {
    // Number('') === 0, which would pass a naive finite/non-negative check and
    // silently disable retention. A declared-but-empty var is common in
    // container configs, so this must fall back to the default.
    for (const blank of ['', '   ', '\t\n']) {
      process.env.IMAGE_RETENTION_DAYS = blank;
      assert.equal(imageRetentionDays(), 30, `blank ${JSON.stringify(blank)} should mean "unset"`);
    }
  });

  it('still honours an explicit 0 as "disable expiry"', () => {
    process.env.IMAGE_RETENTION_DAYS = '0';
    assert.equal(imageRetentionDays(), 0);
    process.env.IMAGE_RETENTION_DAYS = ' 0 ';
    assert.equal(imageRetentionDays(), 0, 'surrounding whitespace should not change the meaning');
  });

  it('falls back to the default for junk and negatives', () => {
    for (const bad of ['abc', '-1', 'NaN']) {
      process.env.IMAGE_RETENTION_DAYS = bad;
      assert.equal(imageRetentionDays(), 30, `${bad} should fall back`);
    }
  });

  it('rejects finite values too large to express as a date', () => {
    // 1e308 is finite and non-negative, so it passes a naive range check — but
    // Date spans only 1e8 days, so new Date(now + days) is Invalid and the pg
    // driver throws "Invalid time value" from inside store(). Must fall back
    // before the value ever reaches store().
    for (const absurd of ['1e308', '1e8', '100000000', '1e9']) {
      process.env.IMAGE_RETENTION_DAYS = absurd;
      assert.equal(imageRetentionDays(), 30, `${absurd} should fall back`);
    }
  });

  it('still accepts a large but expressible retention', () => {
    process.env.IMAGE_RETENTION_DAYS = '36500';  // 100 years
    assert.equal(imageRetentionDays(), 36500);
  });

  it('every accepted value yields a valid expiry date in store()', async () => {
    // The property the cap exists to guarantee: whatever imageRetentionDays()
    // returns must survive new Date(...).toISOString() in the driver.
    for (const value of ['1e308', '1e9', '36500', '30', '0.5']) {
      process.env.IMAGE_RETENTION_DAYS = value;
      const days = imageRetentionDays();
      const expiry = new Date(Date.now() + days * 86_400_000);
      assert.doesNotThrow(() => expiry.toISOString(), `days=${days} from ${value} must be expressible`);
    }
  });

  it('accepts a whitespace-padded number', () => {
    process.env.IMAGE_RETENTION_DAYS = '  7  ';
    assert.equal(imageRetentionDays(), 7);
  });

  it('does not serve a lapsed blob even before the pruner runs', async () => {
    // The sweep is hours apart, so read-time enforcement is what actually
    // bounds exposure; without it a URL keeps working most of a day past expiry.
    process.env.IMAGE_RETENTION_DAYS = '1';
    const { key } = await store(pngSmall, 'image/png', { ephemeral: true });
    assert.ok(await fetchBlob(key), 'still live before expiry');

    pool.rows.get(key)!.expires_at = new Date(Date.now() - 1000);
    assert.equal(await fetchBlob(key), null, 'a lapsed row must not be served');
    assert.ok(pool.rows.has(key), 'and it is still physically present — pruning is separate');
  });

  it('keeps serving a permanent blob and one whose expiry is in the future', async () => {
    const permanent = await store(pngSmall, 'image/png');
    assert.ok(await fetchBlob(permanent.key));

    pool.rows.get(permanent.key)!.expires_at = new Date(Date.now() + 86_400_000);
    assert.ok(await fetchBlob(permanent.key), 'a future expiry is not yet an expiry');
  });
});
