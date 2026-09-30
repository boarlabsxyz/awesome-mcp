import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CustomFieldValueError,
  isArrayValuedFieldType,
  needsFieldLookup,
  parseJsonContainer,
  prepareCustomFieldValue,
} from '../../clickup/customFieldValue.js';

const LABELS_FIELD = {
  id: '0c9b7a64-15cb-4dc4-a0b8-6407d53fb35b',
  name: 'Scope',
  type: 'labels',
  type_config: {
    options: [
      { id: 'c17be179-de32-44d8-8cc9-56000f36aac3', label: 'SERVICE', orderindex: 0 },
      { id: 'd28cf280-ef43-4ee5-9dd0-67111f47bbd4', label: 'PLATFORM', orderindex: 1 },
    ],
  },
};

const DROP_DOWN_FIELD = {
  id: 'dd-1',
  name: 'Triage Score',
  type: 'drop_down',
  type_config: {
    options: [
      { id: 'aaaaaaaa-1111-2222-3333-444444444444', name: 'Low', orderindex: 0 },
      { id: 'bbbbbbbb-1111-2222-3333-444444444444', name: 'High', orderindex: 3 },
    ],
  },
};

describe('clickup custom field value preparation', () => {
  describe('parseJsonContainer', () => {
    it('revives arrays and objects', () => {
      assert.deepEqual(parseJsonContainer('["a","b"]'), ['a', 'b']);
      assert.deepEqual(parseJsonContainer('  {"lat":1}  '), { lat: 1 });
    });

    it('leaves scalars and non-JSON alone', () => {
      assert.equal(parseJsonContainer('12'), undefined);
      assert.equal(parseJsonContainer('true'), undefined);
      assert.equal(parseJsonContainer('plain text'), undefined);
      assert.equal(parseJsonContainer('[not json'), undefined);
    });
  });

  describe('needsFieldLookup', () => {
    it('is true for any string, since only the type says whether to revive it', () => {
      assert.equal(needsFieldLookup('["uuid"]'), true);
      assert.equal(needsFieldLookup('SERVICE'), true);
    });

    it('is true for an array holding something that may be an option name', () => {
      assert.equal(needsFieldLookup(['SERVICE']), true);
    });

    it('is false when the value is already in ClickUp shape — that set stays one request', () => {
      assert.equal(needsFieldLookup([LABELS_FIELD.type_config.options[0].id]), false);
      assert.equal(needsFieldLookup(3), false);
      assert.equal(needsFieldLookup(true), false);
      assert.equal(needsFieldLookup([1, 2]), false);
    });
  });

  it('classifies array-valued types', () => {
    assert.equal(isArrayValuedFieldType('labels'), true);
    assert.equal(isArrayValuedFieldType('users'), true);
    assert.equal(isArrayValuedFieldType('text'), false);
    assert.equal(isArrayValuedFieldType(undefined), false);
  });

  describe('labels (the FIELD_144 defect)', () => {
    it('parses a stringified array back into an array', () => {
      const out = prepareCustomFieldValue(
        JSON.stringify([LABELS_FIELD.type_config.options[0].id]),
        LABELS_FIELD,
      );
      assert.deepEqual(out.value, ['c17be179-de32-44d8-8cc9-56000f36aac3']);
      assert.ok(out.notes.some((n) => n.includes('FIELD_144')));
    });

    it('wraps a bare option UUID in an array', () => {
      const out = prepareCustomFieldValue('c17be179-de32-44d8-8cc9-56000f36aac3', LABELS_FIELD);
      assert.deepEqual(out.value, ['c17be179-de32-44d8-8cc9-56000f36aac3']);
    });

    it('resolves a label name to its option UUID', () => {
      const out = prepareCustomFieldValue(['service'], LABELS_FIELD);
      assert.deepEqual(out.value, ['c17be179-de32-44d8-8cc9-56000f36aac3']);
      assert.ok(out.notes.some((n) => n.includes('Resolved label')));
    });

    it('refuses an unknown label and names the real options, before any write', () => {
      assert.throws(
        () => prepareCustomFieldValue(['NOPE'], LABELS_FIELD),
        (err: any) => {
          assert.ok(err instanceof CustomFieldValueError);
          assert.ok(err.message.includes('SERVICE'));
          assert.ok(err.message.includes('PLATFORM'));
          assert.ok(err.message.includes('Nothing was written'));
          return true;
        },
      );
    });

    it('passes an array of UUIDs through untouched', () => {
      const ids = LABELS_FIELD.type_config.options.map((o) => o.id);
      const out = prepareCustomFieldValue(ids, LABELS_FIELD);
      assert.deepEqual(out.value, ids);
      assert.deepEqual(out.notes, []);
    });
  });

  describe('users', () => {
    it('wraps a single numeric user ID in an array', () => {
      const out = prepareCustomFieldValue(42, { id: 'u', name: 'Owner', type: 'users' });
      assert.deepEqual(out.value, [42]);
    });

    it('revives a stringified array of user IDs', () => {
      const out = prepareCustomFieldValue('[42,43]', { id: 'u', name: 'Owner', type: 'users' });
      assert.deepEqual(out.value, [42, 43]);
    });
  });

  describe('scalar types', () => {
    it('leaves a bracketed string alone on a text field — it is a literal there', () => {
      const out = prepareCustomFieldValue('["a"]', { id: 't', name: 'Notes', type: 'text' });
      assert.equal(out.value, '["a"]');
      assert.deepEqual(out.notes, []);
    });

    it('reads a numeric string as a number', () => {
      assert.equal(prepareCustomFieldValue('12', { id: 'n', type: 'number' }).value, 12);
    });

    it('reads a boolean string as a boolean', () => {
      assert.equal(prepareCustomFieldValue('TRUE', { id: 'c', type: 'checkbox' }).value, true);
    });

    it('resolves a drop-down by name and by option UUID to its orderindex', () => {
      assert.equal(prepareCustomFieldValue('High', DROP_DOWN_FIELD).value, 3);
      assert.equal(
        prepareCustomFieldValue('bbbbbbbb-1111-2222-3333-444444444444', DROP_DOWN_FIELD).value,
        3,
      );
      assert.equal(prepareCustomFieldValue(3, DROP_DOWN_FIELD).value, 3);
    });

    // Live shape from list 901523097822: options are NAMED "1".."10" while
    // their orderindexes run 0..9, so a numeric string is ambiguous and the
    // two readings differ by one. The documented contract wins, and the
    // collision is reported rather than resolved silently.
    const NUMERIC_NAMED_FIELD = {
      id: '1d43d9f5-99b1-41f9-8250-cfdde01b76e0',
      name: 'Triage Score',
      type: 'drop_down',
      type_config: {
        options: [
          { id: '7ab8d4c0-9d35-4c9e-a6c2-d10781197b68', name: '1', orderindex: 0 },
          { id: '610cfac3-ed75-4e6f-8665-b6542c71898d', name: '3', orderindex: 2 },
        ],
      },
    };

    it('reads a numeric drop-down string as the orderindex, not as an option name', () => {
      const out = prepareCustomFieldValue('3', NUMERIC_NAMED_FIELD);
      assert.equal(out.value, 3);
      assert.ok(out.notes.some((n) => n.includes('NAMED "3"')), out.notes.join(' | '));
      assert.ok(out.notes.some((n) => n.includes('610cfac3-ed75-4e6f-8665-b6542c71898d')));
    });

    it('refuses an unknown drop-down option', () => {
      assert.throws(
        () => prepareCustomFieldValue('Medium', DROP_DOWN_FIELD),
        (err: any) => err instanceof CustomFieldValueError && err.message.includes('Low'),
      );
    });
  });

  describe('without a field definition (the lookup failed)', () => {
    it('still undoes an obvious serialisation', () => {
      const out = prepareCustomFieldValue('["a"]', undefined);
      assert.deepEqual(out.value, ['a']);
      assert.equal(out.notes.length, 1);
    });

    it('never reinterprets a scalar', () => {
      assert.equal(prepareCustomFieldValue('12', undefined).value, '12');
      assert.equal(prepareCustomFieldValue('true', undefined).value, 'true');
      assert.equal(prepareCustomFieldValue('plain', undefined).value, 'plain');
    });
  });

  it('refuses null and points at removeCustomFieldValue', () => {
    assert.throws(
      () => prepareCustomFieldValue(null, LABELS_FIELD),
      (err: any) => err instanceof CustomFieldValueError && err.message.includes('removeCustomFieldValue'),
    );
  });
});
