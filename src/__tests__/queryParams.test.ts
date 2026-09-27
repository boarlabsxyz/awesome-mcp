import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { qstr, qint, qarr, qoptint, qflag, redmineCustomFieldFilters } from '../util/queryParams.js';

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

describe('qarr', () => {
  it('wraps a single string value', () => {
    assert.deepEqual(qarr('opened'), ['opened']);
  });

  it('keeps a repeated param as an array', () => {
    assert.deepEqual(qarr(['opened', 'closed']), ['opened', 'closed']);
  });

  it('splits a comma-separated string', () => {
    assert.deepEqual(qarr('opened,closed'), ['opened', 'closed']);
  });

  it('trims whitespace and drops empty segments', () => {
    assert.deepEqual(qarr('opened, closed ,,'), ['opened', 'closed']);
  });

  it('returns undefined when nothing usable is present', () => {
    assert.equal(qarr(undefined), undefined);
    assert.equal(qarr(''), undefined);
    assert.equal(qarr([]), undefined);
  });

  // The ?foo[bar]=baz case qstr guards against: drop it rather than
  // stringifying it to '[object Object]'.
  it('drops non-string entries instead of stringifying them', () => {
    assert.equal(qarr({ bar: 'baz' }), undefined);
    assert.deepEqual(qarr(['opened', { bar: 'baz' }]), ['opened']);
  });
});

describe('qoptint', () => {
  it('returns undefined for an absent or empty param, so an omitted filter stays omitted', () => {
    assert.equal(qoptint(undefined), undefined);
    assert.equal(qoptint(''), undefined);
  });

  it('parses a base-10 integer', () => {
    assert.equal(qoptint('42'), 42);
    assert.equal(qoptint('-7'), -7);
    assert.equal(qoptint('08'), 8);
  });

  // The distinction that matters: a present-but-garbage value must NOT collapse
  // to undefined, because undefined means "no filter" and would hand back a
  // wider result set than the caller asked for. NaN fails the Zod schema, which
  // is a 400.
  it('returns NaN for a present unparseable value rather than undefined', () => {
    assert.ok(Number.isNaN(qoptint('abc')));
    assert.ok(Number.isNaN(qoptint('  ')));
  });

  it('ignores non-string input, including the ?foo[bar]=baz object case', () => {
    assert.equal(qoptint({ bar: 'baz' }), undefined);
    assert.equal(qoptint(['1', '2']), undefined);
  });
});

describe('qflag', () => {
  it('returns undefined when the key is absent or empty', () => {
    assert.equal(qflag(undefined), undefined);
    assert.equal(qflag(''), undefined);
  });

  it('accepts true and 1 as true', () => {
    assert.equal(qflag('true'), true);
    assert.equal(qflag('1'), true);
  });

  it('treats anything else present as false', () => {
    assert.equal(qflag('false'), false);
    assert.equal(qflag('0'), false);
    assert.equal(qflag('yes'), false);
  });

  it('ignores non-string input', () => {
    assert.equal(qflag(['true']), undefined);
    assert.equal(qflag({ a: 1 }), undefined);
  });
});

describe('redmineCustomFieldFilters', () => {
  it('collects cf_<digits> keys and ignores everything else', () => {
    const r = redmineCustomFieldFilters({ cf_3: 'Urgent', cf_12: 'Team A', projectId: 'p', limit: '25' });
    assert.deepEqual(r.filters, { cf_3: 'Urgent', cf_12: 'Team A' });
    assert.deepEqual(r.invalidKeys, []);
  });

  it('returns undefined filters when there are none, so the caller sends nothing', () => {
    const r = redmineCustomFieldFilters({ projectId: 'p' });
    assert.equal(r.filters, undefined);
    assert.deepEqual(r.invalidKeys, []);
  });

  it('ignores near-misses that are not cf_<digits>', () => {
    const r = redmineCustomFieldFilters({ cf_: 'x', cf_abc: 'x', CF_3: 'x', cf3: 'x', cf_3x: 'x' });
    assert.equal(r.filters, undefined);
    assert.deepEqual(r.invalidKeys, []);
  });

  // The regression this shape exists for. Express parses ?cf_3=a&cf_3=b into an
  // array; silently skipping it would send the query to Redmine with no cf_3
  // filter at all, and Redmine answers a missing filter with MORE rows — a
  // wider result set that reads as a successful match.
  it('reports a repeated cf_ key as invalid instead of dropping the filter', () => {
    const r = redmineCustomFieldFilters({ cf_3: ['a', 'b'] });
    assert.equal(r.filters, undefined);
    assert.deepEqual(r.invalidKeys, ['cf_3']);
  });

  it('reports a nested cf_ key as invalid', () => {
    const r = redmineCustomFieldFilters({ cf_3: { x: 'y' } });
    assert.deepEqual(r.invalidKeys, ['cf_3']);
  });

  it('keeps the valid filters alongside the invalid keys it reports', () => {
    const r = redmineCustomFieldFilters({ cf_1: 'ok', cf_2: ['a', 'b'], cf_4: ['c'] });
    assert.deepEqual(r.filters, { cf_1: 'ok' });
    assert.deepEqual(r.invalidKeys, ['cf_2', 'cf_4']);
  });
});
