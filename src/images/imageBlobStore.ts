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
// Public interface (do not widen without good reason):
//   store(buffer, declaredMime) -> { key, url, bytes, deduped }
//   fetch(key)                  -> { buffer, contentType } | null

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

/**
 * Recompress `buffer` to WebP, persist it under a content-hash key, and return
 * the key/url. `declaredMime` is accepted for interface symmetry but is
 * intentionally ignored — the real format is detected from the bytes.
 */
export async function store(buffer: Buffer, declaredMime: string): Promise<StoreResult> {
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

  // ON CONFLICT DO NOTHING dedups atomically: rowCount is 1 when we inserted a
  // new blob, 0 when the identical bytes were already stored.
  const result = await pool().query(
    `INSERT INTO image_blobs (key, data, content_type, bytes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO NOTHING`,
    [key, webp, STORED_CONTENT_TYPE, webp.length],
  );
  const deduped = (result.rowCount ?? 0) === 0;

  return { key, url: `${getImagePublicBaseUrl()}/images/${key}`, bytes: webp.length, deduped };
}

export interface FetchResult {
  buffer: Buffer;
  contentType: string;
}

/** Read stored bytes back by key. Returns null when the key is unknown. */
export async function fetch(key: string): Promise<FetchResult | null> {
  const result = await pool().query(
    `SELECT data, content_type FROM image_blobs WHERE key = $1`,
    [key],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return { buffer: row.data as Buffer, contentType: row.content_type as string };
}
