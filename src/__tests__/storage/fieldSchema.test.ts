import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  convertValue,
  fieldsProblems,
  validateRecord,
  type Fields,
} from '../../storage/fieldSchema.js';

const fields: Fields = {
  name: { type: 'string', required: true, description: 'Full name' },
  profileUrl: { type: 'url', required: true, description: 'LinkedIn URL' },
  followers: { type: 'integer', required: false, description: 'Follower count' },
  score: { type: 'number', required: false, description: 'Fit score' },
  open: { type: 'boolean', required: false, description: 'Open to work' },
  seenAt: { type: 'datetime', required: false, description: 'Last seen' },
  skills: { type: 'string[]', required: false, description: 'Skills' },
  ratings: { type: 'number[]', required: false, description: 'Ratings' },
  stage: { type: 'string', required: false, description: 'Pipeline stage', enum: ['lead', 'contacted'] },
  raw: { type: 'json', required: false, description: 'Scraped page' },
};

const valid = { name: 'Ada', profileUrl: 'https://linkedin.com/in/ada' };

describe('validateRecord', () => {
  it('accepts a record with every type set correctly', () => {
    const result = validateRecord(fields, {
      ...valid,
      followers: 12,
      score: 0.5,
      open: true,
      seenAt: '2026-11-04T10:30:00Z',
      skills: ['ts'],
      ratings: [1, 2.5],
      stage: 'lead',
      raw: { headline: 'x', jobs: [1] },
    });
    assert.equal(result.ok, true);
  });

  it('rejects unknown fields and names the schema fields', () => {
    const result = validateRecord(fields, { ...valid, title: 'CTO' });
    assert.equal(result.ok, false);
    assert.match((result as any).issues[0], /unknown field\(s\) "title"/);
    assert.match((result as any).issues[0], /migrateCollection/);
  });

  it('rejects a missing required field', () => {
    const result = validateRecord(fields, { name: 'Ada' });
    assert.equal(result.ok, false);
    assert.match((result as any).issues.join(), /profileUrl/);
  });

  it('rejects wrong types, bad urls, bad datetimes, non-integers and values outside the enum', () => {
    for (const bad of [
      { followers: 1.5 },
      { followers: '12' },
      { profileUrl: 'not a url' },
      { seenAt: 'yesterday' },
      { stage: 'hired' },
      { raw: 'text' },
      { skills: 'ts' },
    ]) {
      assert.equal(validateRecord(fields, { ...valid, ...bad }).ok, false, JSON.stringify(bad));
    }
  });

  it('treats null on an optional field as absent, but not on a required one', () => {
    const ok = validateRecord(fields, { ...valid, followers: null });
    assert.deepEqual(ok, { ok: true, data: valid });
    assert.equal(validateRecord(fields, { ...valid, name: null }).ok, false);
  });

  it('does not mistake Object.prototype members for schema fields', () => {
    const plain: Fields = { a: { type: 'string', required: false, description: 'x' } };
    // null on a name the schema lacks is not "absent optional": it is an unknown field.
    assert.equal(validateRecord(plain, { toString: null }).ok, false);
  });

  it('rejects a non-object record', () => {
    assert.equal(validateRecord(fields, [1]).ok, false);
    assert.equal(validateRecord(fields, 'x').ok, false);
  });
});

describe('fieldsProblems', () => {
  it('refuses reserved and malformed names, enums on non-string fields, and empty schemas', () => {
    assert.match(fieldsProblems({ _id: { type: 'string', required: false, description: 'x' } }).join(), /not a valid field name/);
    assert.match(fieldsProblems({ 'a-b': { type: 'string', required: false, description: 'x' } }).join(), /not a valid field name/);
    assert.match(fieldsProblems({ n: { type: 'number', required: false, description: 'x', enum: ['1'] } }).join(), /enum is only allowed/);
    assert.match(fieldsProblems({}).join(), /at least one field/);
    const reserved = JSON.parse('{"constructor":{"type":"string","required":false,"description":"x"}}') as Fields;
    assert.match(fieldsProblems(reserved).join(), /reserved/);
    assert.deepEqual(fieldsProblems(fields), []);
  });

  it('caps the number of fields', () => {
    const many: Fields = {};
    for (let i = 0; i < 51; i++) many[`f${i}`] = { type: 'string', required: false, description: 'x' };
    assert.match(fieldsProblems(many).join(), /at most 50/);
  });
});

describe('convertValue', () => {
  it('converts what converts cleanly', () => {
    assert.deepEqual(convertValue('42', 'integer'), { ok: true, value: 42 });
    assert.deepEqual(convertValue(' 4.5 ', 'number'), { ok: true, value: 4.5 });
    assert.deepEqual(convertValue(7, 'string'), { ok: true, value: '7' });
    assert.deepEqual(convertValue('TRUE', 'boolean'), { ok: true, value: true });
    assert.deepEqual(convertValue('ts', 'string[]'), { ok: true, value: ['ts'] });
    assert.deepEqual(convertValue(['1', 2], 'number[]'), { ok: true, value: [1, 2] });
    assert.deepEqual(convertValue(0, 'datetime'), { ok: true, value: '1970-01-01T00:00:00.000Z' });
  });

  it('refuses rather than guesses', () => {
    for (const [value, to] of [
      ['12 people', 'integer'],
      ['4.5', 'integer'],
      ['yes', 'boolean'],
      [{ a: 1 }, 'string'],
      ['x', 'json'],
      [['a', 'b'], 'number[]'],
      [9e15, 'datetime'], // past the Date range: toISOString() would throw
    ] as const) {
      assert.equal(convertValue(value, to).ok, false, `${JSON.stringify(value)} -> ${to}`);
    }
  });
});
