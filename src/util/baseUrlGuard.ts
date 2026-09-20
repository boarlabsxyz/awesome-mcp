// src/util/baseUrlGuard.ts
// SSRF guard for user-supplied base URLs.
//
// Self-hosted connectors (Outline, Redmine) take the instance URL from the
// user, which makes it attacker-controllable input that this server will then
// send a credential to. Both need the identical range table, so it lives here
// once rather than being forked per provider — a second copy would drift, and
// a drifting security control is worse than a shared one.
//
// Only the message prefix is provider-specific; pass it as `serviceLabel`.

import net from 'node:net';

/**
 * Reject IP literals that point at loopback, RFC1918, link-local, or IPv6
 * private ranges. Blocks the most common SSRF entry points (localhost probes,
 * cloud metadata endpoints like 169.254.169.254, internal RFC1918 subnets)
 * before the router forwards the pasted credential upstream.
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

  // Well-known loopback hostnames
  if (host === 'localhost' || host === 'ip6-localhost' || host === 'ip6-loopback') return true;

  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 0) return true;                                 // 0.0.0.0/8 "this network"
    if (a === 10) return true;                                // 10.0.0.0/8 RFC1918
    if (a === 127) return true;                               // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true;                  // 169.254.0.0/16 link-local (AWS metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;         // 172.16.0.0/12 RFC1918
    if (a === 192 && b === 168) return true;                  // 192.168.0.0/16 RFC1918
    return false;
  }

  if (net.isIPv6(host)) {
    // Strip any zone id (e.g. fe80::1%eth0)
    const addr = host.split('%')[0];
    // Canonical short forms
    if (addr === '::' || addr === '::1') return true;
    // IPv4-mapped IPv6. Two on-wire forms:
    //   Dotted quad:      ::ffff:127.0.0.1        (accepted by parsers but not
    //                                              produced by URL.hostname)
    //   WHATWG canonical: ::ffff:7f00:1           (what new URL(...).hostname
    //                                              produces — two 16-bit groups)
    if (addr.startsWith('::ffff:')) {
      const rest = addr.slice(7);
      if (net.isIPv4(rest)) return isPrivateHost(rest);
      const [hi, lo] = rest.split(':');
      const high = parseInt(hi || '', 16);
      const low  = parseInt(lo || '', 16);
      if (
        !Number.isNaN(high) && !Number.isNaN(low) &&
        high >= 0 && high <= 0xffff && low >= 0 && low <= 0xffff
      ) {
        const v4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
        return isPrivateHost(v4);
      }
    }
    // Uncompressed loopback / unspecified (0:0:0:0:0:0:0:0 or ...:1)
    const groups = addr.split(':');
    if (groups.length === 8 && groups.slice(0, 7).every(g => parseInt(g || '0', 16) === 0)) {
      const last = parseInt(groups[7] || '0', 16);
      if (last === 0 || last === 1) return true;
    }
    // First-group numeric range checks for link-local and unique-local prefixes
    const firstGroup = parseInt(groups[0] || '0', 16);
    if (!Number.isNaN(firstGroup)) {
      if (firstGroup >= 0xfe80 && firstGroup <= 0xfebf) return true;  // fe80::/10 link-local
      if (firstGroup >= 0xfc00 && firstGroup <= 0xfdff) return true;  // fc00::/7 unique local
    }
    return false;
  }

  return false;
}

/**
 * Reject inputs that are clearly wrong before hitting the network:
 *  - non-string / empty
 *  - missing scheme (http/https)
 *  - contains whitespace
 *  - hostname resolves (statically) to a loopback / RFC1918 / link-local
 *    / IPv6-private range — closes the most common SSRF entry points
 *    before the pasted credential is forwarded anywhere.
 *
 * Returns `null` if the URL is acceptable; otherwise the user-facing reason,
 * prefixed with `serviceLabel` so the message names the field the user filled
 * in. Callers surface the string verbatim, so it must stay user-readable.
 */
export function checkBaseUrl(raw: string, serviceLabel: string): string | null {
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
  return null;
}
