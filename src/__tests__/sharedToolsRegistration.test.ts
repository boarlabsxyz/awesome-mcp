import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { REST_CATALOG, SERVICE_SERVER_PATH, type RestService } from '../restCatalog.js';

// Drift guard: a service that publishes live REST endpoints must also give MCP
// clients a way to reach them.
//
// The gap this was written for: PeopleForce shipped 46 live endpoints, and
// public/openapi-peopleforce.json told clients to authenticate with "a
// 5-minute bearer from the mintRestBearerForCurl MCP tool" — a tool its server
// never registered. The only remaining credential was the PERMANENT dashboard
// API key, which can mutate leave and recruitment state. Nothing failed;
// nothing was looking.
//
// Same shape as the catalog guard at restCatalog.test.ts:69-74 — "everything in
// X must be satisfied by Y" — and the same class of bug as the Sheets MCP/REST
// divergence (ClickUp 86cb89z8q): two things that must agree, with no assertion
// that they do.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Static source scan rather than importing each server and introspecting its
// tools. The dynamic idiom exists (clickup/server.test.ts patches
// FastMCP.prototype.addTool before importing), but it cannot be used here:
// src/google-docs/server.ts calls startServer() at module scope, so importing
// it runs initDatabase(), loadUsers(), seedDefaultCatalogs() and binds ports —
// and 'docs' is one of the services this guard must cover. A text scan is also
// the honest shape of the check: what is being guarded IS the presence of two
// registration lines.
const REGISTRARS = ['registerMintRestBearerForCurl', 'registerListRestEndpoints'] as const;
type Registrar = typeof REGISTRARS[number];

function serverSource(service: RestService): string {
  // Strip block comments so a commented-out registration cannot satisfy the
  // guard. Line comments are handled by anchoring the call match below.
  return readFileSync(resolve(REPO_ROOT, SERVICE_SERVER_PATH[service]), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Two independent signals, because either alone is weak: the call must appear
 * at the start of a line (so `// registerX(server)` cannot match), AND the
 * symbol must be imported from ../sharedTools/ (so an unrelated identifier
 * that happens to share the name cannot match).
 */
function registers(service: RestService, fn: Registrar): { called: boolean; imported: boolean } {
  const source = serverSource(service);
  return {
    called: new RegExp(`^[ \\t]*${fn}[ \\t]*\\(`, 'm').test(source),
    imported: new RegExp(`import\\s*\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*from\\s*'\\.\\./sharedTools/`).test(source),
  };
}

function servicesWithLiveEndpoints(): RestService[] {
  return [...new Set(REST_CATALOG.filter(e => e.status === 'live').map(e => e.service))];
}

describe('shared REST tools are registered wherever the REST plane is live', () => {
  it('finds at least one live service (guard is not vacuously passing)', () => {
    assert.ok(servicesWithLiveEndpoints().length > 0);
  });

  for (const service of servicesWithLiveEndpoints()) {
    for (const fn of REGISTRARS) {
      it(`${service}: ${SERVICE_SERVER_PATH[service]} calls ${fn}()`, () => {
        const { called, imported } = registers(service, fn);
        assert.equal(
          called,
          true,
          `${SERVICE_SERVER_PATH[service]} never calls ${fn}(). Service "${service}" serves ` +
            `live /api/v1/* endpoints, so an MCP client on this server cannot ` +
            `${fn === 'registerMintRestBearerForCurl'
              ? 'mint a short-lived bearer and must fall back to the PERMANENT dashboard API key'
              : 'discover which endpoints exist'}.`,
        );
        assert.equal(
          imported,
          true,
          `${SERVICE_SERVER_PATH[service]} calls ${fn} but does not import it from ../sharedTools/.`,
        );
      });
    }
  }

  it('every mapped server file exists', () => {
    // SERVICE_SERVER_PATH is a total Record<RestService, string>, so a new
    // service fails typecheck until mapped — but a RENAMED directory would
    // still typecheck. This catches that.
    for (const [service, path] of Object.entries(SERVICE_SERVER_PATH)) {
      assert.doesNotThrow(
        () => readFileSync(resolve(REPO_ROOT, path), 'utf8'),
        `SERVICE_SERVER_PATH["${service}"] points at ${path}, which does not exist`,
      );
    }
  });

  it('services with only planned endpoints are exempt, and stop being exempt automatically', () => {
    // outline and hubspot have no live routes; registering the tools there
    // would advertise a data plane that 404s (see restCatalog.ts:114-116).
    // They are not hardcoded as exceptions — they are simply absent from
    // servicesWithLiveEndpoints(), so flipping any entry to 'live' enrolls
    // them with no edit to this file.
    const live = new Set(servicesWithLiveEndpoints());
    const planned = [...new Set(REST_CATALOG.map(e => e.service))].filter(s => !live.has(s));
    for (const service of planned) {
      const hasLive = REST_CATALOG.some(e => e.service === service && e.status === 'live');
      assert.equal(hasLive, false, `${service} was treated as exempt but has live endpoints`);
    }
  });
});
