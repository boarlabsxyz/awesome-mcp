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
