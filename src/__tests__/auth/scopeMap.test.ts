import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getRequiredScope, ALL_SCOPES, getScopesForSlug } from '../../auth/scopeMap.js';

describe('scopeMap', () => {
  describe('getRequiredScope', () => {
    it('should return mcp:docs for /mcp', () => {
      assert.equal(getRequiredScope('/mcp'), 'mcp:docs');
    });

    it('should return mcp:docs for /sse', () => {
      assert.equal(getRequiredScope('/sse'), 'mcp:docs');
    });

    it('should return mcp:calendar for /calendar', () => {
      assert.equal(getRequiredScope('/calendar'), 'mcp:calendar');
    });

    it('should return mcp:calendar for /calendar-sse', () => {
      assert.equal(getRequiredScope('/calendar-sse'), 'mcp:calendar');
    });

    it('should return mcp:sheets for /sheets', () => {
      assert.equal(getRequiredScope('/sheets'), 'mcp:sheets');
    });

    it('should return mcp:sheets for /sheets-sse', () => {
      assert.equal(getRequiredScope('/sheets-sse'), 'mcp:sheets');
    });

    it('should return mcp:gmail for /gmail', () => {
      assert.equal(getRequiredScope('/gmail'), 'mcp:gmail');
    });

    it('should return mcp:slides for /slides', () => {
      assert.equal(getRequiredScope('/slides'), 'mcp:slides');
    });

    it('should return mcp:drive for /drive', () => {
      assert.equal(getRequiredScope('/drive'), 'mcp:drive');
    });

    it('should return mcp:clickup for /clickup', () => {
      assert.equal(getRequiredScope('/clickup'), 'mcp:clickup');
    });

    it('should return mcp:clickup for /clickup-sse', () => {
      assert.equal(getRequiredScope('/clickup-sse'), 'mcp:clickup');
    });

    it('should return null for unknown routes', () => {
      assert.equal(getRequiredScope('/health'), null);
      assert.equal(getRequiredScope('/api/config'), null);
      assert.equal(getRequiredScope('/unknown'), null);
    });

    it('should handle subpaths', () => {
      assert.equal(getRequiredScope('/calendar/foo'), 'mcp:calendar');
      assert.equal(getRequiredScope('/mcp/bar'), 'mcp:docs');
    });
  });

  describe('ALL_SCOPES', () => {
    it('should contain all 7 scopes', () => {
      assert.equal(ALL_SCOPES.length, 7);
      assert.ok(ALL_SCOPES.includes('mcp:docs'));
      assert.ok(ALL_SCOPES.includes('mcp:calendar'));
      assert.ok(ALL_SCOPES.includes('mcp:sheets'));
      assert.ok(ALL_SCOPES.includes('mcp:gmail'));
      assert.ok(ALL_SCOPES.includes('mcp:slides'));
      assert.ok(ALL_SCOPES.includes('mcp:drive'));
      assert.ok(ALL_SCOPES.includes('mcp:clickup'));
    });
  });

  describe('getScopesForSlug', () => {
    it('should return single scope for known slugs', () => {
      assert.deepEqual(getScopesForSlug('google-docs'), ['mcp:docs']);
      assert.deepEqual(getScopesForSlug('google-calendar'), ['mcp:calendar']);
      assert.deepEqual(getScopesForSlug('google-sheets'), ['mcp:sheets']);
      assert.deepEqual(getScopesForSlug('google-gmail'), ['mcp:gmail']);
      assert.deepEqual(getScopesForSlug('google-slides'), ['mcp:slides']);
      assert.deepEqual(getScopesForSlug('google-drive'), ['mcp:drive']);
      assert.deepEqual(getScopesForSlug('clickup'), ['mcp:clickup']);
    });

    it('should return all scopes for unknown slugs', () => {
      assert.deepEqual(getScopesForSlug('unknown-slug'), ALL_SCOPES);
    });
  });
});
