import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, relative, resolve } from 'node:path';
import { REST_CATALOG, SERVICE_SERVER_PATH, type RestService } from '../restCatalog.js';

// Drift guard: a new MCP tool on a server that has a REST plane must make an
// explicit REST decision. Either it gets a catalog entry in src/restCatalog.ts
// (live or planned), or it is listed in MCP_ONLY below with the reason it has
// none. Nothing else in the repo forces that decision. The add-mcp-tool skill
// does not chain to add-rest-endpoint, and no other test checks that tools and
// catalog agree, so a tool shipped without an endpoint passed CI silently.
//
// Listing a tool in MCP_ONLY is a legitimate answer, not a loophole. The
// catalog's own header says a write earns a REST sibling only when its body is
// large or it belongs in a shell pipeline, and a destructive endpoint needs
// sign-off recorded in the catalog notes (root CLAUDE.md). The point is that
// someone decides, and a reviewer sees the decision in the diff.
//
// Static source scan, like sharedToolsRegistration.test.ts and for the same
// reason: importing src/google-docs/server.ts starts the whole app.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Servers with no REST service at all. Every other src/<dir>/server.ts must be in SERVICE_SERVER_PATH. */
const NO_REST_PLANE: Record<string, string> = {
  'src/slack-user/server.ts': 'Shares the slack bot server\'s REST endpoints, which need a slack-bot connection.',
  'src/peopleforce-v4/server.ts': 'No RestService in src/restCatalog.ts.',
  'src/admin-mcp/server.ts': 'Admin-only MCP (ADMIN_ONLY_MCPS); no REST plane.',
  'src/sandbox/server.ts': 'No RestService in src/restCatalog.ts.',
};

const PREDATES = 'Predates this guard; REST not decided yet.';
const DESTRUCTIVE = 'Destructive: a REST sibling needs sign-off recorded in the catalog notes (root CLAUDE.md).';
const UNIMPLEMENTED = 'Throws NOT_IMPLEMENTED (e2e/tools.ts): an endpoint would only advertise a 500.';

/**
 * Tools on a REST-plane server that deliberately have no catalog entry, each
 * with its reason. Adding a REST endpoint for one of them means deleting it
 * here: the stale-entry test below fails until you do.
 */
const MCP_ONLY: Partial<Record<RestService, Record<string, string>>> = {
  docs: {
    deleteDocumentTab: DESTRUCTIVE,
    deleteSuggestion: DESTRUCTIVE,
    deleteTableRowOrColumn: DESTRUCTIVE,
    editTableCell: UNIMPLEMENTED,
    findElement: UNIMPLEMENTED,
    fixListFormatting: UNIMPLEMENTED,
    rejectSuggestion: DESTRUCTIVE,
  },
  sheets: {
    addSpreadsheetSheet: PREDATES,
    deleteSpreadsheetRowsOrColumns: DESTRUCTIVE,
    updateCellByFieldName: PREDATES,
  },
  calendar: {
    queryFreeBusy: PREDATES,
  },
  drive: {
    createDocument: PREDATES,
  },
  gmail: {
    deleteFilter: DESTRUCTIVE,
  },
  clickup: {
    subscribeToTaskEvents: PREDATES,
    unsubscribeFromTaskEvents: DESTRUCTIVE,
  },
  slack: {
    downloadFile: PREDATES,
    findCanvasSections: PREDATES,
    openDm: PREDATES,
  },
  outline: {
    deleteCollection: DESTRUCTIVE,
    deleteComment: DESTRUCTIVE,
    deleteDocument: DESTRUCTIVE,
  },
  hubspot: {
    searchCompanies: PREDATES,
    searchContacts: PREDATES,
    searchDeals: PREDATES,
  },
  redmine: {
    deleteProject: DESTRUCTIVE,
  },
  browserbase: {
    act: PREDATES,
    end: PREDATES,
  },
  supabase: {
    apply_migration: DESTRUCTIVE,
    confirm_cost: PREDATES,
    create_branch: PREDATES,
    create_notebook: PREDATES,
    create_project: PREDATES,
    delete_branch: DESTRUCTIVE,
    delete_feedback: DESTRUCTIVE,
    deploy_edge_function: DESTRUCTIVE,
    execute_sql: DESTRUCTIVE,
    get_notebook: PREDATES,
    get_storage_config: PREDATES,
    list_notebooks: PREDATES,
    list_storage_buckets: PREDATES,
    merge_branch: DESTRUCTIVE,
    pause_project: PREDATES,
    rebase_branch: DESTRUCTIVE,
    reset_branch: DESTRUCTIVE,
    restore_project: PREDATES,
    run_notebook: DESTRUCTIVE,
    submit_feedback: PREDATES,
    update_storage_config: DESTRUCTIVE,
  },
  storage: {
    createCollection: PREDATES,
    deleteRecords: DESTRUCTIVE,
    dropCollection: DESTRUCTIVE,
    migrateCollection: DESTRUCTIVE,
  },
};

function stripComments(source: string): string {
  // Whole-line `//` comments first: the order is load-bearing. See the same
  // strip in sharedToolsRegistration.test.ts for the bug it prevents.
  return source.replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * The server file plus every module it imports that registers tools itself
 * (src/slack/workspaceTools.ts). Same rule as scripts/buildMcpToolsDoc.mjs:
 * shared tools are skipped (they are not a service's own), and another
 * server.ts is never followed, because src/google-docs/server.ts is the app
 * entry point and imports every other server.
 */
function toolSourceFiles(serverPath: string): string[] {
  const absolute = resolve(REPO_ROOT, serverPath);
  const files = [absolute];
  const source = stripComments(readFileSync(absolute, 'utf8'));
  for (const match of source.matchAll(/from\s+'(\.{1,2}\/[^']+)\.js'/g)) {
    const candidate = resolve(dirname(absolute), `${match[1]}.ts`);
    const path = relative(REPO_ROOT, candidate);
    if (path.startsWith('src/sharedTools/') || path.endsWith('/server.ts') || !existsSync(candidate)) continue;
    if (/\b[A-Za-z]*Tool\(\s*\{/.test(stripComments(readFileSync(candidate, 'utf8')))) files.push(candidate);
  }
  return files;
}

/**
 * Names of the tools registered in a source file: every `<anything>Tool({ name: '...' })`
 * call. Matching any identifier ending in `Tool` covers `addTool` and the
 * per-provider helpers (addPaginatedListTool, addRecentListTool, supabaseTool,
 * and whatever comes next) without a list to keep in step. A helper's own
 * definition passes `name: config.name`, which is not a literal and is skipped.
 */
function registeredToolNames(source: string): string[] {
  const names: string[] = [];
  const opener = /\b[A-Za-z]*Tool\(\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    let index = match.index + match[0].length;
    const start = index;
    let depth = 1;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === "'" || char === '"' || char === '`') {
        index += 1;
        while (index < source.length && source[index] !== char) {
          if (source[index] === '\\') index += 1;
          index += 1;
        }
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
      }
      index += 1;
    }
    const name = source.slice(start, index - 1).match(/(?:^|[\s,{])name:\s*(['"])([^'"]+)\1/)?.[2];
    if (name !== undefined) names.push(name);
  }
  return names;
}

function toolsOf(service: RestService): Set<string> {
  const names = new Set<string>();
  for (const file of toolSourceFiles(SERVICE_SERVER_PATH[service])) {
    for (const name of registeredToolNames(stripComments(readFileSync(file, 'utf8')))) names.add(name);
  }
  return names;
}

function catalogued(service: RestService): Set<string> {
  return new Set(REST_CATALOG.filter(entry => entry.service === service).map(entry => entry.mcpToolName));
}

const SERVICES = Object.keys(SERVICE_SERVER_PATH) as RestService[];

describe('every MCP tool on a REST-plane server makes a REST decision', () => {
  it('every src/<dir>/server.ts is either a REST service or listed as having no REST plane', () => {
    const servers = readdirSync(resolve(REPO_ROOT, 'src'), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(resolve(REPO_ROOT, 'src', entry.name, 'server.ts')))
      .map(entry => `src/${entry.name}/server.ts`);
    const restServers = new Set(Object.values(SERVICE_SERVER_PATH));
    const unclassified = servers.filter(path => !restServers.has(path) && NO_REST_PLANE[path] === undefined);
    assert.deepEqual(
      unclassified,
      [],
      'A server with no REST service must be listed in NO_REST_PLANE with its reason, or mapped in SERVICE_SERVER_PATH (src/restCatalog.ts).',
    );
    for (const path of Object.keys(NO_REST_PLANE)) {
      assert.ok(servers.includes(path), `NO_REST_PLANE lists ${path}, which no longer exists`);
      assert.ok(!restServers.has(path), `${path} is a REST service now: remove it from NO_REST_PLANE`);
    }
  });

  for (const service of SERVICES) {
    describe(service, () => {
      const tools = toolsOf(service);
      const inCatalog = catalogued(service);
      const mcpOnly = MCP_ONLY[service] ?? {};

      it('the scan finds its tools', () => {
        assert.ok(tools.size > 0, `found no tool registrations in ${SERVICE_SERVER_PATH[service]}: the scanner is broken`);
      });

      it('each tool has a catalog entry or an MCP_ONLY reason', () => {
        const undecided = [...tools].filter(name => !inCatalog.has(name) && mcpOnly[name] === undefined).sort();
        const files = toolSourceFiles(SERVICE_SERVER_PATH[service]).map(file => relative(REPO_ROOT, file)).join(', ');
        assert.deepEqual(
          undecided,
          [],
          `${service} tools in ${files} with no REST decision: ${undecided.join(', ')}.\n` +
            'Either add a REST endpoint (the add-rest-endpoint skill: an entry in src/restCatalog.ts, the handler in ' +
            'src/website/webServer.ts, regenerated docs), which every read tool should get; or, for a write that does not ' +
            "earn one (see the header of src/restCatalog.ts), add it to MCP_ONLY in this file with the reason.",
        );
      });

      it('MCP_ONLY lists only tools that exist and still have no catalog entry', () => {
        for (const name of Object.keys(mcpOnly)) {
          assert.ok(tools.has(name), `MCP_ONLY.${service} lists ${name}, which ${service} no longer registers: remove it`);
          assert.ok(!inCatalog.has(name), `${name} now has a REST endpoint: remove it from MCP_ONLY.${service}`);
        }
      });
    });
  }

  it('MCP_ONLY names only REST services', () => {
    for (const service of Object.keys(MCP_ONLY)) {
      assert.ok(SERVICES.includes(service as RestService), `MCP_ONLY has a key for unknown service ${service}`);
    }
  });
});
