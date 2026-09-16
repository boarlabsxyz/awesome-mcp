// Invariants a tool's output must hold, for the tiers where exact values cannot
// be asserted.
//
// The needle tier asserts a literal substring and needs nothing from this file.
// The volume and zero tiers cannot: the rich account's content changes, and the
// interesting failures there are shape failures, not value failures. Nearly
// every entry below exists because CLAUDE.md documents a real bug of that shape:
//
//   parsesAsJson       format:'json' used to slice already-serialised JSON and
//                      return the fragment, so callers failed with "EOF while
//                      parsing a string" -- a truncation bug that reads exactly
//                      like a transport bug.
//   noLoneSurrogates   truncation used substring(), which cuts on UTF-16 code
//                      units and leaves an unpaired surrogate mid-pair. Only
//                      reproducible on content long enough to truncate.
//   transportSafe      the U+000B Docs emits for a shift-enter soft break, and
//                      the private-use placeholders it emits for inline objects,
//                      must not reach the wire verbatim.
//   minLines           a paging cap that silently returns the first N and reads
//                      as "that is all there is".
//
// All failures are collected and reported together: a volume check that breaks
// three invariants at once tells you more than its first one does.

export interface Invariants {
  /** Literal substrings that must appear. */
  includes?: string[];
  /** Literal substrings that must NOT appear. */
  excludes?: string[];
  /** Patterns that must match. */
  matches?: RegExp[];
  minLength?: number;
  /** Non-empty lines, after trimming. Use for "did this return N rows". */
  minLines?: number;
  /** The body (or the slice named by `between`) must be valid JSON. */
  parsesAsJson?: boolean;
  /** No unpaired UTF-16 surrogate anywhere in the body. */
  noLoneSurrogates?: boolean;
  /** No raw Docs control / private-use characters. Implies noLoneSurrogates. */
  transportSafe?: boolean;
  /** Escape hatch: return a message to fail, anything else to pass. */
  predicate?: (body: string) => string | void | undefined;
  /** Narrow the body to what lies between these markers before checking. */
  between?: [string, string];
}

// Written as code points rather than literals or escapes on purpose: these
// characters are invisible in a diff and in a terminal, so a future edit that
// "tidies" them would silently disable the check.
const VERTICAL_TAB = 0x0b;
const PRIVATE_USE_START = 0xe000;
const PRIVATE_USE_END = 0xf8ff;

export function checkInvariants(response: string, inv: Invariants): void {
  const failures: string[] = [];
  let body = response;

  if (inv.between) {
    const [start, end] = inv.between;
    const from = body.indexOf(start);
    const to = from === -1 ? -1 : body.indexOf(end, from + start.length);
    if (from === -1 || to === -1) {
      throw new Error(
        `Response missing delimiters ${JSON.stringify(inv.between)}. Response: ${truncate(response)}`,
      );
    }
    body = body.slice(from + start.length, to);
  }

  for (const needle of inv.includes ?? []) {
    if (!body.includes(needle)) failures.push(`missing substring ${JSON.stringify(needle)}`);
  }
  for (const banned of inv.excludes ?? []) {
    if (body.includes(banned)) failures.push(`contains banned substring ${JSON.stringify(banned)}`);
  }
  for (const pattern of inv.matches ?? []) {
    if (!pattern.test(body)) failures.push(`does not match ${pattern}`);
  }
  if (inv.minLength !== undefined && body.length < inv.minLength) {
    failures.push(`length ${body.length} < minLength ${inv.minLength}`);
  }
  if (inv.minLines !== undefined) {
    const lines = body.split('\n').filter((l) => l.trim().length > 0).length;
    if (lines < inv.minLines) failures.push(`${lines} non-empty lines < minLines ${inv.minLines}`);
  }
  if (inv.parsesAsJson) {
    try {
      JSON.parse(body);
    } catch (e) {
      failures.push(`not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (inv.noLoneSurrogates || inv.transportSafe) {
    const at = findLoneSurrogate(body);
    if (at !== -1) {
      failures.push(
        `lone surrogate 0x${hex(body.charCodeAt(at))} at offset ${at} ` +
          '(truncation cut a surrogate pair -- use sliceSafe, not substring)',
      );
    }
  }
  if (inv.transportSafe) {
    const unsafe = findUnsafeChar(body);
    if (unsafe) {
      failures.push(
        unsafe.code === VERTICAL_TAB
          ? `raw U+000B at offset ${unsafe.offset} (soft break not converted to a newline)`
          : `private-use character 0x${hex(unsafe.code)} at offset ${unsafe.offset} ` +
            '(an inline-object placeholder reached the wire)',
      );
    }
  }
  const custom = inv.predicate?.(body);
  if (typeof custom === 'string') failures.push(custom);

  if (failures.length > 0) {
    throw new Error(
      `${failures.length} invariant(s) failed:\n  - ${failures.join('\n  - ')}\nBody: ${truncate(body)}`,
    );
  }
}

/** Offset of the first unpaired surrogate, or -1. */
export function findLoneSurrogate(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;
    if (!isHigh && !isLow) continue;
    if (isLow) return i; // a low surrogate with no high surrogate before it
    const next = s.charCodeAt(i + 1);
    if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return i;
    i++; // consumed a valid pair
  }
  return -1;
}

/** First vertical tab or private-use character, or null. */
export function findUnsafeChar(s: string): { offset: number; code: number } | null {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === VERTICAL_TAB || (code >= PRIVATE_USE_START && code <= PRIVATE_USE_END)) {
      return { offset: i, code };
    }
  }
  return null;
}

function hex(code: number): string {
  return code.toString(16).toUpperCase().padStart(4, '0');
}

function truncate(s: string, n = 600): string {
  return s.length > n ? `${s.slice(0, n)}...(truncated)` : s;
}

/**
 * Patterns for a model reporting that a tool let it down.
 *
 * This is the assertion that only exists for live-client tests, and it covers a
 * failure mode nothing else can see. A direct tool check gets a 403 and fails
 * loudly. A model gets the same 403 and says "I don't have permission to search
 * your Drive" -- or quietly falls back to another tool and answers anyway. Both
 * read as success to anything watching the transport, and in production nobody
 * files a bug for the first one, because the assistant sounded like it was
 * working as intended.
 *
 * Every loose verb is QUALIFIED by what it could not do, and that is the whole
 * design. "I was unable to find a matching document" is a correct answer to a
 * search with no matches; "I was unable to access your documents" is a tool
 * failure. A bare /unable to/ cannot tell them apart and would fail a passing
 * task on the model's choice of wording -- which is the same reason
 * "I couldn't find" is absent entirely.
 */
export const REPORTED_FAILURE_PATTERNS: readonly RegExp[] = [
  /i (?:don't|do not) have (?:the )?(?:permission|access)/i,
  /permission denied/i,
  /not authorized/i,
  /insufficient permissions?/i,
  // Qualified by an ACCESS verb, never "find".
  /i (?:was|am) (?:unable|not able) to (?:access|read|list|search|retrieve|open|reach|connect)/i,
  /i (?:wasn't|couldn't|could not) (?:able to )?(?:access|read|list|retrieve|open|reach|connect)/i,
  /(?:an )?error (?:occurred|occurred while)/i,
  /encountered an error/i,
  /something went wrong/i,
  /failed to (?:retrieve|access|read|list|search|open)/i,
];

/**
 * The text of the first reported-failure match, or null.
 *
 * `extra` takes strings (matched literally, case-insensitively) or regexes, for
 * a phrase that only counts as a failure in one task's context.
 */
export function findReportedFailure(
  text: string,
  extra: readonly (string | RegExp)[] = [],
): string | null {
  for (const pattern of REPORTED_FAILURE_PATTERNS) {
    const hit = text.match(pattern);
    if (hit) return hit[0];
  }
  for (const item of extra) {
    if (typeof item === 'string') {
      const at = text.toLowerCase().indexOf(item.toLowerCase());
      if (at !== -1) return text.slice(at, at + item.length);
    } else {
      const hit = text.match(item);
      if (hit) return hit[0];
    }
  }
  return null;
}
