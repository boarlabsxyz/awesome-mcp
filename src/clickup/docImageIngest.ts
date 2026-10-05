// src/clickup/docImageIngest.ts
//
// The single ingest path for an image destined for a ClickUp Doc page: a caller
// supplies EXACTLY ONE of a public URL or base64 bytes, and both converge on the
// shared content-addressed blob store, which returns the public URL to embed as
// markdown. ClickUp has no image-upload API for Docs, so this server hosts the
// bytes itself.
//
// Hoisted out of `server.ts` so the REST data plane (`webServer.ts`) reuses the
// same ingest rather than growing a second copy. That matters more than tidiness
// here: the URL branch is a server-side fetch of a caller-supplied URL — an SSRF
// primitive — and its per-redirect-hop guard lives in `fetchImageBytes`
// (`./docImageStore.ts`). A second call site that fetched the URL itself would
// re-open the hole this module exists to keep closed, so new call sites must go
// through `storeImageFromArgs` and never fetch the URL directly.
import { UserError } from 'fastmcp';
import { fetchImageBytes } from './docImageStore.js';
import { store as storeImageBlob } from '../images/imageBlobStore.js';

// Base64 ingest is a fallback for clients that can't reach POST /images/upload.
// Caps are much tighter than the URL path's 20MB because the payload rides in the
// calling model's context window. The 2MB post-recompression cap in store() still
// applies afterward.
const MAX_BASE64_STRING_BYTES = 2 * 1024 * 1024;    // reject the string before decode
const MAX_BASE64_DECODED_BYTES = 1.5 * 1024 * 1024; // reject decoded bytes

/** One image source, as every caller of this module accepts it. */
export type ImageSourceArgs = { imageUrl?: string; imageBase64?: string; fileName?: string };

// Exactly one of imageUrl / imageBase64 must be present. Never echoes values.
export function assertOneImageSource(args: { imageUrl?: string; imageBase64?: string }): void {
  const hasUrl = typeof args.imageUrl === 'string' && args.imageUrl.length > 0;
  const hasB64 = typeof args.imageBase64 === 'string' && args.imageBase64.length > 0;
  if (hasUrl && hasB64) {
    throw new UserError('Provide only one of imageUrl or imageBase64, not both.');
  }
  if (!hasUrl && !hasB64) {
    throw new UserError('Provide exactly one of imageUrl or imageBase64.');
  }
}

// Decode a base64 image payload to raw bytes. Does NOT validate the image format
// or normalize it — that stays store()'s single responsibility. CRITICAL: never
// put the payload (or any slice of it) into an error; it can be ~2MB and would
// blow up the caller's context and flood logs. Only fileName + sizes appear.
export function decodeBase64Image(raw: string, fileName?: string): Buffer {
  const where = fileName ? ` (${fileName})` : '';

  // Strip a data-URL prefix (data:image/png;base64,....) if present.
  let s = raw;
  if (s.startsWith('data:')) {
    const comma = s.indexOf(',');
    if (comma !== -1) s = s.slice(comma + 1);
  }
  // Strip all whitespace / newlines.
  s = s.replace(/\s+/g, '');

  if (s.length === 0) {
    throw new UserError(`imageBase64${where} is empty.`);
  }
  // Reject the STRING before decoding.
  if (s.length > MAX_BASE64_STRING_BYTES) {
    throw new UserError(`imageBase64${where} is too large (${s.length} chars). base64 is for small images (~100KB); use imageUrl for anything larger.`);
  }
  // Validate it is actually base64 BEFORE decoding — Buffer.from silently drops
  // invalid characters and returns garbage otherwise, which would reach sharp as
  // nonsense bytes.
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) {
    throw new UserError(`imageBase64${where} is not valid base64.`);
  }

  const buf = Buffer.from(s, 'base64');
  if (buf.length === 0) {
    throw new UserError(`imageBase64${where} decoded to zero bytes.`);
  }
  if (buf.length > MAX_BASE64_DECODED_BYTES) {
    throw new UserError(`Decoded image${where} is too large (${buf.length} bytes, max ${MAX_BASE64_DECODED_BYTES}). base64 is for small images; use imageUrl for anything larger.`);
  }
  return buf;
}

// Produce raw image bytes from whichever source the caller supplied. Assumes
// assertOneImageSource() already ran. Both branches converge on store().
async function imageBytesFromArgs(args: ImageSourceArgs): Promise<Buffer> {
  if (typeof args.imageBase64 === 'string' && args.imageBase64.length > 0) {
    return decodeBase64Image(args.imageBase64, args.fileName);
  }
  return fetchImageBytes(args.imageUrl as string);
}

// The single write path for image bytes: source → store() (magic-byte validation,
// WebP normalization, 2MB cap, dedup) → public URL to embed.
export async function storeImageFromArgs(args: ImageSourceArgs): Promise<string> {
  const bytes = await imageBytesFromArgs(args);
  const { url } = await storeImageBlob(bytes, '');
  return url;
}

// True only when imageUrl is an http(s) URL actually served by our image host:
// same origin as the public base AND a /images/ path. A naive startsWith(base)
// check would wrongly match https://host.example.evil.com/... (a different
// origin that merely shares the base as a string prefix).
export function isImageUrlOnOurHost(imageUrl: string, publicBase: string): boolean {
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(imageUrl);
    base = new URL(publicBase);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return parsed.origin === base.origin && parsed.pathname.startsWith('/images/');
}
