// The migration planner: pure, no database. migrateCollection runs the same
// plan for a dry run and for the real thing, so what the dry run shows is
// exactly what gets written.
import { z } from 'zod';
import {
  FIELD_TYPES,
  MAX_FIELDS,
  convertValue,
  fieldDefProblems,
  fieldOf,
  validateRecord,
  valueProblem,
  type FieldDef,
  type Fields,
} from './fieldSchema.js';

const fieldName = z.string().min(1).max(64);

export const migrationOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('addField'),
    field: fieldName,
    type: z.enum(FIELD_TYPES),
    required: z.boolean().default(false),
    description: z.string().min(1).max(500),
    enum: z.array(z.string().min(1).max(200)).min(1).max(100).optional(),
    default: z.unknown().optional().describe('Value given to existing records. Required when adding a required field to a collection that has records.'),
  }),
  z.object({
    op: z.literal('renameField'),
    from: fieldName,
    to: fieldName,
  }),
  z.object({
    op: z.literal('removeField'),
    field: fieldName,
  }),
  z.object({
    op: z.literal('changeField'),
    field: fieldName,
    type: z.enum(FIELD_TYPES).optional().describe('New type; every existing value is converted, and the migration aborts on any value that cannot be, unless default is given.'),
    required: z.boolean().optional(),
    description: z.string().min(1).max(500).optional(),
    enum: z.array(z.string().min(1).max(200)).min(1).max(100).nullable().optional().describe('New allowed values; null removes the restriction.'),
    default: z.unknown().optional().describe('Value for records whose current value is missing or cannot be converted.'),
  }),
  z.object({
    op: z.literal('setOptions'),
    description: z.string().min(1).max(1000).optional(),
    keyField: fieldName.nullable().optional().describe('Field whose value uniquely identifies a record (enables upsert by key). null removes it.'),
    ttlDays: z.number().int().min(1).max(3650).nullable().optional().describe('Records older than this are flagged _stale on read. null removes it.'),
  }),
]);
export type MigrationOp = z.infer<typeof migrationOpSchema>;

export interface CollectionShape {
  description: string;
  fields: Fields;
  keyField: string | null;
  ttlDays: number | null;
}

export interface StoredRecord {
  id: string;
  key: string | null;
  data: Record<string, unknown>;
}

export interface PlannedChange {
  id: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  key: string | null;
}

export interface MigrationPlan {
  shape: CollectionShape;
  changed: PlannedChange[];
  failures: Array<{ id: string; reason: string }>;
}

/**
 * JSON with object keys sorted, for comparing records. Postgres returns JSONB
 * keys in its own order (shortest first) while validation returns schema
 * order, so a plain JSON.stringify would call every untouched record changed.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** A migration the planner refuses outright (bad op, not a bad record). */
export class MigrationError extends Error {}

/** The key a record gets under `keyField`, or null when it has no usable value. */
export function keyOf(data: Record<string, unknown>, keyField: string | null): string | null {
  if (!keyField) return null;
  const value = data[keyField];
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** Field types a keyField may have: the value must be a single string or number. */
const KEYABLE: ReadonlySet<string> = new Set(['string', 'url', 'integer', 'number']);

/** Checks a keyField against fields. Returns a problem, or null. */
export function keyFieldProblem(fields: Fields, keyField: string): string | null {
  const def = fieldOf(fields, keyField);
  if (!def) return `keyField "${keyField}" is not a field of this collection.`;
  if (!KEYABLE.has(def.type)) return `keyField "${keyField}" is ${def.type}; a key must be a string, url, integer or number field.`;
  if (!def.required) return `keyField "${keyField}" must be a required field, so every record has a key.`;
  return null;
}

function requireField(fields: Fields, name: string, opName: string): FieldDef {
  const def = fieldOf(fields, name);
  if (!def) throw new MigrationError(`${opName}: there is no field "${name}". Fields: ${Object.keys(fields).join(', ') || '(none)'}.`);
  return def;
}

/** Applies the ops to the collection's shape, refusing any op that cannot apply. */
function planShape(shape: CollectionShape, ops: MigrationOp[], recordCount: number): CollectionShape {
  const fields: Fields = { ...shape.fields };
  let { description, keyField, ttlDays } = shape;
  for (const op of ops) {
    switch (op.op) {
      case 'addField': {
        if (fieldOf(fields, op.field)) throw new MigrationError(`addField: "${op.field}" already exists. Use changeField to modify it.`);
        const def: FieldDef = { type: op.type, required: op.required, description: op.description, ...(op.enum ? { enum: op.enum } : {}) };
        const problems = fieldDefProblems(op.field, def);
        if (problems.length) throw new MigrationError(`addField: ${problems.join(' ')}`);
        if (op.required && recordCount > 0 && op.default === undefined) {
          throw new MigrationError(`addField: "${op.field}" is required and the collection has ${recordCount} record(s), so give a default for them.`);
        }
        if (op.default !== undefined) {
          const problem = valueProblem(def, op.default);
          if (problem) throw new MigrationError(`addField: the default for "${op.field}" is invalid: ${problem}`);
        }
        fields[op.field] = def;
        if (Object.keys(fields).length > MAX_FIELDS) throw new MigrationError(`addField: a collection has at most ${MAX_FIELDS} fields.`);
        break;
      }
      case 'renameField': {
        const def = requireField(fields, op.from, 'renameField');
        if (fieldOf(fields, op.to)) throw new MigrationError(`renameField: "${op.to}" already exists.`);
        const problems = fieldDefProblems(op.to, def);
        if (problems.length) throw new MigrationError(`renameField: ${problems.join(' ')}`);
        delete fields[op.from];
        fields[op.to] = def;
        if (keyField === op.from) keyField = op.to;
        break;
      }
      case 'removeField': {
        requireField(fields, op.field, 'removeField');
        if (keyField === op.field) throw new MigrationError(`removeField: "${op.field}" is the keyField. Change keyField with setOptions first.`);
        delete fields[op.field];
        if (Object.keys(fields).length === 0) throw new MigrationError('removeField: a collection needs at least one field. Use dropCollection to delete it.');
        break;
      }
      case 'changeField': {
        const current = requireField(fields, op.field, 'changeField');
        if (op.type === undefined && op.required === undefined && op.description === undefined && op.enum === undefined) {
          throw new MigrationError(`changeField: nothing to change on "${op.field}". Give type, required, description or enum.`);
        }
        const next: FieldDef = {
          type: op.type ?? current.type,
          required: op.required ?? current.required,
          description: op.description ?? current.description,
        };
        const nextEnum = op.enum === undefined ? current.enum : op.enum ?? undefined;
        if (nextEnum) next.enum = nextEnum;
        const problems = fieldDefProblems(op.field, next);
        if (problems.length) throw new MigrationError(`changeField: ${problems.join(' ')}`);
        if (op.default !== undefined) {
          const problem = valueProblem(next, op.default);
          if (problem) throw new MigrationError(`changeField: the default for "${op.field}" is invalid: ${problem}`);
        }
        fields[op.field] = next;
        break;
      }
      case 'setOptions': {
        if (op.description === undefined && op.keyField === undefined && op.ttlDays === undefined) {
          throw new MigrationError('setOptions: nothing to change. Give description, keyField or ttlDays.');
        }
        if (op.description !== undefined) description = op.description;
        if (op.keyField !== undefined) keyField = op.keyField;
        if (op.ttlDays !== undefined) ttlDays = op.ttlDays;
        break;
      }
    }
  }
  if (keyField) {
    const problem = keyFieldProblem(fields, keyField);
    if (problem) throw new MigrationError(problem);
  }
  return { description, fields, keyField, ttlDays };
}

/** One record through every op. Returns the new data, or why it cannot migrate. */
function migrateData(data: Record<string, unknown>, ops: MigrationOp[], fieldsAfter: (i: number) => Fields): { data: Record<string, unknown> } | { reason: string } {
  const out: Record<string, unknown> = { ...data };
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    switch (op.op) {
      case 'addField':
        if (out[op.field] === undefined && op.default !== undefined) out[op.field] = op.default;
        break;
      case 'renameField':
        if (op.from in out) {
          out[op.to] = out[op.from];
          delete out[op.from];
        }
        break;
      case 'removeField':
        delete out[op.field];
        break;
      case 'changeField': {
        const def = fieldOf(fieldsAfter(i), op.field) as FieldDef;
        const current = out[op.field];
        if (current === undefined) {
          // The default fills a missing value whether or not the field is
          // required — that is what its description promises.
          if (op.default !== undefined) out[op.field] = op.default;
          else if (def.required) return { reason: `"${op.field}" is missing and is now required (give a default)` };
          break;
        }
        const converted = op.type ? convertValue(current, def.type) : { ok: true as const, value: current };
        const problem = converted.ok ? valueProblem(def, converted.value) : converted.reason;
        if (problem === null && converted.ok) {
          out[op.field] = converted.value;
        } else if (op.default !== undefined) {
          out[op.field] = op.default;
        } else {
          return { reason: `"${op.field}": ${problem}` };
        }
        break;
      }
      case 'setOptions':
        break;
    }
  }
  return { data: out };
}

/**
 * Plans a migration over every record. Throws MigrationError when an op cannot
 * apply at all; records that cannot migrate are returned as failures, and any
 * failure means the migration must not be applied.
 */
export function planMigration(shape: CollectionShape, records: StoredRecord[], ops: MigrationOp[]): MigrationPlan {
  if (ops.length === 0) throw new MigrationError('A migration needs at least one operation.');
  // The field map after each op, so changeField validates against its own step.
  const steps: Fields[] = [];
  for (let i = 0; i < ops.length; i++) steps.push(planShape(shape, ops.slice(0, i + 1), records.length).fields);
  const next = planShape(shape, ops, records.length);

  const changed: PlannedChange[] = [];
  const failures: Array<{ id: string; reason: string }> = [];
  const seenKeys = new Map<string, string>();

  for (const record of records) {
    const migrated = migrateData(record.data, ops, (i) => steps[i]);
    if ('reason' in migrated) {
      failures.push({ id: record.id, reason: migrated.reason });
      continue;
    }
    const validation = validateRecord(next.fields, migrated.data);
    if (!validation.ok) {
      failures.push({ id: record.id, reason: validation.issues.join('; ') });
      continue;
    }
    const key = keyOf(validation.data, next.keyField);
    if (next.keyField) {
      if (key === null) {
        failures.push({ id: record.id, reason: `no value for keyField "${next.keyField}"` });
        continue;
      }
      const other = seenKeys.get(key);
      if (other) {
        failures.push({ id: record.id, reason: `keyField "${next.keyField}" value ${JSON.stringify(key)} is also used by record ${other}` });
        continue;
      }
      seenKeys.set(key, record.id);
    }
    if (canonicalJson(validation.data) !== canonicalJson(record.data) || key !== record.key) {
      changed.push({ id: record.id, before: record.data, after: validation.data, key });
    }
  }
  return { shape: next, changed, failures };
}
