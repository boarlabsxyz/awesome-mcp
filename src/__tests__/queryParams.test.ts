import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { qstr, qint } from '../util/queryParams.js';

describe('qstr', () => {
  it('returns the value when it is a string', () => {
    assert.equal(qstr('hello'), 'hello');
  });

  it('returns the fallback (default "") when the value is missing', () => {
    assert.equal(qstr(undefined), '');
    assert.equal(qstr(null), '');
  });

  it('returns the fallback when the value is an array (?key=a&key=b)', () => {
    assert.equal(qstr(['a', 'b']), '');
  });

  it('returns the fallback when the value is a nested object (?key[x]=y)', () => {
    assert.equal(qstr({ x: 'y' }), '');
  });

  it('honors a custom fallback', () => {
    assert.equal(qstr(undefined, 'default-val'), 'default-val');
    assert.equal(qstr(['a'], 'default-val'), 'default-val');
  });

  it('preserves an empty string when explicitly passed', () => {
    assert.equal(qstr(''), '');
  });
});

describe('qint', () => {
  it('parses a numeric string', () => {
    assert.equal(qint('42', 0), 42);
  });

  it('returns the fallback for missing input', () => {
    assert.equal(qint(undefined, 7), 7);
  });

  it('returns the fallback for an array (non-string)', () => {
    assert.equal(qint(['12'], 5), 5);
  });

  it('returns the fallback for a non-numeric string', () => {
    assert.equal(qint('not-a-number', 9), 9);
  });

  it('clamps below the supplied min', () => {
    assert.equal(qint('0', 1, { min: 1 }), 1);
    assert.equal(qint('-50', 1, { min: 1 }), 1);
  });

  it('clamps above the supplied max', () => {
    assert.equal(qint('500', 50, { max: 100 }), 100);
  });

  it('respects both min and max together', () => {
    assert.equal(qint('-5', 0, { min: 0, max: 10 }), 0);
    assert.equal(qint('20', 0, { min: 0, max: 10 }), 10);
    assert.equal(qint('7', 0, { min: 0, max: 10 }), 7);
  });

  it('falls back when value is empty string', () => {
    assert.equal(qint('', 5), 5);
  });
});
