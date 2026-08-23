// Safe coercion helpers for Express `req.query` values.
//
// `req.query.X` is typed as `string | string[] | ParsedQs | ParsedQs[] |
// undefined`. The historical `(req.query.X ?? '').toString()` pattern produced
// `'[object Object]'` if a client sent a nested query (e.g. ?foo[bar]=baz),
// silently corrupting downstream parsing/validation. These helpers fall back
// to a default when the value isn't a plain string.

export function qstr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/**
 * Parse a query value as a base-10 integer with a fallback for non-string or
 * NaN inputs. Optional clamping keeps the result within [min, max].
 */
export function qint(
  v: unknown,
  fallback: number,
  opts: { min?: number; max?: number } = {},
): number {
  const raw = typeof v === 'string' ? v : '';
  const parsed = Number.parseInt(raw, 10);
  let n = Number.isFinite(parsed) ? parsed : fallback;
  if (opts.min !== undefined) n = Math.max(n, opts.min);
  if (opts.max !== undefined) n = Math.min(n, opts.max);
  return n;
}

/**
 * Parse a repeatable query value into a string array.
 *
 * Accepts both `?status=opened&status=closed` (Express hands us an array) and
 * `?status=opened,closed` (a single comma-separated string), because curl users
 * reach for either. Non-string entries — the `?foo[bar]=baz` nested-object case
 * `qstr` guards against — are dropped rather than stringified to
 * `'[object Object]'`. Returns `undefined` when nothing usable is present, so
 * callers can pass the result straight through to an optional client field.
 */
export function qarr(v: unknown): string[] | undefined {
  const raw = Array.isArray(v) ? v : [v];
  const out = raw
    .filter((x): x is string => typeof x === 'string')
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return out.length > 0 ? out : undefined;
}
