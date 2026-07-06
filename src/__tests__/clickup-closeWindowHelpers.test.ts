import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatCloseWindowCapMessage,
  parseCloseWindow,
  parseTimestampInput,
} from '../clickup/apiHelpers.js';

describe('parseTimestampInput', () => {
  it('parses a digit-only Unix ms string via Number()', () => {
    assert.equal(parseTimestampInput('1700000000000'), 1700000000000);
  });

  it('parses zero', () => {
    assert.equal(parseTimestampInput('0'), 0);
  });

  it('parses a negative Unix ms string', () => {
    assert.equal(parseTimestampInput('-1000'), -1000);
  });

  it('parses an ISO 8601 date string', () => {
    assert.equal(parseTimestampInput('2026-07-01T00:00:00Z'), new Date('2026-07-01T00:00:00Z').getTime());
  });

  it('parses an ISO date-only string', () => {
    assert.equal(parseTimestampInput('2026-07-01'), new Date('2026-07-01').getTime());
  });

  it('trims surrounding whitespace before dispatching', () => {
    assert.equal(parseTimestampInput('  1700000000000  '), 1700000000000);
  });

  it('returns NaN for a garbage string', () => {
    assert.ok(Number.isNaN(parseTimestampInput('not-a-date')));
  });

  it('returns NaN for a mixed alphanumeric string', () => {
    assert.ok(Number.isNaN(parseTimestampInput('12abc34')));
  });
});

describe('parseCloseWindow', () => {
  it('returns empty object when both inputs are undefined', () => {
    const win = parseCloseWindow(undefined, undefined);
    assert.deepEqual(win, { from: undefined, to: undefined });
  });

  it('treats empty strings as unset', () => {
    const win = parseCloseWindow('', '');
    assert.equal(win.from, undefined);
    assert.equal(win.to, undefined);
    assert.equal(win.error, undefined);
  });

  it('parses only closedAfter when closedBefore is absent', () => {
    const win = parseCloseWindow('1700000000000', undefined);
    assert.equal(win.from, 1700000000000);
    assert.equal(win.to, undefined);
    assert.equal(win.error, undefined);
  });

  it('parses only closedBefore when closedAfter is absent', () => {
    const win = parseCloseWindow(undefined, '2026-07-01');
    assert.equal(win.from, undefined);
    assert.equal(win.to, new Date('2026-07-01').getTime());
    assert.equal(win.error, undefined);
  });

  it('parses both bounds when supplied', () => {
    const win = parseCloseWindow('1700000000000', '1800000000000');
    assert.equal(win.from, 1700000000000);
    assert.equal(win.to, 1800000000000);
  });

  it('mixes ISO and Unix ms inputs', () => {
    const win = parseCloseWindow('2026-07-01T00:00:00Z', '1800000000000');
    assert.equal(win.from, new Date('2026-07-01T00:00:00Z').getTime());
    assert.equal(win.to, 1800000000000);
  });

  it('reports Invalid closedAfter for a garbage string', () => {
    const win = parseCloseWindow('bogus', '1800000000000');
    assert.equal(win.error, 'Invalid closedAfter: bogus');
  });

  it('reports Invalid closedBefore for a garbage string', () => {
    const win = parseCloseWindow('1700000000000', 'nope');
    assert.equal(win.error, 'Invalid closedBefore: nope');
  });

  it('reports closedAfter first when both bounds are invalid', () => {
    const win = parseCloseWindow('bogus', 'nope');
    assert.equal(win.error, 'Invalid closedAfter: bogus');
  });
});

describe('formatCloseWindowCapMessage', () => {
  it('embeds the pagesScanned count and mentions the cap', () => {
    const msg = formatCloseWindowCapMessage(20);
    assert.match(msg, /Exceeded 2000-task pagination cap/);
    assert.match(msg, /scanning 20 pages/);
    assert.match(msg, /Narrow closedAfter\/closedBefore/);
  });
});
