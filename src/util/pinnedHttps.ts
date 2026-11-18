// src/util/pinnedHttps.ts
// An https request that connects only to public addresses.
//
// Resolving a hostname, checking the answer, then calling fetch() resolves it
// twice: a name that answers with a public address for the check and a private
// one for the connection (DNS rebinding) reaches the internal host. Here the
// check runs INSIDE the socket's own DNS lookup, so the address that was
// checked is the address connected to. TLS SNI and the Host header keep the
// original hostname.

import dns from 'node:dns';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { isPrivateHost } from './baseUrlGuard.js';

/** `code` of the error raised when a host is, or resolves to, a private address. */
export const PRIVATE_ADDRESS = 'EPRIVATEADDRESS';

function privateAddressError(hostname: string, address?: string): Error {
  const where = address && address !== hostname ? ` (${address})` : '';
  return Object.assign(new Error(`${hostname}${where} is a private address.`), { code: PRIVATE_ADDRESS });
}

/** A `lookup` for net/tls that fails when ANY address the name resolves to is private. */
export const publicAddressLookup: LookupFunction = (hostname, options, callback) => {
  // Property access, not a destructured import, so tests can replace dns.lookup.
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) { callback(err, '', 0); return; }
    const list = addresses as unknown as dns.LookupAddress[];
    const bad = list.find((a) => isPrivateHost(a.address));
    if (list.length === 0 || bad) { callback(privateAddressError(hostname, bad?.address), '', 0); return; }
    if (options.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  });
};

export interface PinnedRequestInit {
  method: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  signal?: AbortSignal;
}

/**
 * Send `init` to an https `url`, connecting only to public addresses. Redirects
 * are not followed: a 3xx comes back as the answer. The request body is
 * buffered (callers send a few MB at most), and so is the answer, up to
 * `maxResponseBytes` — enough for an error message from storage.
 */
export async function pinnedHttpsRequest(url: URL, init: PinnedRequestInit, maxResponseBytes = 64 * 1024): Promise<Response> {
  if (url.protocol !== 'https:') throw new Error(`Only https is allowed, got ${url.protocol}`);
  // An IP literal never reaches the lookup, so it is checked here.
  if (isPrivateHost(url.hostname)) throw privateAddressError(url.hostname);
  // Request serialises FormData and Blob bodies exactly as fetch would, multipart boundary included.
  const prepared = new Request(url, { method: init.method, headers: init.headers, body: init.body });
  const payload = Buffer.from(await prepared.arrayBuffer());
  const headers: Record<string, string> = Object.fromEntries(prepared.headers);
  headers['content-length'] = String(payload.length);

  return new Promise<Response>((resolve, reject) => {
    const req = https.request(url, { method: init.method, headers, lookup: publicAddressLookup, signal: init.signal }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        if (size < maxResponseBytes) { chunks.push(chunk); size += chunk.length; }
      });
      res.on('error', reject);
      res.on('end', () => {
        const status = res.statusCode ?? 502;
        const empty = status === 204 || status === 205 || status === 304;
        resolve(new Response(empty ? null : Buffer.concat(chunks).subarray(0, maxResponseBytes), { status }));
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
