#!/usr/bin/env node
// Generates docs/REST_ENDPOINTS.md from src/restCatalog.ts.
//
// The catalog is the single source of truth; this script renders it as a
// markdown table grouped by service. Run after editing src/restCatalog.ts:
//   node scripts/buildRestEndpointsDoc.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const catalogPath = join(root, 'src', 'restCatalog.ts');
const outDir = join(root, 'docs');
const outPath = join(outDir, 'REST_ENDPOINTS.md');

const BASE_URL = (process.env.BASE_URL || 'https://awesome-mcp.xyz').replace(/\/+$/, '');

// Parse REST_CATALOG entries out of the TS source so this script has no
// dependency on a build step. The catalog is a flat array of literals — we
// just extract the relevant fields with a regex.
const src = readFileSync(catalogPath, 'utf8');
const arrayMatch = src.match(/REST_CATALOG[\s\S]*?=\s*\[([\s\S]*?)\];/);
if (!arrayMatch) {
  console.error('Could not locate REST_CATALOG in', catalogPath);
  process.exit(1);
}
const body = arrayMatch[1];

const entries = [];
const entryRe = /\{\s*service:\s*'([^']+)',\s*method:\s*'([^']+)',\s*path:\s*'([^']+)',\s*summary:\s*'([^']+)',\s*mcpToolName:\s*'([^']+)',\s*openapiOperationId:\s*'([^']+)',\s*status:\s*'([^']+)'(?:,\s*notes:\s*'([^']+)')?\s*\}/g;
let m;
while ((m = entryRe.exec(body)) !== null) {
  entries.push({
    service: m[1],
    method: m[2],
    path: m[3],
    summary: m[4],
    mcpToolName: m[5],
    openapiOperationId: m[6],
    status: m[7],
    notes: m[8],
  });
}

const SERVICE_TITLE = {
  docs: 'Google Docs',
  sheets: 'Google Sheets',
  calendar: 'Google Calendar',
  drive: 'Google Drive',
  gmail: 'Gmail',
  slides: 'Google Slides',
  clickup: 'ClickUp',
  slack: 'Slack',
  outline: 'Outline',
  peopleforce: 'PeopleForce',
};

const SERVICE_ORDER = ['docs', 'sheets', 'calendar', 'drive', 'gmail', 'slides', 'clickup', 'slack', 'outline', 'peopleforce'];

const lines = [];
lines.push('# REST Data Plane — Endpoint Catalog');
lines.push('');
lines.push('Generated from `src/restCatalog.ts` by `scripts/buildRestEndpointsDoc.mjs`. Do not edit by hand.');
lines.push('');
lines.push('## Why this exists');
lines.push('');
lines.push('Every MCP tool response flows through the LLM\'s tool-result channel — every byte counts against context and output tokens. For bulk reads (calendar weeks, search results, full doc bodies, channel history), the REST data plane lets the LLM orchestrate the fetch via curl + jq while keeping the bytes off-context.');
lines.push('');
lines.push('## Auth');
lines.push('');
lines.push('1. From any MCP session, call the `getSecurityToken` MCP tool — it returns a 5-minute bearer.');
lines.push('2. Pass it as `Authorization: Bearer <token>` against the URLs below.');
lines.push('');
lines.push('The same endpoints also accept the permanent dashboard API key (for ChatGPT Custom Actions backward compatibility).');
lines.push('');
lines.push('## Content negotiation');
lines.push('');
lines.push('| Header / query | Behavior |');
lines.push('|---|---|');
lines.push('| `Accept: application/json` (default) | Raw upstream JSON from Google/Slack/ClickUp, untransformed |');
lines.push('| `Accept: text/plain` or `?format=text` | Markdown rendering matching the MCP tool\'s output (where supported) |');
lines.push('');
lines.push('## Base URL');
lines.push('');
lines.push('```text');
lines.push(`${BASE_URL}/api/v1`);
lines.push('```');
lines.push('');
lines.push('OpenAPI spec: `' + BASE_URL + '/openapi.json`');
lines.push('');
lines.push('## Endpoints by service');
lines.push('');

const byService = {};
for (const e of entries) {
  (byService[e.service] ??= []).push(e);
}

for (const svc of SERVICE_ORDER) {
  const list = byService[svc];
  if (!list || list.length === 0) continue;
  lines.push(`### ${SERVICE_TITLE[svc] ?? svc} (\`${svc}\`)`);
  lines.push('');
  lines.push('| MCP tool | REST endpoint | Status | Summary |');
  lines.push('|---|---|---|---|');
  for (const e of list) {
    const notes = e.notes ? ` — _${e.notes}_` : '';
    lines.push(`| \`${e.mcpToolName}\` | \`${e.method} ${e.path}\` | ${e.status} | ${e.summary}${notes} |`);
  }
  lines.push('');
}

lines.push('## Status legend');
lines.push('');
lines.push('- **live** — endpoint is currently wired and reachable.');
lines.push('- **planned** — endpoint is in the catalog and on the roadmap; not yet served by the Express app. Calls return 404 until shipped.');
lines.push('');
lines.push(`Catalog size: ${entries.length} endpoints.`);
lines.push('');

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, lines.join('\n'));
console.log(`Wrote ${outPath} — ${entries.length} endpoints across ${Object.keys(byService).length} services.`);
