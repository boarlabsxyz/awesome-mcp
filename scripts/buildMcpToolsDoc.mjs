#!/usr/bin/env node
// Generates docs/MCP_TOOLS.md from every server.ts file in src/*/server.ts.
//
// Source of truth: the `<serverName>.addTool({ name, description, ... })`
// registrations themselves. This script parses each server.ts as text (no
// build step), extracts each tool's name + description, and renders one
// markdown table per service. The REST column comes from src/restCatalog.ts.
//
// Run after editing tool descriptions:
//   node scripts/buildMcpToolsDoc.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(root, 'docs');
const outPath = join(outDir, 'MCP_TOOLS.md');

// Each entry: [filePath, sectionTitle, catalogServiceKey, autoRegistered?]
// catalogServiceKey matches the `service:` field in src/restCatalog.ts so we
// can cross-reference REST siblings. slack-user uses the same 'slack'
// endpoints (which require a slack-bot connection), so it never shows a
// REST sibling. Entries with autoRegistered=true are the shared tools that
// every FastMCP server registers via the registerX helpers.
const SERVICES = [
  ['src/sharedTools/mintRestBearerForCurl.ts', 'Shared (every server)', null, true],
  ['src/sharedTools/listRestEndpoints.ts','Shared (every server)', null, true],
  ['src/google-docs/server.ts',           'Google Docs',           'docs'],
  ['src/google-sheets/server.ts',         'Google Sheets',         'sheets'],
  ['src/google-calendar/server.ts',       'Google Calendar',       'calendar'],
  ['src/google-drive/server.ts',          'Google Drive',          'drive'],
  ['src/google-gmail/server.ts',          'Gmail',                 'gmail'],
  ['src/google-slides/server.ts',         'Google Slides',         'slides'],
  ['src/clickup/server.ts',               'ClickUp',               'clickup'],
  ['src/slack/server.ts',                 'Slack (bot)',           'slack'],
  ['src/slack-user/server.ts',            'Slack (user)',          null],
  ['src/outline/server.ts',               'Outline',               'outline'],
];

// ---------------------------------------------------------------------------
// REST catalog map: mcpToolName → "GET /api/v1/path"
// ---------------------------------------------------------------------------

function loadRestCatalog() {
  const src = readFileSync(join(root, 'src', 'restCatalog.ts'), 'utf8');
  const arrayMatch = src.match(/REST_CATALOG[\s\S]*?=\s*\[([\s\S]*?)\];/);
  if (!arrayMatch) return new Map();
  const map = new Map();
  const entryRe = /\{\s*service:\s*'([^']+)',\s*method:\s*'([^']+)',\s*path:\s*'([^']+)',[\s\S]*?mcpToolName:\s*'([^']+)',[\s\S]*?status:\s*'([^']+)'/g;
  let m;
  while ((m = entryRe.exec(arrayMatch[1])) !== null) {
    const [, service, method, path, mcpToolName, status] = m;
    if (status !== 'live') continue;
    // Only first encounter wins (e.g. listGoogleDocs has both list + search
    // entries pointing at the same path — the list entry is canonical).
    if (!map.has(`${service}:${mcpToolName}`)) {
      map.set(`${service}:${mcpToolName}`, `${method} ${path}`);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Per-file tool extraction — walks the addTool({ … }) blocks with brace
// counting (skipping over string literals) so we don't get confused by curly
// braces inside Zod schemas or example strings.
// ---------------------------------------------------------------------------

function findAddToolBlocks(src) {
  const blocks = [];
  const opener = /addTool\(\s*\{/g;
  let m;
  while ((m = opener.exec(src)) !== null) {
    const start = m.index + m[0].length;
    let i = start;
    let depth = 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "'" || c === '"' || c === '`') {
        // Skip a string literal verbatim.
        const quote = c;
        i++;
        while (i < src.length && src[i] !== quote) {
          if (src[i] === '\\') i++;
          i++;
        }
      } else if (c === '{') {
        depth++;
      } else if (c === '}') {
        depth--;
      }
      i++;
    }
    blocks.push(src.substring(start, i - 1));
  }
  return blocks;
}

function extractName(block) {
  const m = block.match(/(?:^|[\s,{])name:\s*(['"])([^'"]+)\1/);
  return m ? m[2] : null;
}

function extractDescription(block) {
  // Capture the description expression: one or more quoted/template strings
  // joined by `+`. Stops at the next field (parameters / annotations / etc.)
  // or end of block.
  const m = block.match(/(?:^|[\s,{])description:\s*((?:(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)\s*\+?\s*)+)(?=,\s*\w+\s*:|\s*}\s*$|\s*\n\s*\w+\s*:)/);
  if (!m) return null;
  return evalStringExpr(m[1]);
}

/** Parse a description expression that is a concatenation of string literals.
 *  Accepts: single-quoted, double-quoted, and template literals joined by `+`.
 *  Template literals may interpolate ONLY `${BASE_URL}`, which is replaced
 *  with a generic placeholder so the doc isn't tied to one host. Anything
 *  else (arbitrary identifiers, function calls, other interpolations) is
 *  rejected — even though descriptions come from our own source tree, doc
 *  generation runs in CI and on developer machines, so this stays purely
 *  data-driven instead of eval-ing source text. */
function evalStringExpr(expr) {
  const parts = [];
  let i = 0;
  let expectString = true;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    if (expectString) {
      if (ch === "'" || ch === '"') {
        const r = parseQuotedString(expr, i, ch);
        if (!r) return null;
        parts.push(r.value);
        i = r.next;
      } else if (ch === '`') {
        const r = parseTemplateLiteral(expr, i);
        if (!r) return null;
        parts.push(r.value);
        i = r.next;
      } else {
        return null;
      }
      expectString = false;
    } else {
      if (ch !== '+') return null;
      i++;
      expectString = true;
    }
  }
  if (expectString || parts.length === 0) return null;
  return parts.join('').replace(/\s+/g, ' ').trim();
}

function parseQuotedString(s, start, quote) {
  let i = start + 1;
  let out = '';
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      const next = s[i + 1];
      if (next === undefined) return null;
      out += decodeEscape(next);
      i += 2;
    } else if (ch === quote) {
      return { value: out, next: i + 1 };
    } else {
      out += ch;
      i++;
    }
  }
  return null;
}

function parseTemplateLiteral(s, start) {
  let i = start + 1;
  let out = '';
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      const next = s[i + 1];
      if (next === undefined) return null;
      out += decodeEscape(next);
      i += 2;
    } else if (ch === '`') {
      return { value: out, next: i + 1 };
    } else if (ch === '$' && s[i + 1] === '{') {
      const end = s.indexOf('}', i + 2);
      if (end === -1) return null;
      if (s.slice(i + 2, end).trim() !== 'BASE_URL') return null;
      out += '<base>';
      i = end + 1;
    } else {
      out += ch;
      i++;
    }
  }
  return null;
}

function decodeEscape(c) {
  switch (c) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    case 'b': return '\b';
    case 'f': return '\f';
    case '0': return '\0';
    default: return c;
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function escapeMd(s) {
  // Markdown table cell: backslash-escape pipes, collapse newlines.
  return s.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function renderTable(tools, restMap, catalogServiceKey) {
  const lines = [];
  lines.push('| Tool | Description | REST |');
  lines.push('|---|---|---|');
  for (const t of tools) {
    const rest = catalogServiceKey
      ? restMap.get(`${catalogServiceKey}:${t.name}`) || '—'
      : '—';
    lines.push(`| \`${t.name}\` | ${escapeMd(t.description)} | ${rest === '—' ? '—' : '`' + rest + '`'} |`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const restMap = loadRestCatalog();
const sections = new Map();      // sectionTitle → { title, files: Set<string>, tools: [] }
let grandTotal = 0;

for (const [file, title, serviceKey, autoRegistered] of SERVICES) {
  const fullPath = join(root, file);
  const src = readFileSync(fullPath, 'utf8');
  const blocks = findAddToolBlocks(src);
  const newTools = [];
  for (const block of blocks) {
    const name = extractName(block);
    const description = extractDescription(block);
    if (!name || !description) {
      console.warn(`[buildMcpToolsDoc] Skipping unparseable addTool block in ${file}`);
      continue;
    }
    newTools.push({ name, description });
  }
  let section = sections.get(title);
  if (!section) {
    section = { title, files: [], tools: [], serviceKey, autoRegistered };
    sections.set(title, section);
  }
  section.files.push(file);
  // Dedup by tool name within the same section (the shared tools file pair
  // would otherwise show twice).
  for (const t of newTools) {
    if (!section.tools.find(x => x.name === t.name)) {
      section.tools.push(t);
      grandTotal++;
    }
  }
}

const orderedSections = [...sections.values()];

const out = [];
out.push('# MCP tools');
out.push('');
out.push('Generated from `src/<service>/server.ts` by `scripts/buildMcpToolsDoc.mjs`. Do not edit by hand.');
out.push('');
out.push('Every tool the LLM can call via MCP, grouped by service. The **REST** column shows the matching `/api/v1/*` endpoint when the tool has a REST data-plane sibling — prefer the REST endpoint for bulk reads (see `docs/REST_ENDPOINTS.md`).');
out.push('');
out.push('## Index');
out.push('');
for (const s of orderedSections) {
  out.push(`- [${s.title}](#${s.title.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}) (${s.tools.length})`);
}
out.push('');
for (const s of orderedSections) {
  out.push(`## ${s.title}`);
  out.push('');
  const sourceLabel = s.files.length === 1 ? `\`${s.files[0]}\`` : s.files.map(f => `\`${f}\``).join(', ');
  const note = s.autoRegistered
    ? ' (registered on every FastMCP server)'
    : '';
  out.push(`Source: ${sourceLabel} — ${s.tools.length} tools${note}.`);
  out.push('');
  if (s.tools.length === 0) {
    out.push('_(no tools found)_');
  } else {
    out.push(renderTable(s.tools, restMap, s.serviceKey));
  }
  out.push('');
}
out.push(`---`);
out.push('');
out.push(`**Grand total: ${grandTotal} tools across ${orderedSections.length} sections.**`);
out.push('');

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, out.join('\n'));
console.log(`Wrote ${outPath} — ${grandTotal} tools across ${orderedSections.length} sections.`);
