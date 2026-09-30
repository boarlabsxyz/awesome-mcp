// Value normalisation for setCustomFieldValue.
//
// The defect this exists for (ticket 86cba13av): ClickUp's
// POST /task/{id}/field/{field_id} requires an ARRAY for every array-valued
// field type, and answers a string with
//
//   ClickUp API error (400): {"err":"Value must be an array","ECODE":"FIELD_144"}
//
// The tool's `value` parameter used to be `z.any()`, which renders as the empty
// JSON Schema `{}` -- so a client with nothing to validate against is free to
// hand the array over as its JSON *text*, and every labels/users write failed
// while the scalar types (text, number, drop_down) wrote cleanly through the
// same call. Every labels field in the workspace was unwritable from an agent.
//
// Two things fix it and both are here: the tool now declares a real union for
// `value` (so the array has a declared shape to survive as), and anything that
// still arrives as a string is revived here before it reaches the request body.
//
// Reviving a string is only unambiguously safe when the field's TYPE is known:
// `["a"]` stored in a text field is a legitimate literal, and parsing it there
// would corrupt a value the caller spelled out. So the server looks the field
// definition up first and passes it in; `definition: undefined` is the
// degraded path (the lookup failed) and is deliberately conservative -- it
// revives only a string that parses as a JSON array or object, and never
// touches numbers, booleans or bare text.

/** The parts of a ClickUp custom-field definition this module reads. */
export interface CustomFieldDefinition {
  id?: string;
  name?: string;
  type?: string;
  type_config?: {
    options?: Array<{ id?: string; name?: string; label?: string; orderindex?: number }>;
  };
}

export interface PreparedCustomFieldValue {
  /** The value to put in the request body. */
  value: unknown;
  /** Human-readable record of every change made to the caller's input. */
  notes: string[];
}

/**
 * A refusal we can explain in the caller's terms, raised before any write.
 * The server wraps it in a UserError; keeping it a plain Error keeps this
 * module free of the FastMCP import so it can be unit-tested on its own.
 */
export class CustomFieldValueError extends Error {}

// Field types whose stored value is a JSON array. A scalar sent to one of
// these is the FIELD_144 rejection above, whatever the scalar is.
const ARRAY_VALUED_FIELD_TYPES = new Set([
  'labels',
  'users',
  'tasks',
  'list_relationship',
]);

export function isArrayValuedFieldType(type?: string): boolean {
  return typeof type === 'string' && ARRAY_VALUED_FIELD_TYPES.has(type);
}

/**
 * ClickUp's INCREMENTAL form, documented for People (`users`) and relationship
 * (`tasks`, `list_relationship`) fields: `{"add": [...], "rem": [...]}`, either
 * key on its own. It is an object, not an array, so an array-valued type has
 * two legal shapes and this one must survive untouched -- wrapping it in an
 * array (or refusing it) breaks a call that worked before any of this existed,
 * and it means something a plain array cannot say: add these without replacing
 * the rest.
 */
export function isIncrementalUpdate(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (!keys.length || !keys.every((k) => k === 'add' || k === 'rem')) return false;
  return keys.every((k) => Array.isArray(obj[k]));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse a string that is really a serialised JSON array or object.
 *
 * Containers only, on purpose: `"12"` in a text field must stay the string
 * "12", and `"true"` must stay "true". Only `[` and `{` openers are considered,
 * so the check is cheap and the false-positive surface is a text value that is
 * also valid JSON *and* starts with a bracket.
 */
export function parseJsonContainer(raw: string): unknown | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function optionLabel(opt: { name?: string; label?: string }): string {
  return opt.label ?? opt.name ?? '';
}

function describeOptions(definition: CustomFieldDefinition): string {
  const options = definition.type_config?.options ?? [];
  if (!options.length) return '';
  return options
    .map((o) => `"${optionLabel(o)}" (id: ${o.id}, orderindex: ${o.orderindex})`)
    .join(', ');
}

/**
 * True when the value could still need the field definition to be written
 * correctly, i.e. when the lookup is worth two GETs.
 *
 * A value that is already an array of UUIDs, a number, or a boolean is sent
 * byte-identically to how it was before this module existed and costs exactly
 * one call -- the same "a plain update still costs one request" rule the
 * re-parent pre-flight follows.
 */
export function needsFieldLookup(value: unknown): boolean {
  if (typeof value === 'string') return true;
  if (Array.isArray(value)) {
    // Entries that are already UUIDs or numeric IDs need no resolution;
    // anything else may be an option *name* only the definition can resolve.
    return value.some((entry) => typeof entry === 'string' && !UUID_RE.test(entry.trim()));
  }
  return false;
}

function resolveLabelEntries(
  entries: unknown[],
  definition: CustomFieldDefinition,
  notes: string[],
): unknown[] {
  const options = definition.type_config?.options ?? [];
  if (!options.length) return entries;
  return entries.map((entry) => {
    if (typeof entry !== 'string') return entry;
    const needle = entry.trim();
    if (options.some((o) => o.id === needle)) return needle;
    const byLabel = options.find((o) => optionLabel(o).toLowerCase() === needle.toLowerCase());
    if (byLabel?.id) {
      notes.push(`Resolved label "${entry}" to its option ID ${byLabel.id}.`);
      return byLabel.id;
    }
    throw new CustomFieldValueError(
      `"${entry}" is not an option on labels field "${definition.name ?? definition.id}". ClickUp has no API to `
      + `create a label option, so this has to match one that already exists: ${describeOptions(definition)}. `
      + `Nothing was written.`,
    );
  });
}

/**
 * A drop-down has TWO working value forms, and which one we send matters.
 *
 * ClickUp documents the value as the option's UUID (`{"value": "option_id"}`),
 * while this tool has always documented and sent the ORDERINDEX -- and that
 * form is verified live (2026-09-29, re-setting a drop-down on a real task), so
 * it is not legacy-in-name-only. Hence:
 *
 *   - an option UUID passes through UNCHANGED. It is already the documented
 *     shape; converting it to an orderindex would trade a value ClickUp
 *     documents for one it merely still accepts, and buy nothing.
 *   - a NUMBER, or a numeric string, stays an orderindex. That is the contract
 *     every existing caller was written against, and silently re-reading it as
 *     something else would change which option they set.
 *   - an option NAME resolves to that option's UUID, the documented form.
 *
 * The response says which form went out, so a rejection is diagnosable rather
 * than a mystery about what the tool decided on the caller's behalf.
 */
function prepareDropDown(
  value: unknown,
  definition: CustomFieldDefinition,
  notes: string[],
): unknown {
  if (typeof value !== 'string' && typeof value !== 'number') return value;
  const needle = String(value).trim();
  const options = definition.type_config?.options ?? [];
  const fieldLabel = definition.name ?? definition.id;

  if (options.some((o) => o.id === needle)) return needle;

  if (needle !== '' && Number.isFinite(Number(needle))) {
    const orderindex = Number(needle);
    // Refused rather than sent: every valid orderindex is one of the options'
    // own, so one that matches none can only set the wrong option or nothing,
    // and a silent no-op here reads as a successful write.
    if (options.length && !options.some((o) => o.orderindex === orderindex)) {
      throw new CustomFieldValueError(
        `No option on drop-down field "${fieldLabel}" has orderindex ${orderindex}. Available: `
        + `${describeOptions(definition)}. Nothing was written.`,
      );
    }
    // A numeric string is an ORDERINDEX, never an option name -- the two really
    // can disagree: the live "Triage Score" field has options named "1".."10"
    // whose orderindexes are 0..9, so name-matching here would quietly write 2
    // where the caller asked for 3. Flag the collision instead of resolving it.
    const sameName = options.find((o) => optionLabel(o) === needle);
    if (sameName && sameName.orderindex !== orderindex) {
      notes.push(
        `Sent ${orderindex} as the orderindex, which is this tool's contract for drop-downs. This field also has an `
        + `option NAMED "${needle}" whose orderindex is ${sameName.orderindex} — pass its option UUID `
        + `(${sameName.id}) if that is the one you meant.`,
      );
    } else if (typeof value === 'string') {
      notes.push(`Read the string "${value}" as the orderindex ${orderindex}.`);
    }
    return orderindex;
  }

  const byLabel = options.find((o) => optionLabel(o).toLowerCase() === needle.toLowerCase());
  if (byLabel?.id) {
    notes.push(`Resolved drop-down option "${value}" to its option UUID ${byLabel.id}, the form ClickUp documents.`);
    return byLabel.id;
  }

  if (options.length) {
    throw new CustomFieldValueError(
      `"${value}" is not an option on drop-down field "${fieldLabel}". Available: ${describeOptions(definition)}. `
      + `Nothing was written.`,
    );
  }
  return value;
}

/**
 * Turn whatever the caller handed us into the shape ClickUp's set-field
 * endpoint accepts, explaining each change it makes.
 *
 * Throws CustomFieldValueError rather than writing when the value cannot be
 * made valid -- a refusal here costs nothing, while letting it through buys a
 * raw 400 whose body names neither the field nor the options it would accept.
 */
export function prepareCustomFieldValue(
  value: unknown,
  definition?: CustomFieldDefinition,
): PreparedCustomFieldValue {
  const notes: string[] = [];

  if (value === null || value === undefined) {
    throw new CustomFieldValueError(
      'No value given. ClickUp\'s set-field endpoint does not clear a field — call removeCustomFieldValue to clear it.',
    );
  }

  const type = definition?.type;

  // Degraded path: the field definition could not be read, so the only safe
  // move is to undo an obvious serialisation, never to reinterpret a scalar.
  if (!type) {
    if (typeof value === 'string') {
      const parsed = parseJsonContainer(value);
      if (parsed !== undefined) {
        notes.push('The value arrived as a JSON string and was parsed back into a real array/object — ClickUp rejects the string form with "Value must be an array" (FIELD_144).');
        return { value: parsed, notes };
      }
    }
    return { value, notes };
  }

  if (isArrayValuedFieldType(type)) {
    // The incremental object is as legal as the array here, so it passes
    // through in both the object and the serialised-string form.
    if (isIncrementalUpdate(value)) return { value, notes };
    let entries: unknown[];
    if (Array.isArray(value)) {
      entries = value;
    } else if (typeof value === 'string') {
      const parsed = parseJsonContainer(value);
      if (Array.isArray(parsed)) {
        entries = parsed;
        notes.push(`The value arrived as a JSON string and was parsed back into an array — a ${type} field is stored as an array and ClickUp rejects the string form with "Value must be an array" (FIELD_144).`);
      } else if (isIncrementalUpdate(parsed)) {
        notes.push('The value arrived as a JSON string and was parsed back into an add/rem object, which ClickUp accepts for this field type.');
        return { value: parsed, notes };
      } else if (parsed !== undefined) {
        throw new CustomFieldValueError(
          `Field "${definition?.name ?? definition?.id}" is of type ${type}, which ClickUp sets either from an array `
          + `of entries or from an incremental {"add": [...], "rem": [...]} object. The value parsed as neither. `
          + `Nothing was written.`,
        );
      } else {
        entries = [value];
        notes.push(`Wrapped the single value in an array — a ${type} field is stored as an array.`);
      }
    } else if (value !== null && typeof value === 'object') {
      // Never wrap an object: an array holding one would be neither shape, and
      // the caller plainly meant the incremental form.
      throw new CustomFieldValueError(
        `Field "${definition?.name ?? definition?.id}" is of type ${type}, which ClickUp sets either from an array of `
        + `entries or from an incremental {"add": [...], "rem": [...]} object whose keys are arrays. The object given `
        + `is neither. Nothing was written.`,
      );
    } else {
      entries = [value];
      notes.push(`Wrapped the single value in an array — a ${type} field is stored as an array.`);
    }
    if (type === 'labels' && definition) {
      entries = resolveLabelEntries(entries, definition, notes);
    }
    return { value: entries, notes };
  }

  switch (type) {
    case 'drop_down':
      return { value: prepareDropDown(value, definition!, notes), notes };
    case 'number':
    case 'currency':
    case 'date':
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
        notes.push(`Read the string "${value}" as the number ${Number(value)}.`);
        return { value: Number(value), notes };
      }
      return { value, notes };
    case 'checkbox':
      if (typeof value === 'string') {
        const lowered = value.trim().toLowerCase();
        if (lowered === 'true' || lowered === 'false') {
          notes.push(`Read the string "${value}" as the boolean ${lowered}.`);
          return { value: lowered === 'true', notes };
        }
      }
      return { value, notes };
    default:
      // Text-like types (text, short_text, url, email, phone, location, …):
      // leave the value exactly as given. A bracketed string here is a literal.
      return { value, notes };
  }
}
