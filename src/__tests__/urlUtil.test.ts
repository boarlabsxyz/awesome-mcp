import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stripTrailingSlashes } from '../util/url.js';

describe('stripTrailingSlashes', () => {
  it('returns the same string when no trailing slash', () => {
    assert.equal(stripTrailingSlashes('https://example.com'), 'https://example.com');
  });

  it('strips one trailing slash', () => {
    assert.equal(stripTrailingSlashes('https://example.com/'), 'https://example.com');
  });

  it('strips many trailing slashes', () => {
    assert.equal(stripTrailingSlashes('https://example.com////'), 'https://example.com');
  });

  it('leaves internal slashes intact', () => {
    assert.equal(stripTrailingSlashes('https://example.com/api/v1/'), 'https://example.com/api/v1');
  });

  it('handles the empty string', () => {
    assert.equal(stripTrailingSlashes(''), '');
  });

  it('handles all-slashes input', () => {
    assert.equal(stripTrailingSlashes('////'), '');
  });
});
