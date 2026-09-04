// src/google-docs/textSafety.ts
import { UserError } from 'fastmcp';

// Keeping Google Docs text safe to put on the wire.
//
// A tool result is embedded in one JSON-RPC message that the MCP SDK writes as
// a single SSE `data:` line via `JSON.stringify`. That is well-formed by spec,
// but two things upstream of it are not:
//
//   1. Every truncation in the Docs handlers used `String.prototype.substring`,
//      which cuts on UTF-16 *code units*. A cut between the halves of a
//      surrogate pair leaves a lone surrogate — legal to stringify (it escapes
//      to \udXXX) and rejected by strict parsers on the other end.
//   2. `textRun.content` is copied verbatim from the API. Google Docs uses
//      U+000B for shift-enter soft line breaks, and private-use characters as
//      placeholders for some inline objects; neither belongs in output a strict
//      JSON reader will parse.
//
// Both produce a payload the caller can neither read nor diagnose, which is
// what `assertTransportSafe` exists to turn into an error naming the offending
// character instead.

/** Unpaired high or low surrogate — what a naive slice creates. */
const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
const LONE_LOW_SURROGATE = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * C0 controls and DEL that must not appear raw. Tab, LF and CR are legitimate
 * text and are deliberately excluded; U+000B is handled separately because it
 * carries meaning (see `sanitizeDocText`).
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const BAD_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Basic Multilingual Plane private-use area. */
const PUA_GLOBAL = /[\uE000-\uF8FF]/g;

/**
 * Truncate to at most `max` UTF-16 code units without splitting a surrogate
 * pair.
 *
 * When `max` would land between the two halves of an astral character (an
 * emoji, most CJK extensions, many maths symbols) the cut backs off by one, so
 * the result is one character shorter rather than one *invalid* character
 * longer. Returns the input untouched when it already fits.
 */
export function sliceSafe(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  // A high surrogate in the last kept position has its partner as the first
  // dropped one, so drop both.
  const end = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return text.slice(0, end);
}

/**
 * Make Google Docs text safe to serialise.
 *
 * - U+000B (vertical tab) becomes a newline. Docs emits it for a shift-enter
 *   soft break, so it genuinely *is* a line break — dropping it would silently
 *   join two lines together.
 * - Other C0 controls and DEL are dropped; they carry no text.
 * - Private-use characters are dropped. Docs uses them as placeholders for
 *   inline objects, and they render as tofu everywhere else.
 * - Any unpaired surrogate becomes U+FFFD, the standard "not representable"
 *   marker, rather than being silently deleted.
 */
export function sanitizeDocText(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex -- U+000B is Docs' soft line break
    .replace(/\u000B/g, '\n')
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u0008\u000C\u000E-\u001F\u007F]/g, '')
    .replace(PUA_GLOBAL, '')
    .replace(new RegExp(LONE_HIGH_SURROGATE.source, 'g'), '�')
    .replace(new RegExp(LONE_LOW_SURROGATE.source, 'g'), '�');
}

/** Where and what the first unencodable character is, or null if clean. */
export function findUnencodable(text: string): { offset: number; codePoint: number } | null {
  const candidates = [
    LONE_HIGH_SURROGATE.exec(text),
    LONE_LOW_SURROGATE.exec(text),
    BAD_CONTROL.exec(text),
  ].filter((m): m is RegExpExecArray => m !== null);
  if (candidates.length === 0) return null;
  const first = candidates.reduce((a, b) => (a.index <= b.index ? a : b));
  return { offset: first.index, codePoint: text.charCodeAt(first.index) };
}

/** `U+000B` style label for an error message. */
export function formatCodePoint(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Last line of defence before a string is handed to the transport.
 *
 * After `sanitizeDocText` this should never fire — that is precisely the point.
 * It exists so that if some path ever does reach the wire with an unencodable
 * character, the caller gets an error naming the offset and code point instead
 * of a JSON parse failure inside their client, which is undiagnosable from the
 * outside and was the original bug report.
 *
 * Returns the text unchanged when clean, so it can wrap a return value.
 *
 * Throws `UserError` rather than a bare `Error`: this is an expected,
 * actionable condition, and FastMCP surfaces a UserError's message as the tool
 * result instead of framing it as an internal execution failure.
 */
export function assertTransportSafe(
  text: string,
  context: { documentId?: string; what?: string } = {},
): string {
  const hit = findUnencodable(text);
  if (!hit) return text;
  const where = context.documentId ? ` in document ${context.documentId}` : '';
  const what = context.what ? `${context.what} ` : '';
  throw new UserError(
    `Refusing to return ${what}content${where}: unencodable character ${formatCodePoint(hit.codePoint)} at offset ${hit.offset}. ` +
    'This character cannot be represented in a JSON tool result. Please report the document ID so the extractor can be fixed.',
  );
}
