// src/__tests__/github/catalogSeed.test.ts
// The GitHub catalog row is env-gated: OAuth client credentials turn on
// "Connect with GitHub", and without them the dashboard must fall back to the
// paste-a-PAT form — which it does precisely because oauthAuthorizationUrl is
// empty. Seeded into a throwaway DATA_DIR so no shared data/ file is touched.
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'gh-catalog-'));
process.env.DATA_DIR = dir;
const saved = { id: process.env.GITHUB_CLIENT_ID, secret: process.env.GITHUB_CLIENT_SECRET, url: process.env.GITHUB_MCP_URL };
delete process.env.DATABASE_URL;

const store = await import('../../mcpCatalogStore.js');
const { GITHUB_AUTHORIZE_URL, GITHUB_TOKEN_URL } = await import('../../github/oauthCallback.js');

describe('seedDefaultCatalogs — github row', () => {
  before(() => { delete process.env.GITHUB_MCP_URL; });
  after(() => {
    for (const [key, value] of [['GITHUB_CLIENT_ID', saved.id], ['GITHUB_CLIENT_SECRET', saved.secret], ['GITHUB_MCP_URL', saved.url]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('with OAuth credentials, advertises GitHub\'s OAuth endpoints and asks for `repo` + `read:org`', async () => {
    process.env.GITHUB_CLIENT_ID = 'cid';
    process.env.GITHUB_CLIENT_SECRET = 'csecret';
    await store.seedDefaultCatalogs();
    const row = await store.getMcpCatalog('github');
    assert.ok(row);
    assert.equal(row.provider, 'github');
    assert.equal(row.oauthAuthorizationUrl, GITHUB_AUTHORIZE_URL);
    assert.equal(row.oauthTokenUrl, GITHUB_TOKEN_URL);
    assert.deepEqual(row.oauthScopes, ['repo', 'read:org']);
    assert.equal(row.googleClientId, 'cid');
    assert.equal(row.mcpUrl, '/github');
    assert.equal(row.isActive, true);
  });

  it('without them, leaves the OAuth URL empty so the dashboard shows the PAT form', async () => {
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    await store.seedDefaultCatalogs();
    const row = await store.getMcpCatalog('github');
    assert.equal(row?.oauthAuthorizationUrl, '');
    assert.deepEqual(row?.oauthScopes, []);
  });
});
