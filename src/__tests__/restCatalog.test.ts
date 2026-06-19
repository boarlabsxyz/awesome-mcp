import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  REST_CATALOG,
  endpointsForTool,
  endpointsForService,
  restHintForTool,
} from '../restCatalog.js';

describe('restCatalog', () => {
  describe('REST_CATALOG shape', () => {
    it('is non-empty', () => {
      assert.ok(REST_CATALOG.length > 0);
    });

    it('every entry has the required fields', () => {
      for (const e of REST_CATALOG) {
        assert.ok(e.service, `service missing on ${e.path}`);
        assert.equal(e.method, 'GET', `non-GET method on ${e.path}`);
        assert.ok(e.path.startsWith('/api/v1/'), `bad path: ${e.path}`);
        assert.ok(e.summary.length > 0);
        assert.ok(e.mcpToolName.length > 0);
        assert.ok(e.openapiOperationId.length > 0);
        assert.ok(['live', 'planned'].includes(e.status), `bad status on ${e.path}`);
      }
    });

    it('every openapiOperationId is unique', () => {
      const ids = REST_CATALOG.map(e => e.openapiOperationId);
      const dedup = new Set(ids);
      assert.equal(dedup.size, ids.length, 'duplicate operationId');
    });
  });

  describe('endpointsForTool', () => {
    it('returns entries with matching mcpToolName', () => {
      const eps = endpointsForTool('listCalendars');
      assert.ok(eps.length >= 1);
      for (const e of eps) assert.equal(e.mcpToolName, 'listCalendars');
    });

    it('returns empty array for unknown tool', () => {
      assert.deepEqual(endpointsForTool('definitelyNotATool'), []);
    });
  });

  describe('endpointsForService', () => {
    it('returns only entries for the requested service', () => {
      const eps = endpointsForService('drive');
      assert.ok(eps.length > 0);
      for (const e of eps) assert.equal(e.service, 'drive');
    });

    it('returns empty array for an unused service (only known services in catalog)', () => {
      // Using `as any` because the type forbids invalid services.
      assert.deepEqual(endpointsForService('nonexistent' as any), []);
    });
  });

  describe('restHintForTool', () => {
    it('returns a formatted hint for a known tool', () => {
      const hint = restHintForTool('listCalendars');
      assert.ok(hint);
      assert.ok(hint!.includes('REST: GET'));
      assert.ok(hint!.includes('getSecurityToken'));
    });

    it('returns null for an unknown tool', () => {
      assert.equal(restHintForTool('definitelyNotATool'), null);
    });
  });
});
