// src/__tests__/peopleforce-v4/server.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { personBody, createPersonSchema, updatePersonSchema } from '../../peopleforce-v4/server.js';

describe('personBody', () => {
  test('maps camelCase args onto the snake_case keys v4 documents', () => {
    assert.deepEqual(
      personBody({ firstName: 'Ada', lastName: 'Lovelace', personalEmail: 'ada@home.example', hiredOn: '2026-01-05' }),
      { first_name: 'Ada', last_name: 'Lovelace', personal_email: 'ada@home.example', hired_on: '2026-01-05' },
    );
  });

  test('drops undefined fields instead of sending nulls', () => {
    assert.deepEqual(personBody({ firstName: 'Ada', lastName: undefined }), { first_name: 'Ada' });
  });

  test('ignores keys v4 does not accept on a person write', () => {
    // department / position / managerId have no v4 write endpoint. Forwarding
    // them would be silently dropped upstream while the tool reported success.
    assert.deepEqual(personBody({ firstName: 'Ada', departmentId: 3, position: 'Engineer' }), { first_name: 'Ada' });
  });
});

describe('createPersonSchema', () => {
  test('requires first and last name', () => {
    assert.equal(createPersonSchema.safeParse({ firstName: 'Ada' }).success, false);
    assert.equal(createPersonSchema.safeParse({ firstName: 'Ada', lastName: 'Lovelace' }).success, true);
  });

  test('rejects a date that is not a real calendar date', () => {
    const r = createPersonSchema.safeParse({ firstName: 'A', lastName: 'B', hiredOn: '2026-02-31' });
    assert.equal(r.success, false);
  });

  test('rejects a malformed email rather than letting the API do it', () => {
    assert.equal(createPersonSchema.safeParse({ firstName: 'A', lastName: 'B', email: 'nope' }).success, false);
  });
});

describe('updatePersonSchema', () => {
  test('accepts a single field', () => {
    assert.equal(updatePersonSchema.safeParse({ id: 1, workPhoneNumber: '+380000000' }).success, true);
  });

  test('rejects an id-only payload', () => {
    // PUT {} succeeds upstream and changes nothing, which reads downstream as
    // "the update was applied". Better to refuse before the call.
    const r = updatePersonSchema.safeParse({ id: 1 });
    assert.equal(r.success, false);
    if (!r.success) assert.match(JSON.stringify(r.error.issues), /at least one field/);
  });
});
