// src/clickup/docImageStore.ts
//
// Image-hosting store for ClickUp Docs. ClickUp's Doc pages render markdown, so
// an image is placed by embedding `![alt](url)` — but that needs a publicly
// reachable URL. ClickUp's own `/v1/attachment` upload route requires a browser
// session JWT we don't have (this server authenticates ClickUp with a per-user
// OAuth token), so instead we re-host the image ourselves: store the bytes in
// Postgres and serve them from a public Express route under BASE_URL.
//
// Postgres-only — image blobs don't belong in the JSON file fallback. The tools
// that call this surface a clear UserError when DATABASE_URL isn't set.
//
// Public API:
//   fetchRemoteImage(url)          — SSRF-guarded, size-capped fetch of a remote image
//   storeDocImage(bytes, mime, by) — persist bytes, return an unguessable id
//   getDocImage(id)                — read bytes + mime back (for the serve route)

import { randomUUID } from 'crypto';
import { UserError } from 'fastmcp';
import { isDatabaseAvailable, getPool } from '../db.js';
import { validateFetchUrl, rejectPrivateAddress } from '../google-docs/apiHelpers.js';

// The clickup_doc_images table schema lives in src/db.ts alongside the other
// ClickUp tables (that's where this repo keeps its migrations), created during
// initDatabase().

const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB
const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

// Extension → MIME, mirroring src/google-docs/apiHelpers.ts. Used as a fallback
// when the response has no usable Content-Type. SVG is intentionally excluded:
// we serve these bytes back from our own origin, and SVG can carry active
// content (scripts), so re-hosting one would be stored XSS. Raster types only.
const MIME_BY_EXT: { [key: string]: string } = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
};

function requireDb(): void {
  if (!isDatabaseAvailable()) {
    throw new UserError('ClickUp doc images require Postgres. Set DATABASE_URL and REDIS_URL.');
  }
}

/**
 * Fail fast if the image store isn't usable, so callers can validate before
 * spending a network fetch / creating an orphan row.
 */
export function assertDocImagesReady(): void {
  requireDb();
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
 * Fetch a remote image with the same SSRF and size protections used by the
 * Google Docs image path. Returns the raw bytes and a best-effort MIME type.
 */
export async function fetchRemoteImage(url: string): Promise<{ bytes: Buffer; mime: string }> {
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
    let finalUrl = new URL(currentUrl);
    let response: Response;
    let redirects = 0;

    while (true) {
      const parsed = validateFetchUrl(currentUrl);
      // Race the SSRF DNS lookup against the same deadline as the fetch.
      await raceAbort(rejectPrivateAddress(parsed.hostname), controller.signal, url);
      finalUrl = parsed;

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

    const bytes = Buffer.concat(chunks.map((c) => Buffer.from(c)));

    // Derive MIME: trust the server's declared Content-Type when it names an
    // image type (it's more authoritative than a spoofable URL extension, and
    // this is what catches an image/svg+xml body served from a ".png" URL). Fall
    // back to the extension only when the header is absent or generic (many CDNs
    // send application/octet-stream for images).
    const path = await import('path');
    const ext = path.extname(finalUrl.pathname).toLowerCase();
    const headerMime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const mime = (headerMime.startsWith('image/') ? headerMime : (MIME_BY_EXT[ext] || headerMime)) || 'application/octet-stream';

    // Block SVG explicitly: a .svg extension or an image/svg+xml Content-Type
    // must not establish image validity, since we'd re-serve it from our own
    // origin (stored XSS). Only the raster types in MIME_BY_EXT are allowed.
    if (mime === 'image/svg+xml') {
      throw new UserError(`SVG images are not supported (they can carry active content): ${url}`);
    }
    if (!mime.startsWith('image/')) {
      throw new UserError(`URL did not return an image (resolved type: ${mime || 'unknown'}): ${url}`);
    }

    return { bytes, mime };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Persist image bytes and return an unguessable id used to build the public URL.
 */
export async function storeDocImage(
  bytes: Buffer,
  mime: string,
  createdBy?: string,
): Promise<{ id: string }> {
  requireDb();
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO clickup_doc_images (id, bytes, mime, byte_size, created_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, bytes, mime, bytes.length, createdBy ?? null],
  );
  return { id };
}

/**
 * Delete a stored image row. Used to clean up an orphan when the downstream
 * page edit fails after the bytes were already persisted. Best-effort.
 */
export async function deleteDocImage(id: string): Promise<void> {
  requireDb();
  await getPool().query(`DELETE FROM clickup_doc_images WHERE id = $1`, [id]);
}

/**
 * Read stored image bytes + MIME back. Returns null when the id is unknown.
 */
export async function getDocImage(id: string): Promise<{ bytes: Buffer; mime: string } | null> {
  requireDb();
  const result = await getPool().query(
    `SELECT bytes, mime FROM clickup_doc_images WHERE id = $1`,
    [id],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return { bytes: row.bytes as Buffer, mime: row.mime as string };
}
