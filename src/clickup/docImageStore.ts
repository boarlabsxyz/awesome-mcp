// src/clickup/docImageStore.ts
//
// Two concerns live here now:
//
//  1. fetchImageBytes(url) — a safe OUTBOUND fetch: SSRF guards (per-redirect-hop),
//     a request timeout, and a max-response-size cap. It returns raw bytes only;
//     format validation, WebP normalization, and the size cap are the storage
//     module's job (src/images/imageBlobStore.ts store()). This is the single
//     write path for image bytes.
//
//  2. getDocImage(id) — the READ side of the legacy content-addressed-by-UUID
//     store (clickup_doc_images), kept PERMANENTLY: /images/clickup-doc/:id URLs
//     are already embedded in live ClickUp docs and must keep resolving. Nothing
//     writes to clickup_doc_images anymore (new uploads go through image_blobs),
//     but we never drop the table or this read path.

import { UserError } from 'fastmcp';
import { isDatabaseAvailable, getPool } from '../db.js';
import { validateFetchUrl, rejectPrivateAddress } from '../google-docs/apiHelpers.js';

const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB — matches the upload route's body cap
const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

// Test seam: unit tests inject a fake pool here so the (legacy read) DB path can
// be exercised without a live Postgres (ESM has no module-mocking in this runner).
// Null in production — only a test helper ever sets it.
type PoolLike = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };
let testPool: PoolLike | null = null;
export function __setDocImagePoolForTests(p: PoolLike | null): void {
  testPool = p;
}

function activePool(): PoolLike {
  return testPool ?? (getPool() as unknown as PoolLike);
}

function requireDb(): void {
  if (testPool == null && !isDatabaseAvailable()) {
    throw new UserError('ClickUp doc images require Postgres. Set DATABASE_URL and REDIS_URL.');
  }
}

/**
 * Races a promise against the shared abort deadline. The SSRF DNS lookup doesn't
 * observe the fetch AbortSignal, so without this a slow resolve could outlast
 * FETCH_TIMEOUT_MS. The abort listener is always removed once the race settles.
 */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal, url: string): Promise<T> {
  const timeoutErr = () => new UserError(`Image fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${url}`);
  if (signal.aborted) return Promise.reject(timeoutErr());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(timeoutErr());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Fetch a remote URL into a Buffer with SSRF, timeout, and max-size protections.
 * Returns raw bytes — the caller passes them to the storage module, which does
 * magic-byte validation, WebP normalization, and the post-recompression cap.
 */
export async function fetchImageBytes(url: string): Promise<Buffer> {
  // One timeout covers the whole operation — DNS/connect AND body streaming —
  // so a slow drip on the body can't hang past FETCH_TIMEOUT_MS. Cleared once
  // in the finally, never right after the headers arrive.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    // Follow redirects manually so every hop — not just the first URL — is
    // re-validated against the SSRF guards. With redirect:'follow', a 302 to
    // 169.254.169.254 or 127.0.0.1 would be fetched unchecked.
    let currentUrl = validateFetchUrl(url).toString();
    let response: Response;
    let redirects = 0;

    while (true) {
      const parsed = validateFetchUrl(currentUrl);
      // Race the SSRF DNS lookup against the same deadline as the fetch.
      await raceAbort(rejectPrivateAddress(parsed.hostname), controller.signal, url);

      try {
        response = await fetch(currentUrl, { signal: controller.signal, redirect: 'manual' });
      } catch (err: any) {
        if (err.name === 'AbortError') {
          throw new UserError(`Image fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${url}`);
        }
        throw new UserError(`Failed to fetch image from URL: ${err.message}`);
      }

      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        if (++redirects > MAX_REDIRECTS) {
          throw new UserError(`Too many redirects (>${MAX_REDIRECTS}) fetching image: ${url}`);
        }
        // Resolve relative Location against the current URL, then loop to
        // re-validate the destination before fetching it.
        currentUrl = new URL(location, currentUrl).toString();
        await response.body?.cancel().catch(() => { /* ignore */ });
        continue;
      }
      break;
    }

    if (!response.ok) {
      throw new UserError(`Failed to fetch image from URL (${response.status}): ${url}`);
    }

    // Reject early if Content-Length advertises an oversize payload.
    const contentLength = Number(response.headers.get('content-length') || '0');
    if (contentLength > MAX_IMAGE_SIZE) {
      throw new UserError(`Image too large (${contentLength} bytes, max ${MAX_IMAGE_SIZE}): ${url}`);
    }

    // Stream with size enforcement rather than trusting Content-Length. The
    // abort signal stays live here, so the timeout still applies to the body.
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const reader = response.body?.getReader();
    if (!reader) {
      throw new UserError(`No response body from URL: ${url}`);
    }
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_IMAGE_SIZE) {
          await reader.cancel().catch(() => { /* ignore */ });
          throw new UserError(`Image exceeds max size (${MAX_IMAGE_SIZE} bytes): ${url}`);
        }
        chunks.push(value);
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new UserError(`Image fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${url}`);
      }
      throw err;
    } finally {
      reader.releaseLock();
    }

    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Read a legacy image back by UUID for the permanent /images/clickup-doc/:id
 * serve route. Returns null when the id is unknown. New images are NOT written
 * here — this only serves rows created before the image_blobs migration.
 */
export async function getDocImage(id: string): Promise<{ bytes: Buffer; mime: string } | null> {
  requireDb();
  const result = await activePool().query(
    `SELECT bytes, mime FROM clickup_doc_images WHERE id = $1`,
    [id],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return { bytes: row.bytes as Buffer, mime: row.mime as string };
}
