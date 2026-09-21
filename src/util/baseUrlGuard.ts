// src/util/baseUrlGuard.ts
// SSRF + transport guard for user-supplied base URLs.
//
// Self-hosted connectors (Outline, Redmine) take the instance URL from the
// user, which makes it attacker-controllable input that this server will then
// send a credential to. Both need the identical range table, so it lives here
// once rather than being forked per provider — a second copy would drift, and
// a drifting security control is worse than a shared one.
//
// Only the message prefix is provider-specific; pass it as `serviceLabel`.

import net from 'node:net';

/** Hostnames that always mean "this machine", independent of DNS. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback']);

/**
 * Private / infrastructure IPv4 ranges, as [first octet, predicate on the
 * second]. Kept as a table so adding a range is one line and the reasoning
 * stays next to the value.
 */
const PRIVATE_IPV4_RANGES: ReadonlyArray<{ a: number; b?: (b: number) => boolean; why: string }> = [
  { a: 0,   why: '0.0.0.0/8 "this network"' },
  { a: 10,  why: '10.0.0.0/8 RFC1918' },
  { a: 127, why: '127.0.0.0/8 loopback' },
  // 100.64.0.0/10 is carrier-grade NAT space, and carries Alibaba Cloud's
  // metadata endpoint at 100.100.100.200 — the same class of target as
  // 169.254.169.254, which is why it is blocked rather than treated as public.
  { a: 100, b: b => b >= 64 && b <= 127, why: '100.64.0.0/10 CGNAT + Alibaba metadata' },
  // 169.254.169.254 is the AWS / GCP / Azure metadata endpoint.
  { a: 169, b: b => b === 254, why: '169.254.0.0/16 link-local' },
  { a: 172, b: b => b >= 16 && b <= 31, why: '172.16.0.0/12 RFC1918' },
  { a: 192, b: b => b === 168, why: '192.168.0.0/16 RFC1918' },
];

/** Is this dotted-quad IPv4 literal in a private / infrastructure range? */
function isPrivateIPv4(host: string): boolean {
  const [a, b] = host.split('.').map(Number);
  return PRIVATE_IPV4_RANGES.some(range => range.a === a && (!range.b || range.b(b)));
}

/**
 * Decode the IPv4 address inside an `::ffff:…` IPv4-mapped IPv6 literal.
 * Two on-wire forms exist:
 *   Dotted quad:      ::ffff:127.0.0.1   (accepted by parsers, not produced by URL.hostname)
 *   WHATWG canonical: ::ffff:7f00:1      (what new URL(...).hostname produces — two 16-bit groups)
 * Returns null when the tail is neither.
 */
function ipv4FromMapped(addr: string): string | null {
  if (!addr.startsWith('::ffff:')) return null;
  const rest = addr.slice(7);
  if (net.isIPv4(rest)) return rest;
  const [hi, lo] = rest.split(':');
  const high = Number.parseInt(hi || '', 16);
  const low = Number.parseInt(lo || '', 16);
  if (Number.isNaN(high) || Number.isNaN(low)) return null;
  if (high < 0 || high > 0xffff || low < 0 || low > 0xffff) return null;
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

/** Is this an uncompressed all-zero IPv6 address ending in 0 or 1 (:: or ::1)? */
function isUncompressedLoopback(groups: string[]): boolean {
  if (groups.length !== 8) return false;
  if (!groups.slice(0, 7).every(g => Number.parseInt(g || '0', 16) === 0)) return false;
  const last = Number.parseInt(groups[7] || '0', 16);
  return last === 0 || last === 1;
}

/** Is this IPv6 literal loopback, link-local (fe80::/10) or unique-local (fc00::/7)? */
function isPrivateIPv6(host: string): boolean {
  // Strip any zone id (e.g. fe80::1%eth0)
  const addr = host.split('%')[0];
  if (addr === '::' || addr === '::1') return true;

  const mapped = ipv4FromMapped(addr);
  if (mapped) return isPrivateIPv4(mapped);

  const groups = addr.split(':');
  if (isUncompressedLoopback(groups)) return true;

  const firstGroup = Number.parseInt(groups[0] || '0', 16);
  if (Number.isNaN(firstGroup)) return false;
  if (firstGroup >= 0xfe80 && firstGroup <= 0xfebf) return true;  // fe80::/10 link-local
  return firstGroup >= 0xfc00 && firstGroup <= 0xfdff;            // fc00::/7 unique local
}

/**
 * Reject IP literals that point at loopback, RFC1918, CGNAT, link-local, or
 * IPv6 private ranges. Blocks the most common SSRF entry points (localhost
 * probes, cloud metadata endpoints, internal subnets) before the router
 * forwards the pasted credential upstream.
 *
 * Exported for direct unit testing — the range table is easy to get wrong.
 *
 * NOTE: This does not defend against DNS rebinding — a hostname that resolves
 * to a public IP at check time but a private one at fetch time still slips
 * through. If that becomes a concern, the next step is to resolve the hostname
 * here and pin the request to the resolved public IP (Node fetch doesn't
 * support that natively; would need a custom Undici Agent).
 */
export function isPrivateHost(hostname: string): boolean {
  if (!hostname) return false;
  // URL.hostname keeps the brackets on IPv6 in modern Node — strip them.
  const stripped = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  const host = stripped.toLowerCase();

  if (LOOPBACK_HOSTNAMES.has(host)) return true;
  if (net.isIPv4(host)) return isPrivateIPv4(host);
  if (net.isIPv6(host)) return isPrivateIPv6(host);
  return false;
}

export interface CheckBaseUrlOptions {
  /**
   * Require https://. Defaults to true: every caller of this guard goes on to
   * send an API key or access token to the URL, and http:// puts that
   * credential on the wire in cleartext.
   *
   * The check runs AFTER the private-host check, so a loopback or RFC1918
   * address is still reported as "must point to a public host" — the more
   * specific and more useful answer.
   */
  requireHttps?: boolean;
}

/**
 * Reject inputs that are clearly wrong before hitting the network:
 *  - non-string / empty
 *  - missing scheme (http/https)
 *  - contains whitespace
 *  - hostname resolves (statically) to a loopback / RFC1918 / CGNAT /
 *    link-local / IPv6-private range — closes the most common SSRF entry
 *    points before the pasted credential is forwarded anywhere
 *  - plain http:// to a public host, which would send the credential in
 *    cleartext (unless `requireHttps: false`)
 *
 * Returns `null` if the URL is acceptable; otherwise the user-facing reason,
 * prefixed with `serviceLabel` so the message names the field the user filled
 * in. Callers surface the string verbatim, so it must stay user-readable.
 */
export function checkBaseUrl(
  raw: string,
  serviceLabel: string,
  options: CheckBaseUrlOptions = {},
): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return `${serviceLabel} URL is required.`;
  const trimmed = raw.trim();
  if (/\s/.test(trimmed)) return `${serviceLabel} URL must not contain whitespace.`;
  if (!/^https?:\/\//i.test(trimmed)) return `${serviceLabel} URL must start with http:// or https://.`;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return `${serviceLabel} URL is not a valid URL.`;
  }
  if (isPrivateHost(parsed.hostname)) {
    return `${serviceLabel} URL must point to a public host.`;
  }
  if (options.requireHttps !== false && parsed.protocol !== 'https:') {
    return `${serviceLabel} URL must use https:// — the credential travels on every request and http:// would send it in cleartext.`;
  }
  return null;
}
