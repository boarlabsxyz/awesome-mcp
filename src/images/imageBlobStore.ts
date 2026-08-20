// src/images/imageBlobStore.ts
//
// Content-addressed image blob store. This is the ONLY module that touches the
// `image_blobs` table (no SQL for it anywhere else). It is deliberately narrow —
// store()/fetch() — so the backend can be swapped for Cloudflare R2 later by
// re-implementing just these two functions. Everything that hosts image bytes in
// this codebase must go through here.
//
// Normalization: every input is recompressed to WebP q80 with the long edge
// capped at 2000px, regardless of what the client sent. The storage key is the
// sha256 of the STORED (post-recompression) bytes plus a `.webp` extension, so
// identical images dedup and a given URL's bytes can never change (safe to cache
// immutably forever).
//
// Retention: blobs are permanent by default. A caller may pass
// { ephemeral: true } to opt into expiry after IMAGE_RETENTION_DAYS, which the
// scheduler here sweeps. Expiry is a property of the use case, not the bytes —
// see StoreOptions.ephemeral for why a single global TTL would break ClickUp.
//
// Public interface (do not widen without good reason):
//   store(buffer, declaredMime, opts?) -> { key, url, bytes, deduped }
//   fetch(key)                         -> { buffer, contentType } | null

import { createHash } from 'crypto';
import sharp from 'sharp';
import { isDatabaseAvailable, getPool } from '../db.js';

// --- Tunables ---------------------------------------------------------------

const LONG_EDGE = 2000;              // cap the long edge (px) at recompress time
const WEBP_QUALITY = 80;

// Decompression-bomb guard: a tiny file can decode to enormous pixel dimensions.
// This bounds what sharp will even attempt to decode. Together with the request
// body cap in the route, this is the real memory/DoS protection.
const INPUT_PIXEL_LIMIT = 100_000_000; // 100 megapixels

// Everything is stored as WebP. Exported so routes can report it without
// re-deriving the string (store()'s return stays exactly {key,url,bytes,deduped}).
export const STORED_CONTENT_TYPE = 'image/webp';

// Storage-hygiene cap on the *output* — NOT a security control. The DoS guard is
// the request-body limit in the route (bytes are rejected before decode) plus
// INPUT_PIXEL_LIMIT above. Do not remove the input-side caps on the assumption
// that this output cap covers them: by the time we're here the input has already
// been decoded, which is where the memory cost lives.
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // 2 MB
const HARD_MAX_OUTPUT_BYTES = 20 * 1024 * 1024;   // clamp so IMAGE_MAX_BYTES can't foot-gun

function maxOutputBytes(): number {
  const raw = Number(process.env.IMAGE_MAX_BYTES);
  const val = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_OUTPUT_BYTES;
  return Math.min(val, HARD_MAX_OUTPUT_BYTES);
}

// --- Typed errors (mapped to HTTP status by the route) ----------------------

export class UnsupportedFormatError extends Error {
  readonly httpStatus = 415;
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedFormatError';
  }
}

export class ImageTooLargeError extends Error {
  readonly httpStatus = 413;
  constructor(message: string) {
    super(message);
    this.name = 'ImageTooLargeError';
  }
}

// --- Format detection via magic bytes (never trust Content-Type) ------------

type InputFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'bmp';

function sniffFormat(b: Buffer): InputFormat | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif'; // "GIF8"
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp'; // "BM"
  if (
    b.length >= 12 &&
    b.toString('ascii', 0, 4) === 'RIFF' &&
    b.toString('ascii', 8, 12) === 'WEBP'
  ) return 'webp';
  return null;
}

// --- Pool access + test seam ------------------------------------------------
// Unit tests inject a fake pool so the DB-backed paths run without a live
// Postgres (this test runner has no ESM module mocking). Null in production —
// only a test helper ever sets it.
type PoolLike = { query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
let testPool: PoolLike | null = null;
export function __setImageBlobPoolForTests(p: PoolLike | null): void {
  testPool = p;
}

function pool(): PoolLike {
  if (testPool) return testPool;
  if (!isDatabaseAvailable()) {
    throw new Error('image_blobs storage requires Postgres. Set DATABASE_URL.');
  }
  return getPool() as unknown as PoolLike;
}

// Public base URL for hosting images. This is the ONLY reader of
// IMAGE_PUBLIC_BASE_URL (a dedicated var — we deliberately do NOT reuse BASE_URL,
// which serves an unrelated purpose). Nothing else in the codebase builds image
// URLs. The trailing slash is stripped on read so config like
// "https://img.example/" normalizes to "https://img.example".
function readImagePublicBaseUrl(): string {
  return (process.env.IMAGE_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
}

/**
 * Returns the validated public base URL, throwing if it is unset/empty. A bad
 * value would get permanently embedded in ClickUp docs, so this must never
 * silently produce a relative or empty URL.
 */
export function getImagePublicBaseUrl(): string {
  const base = readImagePublicBaseUrl();
  if (!base) {
    throw new Error('IMAGE_PUBLIC_BASE_URL is not set — it must be a non-empty public base URL for hosting images.');
  }
  return base;
}

/**
 * Startup guard: throws immediately if IMAGE_PUBLIC_BASE_URL is unset/empty.
 * Call once during boot so a misconfigured deploy fails fast instead of
 * deferring the failure (or a bad URL) to the first upload.
 */
export function assertImagePublicBaseUrlConfigured(): void {
  getImagePublicBaseUrl();
}

// --- Public API -------------------------------------------------------------

export interface StoreResult {
  key: string;
  url: string;
  bytes: number;
  deduped: boolean;
}

export interface StoreOptions {
  /**
   * Mark this blob as short-lived, so the pruner can delete it after
   * IMAGE_RETENTION_DAYS.
   *
   * Opt-in, never the default: a caller whose URL is re-fetched for the life of
   * the document it's embedded in (ClickUp Docs) must NOT set this, or the
   * image 404s the day it expires. Set it only where the URL is consumed once —
   * Slack's downloadFile, whose link is handed to insertImageFromUrl and copied
   * into the Google Doc at insert time.
   */
  ephemeral?: boolean;
}

const DEFAULT_RETENTION_DAYS = 30;

// Date spans ±8.64e15 ms from the epoch — 1e8 days — so any retention at or
// above that makes `new Date(now + days)` Invalid. It is finite and
// non-negative, so it passes a naive range check, and store() then hands the
// Invalid Date to the driver, where toISOString() throws
// "RangeError: Invalid time value". The caller sees "Could not host this image"
// with an opaque cause instead of a retention policy. 100,000 years is far past
// any real intent and comfortably inside Date's range.
const MAX_RETENTION_DAYS = 36_500_000;

/**
 * How long an ephemeral blob lives. `IMAGE_RETENTION_DAYS` (default 30);
 * set it to 0 to disable expiry entirely and restore the previous
 * keep-everything-forever behaviour.
 */
export function imageRetentionDays(): number {
  // Trim and reject blank BEFORE Number(): Number('') and Number('   ') are both
  // 0, which passes the finite/non-negative check and silently disables expiry.
  // A declared-but-empty env var is common in container configs, and failing
  // that way would turn retention off exactly where it's most wanted.
  const configured = (process.env.IMAGE_RETENTION_DAYS ?? '').trim();
  if (configured === '') return DEFAULT_RETENTION_DAYS;
  const raw = Number(configured);
  if (Number.isFinite(raw) && raw >= 0 && raw <= MAX_RETENTION_DAYS) return raw;
  return DEFAULT_RETENTION_DAYS;
}

/**
 * Recompress `buffer` to WebP, persist it under a content-hash key, and return
 * the key/url. `declaredMime` is accepted for interface symmetry but is
 * intentionally ignored — the real format is detected from the bytes.
 */
export async function store(buffer: Buffer, declaredMime: string, opts?: StoreOptions): Promise<StoreResult> {
  void declaredMime; // never trusted; real format comes from magic bytes below

  const format = sniffFormat(buffer);
  if (!format) {
    throw new UnsupportedFormatError('Unsupported image format (expected png, jpeg, webp, gif, or bmp).');
  }

  // Read metadata (also a second decode-level validity check) and reject
  // animated input. Frame count isn't constrained by the long-edge resize, so a
  // small-dimension many-frame animation can blow past every size assumption.
  // Deliberate choice: doc images are screenshots/diagrams — we reject animation
  // rather than silently flatten to the first frame.
  let meta: sharp.Metadata;
  try {
    meta = await sharp(buffer, { limitInputPixels: INPUT_PIXEL_LIMIT }).metadata();
  } catch {
    throw new UnsupportedFormatError('Image could not be decoded.');
  }
  if ((meta.pages ?? 1) > 1) {
    throw new UnsupportedFormatError('Animated images are not supported.');
  }

  const webp = await sharp(buffer, { limitInputPixels: INPUT_PIXEL_LIMIT })
    .rotate() // honor EXIF orientation before metadata is stripped
    .resize(LONG_EDGE, LONG_EDGE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();

  const cap = maxOutputBytes();
  if (webp.length > cap) {
    throw new ImageTooLargeError(`Recompressed image is ${webp.length} bytes, over the ${cap}-byte cap.`);
  }

  const key = `${createHash('sha256').update(webp).digest('hex')}.webp`;

  // null = keep forever. Reached either because the caller didn't opt in, or
  // because the operator set IMAGE_RETENTION_DAYS=0 to disable expiry.
  const retentionDays = opts?.ephemeral ? imageRetentionDays() : 0;
  const expiresAt = retentionDays > 0
    ? new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000)
    : null;

  // ON CONFLICT DO NOTHING dedups atomically: rowCount is 1 when we inserted a
  // new blob, 0 when the identical bytes were already stored.
  const result = await pool().query(
    `INSERT INTO image_blobs (key, data, content_type, bytes, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (key) DO NOTHING`,
    [key, webp, STORED_CONTENT_TYPE, webp.length, expiresAt],
  );
  const deduped = (result.rowCount ?? 0) === 0;

  // Reconcile lifetimes when these bytes were already stored. Content-addressing
  // means one row can back several uses with different lifetimes, so the longest
  // one has to win — expiring a blob that a ClickUp Doc still renders would be a
  // silent 404 on someone else's page.
  if (deduped) {
    if (expiresAt === null) {
      // A permanent use promotes the row, dropping any expiry it carried. The
      // IS NOT NULL guard makes the common case (already permanent) a no-op
      // rather than rewriting the row — and these rows hold megabytes of BYTEA.
      await pool().query(
        'UPDATE image_blobs SET expires_at = NULL WHERE key = $1 AND expires_at IS NOT NULL',
        [key],
      );
    } else {
      // Extend only. Never shortens a row, and the IS NOT NULL guard means a
      // permanent row is never demoted to an expiring one.
      await pool().query(
        `UPDATE image_blobs SET expires_at = $2
         WHERE key = $1 AND expires_at IS NOT NULL AND expires_at < $2`,
        [key, expiresAt],
      );
    }
  }

  return { key, url: `${getImagePublicBaseUrl()}/images/${key}`, bytes: webp.length, deduped };
}

export interface FetchResult {
  buffer: Buffer;
  contentType: string;
}

/** Read stored bytes back by key. Returns null when the key is unknown. */
export async function fetch(key: string): Promise<FetchResult | null> {
  // Expiry is enforced here, not left to the pruner. The sweep runs every few
  // hours, so a row can sit lapsed-but-present for most of a day; serving it in
  // that window would quietly extend the exposure the retention policy exists
  // to bound. pruneExpiredImageBlobs() then only reclaims storage.
  const result = await pool().query(
    `SELECT data, content_type FROM image_blobs
     WHERE key = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
    [key],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return { buffer: row.data as Buffer, contentType: row.content_type as string };
}

// --- Retention ---------------------------------------------------------------

/**
 * Delete blobs whose expiry has passed. Permanent rows (expires_at IS NULL) are
 * never touched, which is what keeps ClickUp Doc images alive.
 *
 * Bounded by the partial index on expires_at, so the scan only ever visits
 * expiring rows.
 */
export async function pruneExpiredImageBlobs(): Promise<number> {
  const result = await pool().query(
    'DELETE FROM image_blobs WHERE expires_at IS NOT NULL AND expires_at < NOW()',
  );
  return result.rowCount ?? 0;
}

let retentionTimer: NodeJS.Timeout | null = null;

// IMAGE_PRUNE_INTERVAL_MS (default 6h, clamped up to a 1h minimum). Same shape
// as the ClickUp and Slack event pruners — this is periodic hygiene, not a
// real-time job, and a blob living a few extra hours is not a new risk.
// setInterval overflows past a signed 32-bit delay: Node clamps anything larger
// to 1ms and warns, turning a "prune monthly" config into a hot loop. Cap it.
const MAX_TIMER_MS = 2_147_483_647; // ~24.8 days

function readPruneIntervalMs(): number {
  const raw = parseInt(process.env.IMAGE_PRUNE_INTERVAL_MS || '', 10);
  if (Number.isFinite(raw) && raw >= 3_600_000) return Math.min(raw, MAX_TIMER_MS);
  return 6 * 60 * 60 * 1000;
}

/** Safe to call more than once; the second call is a no-op. */
export function startImageBlobRetentionScheduler(): void {
  if (retentionTimer) return;
  if (!isDatabaseAvailable()) return;
  const intervalMs = readPruneIntervalMs();

  const runOnce = async () => {
    try {
      const deleted = await pruneExpiredImageBlobs();
      if (deleted > 0) console.error(`[image-blobs] pruned ${deleted} expired blob(s)`);
    } catch (err: any) {
      console.error('[image-blobs] prune failure:', err?.message || err);
    }
  };

  retentionTimer = setInterval(runOnce, intervalMs);
  retentionTimer.unref();
  // Initial sweep so a container booting after a long outage doesn't wait a
  // full interval for the first cleanup.
  void runOnce();
}

export function stopImageBlobRetentionScheduler(): void {
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
}
