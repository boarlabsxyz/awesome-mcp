import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';
import {
  REST_CATALOG,
  REST_SERVICE_NOTES,
  endpointsForTool,
  endpointsForService,
  restHintForTool,
} from '../restCatalog.js';
import { SERVICE_VALUES } from '../sharedTools/listRestEndpoints.js';

describe('restCatalog', () => {
  it('service notes obey the doc generator parse rules (known service, no apostrophe)', () => {
    for (const [service, note] of Object.entries(REST_SERVICE_NOTES)) {
      assert.ok((SERVICE_VALUES as string[]).includes(service), service);
      assert.ok(note && !note.includes("'"), `${service}: an apostrophe truncates the note in docs/REST_ENDPOINTS.md`);
    }
  });

  describe('REST_CATALOG shape', () => {
    it('is non-empty', () => {
      assert.ok(REST_CATALOG.length > 0);
    });

    it('every entry has the required fields', () => {
      for (const e of REST_CATALOG) {
        assert.ok(e.service, `service missing on ${e.path}`);
        assert.ok(['GET', 'POST'].includes(e.method), `unsupported method ${e.method} on ${e.path}`);
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

  describe('listRestEndpoints SERVICE_VALUES', () => {
    const serviceEnum = z.enum(SERVICE_VALUES);

    it("accepts service: 'hubspot' through the z.enum validation path", () => {
      assert.equal(serviceEnum.safeParse('hubspot').success, true);
    });

    it('accepts every service that has catalog entries (no silent rejection)', () => {
      const inCatalog = new Set(REST_CATALOG.map(e => e.service));
      for (const svc of inCatalog) {
        assert.equal(serviceEnum.safeParse(svc).success, true, `service "${svc}" is in REST_CATALOG but rejected by SERVICE_VALUES`);
      }
    });
  });

  describe('restHintForTool', () => {
    it('returns a formatted hint for a known tool', () => {
      const hint = restHintForTool('listCalendars');
      assert.ok(hint);
      assert.ok(hint!.includes('REST: GET'));
      assert.ok(hint!.includes('mintRestBearerForCurl'));
    });

    it('names every route of a tool that has more than one', () => {
      const hint = restHintForTool('listLists');
      assert.ok(hint!.includes('GET /api/v1/clickup/folders/{folderId}/lists'));
      assert.ok(hint!.includes('GET /api/v1/clickup/spaces/{spaceId}/lists'));
    });

    it('returns null for an unknown tool', () => {
      assert.equal(restHintForTool('definitelyNotATool'), null);
    });
  });

  // The catalog said ?q for Gmail search while public/openapi.json said
  // ?query, and the route read only ?query: a caller following either doc
  // could be searching nothing. A `?name={x}` in a catalog path must appear as
  // that query parameter in the published spec (rebuild it with
  // node scripts/buildRootOpenapi.mjs).
  describe('catalog query parameters agree with public/openapi.json', () => {
    const spec = JSON.parse(readFileSync(join(process.cwd(), 'public', 'openapi.json'), 'utf8'));
    for (const e of REST_CATALOG.filter((x) => x.status === 'live' && x.path.includes('?'))) {
      const [path, qs] = e.path.split('?');
      const names = [...qs.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=\{[^}]+\}/g)].map(([, n]) => n);
      it(`${e.method} ${e.path}`, () => {
        assert.ok(names.length > 0, `no {param} template in ${e.path}`);
        const op = spec.paths?.[path]?.[e.method.toLowerCase()];
        assert.ok(op, `public/openapi.json has no ${e.method} ${path}`);
        const documented = (op.parameters ?? []).filter((p: { in: string }) => p.in === 'query').map((p: { name: string }) => p.name);
        for (const n of names) assert.ok(documented.includes(n), `${e.method} ${path}: catalog documents ?${n}, openapi.json lists ${JSON.stringify(documented)}`);
      });
    }
  });
});
