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
import { fetchImageWithRedirectGuard } from '../google-docs/apiHelpers.js';


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

export async function fetchImageBytes(url: string): Promise<Buffer> {
  // Delegates to the one guarded implementation, which lives beside the SSRF
  // guards it uses (google-docs/apiHelpers.ts). It was inlined here, which is how
  // uploadImageToDrive ended up with a second copy that validated only the first
  // hop — two copies of a security guard drift, and that one did.
  const { bytes } = await fetchImageWithRedirectGuard(url);
  return bytes;
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
