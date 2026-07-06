import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isHiddenSlug } from '../mcpCatalogStore.js';

describe('mcpCatalogStore.isHiddenSlug', () => {
  it('marks outline as hidden until it is stabilized', () => {
    assert.equal(isHiddenSlug('outline'), true);
  });

  it('does not hide other active connectors', () => {
    assert.equal(isHiddenSlug('clickup'), false);
    assert.equal(isHiddenSlug('slack'), false);
    assert.equal(isHiddenSlug('google-docs'), false);
    assert.equal(isHiddenSlug('google-sheets'), false);
    assert.equal(isHiddenSlug('google-calendar'), false);
    assert.equal(isHiddenSlug('gmail'), false);
    assert.equal(isHiddenSlug('drive'), false);
  });

  it('does not hide unknown slugs (they just won\'t resolve in the store)', () => {
    assert.equal(isHiddenSlug('anything-else'), false);
    assert.equal(isHiddenSlug(''), false);
  });
});
