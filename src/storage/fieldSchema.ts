// The Storage MCP's schema language: a flat map of typed, described fields,
// compiled to a strict Zod object. Deliberately smaller than JSON Schema — every
// field is top-level, so a migration can name exactly what it changes — and
// `json` is the escape hatch for nested, scraped blobs.
import { z } from 'zod';

export const FIELD_TYPES = ['string', 'number', 'integer', 'boolean', 'datetime', 'url', 'string[]', 'number[]', 'json'] as const;
export type FieldType = typeof FIELD_TYPES[number];

export interface FieldDef {
  type: FieldType;
  required: boolean;
  description: string;
  enum?: string[];
}
export type Fields = Record<string, FieldDef>;

/** Leading `_` is reserved for the system fields reads add (`_id`, `_updatedAt`, …). */
export const FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
export const MAX_FIELDS = 50;

export const fieldDefSchema = z.object({
  type: z.enum(FIELD_TYPES).describe('string, number, integer, boolean, datetime (ISO 8601), url, string[], number[], or json (any object or array, for nested data that needs no querying).'),
  required: z.boolean().default(false).describe('Whether every record must carry this field.'),
  description: z.string().min(1).max(500).describe('What the field holds. Required: it is what a later conversation reads to understand the data.'),
  enum: z.array(z.string().min(1).max(200)).min(1).max(100).optional().describe('Allowed values. Only for string and string[] fields.'),
});

export const fieldsSchema = z.record(z.string(), fieldDefSchema)
  .describe('The collection\'s fields, by name. Names start with a letter and use letters, digits and _ (max 64 chars); at most 50 fields.');

/**
 * The field named `name`, if the schema has one. An own-property check, so
 * names like `constructor` or `toString` are not mistaken for Object.prototype
 * members — `fields[name]` alone would find those on every schema.
 */
export function fieldOf(fields: Fields, name: string): FieldDef | undefined {
  return Object.hasOwn(fields, name) ? fields[name] : undefined;
}

const ENUM_TYPES: ReadonlySet<FieldType> = new Set(['string', 'string[]']);
export const SCALAR_TYPES: ReadonlySet<FieldType> = new Set(['string', 'number', 'integer', 'boolean', 'datetime', 'url']);

/** Problems with one field definition, phrased for the model. Empty when valid. */
export function fieldDefProblems(name: string, def: FieldDef): string[] {
  const problems: string[] = [];
  if (!FIELD_NAME_RE.test(name)) {
    problems.push(`"${name}" is not a valid field name: start with a letter, then letters, digits or _ (max 64 chars). A leading _ is reserved.`);
  } else if (name in Object.prototype) {
    // Zod reads a missing key's INHERITED value (Object.prototype.toString is
    // a function), so such a field would fail validation on every record.
    problems.push(`"${name}" is reserved (a built-in JavaScript object property); pick another field name.`);
  }
  if (def.enum && !ENUM_TYPES.has(def.type)) {
    problems.push(`"${name}": enum is only allowed on string and string[] fields, not ${def.type}.`);
  }
  return problems;
}

/** Problems with a whole field map. Empty when valid. */
export function fieldsProblems(fields: Fields): string[] {
  const names = Object.keys(fields);
  const problems: string[] = [];
  if (names.length === 0) problems.push('A collection needs at least one field.');
  if (names.length > MAX_FIELDS) problems.push(`A collection has at most ${MAX_FIELDS} fields; this one would have ${names.length}.`);
  for (const name of names) problems.push(...fieldDefProblems(name, fields[name]));
  return problems;
}

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const datetimeSchema = z.string().refine(
  (s) => ISO_DATETIME_RE.test(s) && !Number.isNaN(Date.parse(s)),
  { message: 'Expected an ISO 8601 date or date-time, e.g. 2026-11-04 or 2026-11-04T10:30:00Z' },
);

function stringSchema(def: FieldDef): z.ZodTypeAny {
  return def.enum ? z.enum(def.enum as [string, ...string[]]) : z.string();
}

/** The Zod schema for one field's value. */
export function valueSchema(def: FieldDef): z.ZodTypeAny {
  switch (def.type) {
    case 'string': return stringSchema(def);
    case 'number': return z.number().finite();
    case 'integer': return z.number().int();
    case 'boolean': return z.boolean();
    case 'datetime': return datetimeSchema;
    case 'url': return z.string().url();
    case 'string[]': return z.array(stringSchema(def));
    case 'number[]': return z.array(z.number().finite());
    case 'json': return z.union([z.record(z.unknown()), z.array(z.unknown())]);
  }
}

/** A strict schema for whole records: unknown fields are rejected, which is the point. */
export function buildRecordSchema(fields: Fields): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, def] of Object.entries(fields)) {
    shape[name] = def.required ? valueSchema(def) : valueSchema(def).optional();
  }
  return z.object(shape).strict();
}

export type RecordValidation =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; issues: string[] };

/**
 * Validates one record. A null on an optional field means "absent" and is
 * dropped — models send null for "unknown" far more often than they omit a key.
 */
export function validateRecord(fields: Fields, record: unknown): RecordValidation {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, issues: ['A record must be a JSON object.'] };
  }
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    if (value === null && fieldOf(fields, key)?.required === false) continue;
    cleaned[key] = value;
  }
  const parsed = buildRecordSchema(fields).safeParse(cleaned);
  if (parsed.success) return { ok: true, data: parsed.data as Record<string, unknown> };
  const issues = parsed.error.issues.map((issue) => {
    if (issue.code === 'unrecognized_keys') {
      return `unknown field(s) ${issue.keys.map((k) => `"${k}"`).join(', ')}; the schema has ${Object.keys(fields).map((k) => `"${k}"`).join(', ')}. Add a field with migrateCollection first.`;
    }
    const path = issue.path.length ? `field "${issue.path.join('.')}"` : 'record';
    return `${path}: ${issue.message}`;
  });
  return { ok: false, issues };
}

export type Conversion = { ok: true; value: unknown } | { ok: false; reason: string };

const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

function convertScalar(value: unknown, to: FieldType): Conversion {
  const fail = (): Conversion => ({ ok: false, reason: `cannot convert ${JSON.stringify(value)} to ${to}` });
  switch (to) {
    case 'string':
    case 'url':
      if (typeof value === 'string') return { ok: true, value };
      if (typeof value === 'number' || typeof value === 'boolean') return { ok: true, value: String(value) };
      return fail();
    case 'number':
    case 'integer': {
      let n: number | undefined;
      if (typeof value === 'number') n = value;
      else if (typeof value === 'string' && NUMERIC_RE.test(value.trim())) n = Number(value.trim());
      else if (typeof value === 'boolean') n = value ? 1 : 0;
      if (n === undefined || !Number.isFinite(n)) return fail();
      if (to === 'integer' && !Number.isInteger(n)) return fail();
      return { ok: true, value: n };
    }
    case 'boolean':
      if (typeof value === 'boolean') return { ok: true, value };
      if (typeof value === 'string' && /^(true|false)$/i.test(value.trim())) return { ok: true, value: value.trim().toLowerCase() === 'true' };
      if (value === 0 || value === 1) return { ok: true, value: value === 1 };
      return fail();
    case 'datetime':
      if (typeof value === 'number' && Number.isFinite(value)) {
        // Past ±8.64e15 ms a Date is invalid and toISOString() throws.
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? fail() : { ok: true, value: date.toISOString() };
      }
      if (typeof value === 'string') return { ok: true, value };
      return fail();
    default:
      return fail();
  }
}

/**
 * Converts a stored value to another field type, for a migration's type
 * change. Returns a failure rather than guessing; the caller validates the
 * result against the new field afterwards.
 */
export function convertValue(value: unknown, to: FieldType): Conversion {
  if (to === 'json') {
    return value !== null && typeof value === 'object'
      ? { ok: true, value }
      : { ok: false, reason: `cannot convert ${JSON.stringify(value)} to json (needs an object or array)` };
  }
  if (to === 'string[]' || to === 'number[]') {
    const element: FieldType = to === 'string[]' ? 'string' : 'number';
    const items = Array.isArray(value) ? value : [value];
    const out: unknown[] = [];
    for (const item of items) {
      const converted = convertScalar(item, element);
      if (!converted.ok) return converted;
      out.push(converted.value);
    }
    return { ok: true, value: out };
  }
  if (Array.isArray(value) || (value !== null && typeof value === 'object')) {
    return { ok: false, reason: `cannot convert ${Array.isArray(value) ? 'an array' : 'an object'} to ${to}` };
  }
  return convertScalar(value, to);
}

/** Validates a single value against a field definition. */
export function valueProblem(def: FieldDef, value: unknown): string | null {
  const parsed = valueSchema(def).safeParse(value);
  return parsed.success ? null : parsed.error.issues[0]?.message ?? 'invalid value';
}
