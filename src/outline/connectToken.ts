// src/outline/connectToken.ts
// Validates a pasted Outline base URL + personal API key by calling
// POST <baseUrl>/api/auth.info. Extracted from webServer.ts so the
// validation + error-mapping logic can be unit-tested independently.

import net from 'node:net';

const VALIDATE_TIMEOUT_MS = 10_000;

/**
 * Reject IP literals that point at loopback, RFC1918, link-local, or IPv6
 * private ranges. Blocks the most common SSRF entry points (localhost probes,
 * cloud metadata endpoints like 169.254.169.254, internal RFC1918 subnets)
 * before the router forwards the pasted API key upstream.
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

export type FetchImpl = typeof fetch;

export type ValidateOk = {
  ok: true;
  /** Base URL with any trailing slashes stripped. Safe to use as `${baseUrl}${path}`. */
  baseUrl: string;
  email: string | null;
  teamName: string | null;
};

export type ValidateErr = {
  ok: false;
  status: number;
  userMessage: string;
  logMessage: string;
};

export type ValidateResult = ValidateOk | ValidateErr;

export interface ValidateInput {
  baseUrl: string;
  token: string;
  fetchImpl?: FetchImpl;
}

/**
 * Reject inputs that are clearly wrong before hitting the network:
 *  - non-string / empty
 *  - missing scheme (http/https)
 *  - contains whitespace
 *  - hostname resolves (statically) to a loopback / RFC1918 / link-local
 *    / IPv6-private range — closes the most common SSRF entry points
 *    before the pasted token is forwarded anywhere.
 * Returns `null` if the URL is acceptable; otherwise the user-facing reason.
 */
export function checkBaseUrl(raw: string): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return 'Outline URL is required.';
  const trimmed = raw.trim();
  if (/\s/.test(trimmed)) return 'Outline URL must not contain whitespace.';
  if (!/^https?:\/\//i.test(trimmed)) return 'Outline URL must start with http:// or https://.';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'Outline URL is not a valid URL.';
  }
  if (isPrivateHost(parsed.hostname)) {
    return 'Outline URL must point to a public host.';
  }
  return null;
}

/**
 * POST <baseUrl>/api/auth.info with the pasted token; treat 200 as proof the
 * token is real. Uses a discriminated result so the caller can map to an HTTP
 * response without a second try/catch.
 */
export async function validateOutlineToken(input: ValidateInput): Promise<ValidateResult> {
  const badUrl = checkBaseUrl(input.baseUrl);
  if (badUrl) {
    return { ok: false, status: 400, userMessage: badUrl, logMessage: `Rejected Outline base URL: ${badUrl}` };
  }
  if (typeof input.token !== 'string' || !input.token.trim()) {
    return { ok: false, status: 400, userMessage: 'Outline API key is required.', logMessage: 'Rejected empty Outline API key' };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
  const token = input.token.trim();

  // Single AbortController + timeout guards the entire round trip: the fetch
  // headers, response.text(), and response.json(). A Slowloris-style slow body
  // would otherwise hang the connect flow forever.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
  const timedOut = (): ValidateErr => ({
    ok: false,
    status: 502,
    userMessage: 'Outline did not respond in time. Check the URL and try again.',
    logMessage: `Outline auth.info timed out: ${baseUrl}`,
  });

  try {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/api/auth.info`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') return timedOut();
      return {
        ok: false,
        status: 502,
        userMessage: `Could not reach Outline at ${baseUrl}. Check the URL.`,
        logMessage: `Outline auth.info fetch failed: ${err?.message ?? err}`,
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: 400,
        userMessage: 'Outline rejected the API key. Check that it is valid and still active.',
        logMessage: `Outline auth.info unauthorized: ${response.status}`,
      };
    }

    if (!response.ok) {
      let body = '';
      try {
        body = await response.text();
      } catch (bodyErr: any) {
        if (bodyErr?.name === 'AbortError') return timedOut();
        // Non-abort body-read failure: log without the body, keep going.
      }
      return {
        ok: false,
        status: 502,
        userMessage: `Outline returned an unexpected response (${response.status}). Try again.`,
        logMessage: `Outline auth.info non-2xx: ${response.status} ${body}`,
      };
    }

    type AuthInfoBody = { data?: { user?: { email?: string }; team?: { name?: string } } };
    let data: AuthInfoBody | null = null;
    try {
      data = await response.json() as AuthInfoBody;
    } catch (bodyErr: any) {
      if (bodyErr?.name === 'AbortError') return timedOut();
      // Non-abort JSON parse failure: treat as an OK-but-no-metadata response.
    }

    return {
      ok: true,
      baseUrl,
      email: data?.data?.user?.email ?? null,
      teamName: data?.data?.team?.name ?? null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Compose the instance display name shown on the dashboard. Priority:
 *   1. Explicit `providedInstanceName` from the paste form (highest)
 *   2. `<Service Name> (<Team>)` — preferred when the team is known
 *   3. `<Service Name> (<Email>)` — fallback when only email is known
 *   4. `<Service Name>` — last-resort
 *
 * Duplicates the shape used by the OAuth path in src/outline/oauthCallback.ts
 * on purpose — the two auth flows should produce identical connection names
 * for the same team, so a user connecting via API key and later via OAuth
 * still triggers the duplicate-connection guard.
 */
export function buildOutlineInstanceName(input: {
  serviceName: string;
  providedInstanceName?: string | null;
  teamName?: string | null;
  email?: string | null;
}): string {
  if (input.providedInstanceName) return input.providedInstanceName;
  if (input.teamName) return `${input.serviceName} (${input.teamName})`;
  if (input.email) return `${input.serviceName} (${input.email})`;
  return input.serviceName;
}
