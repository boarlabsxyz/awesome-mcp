// src/slack/fileDownload.ts
//
// Authenticated binary fetch for Slack file downloads (`url_private_download`).
//
// This cannot go through SlackClient.request(): that helper hardcodes POST +
// form-encoding + the https://slack.com/api base + a JSON parse, whereas a file
// download is a GET to files.slack.com that returns raw bytes.
//
// The redirect loop is modelled on fetchImageBytes() in
// ../clickup/docImageStore.ts — same manual per-hop SSRF re-validation, same
// single deadline covering DNS *and* body streaming, same streaming size cap.
// Three things are specific to Slack:
//
//   1. The bearer token is attached ONLY when the target host is a Slack host.
//      Slack redirects file downloads to signed S3/CDN URLs; sending the
//      workspace token to those hosts would leak it to a third party. Because
//      the check runs per hop, a cross-origin redirect silently drops the
//      header (this is `curl` default behaviour vs `--location-trusted`).
//   2. The initial URL must already be a Slack host — callers pass a URL that
//      came out of files.info, so anything else is a bug or an injection.
//   3. A token without `files:read` does NOT get a 401 from Slack. It gets
//      200 OK with an HTML sign-in page. Without the content-type check below
//      those bytes would be stored as if they were the user's screenshot.

import { UserError } from 'fastmcp';
import { validateFetchUrl, rejectPrivateAddress } from '../google-docs/apiHelpers.js';

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024; // 20 MB — matches the image upload body cap
const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

/** True for slack.com and any subdomain of it (files.slack.com in practice). */
export function isSlackHost(hostname: string): boolean {
  let h = hostname.toLowerCase();
  while (h.endsWith('.')) h = h.slice(0, -1);
  return h === 'slack.com' || h.endsWith('.slack.com');
}

/**
 * Races a promise against the shared abort deadline. The SSRF DNS lookup doesn't
 * observe the fetch AbortSignal, so without this a slow resolve could outlast
 * FETCH_TIMEOUT_MS. The abort listener is always removed once the race settles.
 */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  const timeoutErr = () => new UserError(`Slack file download timed out after ${FETCH_TIMEOUT_MS / 1000}s.`);
  if (signal.aborted) return Promise.reject(timeoutErr());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(timeoutErr());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export interface SlackFileBytes {
  buffer: Buffer;
  contentType: string;
}

/**
 * Fetch a Slack-hosted file into a Buffer using the workspace token.
 *
 * `maxBytes` caps the streamed body; callers pass a smaller value for payloads
 * that ride in the model's context.
 */
export async function fetchSlackFileBytes(
  url: string,
  token: string,
  opts?: { maxBytes?: number },
): Promise<SlackFileBytes> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;

  const initial = validateFetchUrl(url);
  if (!isSlackHost(initial.hostname)) {
    throw new UserError(
      `Refusing to download from a non-Slack host (${initial.hostname}). Only Slack-hosted files can be downloaded.`,
    );
  }

  // One timeout covers the whole operation — DNS/connect AND body streaming —
  // so a slow drip on the body can't hang past FETCH_TIMEOUT_MS.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    let currentUrl = initial.toString();
    let response: Response;
    let redirects = 0;

    for (;;) {
      const parsed = validateFetchUrl(currentUrl);
      // Re-validate EVERY hop, not just the first URL. With redirect:'follow' a
      // 302 to 169.254.169.254 or 127.0.0.1 would be fetched unchecked.
      await raceAbort(rejectPrivateAddress(parsed.hostname), controller.signal);

      // Credentials are attached per hop, so they never survive a redirect off
      // a Slack host.
      const headers: Record<string, string> = {};
      if (isSlackHost(parsed.hostname)) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      try {
        response = await fetch(currentUrl, { headers, signal: controller.signal, redirect: 'manual' });
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          throw new UserError(`Slack file download timed out after ${FETCH_TIMEOUT_MS / 1000}s.`);
        }
        throw new UserError(`Slack file download failed: ${err?.message || err}`);
      }

      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        if (++redirects > MAX_REDIRECTS) {
          throw new UserError(`Too many redirects (>${MAX_REDIRECTS}) downloading Slack file.`);
        }
        currentUrl = new URL(location, currentUrl).toString();
        await response.body?.cancel().catch(() => { /* ignore */ });
        continue;
      }
      break;
    }

    if (!response.ok) {
      // Same string shape as SlackClient so mapSlackErrorToHttpStatus keeps working.
      throw new UserError(`Slack API HTTP error (${response.status}) downloading file.`);
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();

    // A token missing `files:read` gets 200 + an HTML sign-in page, not a 401.
    if (contentType.startsWith('text/html')) {
      await response.body?.cancel().catch(() => { /* ignore */ });
      throw new UserError(
        'Slack returned a sign-in page instead of the file. The connected Slack token is missing the "files:read" scope — reconnect Slack from the dashboard to re-consent.',
      );
    }

    // Reject early if Content-Length advertises an oversize payload.
    const contentLength = Number(response.headers.get('content-length') || '0');
    if (contentLength > maxBytes) {
      await response.body?.cancel().catch(() => { /* ignore */ });
      throw new UserError(`Slack file is too large (${contentLength} bytes, max ${maxBytes}).`);
    }

    // Stream with size enforcement rather than trusting Content-Length.
    const reader = response.body?.getReader();
    if (!reader) {
      throw new UserError('Slack returned an empty response body for this file.');
    }
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => { /* ignore */ });
          throw new UserError(`Slack file exceeds the maximum size (${maxBytes} bytes).`);
        }
        chunks.push(value);
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new UserError(`Slack file download timed out after ${FETCH_TIMEOUT_MS / 1000}s.`);
      }
      throw err;
    } finally {
      reader.releaseLock();
    }

    return {
      buffer: Buffer.concat(chunks.map((c) => Buffer.from(c))),
      contentType: contentType || 'application/octet-stream',
    };
  } finally {
    clearTimeout(timeout);
  }
}
