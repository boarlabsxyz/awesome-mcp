// tests/detectScopeChanges.test.js
import { stripComments, parseArrayConstants, parseCatalogScopes, diffScopes } from '../.github/scripts/detect-scope-changes.mjs';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

const seed = (slug, name, scopesExpr) => `
  await createMcpCatalog({
    slug: '${slug}',
    name: '${name}',
    scopes: ['ignored-not-oauth'],
    oauthScopes: ${scopesExpr},
    isActive: true,
  });`;

describe('detect-scope-changes', () => {
  describe('stripComments', () => {
    it('keeps // inside strings and drops real comments', () => {
      const out = stripComments(`['https://x/a', // 'commented'\n /* 'block' */ 'b']`);
      assert.ok(out.includes("'https://x/a'"));
      assert.ok(!out.includes('commented'));
      assert.ok(!out.includes('block'));
      assert.ok(out.includes("'b'"));
    });
  });

  describe('parseCatalogScopes', () => {
    it('reads literal arrays and ignores the non-OAuth scopes field', () => {
      const entries = parseCatalogScopes(seed('gmail', 'Gmail MCP', `[\n      'a', // why a\n      'b',\n    ]`));
      assert.deepStrictEqual([...entries.get('gmail').scopes], ['a', 'b']);
      assert.strictEqual(entries.get('gmail').name, 'Gmail MCP');
    });

    it('counts both arms of an env ternary', () => {
      const entries = parseCatalogScopes(seed('redmine', 'Redmine MCP', `enabled\n      ? ['view_issues', 'log_time']\n      : []`));
      assert.deepStrictEqual([...entries.get('redmine').scopes], ['view_issues', 'log_time']);
    });

    it('resolves an imported constant', () => {
      const constants = parseArrayConstants(`export const GITHUB_OAUTH_SCOPES = ['repo', 'read:org'];`);
      const entries = parseCatalogScopes(seed('github', 'GitHub MCP', 'enabled ? GITHUB_OAUTH_SCOPES : []'), constants);
      assert.deepStrictEqual([...entries.get('github').scopes], ['repo', 'read:org']);
    });

    it('does not count a commented-out scope', () => {
      const entries = parseCatalogScopes(seed('slack', 'Slack MCP', `['a',\n      // 'lists:write',\n    ]`));
      assert.deepStrictEqual([...entries.get('slack').scopes], ['a']);
    });

    it('parses the real catalog', () => {
      const source = readFileSync('src/mcpCatalogStore.ts', 'utf8');
      const constants = parseArrayConstants(readFileSync('src/github/oauthCallback.ts', 'utf8'));
      const entries = parseCatalogScopes(source, constants);
      assert.ok(entries.get('google-gmail').scopes.has('https://www.googleapis.com/auth/gmail.modify'));
      assert.ok(entries.get('github').scopes.has('repo'));
      assert.ok(entries.get('slack').scopes.has('chat:write'));
      assert.strictEqual(entries.get('clickup').scopes.size, 0);
    });
  });

  describe('diffScopes', () => {
    const entries = (obj) => new Map(Object.entries(obj).map(([slug, scopes]) => [slug, { name: `${slug} MCP`, scopes: new Set(scopes) }]));

    it('reports only added scopes on connectors present at both refs', () => {
      const before = entries({ gmail: ['a'], slack: ['x', 'y'] });
      const after = entries({ gmail: ['a', 'b'], slack: ['x'], brandNew: ['z'] });
      assert.deepStrictEqual(diffScopes(before, after), [{ slug: 'gmail', name: 'gmail MCP', added: ['b'] }]);
    });
  });
});
