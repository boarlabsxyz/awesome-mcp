#!/usr/bin/env node
// Lists the connectors whose OAuth scopes grew between two git refs, so the release
// notes can tell people to reconnect: a token keeps the scopes it was minted with, so
// a connection made before the release can't use what the new scopes unlock.
// No external dependencies — uses only Node.js builtins.
//
// Reads `oauthScopes` from the seed calls in src/mcpCatalogStore.ts at each ref. That
// field is static source (string literals, a ternary on an env flag, or an imported
// constant), so it is parsed as text rather than imported: importing would need the
// TypeScript build and the env of the release being described.
//
// Only connectors present at both refs are reported — a brand-new connector has
// nobody to reconnect. Removed scopes are ignored; a narrower token still works.
// slack-bot is out of reach: its scopes live on the customer's own Slack app.
//
// Usage: detect-scope-changes.mjs --from <ref> --to <ref> --out <file>
// Writes a JSON array: [{ slug, name, added: [scope, ...] }]. An empty --from writes [].

import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import { pathToFileURL } from 'url';

const CATALOG_PATH = 'src/mcpCatalogStore.ts';

// Drops // and /* */ comments without touching string contents, so a scope URL's
// "https://" survives and a commented-out scope is not counted.
export function stripComments(source) {
  let out = '';
  let quote = null;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += source[++i] ?? ''; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue; }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function stringLiterals(text) {
  return [...text.matchAll(/'([^'\\]*)'|"([^"\\]*)"/g)].map(m => m[1] ?? m[2]);
}

// `export const NAME = [ '...', ... ];` — the shape scope constants take
// (e.g. GITHUB_OAUTH_SCOPES in src/github/oauthCallback.ts).
export function parseArrayConstants(source) {
  const constants = new Map();
  for (const m of stripComments(source).matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*\[([^\]]*)\]/g)) {
    constants.set(m[1], stringLiterals(m[2]));
  }
  return constants;
}

// The text of the expression after `oauthScopes:`, up to the comma or brace that
// closes it at bracket depth 0.
function scopeExpression(block) {
  const start = block.search(/\boauthScopes\s*:/);
  if (start === -1) return null;
  let i = block.indexOf(':', start) + 1;
  let depth = 0;
  let quote = null;
  const from = i;
  for (; i < block.length; i++) {
    const ch = block[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '[' || ch === '(' || ch === '{') depth++;
    else if (ch === ']' || ch === ')' || ch === '}') {
      if (depth === 0) break;
      depth--;
    } else if (ch === ',' && depth === 0) break;
  }
  return block.slice(from, i);
}

// Map slug -> { name, scopes: Set } for every seeded catalog entry. Both arms of a
// ternary count: which one runs depends on the deployment's env, not on the source.
export function parseCatalogScopes(source, constants = new Map()) {
  const clean = stripComments(source);
  const entries = new Map();
  const starts = [...clean.matchAll(/\bslug:\s*'([^']+)'/g)];
  starts.forEach((m, idx) => {
    const block = clean.slice(m.index, starts[idx + 1]?.index ?? clean.length);
    const expr = scopeExpression(block);
    const scopes = new Set(expr ? stringLiterals(expr) : []);
    for (const id of expr?.match(/\b[A-Z][A-Z0-9_]+\b/g) ?? []) {
      for (const s of constants.get(id) ?? []) scopes.add(s);
    }
    const name = block.match(/\bname:\s*'([^']*)'/)?.[1] ?? m[1];
    entries.set(m[1], { name, scopes });
  });
  return entries;
}

export function diffScopes(before, after) {
  const changes = [];
  for (const [slug, now] of after) {
    const was = before.get(slug);
    if (!was) continue;
    const added = [...now.scopes].filter(s => !was.scopes.has(s));
    if (added.length) changes.push({ slug, name: now.name, added });
  }
  return changes;
}

function showAtRef(ref, path) {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

// Constants imported into the catalog from sibling modules, read at the same ref.
function importedConstants(ref, catalogSource) {
  const constants = new Map();
  for (const m of catalogSource.matchAll(/import\s*\{[^}]*\}\s*from\s*'\.\/([^']+)\.js'/g)) {
    const source = showAtRef(ref, `src/${m[1]}.ts`);
    if (source) for (const [k, v] of parseArrayConstants(source)) constants.set(k, v);
  }
  return constants;
}

export function scopesAtRef(ref) {
  const source = showAtRef(ref, CATALOG_PATH);
  if (source == null) return new Map();
  return parseCatalogScopes(source, importedConstants(ref, source));
}

function main() {
  const args = process.argv.slice(2);
  const arg = name => {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 ? args[idx + 1] ?? '' : null;
  };
  const from = arg('from');
  const to = arg('to');
  const out = arg('out');
  if (from == null || !to || !out) {
    console.error('Usage: detect-scope-changes.mjs --from <ref> --to <ref> --out <file>');
    process.exit(1);
  }
  const changes = from ? diffScopes(scopesAtRef(from), scopesAtRef(to)) : [];
  writeFileSync(out, JSON.stringify(changes, null, 2));
  if (changes.length === 0) console.log(`No connector gained OAuth scopes between ${from || '(start)'} and ${to}.`);
  for (const c of changes) console.log(`${c.name} (${c.slug}) gained: ${c.added.join(', ')}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
