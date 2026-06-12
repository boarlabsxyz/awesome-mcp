#!/usr/bin/env node
// Merges the per-service OpenAPI specs in public/openapi-*.json into a single
// public/openapi.json published at https://<host>/openapi.json. The root spec
// is what awesome-mcp.xyz exposes for REST clients that want to discover the
// full data plane in one fetch.
//
// Schema namespacing: when two per-service specs define a schema with the
// same name (e.g. Comment in Docs and ClickUp), the second occurrence is
// renamed `<ServicePrefix><Name>` and every $ref within that spec is
// rewritten to match.
//
// The shared `Error` schema is deduplicated — the first occurrence wins,
// later ones are dropped (they are structurally identical).
//
// Run with: node scripts/buildRootOpenapi.mjs

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
const outPath = join(publicDir, 'openapi.json');

const BASE_URL = (process.env.BASE_URL || 'https://awesome-mcp.xyz').replace(/\/+$/, '');

// Map filename → schema prefix used to namespace colliding component schemas.
const SERVICE_PREFIX = {
  'openapi-docs.json': 'Docs',
  'openapi-sheets.json': 'Sheets',
  'openapi-calendar.json': 'Calendar',
  'openapi-drive.json': 'Drive',
  'openapi-gmail.json': 'Gmail',
  'openapi-slides.json': 'Slides',
  'openapi-clickup.json': 'ClickUp',
};

const SHARED_SCHEMAS = new Set(['Error']);

function rewriteRefs(obj, schemaRenames) {
  if (Array.isArray(obj)) {
    for (const item of obj) rewriteRefs(item, schemaRenames);
    return;
  }
  if (obj && typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (key === '$ref' && typeof val === 'string') {
        const match = val.match(/^#\/components\/schemas\/(.+)$/);
        if (match && schemaRenames.has(match[1])) {
          obj[key] = `#/components/schemas/${schemaRenames.get(match[1])}`;
        }
      } else {
        rewriteRefs(val, schemaRenames);
      }
    }
  }
}

const root = {
  openapi: '3.0.0',
  info: {
    title: 'awesome-mcp REST Data Plane',
    description:
      'Combined catalog of REST passthrough endpoints across every service ' +
      'wired into this awesome-mcp instance. Use the getSecurityToken MCP ' +
      'tool to mint a 5-minute bearer token, then GET these URLs to fetch ' +
      'bulk responses directly to disk without burning LLM context.',
    version: '1.0.0',
  },
  servers: [
    { url: BASE_URL, description: 'awesome-mcp REST data plane' },
  ],
  security: [{ bearerAuth: [] }],
  paths: {},
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description:
          'Bearer token from the getSecurityToken MCP tool (5-minute TTL) or ' +
          'a permanent dashboard API key.',
      },
    },
    schemas: {},
  },
};

const seenSchemas = new Set();
const pathOwners = new Map();

const files = readdirSync(publicDir)
  .filter(f => f.startsWith('openapi-') && f.endsWith('.json'))
  .sort();

for (const file of files) {
  const prefix = SERVICE_PREFIX[file];
  if (!prefix) {
    console.warn(`[buildRootOpenapi] Skipping ${file}: no service prefix mapping.`);
    continue;
  }
  const spec = JSON.parse(readFileSync(join(publicDir, file), 'utf8'));

  // Decide which schemas to rename to avoid collisions.
  const renames = new Map();
  const schemas = spec.components?.schemas ?? {};
  for (const name of Object.keys(schemas)) {
    if (SHARED_SCHEMAS.has(name)) {
      // Shared (Error) — keep one; skip later occurrences.
      continue;
    }
    if (seenSchemas.has(name)) {
      renames.set(name, `${prefix}${name}`);
    }
  }
  rewriteRefs(spec, renames);

  // Merge schemas.
  for (const [name, schema] of Object.entries(schemas)) {
    if (SHARED_SCHEMAS.has(name)) {
      if (!root.components.schemas[name]) {
        root.components.schemas[name] = schema;
      }
      continue;
    }
    const finalName = renames.get(name) ?? name;
    if (root.components.schemas[finalName]) {
      console.warn(`[buildRootOpenapi] Schema collision after rename: ${finalName} (from ${file})`);
      continue;
    }
    root.components.schemas[finalName] = schema;
    seenSchemas.add(finalName);
  }

  // Merge paths.
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    if (root.paths[path]) {
      const owner = pathOwners.get(path);
      console.warn(`[buildRootOpenapi] Path collision: ${path} (already owned by ${owner}, second from ${file})`);
      Object.assign(root.paths[path], methods);
    } else {
      root.paths[path] = methods;
      pathOwners.set(path, file);
    }
  }
}

// Fill in stub entries for endpoints listed in src/restCatalog.ts that aren't
// yet in any per-service spec. Keeps the combined openapi.json complete even
// when the per-service specs haven't caught up with the live route handlers.
try {
  const catalogPath = join(__dirname, '..', 'src', 'restCatalog.ts');
  const catalogSrc = readFileSync(catalogPath, 'utf8');
  const arrayMatch = catalogSrc.match(/REST_CATALOG[\s\S]*?=\s*\[([\s\S]*?)\];/);
  if (arrayMatch) {
    const entryRe = /\{\s*service:\s*'([^']+)',\s*method:\s*'([^']+)',\s*path:\s*'([^']+)',\s*summary:\s*'([^']+)',\s*mcpToolName:\s*'([^']+)',\s*openapiOperationId:\s*'([^']+)',\s*status:\s*'([^']+)'/g;
    let m;
    let stubs = 0;
    while ((m = entryRe.exec(arrayMatch[1])) !== null) {
      const [, service, method, rawPath, summary, mcpToolName, opId, status] = m;
      // Strip the query-string template from the path (paths in OpenAPI are
      // the URL path only; query params belong in `parameters`).
      const pathOnly = rawPath.split('?')[0];
      // Convert {param} placeholders to OpenAPI style (they already are).
      if (root.paths[pathOnly]?.[method.toLowerCase()]) continue;
      if (status === 'planned') continue; // don't list endpoints that aren't wired yet
      root.paths[pathOnly] ??= {};
      root.paths[pathOnly][method.toLowerCase()] = {
        operationId: opId,
        summary,
        description: `${summary}. Mirrors the MCP tool \`${mcpToolName}\`. Returns upstream JSON by default; pass Accept: text/plain for markdown.`,
        tags: [service],
        responses: {
          '200': { description: 'Success (raw upstream JSON or rendered text)' },
          '401': { description: 'Missing or invalid bearer token' },
          '403': { description: 'Permission denied' },
          '404': { description: 'Resource not found' },
        },
      };
      stubs++;
    }
    if (stubs > 0) console.log(`  Added ${stubs} stub entries from src/restCatalog.ts`);
  }
} catch (err) {
  console.warn(`[buildRootOpenapi] catalog stub pass skipped: ${err.message}`);
}

writeFileSync(outPath, JSON.stringify(root, null, 2) + '\n');

const pathCount = Object.keys(root.paths).length;
const opCount = Object.values(root.paths).reduce(
  (sum, methods) => sum + Object.keys(methods).filter(k => !k.startsWith('x-') && k !== 'parameters' && k !== 'summary' && k !== 'description').length,
  0,
);
const schemaCount = Object.keys(root.components.schemas).length;

console.log(`[buildRootOpenapi] Wrote ${outPath}`);
console.log(`  Paths:     ${pathCount}`);
console.log(`  Operations: ${opCount}`);
console.log(`  Schemas:   ${schemaCount}`);
console.log(`  Servers:   ${root.servers[0].url}`);
