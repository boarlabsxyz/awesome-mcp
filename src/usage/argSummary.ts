// What a tool call's arguments are reduced to before they are stored for the
// /admin usage view.
//
// MCP never carries the user's prompt — a server sees only the tool name and
// the arguments the model wrote — so search-like arguments are the closest
// signal of intent we have. They are also the only values kept: every other
// argument is recorded by NAME (and the call by total size) because the values
// are document text, email bodies, Slack messages and CRM records, none of
// which belong in an analytics table.
import { sliceSafe } from '../google-docs/textSafety.js';

/**
 * Top-level argument names whose string values are kept (truncated and
 * redacted). Deliberately short: person-name fields (`firstName`, …) and
 * `subject` are left out because their values are personal data or content.
 */
export const PREVIEW_KEYS: ReadonlySet<string> = new Set([
  'query',
  'searchQuery',
  'search',
  'searchValue',
  'searchColumn',
  'findText',
  'textToFind',
  'matchPattern',
  'pattern',
  'title',
  'name',
  'sheetName',
  'tagName',
]);

export const PREVIEW_MAX_CHARS = 200;

export type PreviewValue =
  | string
  | number
  | boolean
  | null
  | { type: 'array' | 'object'; length: number };

export interface ArgSummary {
  argKeys: string[];
  argPreview: Record<string, PreviewValue> | null;
  argBytes: number | null;
}

// Credential shapes that can plausibly appear in a query or an error message.
// Each is replaced wholesale; the prefix is kept so an admin can still see
// WHAT kind of secret was pasted, which is itself worth knowing.
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '[REDACTED_JWT]'],
  [/\bgithub_pat_[A-Za-z0-9_]{10,}/g, 'github_pat_[REDACTED]'],
  [/\b(gh[pousr])_[A-Za-z0-9]{10,}/g, '$1_[REDACTED]'],
  [/\b(xox[abeoprs])-[A-Za-z0-9-]{8,}/g, '$1-[REDACTED]'],
  [/\bsbp_[A-Za-z0-9]{10,}/g, 'sbp_[REDACTED]'],
  [/\bpcsk_[A-Za-z0-9_]{10,}/g, 'pcsk_[REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-[REDACTED]'],
  [/\bpk_[A-Za-z0-9_]{16,}/g, 'pk_[REDACTED]'],
];

/** `text` with every recognised credential replaced by its prefix and a placeholder. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

// A secret's prefix followed by token characters running to the very end of a
// truncated string: what is left when a cut lands inside a token, too short
// for SECRET_PATTERNS' minimum lengths to recognise.
const DANGLING_SECRET = /\b(Bearer\s+|eyJ|github_pat_|gh[pousr]_|xox[abeoprs]-|sbp_|pcsk_|sk-|pk_)[A-Za-z0-9._~+/=-]*$/;

/**
 * Redacts, THEN truncates to `max` characters. The other order lets a token
 * that straddles the cut lose enough characters to slip under its pattern's
 * minimum length and be stored as a partial secret. Redaction runs over a
 * bounded window (4 × max) so the regexes never scan an unbounded input, and
 * whenever anything was cut, a token fragment left dangling at the end — at
 * either cut — is masked as well.
 */
export function redactAndTruncate(text: string, max: number): string {
  const window = sliceSafe(text, max * 4);
  const redacted = redactSecrets(window);
  const out = sliceSafe(redacted, max);
  const truncated = window.length < text.length || out.length < redacted.length;
  if (!truncated) return out;
  // The mask can be longer than the fragment it replaces, so cap again; a cut
  // through the placeholder itself leaves nothing of the secret.
  return sliceSafe(out.replace(DANGLING_SECRET, '$1[TRUNCATED]'), max);
}

/** The stored form of one allowlisted argument value. */
function previewValue(value: unknown): PreviewValue | undefined {
  if (value === null) return null;
  if (typeof value === 'string') return redactAndTruncate(value, PREVIEW_MAX_CHARS);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return { type: 'array', length: value.length };
  if (typeof value === 'object') return { type: 'object', length: Object.keys(value as object).length };
  return undefined;
}

/** Argument names, total size, and redacted values for the allowlisted keys only. */
export function summarizeArgs(args: unknown): ArgSummary {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { argKeys: [], argPreview: null, argBytes: null };
  }
  const record = args as Record<string, unknown>;
  const argKeys = Object.keys(record).filter((k) => record[k] !== undefined);

  let argPreview: Record<string, PreviewValue> | null = null;
  for (const key of argKeys) {
    if (!PREVIEW_KEYS.has(key)) continue;
    const v = previewValue(record[key]);
    if (v === undefined) continue;
    (argPreview ??= {})[key] = v;
  }

  let argBytes: number | null = null;
  try {
    argBytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
  } catch {
    // Circular or BigInt-bearing args cannot be sized; the call is still counted.
  }

  return { argKeys, argPreview, argBytes };
}

export const ERROR_MESSAGE_MAX_CHARS = 500;

/** An error's class name and its message, redacted and capped. */
export function summarizeError(err: unknown): { kind: string; message: string } {
  const kind = (err as any)?.name && typeof (err as any).name === 'string' ? (err as any).name : 'Error';
  const raw = typeof (err as any)?.message === 'string' ? (err as any).message : String(err);
  return { kind, message: redactAndTruncate(raw, ERROR_MESSAGE_MAX_CHARS) };
}
