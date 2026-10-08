// src/browserbase/responseSafety.ts
// Everything that happens to text coming back from the hosted Browserbase MCP
// server before this connector returns it.
//
// This module exists because the first version of the proxy passed upstream
// text through VERBATIM, and a live run showed three ways that is wrong:
//
//   1. `navigate` answers with a serialized Page/CDP object — ~15 KB including
//      the internal connect websocket URL, its `signingKey` JWT repeated
//      several times, internal cluster hostnames and a flow-logger session id.
//      All of that reached the model and the transcript.
//   2. `extract` with an instruction can make the extraction model emit
//      thousands of newlines until its JSON is cut off; the upstream error then
//      echoed ~214 KB of raw text, which alone overflowed a 25 K-token client.
//   3. the tools disagreed on shape — act/observe/extract returned a raw
//      `{"success":true,"data":{…}}` envelope while start/end/getBrowserSession
//      returned formatted text.
//
// The lesson generalises past those three: a proxy must not forward a payload
// whose shape it does not control. So `navigate` is projected down to an
// ALLOWLIST of fields (url, status, title) rather than redacted — redaction can
// only remove secrets I can name, and the upstream is free to add more. The
// redaction below is the backstop for the tools whose payload is the point
// (`extract` content, `observe` elements) and therefore cannot be allowlisted.

/** Max characters of upstream payload returned to the caller. */
export const MAX_PAYLOAD_CHARS = 4_000;

/** Max characters of upstream text echoed inside an error message. */
export const MAX_ERROR_CHARS = 1_000;

/**
 * A run of one repeated character longer than this is degenerate model output,
 * not content. The live case was thousands of consecutive newlines.
 */
const MAX_CHAR_RUN = 80;

/**
 * Credential and internal-topology patterns.
 *
 * Order matters: the websocket URL goes first so the key embedded in its query
 * string is removed along with it, then the standalone JWTs, then any other
 * secret-looking query parameter, then the internal hostnames.
 *
 * Every pattern is a single bounded quantifier over a character class — no
 * nested quantifiers, so none of these can backtrack pathologically on the
 * ~200 KB inputs this is specifically built to handle.
 */
const REDACTIONS: ReadonlyArray<{ label: string; pattern: RegExp; replacement: string }> = [
  // ws://host/?signingKey=… — the connect URL is a live credential on its own.
  { label: 'websocket URL', pattern: /wss?:\/\/[^\s"'<>]+/gi, replacement: '[redacted websocket URL]' },
  // A JWT/JWE: base64url starting `eyJ`, long enough that a prose match is implausible.
  { label: 'token', pattern: /eyJ[A-Za-z0-9_\-.]{20,}/g, replacement: '[redacted token]' },
  // Any remaining secret-shaped query parameter, whatever its value format.
  {
    label: 'credential parameter',
    pattern: /([?&](?:signingkey|signing_key|apikey|api_key|accesstoken|access_token|token|secret|password|key)=)[^&\s"'<>]+/gi,
    replacement: '$1[redacted]',
  },
  // Internal service topology — not a credential, but nothing a caller should see.
  { label: 'internal host', pattern: /[A-Za-z0-9](?:[A-Za-z0-9._-]{0,120})\.svc\.cluster\.local(?::\d{1,5})?/g, replacement: '[internal host]' },
];

export interface SanitizeResult {
  text: string;
  /** Labels of the pattern classes that matched, for the caller's note. */
  redacted: string[];
  /** A degenerate character run was collapsed. */
  collapsed: boolean;
  truncated: boolean;
}

/** Replace credential and topology patterns. Reports which classes matched. */
export function redactSecrets(input: string): { text: string; redacted: string[] } {
  let text = input;
  const redacted: string[] = [];
  for (const { label, pattern, replacement } of REDACTIONS) {
    // `pattern` carries /g, so reset lastIndex — these are module-level and reused.
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      pattern.lastIndex = 0;
      text = text.replace(pattern, replacement);
      redacted.push(label);
    }
  }
  return { text, redacted };
}

/**
 * Collapse a long run of one repeated character.
 *
 * This is what a stuck extraction model produces, and it is worth collapsing
 * rather than only truncating: thousands of newlines truncated at 4 KB is
 * still 4 KB of nothing, and hides whatever real content followed.
 */
export function collapseRuns(input: string): { text: string; collapsed: boolean } {
  // Bounded backreference run — one quantifier, no nesting.
  const run = /(.)\1{80,}/gs;
  run.lastIndex = 0;
  if (!run.test(input)) return { text: input, collapsed: false };
  run.lastIndex = 0;
  const text = input.replace(run, (match, char: string) => {
    const name = char === '\n' ? 'newline' : char === ' ' ? 'space' : JSON.stringify(char);
    return `${char.repeat(Math.min(MAX_CHAR_RUN, 3))}…[${match.length} repeated ${name} characters removed]`;
  });
  return { text, collapsed: true };
}

function cap(input: string, max: number): { text: string; truncated: boolean } {
  if (input.length <= max) return { text: input, truncated: false };
  return {
    text: `${input.slice(0, max)}…[truncated, ${input.length} characters total]`,
    truncated: true,
  };
}

/** Collapse, redact and cap, in that order. */
export function sanitize(input: string, max = MAX_PAYLOAD_CHARS): SanitizeResult {
  // Order is load-bearing in both directions, and the middle step is the
  // subtle one.
  //
  // REDACT FIRST. Collapsing can only shorten text, but shortening a secret is
  // enough to defeat the redactor: `eyJ` followed by 81 identical base64url
  // characters collapses to `eyJAAA…[81 repeated …]`, whose remaining fragment
  // is below the token pattern's 20-character minimum — so the redactor stops
  // matching and part of the key survives. Redacting while the secret is still
  // intact removes that whole class of near-miss.
  //
  // THEN COLLAPSE, THEN CAP. A degenerate run can be most of the input, so
  // collapsing before the cap is what lets the cap keep real content instead of
  // spending its whole budget on a wall of newlines.
  const secrets = redactSecrets(input ?? '');
  const runs = collapseRuns(secrets.text);
  const capped = cap(runs.text, max);
  return {
    text: capped.text,
    redacted: secrets.redacted,
    collapsed: runs.collapsed,
    truncated: capped.truncated,
  };
}

/**
 * Sanitize text destined for an error message, with the tighter cap.
 *
 * The live failure was an upstream error whose body was ~214 K characters —
 * enough to blow a client's context on its own, so the error became unreadable
 * for exactly the reason it needed to be read.
 */
export function safeErrorText(input: string): string {
  const result = sanitize(input ?? '', MAX_ERROR_CHARS);
  return result.text;
}

/** A trailing note naming what was done to the payload, or '' if nothing was. */
export function sanitizeNote(result: SanitizeResult): string {
  const parts: string[] = [];
  if (result.redacted.length) {
    parts.push(`credentials and internal addresses were removed (${[...new Set(result.redacted)].join(', ')})`);
  }
  if (result.collapsed) parts.push('a long run of repeated characters was collapsed');
  if (result.truncated) parts.push('the payload was truncated');
  if (!parts.length) return '';
  return `\n\n(Note: ${parts.join('; ')}.)`;
}

/**
 * Unwrap the hosted server's `{"success":true,"data":…}` envelope.
 *
 * Returns the payload when the text is that envelope, and the original text
 * otherwise — so a tool that answers with plain prose is unaffected.
 */
export function unwrapEnvelope(text: string): unknown {
  const trimmed = (text ?? '').trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return trimmed;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'success' in parsed && 'data' in parsed) {
      return (parsed as { data: unknown }).data;
    }
    return parsed;
  } catch {
    return trimmed;
  }
}

/** Render an unwrapped payload as text, so every tool reads the same way. */
export function renderPayload(data: unknown): string {
  if (data === null || data === undefined) return '';
  if (typeof data === 'string') return data;
  if (typeof data === 'number' || typeof data === 'boolean') return String(data);
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

export interface NavigationFacts {
  status?: number;
  title?: string;
}

const STATUS_KEYS = ['status', 'statuscode', 'httpstatus', 'responsestatus'];
const TITLE_KEYS = ['title', 'pagetitle', 'documenttitle'];

/**
 * Pull just the navigation facts out of whatever `navigate` answered with.
 *
 * An ALLOWLIST, deliberately, and the security fix for finding (1): the
 * upstream payload is a serialized CDP connection whose shape this connector
 * does not control, so projecting the two fields worth reporting is the only
 * approach that stays safe when Browserbase adds a third secret. The URL is
 * not read from here at all — the caller already knows which URL it asked for,
 * and that is more trustworthy than anything echoed back.
 *
 * Searches breadth-first to a bounded depth so a deeply nested object cannot
 * turn this into a long walk. The values it does return are redacted, because
 * an allowlist of FIELD NAMES says nothing about what those fields contain.
 */
export function extractNavigationFacts(data: unknown): NavigationFacts {
  const facts: NavigationFacts = {};
  const queue: Array<{ value: unknown; depth: number }> = [{ value: data, depth: 0 }];
  let visited = 0;

  while (queue.length > 0 && visited < 200) {
    const { value, depth } = queue.shift()!;
    visited += 1;
    if (!value || typeof value !== 'object' || depth > 3) continue;

    for (const [rawKey, child] of Object.entries(value as Record<string, unknown>)) {
      const key = rawKey.toLowerCase();
      if (facts.status === undefined && STATUS_KEYS.includes(key)) {
        const numeric = typeof child === 'number' ? child : Number(child);
        // Only a plausible HTTP status — `status: "RUNNING"` is not one.
        if (Number.isInteger(numeric) && numeric >= 100 && numeric <= 599) facts.status = numeric;
      }
      if (facts.title === undefined && TITLE_KEYS.includes(key) && typeof child === 'string' && child.trim()) {
        // Redacted, not just length-capped. The allowlist stops an UNKNOWN
        // field reaching the caller, but a field on the list can still carry a
        // secret in its value — a page whose <title> holds a token, or an
        // upstream that puts one there. Both navigate paths read this, so the
        // protection belongs here rather than in each of them.
        facts.title = redactSecrets(child.trim().slice(0, 300)).text;
      }
      if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 });
    }
  }
  return facts;
}
