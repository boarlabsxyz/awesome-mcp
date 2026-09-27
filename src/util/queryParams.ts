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

/**
 * Optional integer query param, tri-state.
 *
 * `undefined` when the key is absent so an omitted filter stays omitted, but a
 * present-and-unparseable value comes back as `NaN` rather than `undefined`.
 * That distinction is the point: a Zod `z.number()` rejects NaN, so the caller
 * gets a 400 instead of having a filter they believe is applied quietly
 * dropped. Redmine in particular ignores filters it does not understand, so
 * failing open turns a typo into a plausible-looking wrong answer.
 *
 * Use `qint` instead when the param sizes a response and a default is correct.
 */
export function qoptint(v: unknown): number | undefined {
  if (typeof v !== 'string' || v === '') return undefined;
  return Number.parseInt(v, 10);
}

/**
 * Optional boolean query param, tri-state.
 *
 * Absent stays absent so an omitted flag is never sent downstream as an
 * explicit `false` — which matters where the upstream treats its toggles as
 * PRESENCE flags (Redmine's search does), because there "false" and "omitted"
 * are the same thing and only a missing key leaves the default alone.
 */
export function qflag(v: unknown): boolean | undefined {
  if (typeof v !== 'string' || v === '') return undefined;
  return v === 'true' || v === '1';
}

/**
 * Split `?cf_3=Urgent` style keys out of a query string into Redmine's
 * custom-field filter shape, reporting the ones that cannot be used.
 *
 * Two kinds of key are deliberately treated differently. A key that is not
 * `cf_<digits>` is simply not ours — it belongs to another parameter — so it is
 * ignored. A key that IS `cf_<digits>` but whose value is not a plain string
 * has to be an error, and this is the case worth spelling out: Express parses a
 * repeated `?cf_3=a&cf_3=b` into an ARRAY, and a nested `?cf_3[x]=y` into an
 * object. Skipping those would send the query to Redmine with the filter
 * missing, and Redmine answers an absent filter with MORE rows, not fewer — the
 * exact "the filter matched everything" failure this whole path exists to
 * prevent. Redmine wants one comma-joined value (`?cf_3=a,b`), so the caller is
 * told that rather than silently served a wider result set.
 */
export function redmineCustomFieldFilters(
  query: Record<string, unknown>,
): { filters?: Record<string, string>; invalidKeys: string[] } {
  const filters: Record<string, string> = {};
  const invalidKeys: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (!/^cf_\d+$/.test(key)) continue;
    if (typeof value !== 'string') {
      invalidKeys.push(key);
      continue;
    }
    filters[key] = value;
  }
  return {
    filters: Object.keys(filters).length > 0 ? filters : undefined,
    invalidKeys,
  };
}
