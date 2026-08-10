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

// Extension → MIME, mirroring src/google-docs/apiHelpers.ts. Used as a fallback
// when the response has no usable Content-Type.
const MIME_BY_EXT: { [key: string]: string } = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

function requireDb(): void {
  if (!isDatabaseAvailable()) {
    throw new UserError('ClickUp doc images require Postgres. Set DATABASE_URL and REDIS_URL.');
  }
}

/**
 * Fetch a remote image with the same SSRF and size protections used by the
 * Google Docs image path. Returns the raw bytes and a best-effort MIME type.
 */
export async function fetchRemoteImage(url: string): Promise<{ bytes: Buffer; mime: string }> {
  const validated = validateFetchUrl(url);
  await rejectPrivateAddress(validated.hostname);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new UserError(`Image fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${url}`);
    }
    throw new UserError(`Failed to fetch image from URL: ${err.message}`);
  }
  clearTimeout(timeout);

  if (!response.ok) {
    throw new UserError(`Failed to fetch image from URL (${response.status}): ${url}`);
  }

  // Reject early if Content-Length advertises an oversize payload.
  const contentLength = Number(response.headers.get('content-length') || '0');
  if (contentLength > MAX_IMAGE_SIZE) {
    throw new UserError(`Image too large (${contentLength} bytes, max ${MAX_IMAGE_SIZE}): ${url}`);
  }

  // Stream with size enforcement rather than trusting Content-Length.
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
        reader.cancel();
        throw new UserError(`Image exceeds max size (${MAX_IMAGE_SIZE} bytes): ${url}`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = Buffer.concat(chunks.map((c) => Buffer.from(c)));

  // Derive MIME: prefer a recognized file extension, else the response header.
  const path = await import('path');
  const ext = path.extname(validated.pathname).toLowerCase();
  const headerMime = (response.headers.get('content-type') || '').split(';')[0].trim();
  const mime = MIME_BY_EXT[ext] || headerMime || 'application/octet-stream';

  if (!mime.startsWith('image/')) {
    throw new UserError(`URL did not return an image (resolved type: ${mime || 'unknown'}): ${url}`);
  }

  return { bytes, mime };
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
