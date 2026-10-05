// src/browserbase/accessRules.ts
// Per-connection domain rules for the Browserbase connector, stored under
// providerTokens.accessRules exactly like Slack's channel rules.
//
// Modelled on src/slack-user/accessControl.ts, including its most useful shape:
// a PURE, synchronous assert* function with the I/O in a thin async wrapper in
// server.ts. Everything worth testing then lives in the pure function.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS AND IS NOT. `navigate` is the only tool that *declares* where
// the browser is going, so it is the only place a rule can be applied. `act`
// can click a link to anywhere, and `start` can reattach to a session that was
// already navigated off-list by an earlier call. So this is a guardrail against
// an agent wandering, NOT a security boundary — a determined prompt can leave
// the allowlist and nothing here will stop it. The tool descriptions say so
// too, because a model that reads only the description must not conclude the
// allowlist contains `act`.
// ---------------------------------------------------------------------------

import { UserError } from 'fastmcp';

export type BrowserbaseDenialReason =
  | 'scheme-not-allowed'
  | 'url-unparseable'
  | 'allowlist-miss'
  | 'blocklist-hit';

export class BrowserbaseAccessDenied extends UserError {
  readonly reason: BrowserbaseDenialReason;
  /** The user's own patterns, so the message can say what to edit. */
  readonly patterns?: string[];
  readonly hostname?: string;

  constructor(
    message: string,
    detail: { reason: BrowserbaseDenialReason; patterns?: string[]; hostname?: string },
  ) {
    super(message);
    this.name = 'BrowserbaseAccessDenied';
    this.reason = detail.reason;
    this.patterns = detail.patterns;
    this.hostname = detail.hostname;
  }
}

export interface BrowserbaseAccessRules {
  /** Hostnames (and their subdomains) the browser may visit. Empty = any. */
  allowedDomains?: string[];
  /** Hostnames (and their subdomains) the browser may never visit. */
  blockedDomains?: string[];
}

/** The shape stored in providerTokens for this provider. */
export interface BrowserbaseTokens {
  access_token?: string;
  projectId?: string;
  accessRules?: BrowserbaseAccessRules;
}

/**
 * Does `hostname` fall under `pattern`?
 *
 * Label-boundary suffix match: `example.com` matches `example.com` and
 * `app.example.com`, but NOT `notexample.com`. Case-insensitive, and a leading
 * dot or `*.` prefix on the pattern is tolerated so a user who types the form
 * they are used to gets what they meant.
 *
 * Deliberately NOT matchGlob (src/slack-user/accessControl.ts). Glob semantics
 * on a hostname are ambiguous in the dangerous direction — it is not obvious
 * whether `*.example.com` ought to cover the apex — and an LLM-supplied `*`
 * must never be able to widen a rule. Same instinct as Slack's matchPattern
 * being a literal substring rather than a regex.
 */
export function hostMatchesPattern(pattern: string, hostname: string): boolean {
  let p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (p.startsWith('*.')) p = p.slice(2);
  while (p.startsWith('.')) p = p.slice(1);
  p = p.replace(/\.+$/, '');
  if (!p) return false;

  const host = hostname.trim().toLowerCase().replace(/\.+$/, '');
  if (host === p) return true;
  return host.endsWith(`.${p}`);
}

/** Normalise a rule list, dropping blanks. */
function patternList(values?: string[]): string[] {
  if (!Array.isArray(values)) return [];
  return values.map(v => String(v ?? '').trim()).filter(Boolean);
}

/** True when a rule set would restrict anything at all. */
export function hasDomainRules(rules?: BrowserbaseAccessRules): boolean {
  return patternList(rules?.allowedDomains).length > 0 || patternList(rules?.blockedDomains).length > 0;
}

/**
 * Validate a hostname pattern a user typed into the dashboard.
 *
 * Returns null when fine, or the reason it was refused. Kept here rather than
 * in webServer so the dashboard route and any future CLI validate identically.
 */
export function validateDomainPattern(pattern: string): string | null {
  const raw = String(pattern ?? '').trim();
  if (!raw) return 'Pattern is empty.';
  if (raw.length > 253) return `"${raw.slice(0, 40)}…" is longer than a hostname can be (253 characters).`;
  let p = raw.toLowerCase();
  if (p.startsWith('*.')) p = p.slice(2);
  while (p.startsWith('.')) p = p.slice(1);
  if (!p) return `"${raw}" has no hostname in it.`;
  if (p.includes('/') || p.includes(':') || p.includes('?')) {
    return `"${raw}" looks like a URL. Enter a hostname only, e.g. example.com.`;
  }
  if (p.includes('*')) {
    // Only a leading `*.` is meaningful, and it was already stripped above.
    return `"${raw}" contains a wildcard. Only a leading "*." is supported — a bare hostname already covers its subdomains.`;
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(p)) {
    return `"${raw}" is not a valid hostname.`;
  }
  return null;
}

/**
 * Enforce the rules against a URL the caller asked to navigate to.
 *
 * Pure and synchronous. Absent or empty rules mean UNRESTRICTED — the opposite
 * of Slack's getRules, which throws when no rules are configured. That is
 * correct there (the default must be "read nothing") and wrong here: a freshly
 * connected Browserbase instance has to be able to browse, or it is inert
 * until someone opens a modal they have no reason to open. Only the scheme
 * check applies unconditionally.
 */
export function assertDomainAllowed(rules: BrowserbaseAccessRules | undefined, rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BrowserbaseAccessDenied(
      `"${rawUrl}" is not a valid absolute URL. Include the scheme, e.g. https://example.com.`,
      { reason: 'url-unparseable' },
    );
  }

  // Unconditional, rules or not: a file:// or data: URL is not a web page the
  // cloud browser should be asked to open, and neither is reachable usefully
  // from a remote browser anyway.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BrowserbaseAccessDenied(
      `Only http:// and https:// URLs can be opened (got "${url.protocol}").`,
      { reason: 'scheme-not-allowed', hostname: url.hostname },
    );
  }

  const blocked = patternList(rules?.blockedDomains);
  const allowed = patternList(rules?.allowedDomains);
  const host = url.hostname;

  // Blocklist first: an explicit block outranks an allowlist entry that would
  // otherwise permit it, so the narrower rule wins.
  const blockHit = blocked.find(p => hostMatchesPattern(p, host));
  if (blockHit) {
    throw new BrowserbaseAccessDenied(
      `${host} is on this connection's blocked-domains list (matched "${blockHit}"). Edit Access Rules on the dashboard to change it.`,
      { reason: 'blocklist-hit', patterns: blocked, hostname: host },
    );
  }

  if (allowed.length > 0 && !allowed.some(p => hostMatchesPattern(p, host))) {
    throw new BrowserbaseAccessDenied(
      `${host} is not on this connection's allowed-domains list (${allowed.join(', ')}). ` +
        `Add it under Access Rules on the dashboard, or clear the list to allow any site.`,
      { reason: 'allowlist-miss', patterns: allowed, hostname: host },
    );
  }

  return url;
}

/** One line describing the rules in force, for a tool response. */
export function describeRules(rules?: BrowserbaseAccessRules): string | undefined {
  const allowed = patternList(rules?.allowedDomains);
  const blocked = patternList(rules?.blockedDomains);
  if (!allowed.length && !blocked.length) return undefined;
  const parts: string[] = [];
  if (allowed.length) parts.push(`allowed: ${allowed.join(', ')}`);
  if (blocked.length) parts.push(`blocked: ${blocked.join(', ')}`);
  return `Domain rules on this connection — ${parts.join('; ')}. These apply to navigate only; act can follow a link off-list.`;
}
