import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MigrationError, planMigration, type CollectionShape, type StoredRecord } from '../../storage/migrations.js';

const shape: CollectionShape = {
  description: 'People researched on LinkedIn',
  fields: {
    profileUrl: { type: 'url', required: true, description: 'LinkedIn URL' },
    name: { type: 'string', required: true, description: 'Full name' },
    followers: { type: 'string', required: false, description: 'Follower count as scraped' },
  },
  keyField: 'profileUrl',
  ttlDays: 30,
};

const records: StoredRecord[] = [
  { id: 'r1', key: 'https://l.in/a', data: { profileUrl: 'https://l.in/a', name: 'Ada', followers: '120' } },
  { id: 'r2', key: 'https://l.in/b', data: { profileUrl: 'https://l.in/b', name: 'Bob' } },
];

describe('planMigration', () => {
  it('adds a required field with a default to every record', () => {
    const plan = planMigration(shape, records, [
      { op: 'addField', field: 'company', type: 'string', required: true, description: 'Employer', default: 'unknown' },
    ]);
    assert.equal(plan.failures.length, 0);
    assert.equal(plan.changed.length, 2);
    assert.equal(plan.changed[0].after.company, 'unknown');
    assert.equal(plan.shape.fields.company.required, true);
  });

  it('refuses a required field without a default on a non-empty collection, but allows it on an empty one', () => {
    const op = { op: 'addField' as const, field: 'company', type: 'string' as const, required: true, description: 'Employer' };
    assert.throws(() => planMigration(shape, records, [op]), (e: any) => e instanceof MigrationError && /give a default/.test(e.message));
    assert.equal(planMigration(shape, [], [op]).failures.length, 0);
  });

  it('renames a field in the data and follows the keyField', () => {
    const plan = planMigration(shape, records, [{ op: 'renameField', from: 'profileUrl', to: 'url' }]);
    assert.equal(plan.shape.keyField, 'url');
    assert.equal(plan.changed[0].after.url, 'https://l.in/a');
    assert.equal('profileUrl' in plan.changed[0].after, false);
  });

  it('removes a field, but not the keyField', () => {
    const plan = planMigration(shape, records, [{ op: 'removeField', field: 'followers' }]);
    assert.equal(plan.changed.length, 1); // r2 had no followers: unchanged
    assert.equal('followers' in plan.changed[0].after, false);
    assert.throws(() => planMigration(shape, records, [{ op: 'removeField', field: 'profileUrl' }]), /keyField/);
  });

  it('converts values on a type change, and aborts with the failing ids when one cannot convert', () => {
    const ok = planMigration(shape, records, [{ op: 'changeField', field: 'followers', type: 'integer' }]);
    assert.equal(ok.changed[0].after.followers, 120);

    const messy = [...records, { id: 'r3', key: 'https://l.in/c', data: { profileUrl: 'https://l.in/c', name: 'Cy', followers: '1.2k' } }];
    const failed = planMigration(shape, messy, [{ op: 'changeField', field: 'followers', type: 'integer' }]);
    assert.deepEqual(failed.failures.map((f) => f.id), ['r3']);

    const withDefault = planMigration(shape, messy, [{ op: 'changeField', field: 'followers', type: 'integer', default: 0 }]);
    assert.equal(withDefault.failures.length, 0);
    assert.equal(withDefault.changed.find((c) => c.id === 'r3')?.after.followers, 0);
  });

  it('making a field required fails records that lack it, unless a default fills them', () => {
    const failed = planMigration(shape, records, [{ op: 'changeField', field: 'followers', required: true }]);
    assert.deepEqual(failed.failures.map((f) => f.id), ['r2']);
    const filled = planMigration(shape, records, [{ op: 'changeField', field: 'followers', required: true, default: '0' }]);
    assert.equal(filled.failures.length, 0);
  });

  it('a changeField default fills missing values on an optional field too', () => {
    const plan = planMigration(shape, records, [{ op: 'changeField', field: 'followers', description: 'Followers', default: '0' }]);
    assert.equal(plan.changed.find((c) => c.id === 'r2')?.after.followers, '0');
    assert.equal(plan.shape.fields.followers.required, false);
  });

  it('treats Object.prototype member names as reserved, not as existing fields', () => {
    for (const field of ['constructor', 'toString', 'hasOwnProperty']) {
      assert.throws(
        () => planMigration(shape, records, [{ op: 'addField', field, type: 'string', required: false, description: 'x' }]),
        (e: any) => /reserved/.test(e.message) && !/already exists/.test(e.message),
        field,
      );
    }
    assert.throws(() => planMigration(shape, records, [{ op: 'removeField', field: 'toString' }]), /no field "toString"/);
    assert.throws(() => planMigration(shape, records, [{ op: 'renameField', from: 'name', to: 'valueOf' }]), /reserved/);
  });

  it('refuses a keyField whose values repeat, naming both records', () => {
    const dupes: StoredRecord[] = [
      { id: 'r1', key: 'https://l.in/a', data: { profileUrl: 'https://l.in/a', name: 'Ada' } },
      { id: 'r2', key: 'https://l.in/b', data: { profileUrl: 'https://l.in/b', name: 'Ada' } },
    ];
    const plan = planMigration(shape, dupes, [{ op: 'setOptions', keyField: 'name' }]);
    assert.equal(plan.failures.length, 1);
    assert.match(plan.failures[0].reason, /also used by record r1/);
  });

  it('refuses ops that cannot apply', () => {
    assert.throws(() => planMigration(shape, records, []), MigrationError);
    assert.throws(() => planMigration(shape, records, [{ op: 'renameField', from: 'nope', to: 'x' }]), /no field "nope"/);
    assert.throws(() => planMigration(shape, records, [{ op: 'addField', field: 'name', type: 'string', required: false, description: 'x' }]), /already exists/);
    assert.throws(() => planMigration(shape, records, [{ op: 'changeField', field: 'name' }]), /nothing to change/);
    assert.throws(() => planMigration(shape, records, [{ op: 'setOptions', keyField: 'followers' }]), /must be a required field/);
  });

  it('does not count a record as changed when only its key order differs (JSONB reorders keys)', () => {
    const reordered: StoredRecord[] = [
      { id: 'r1', key: 'https://l.in/a', data: { name: 'Ada', followers: '120', profileUrl: 'https://l.in/a' } },
      { id: 'r2', key: 'https://l.in/b', data: { name: 'Bob', profileUrl: 'https://l.in/b' } },
    ];
    const plan = planMigration(shape, reordered, [{ op: 'removeField', field: 'followers' }]);
    assert.deepEqual(plan.changed.map((c) => c.id), ['r1']);
  });

  it('sets ttl and description without touching records', () => {
    const plan = planMigration(shape, records, [{ op: 'setOptions', ttlDays: null, description: 'People' }]);
    assert.equal(plan.changed.length, 0);
    assert.equal(plan.shape.ttlDays, null);
    assert.equal(plan.shape.description, 'People');
  });

  it('is deterministic: the dry run and the apply see the same plan', () => {
    const ops = [{ op: 'changeField' as const, field: 'followers', type: 'integer' as const, default: 0 }];
    assert.deepEqual(planMigration(shape, records, ops), planMigration(shape, records, ops));
  });
});
