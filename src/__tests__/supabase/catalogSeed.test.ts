// src/__tests__/supabase/catalogSeed.test.ts
// The Supabase catalog row is gated twice: SUPABASE_ENABLED decides whether it
// is visible at all, and OAuth client credentials decide whether the dashboard
// offers "Connect with Supabase" or the paste-a-token form. Seeded into a
// throwaway DATA_DIR so no shared data/ file is touched.
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'supabase-catalog-'));
process.env.DATA_DIR = dir;
const KEYS = ['SUPABASE_CLIENT_ID', 'SUPABASE_CLIENT_SECRET', 'SUPABASE_MCP_URL', 'SUPABASE_ENABLED'] as const;
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
delete process.env.DATABASE_URL;

const store = await import('../../mcpCatalogStore.js');
const { SUPABASE_AUTHORIZE_URL, SUPABASE_TOKEN_URL } = await import('../../supabase/oauthCallback.js');

describe('seedDefaultCatalogs — supabase row', () => {
  before(() => { delete process.env.SUPABASE_MCP_URL; });
  after(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('is hidden unless SUPABASE_ENABLED is exactly "true"', async () => {
    for (const value of [undefined, 'yes', 'TRUE']) {
      if (value === undefined) delete process.env.SUPABASE_ENABLED;
      else process.env.SUPABASE_ENABLED = value;
      await store.seedDefaultCatalogs();
      const listed = (await store.listMcpCatalogs()).some(c => c.slug === 'supabase');
      assert.equal(listed, false, `SUPABASE_ENABLED=${value}`);
    }
  });

  it('with OAuth credentials, advertises Supabase\'s endpoints and asks for no scopes', async () => {
    process.env.SUPABASE_ENABLED = 'true';
    process.env.SUPABASE_CLIENT_ID = 'cid';
    process.env.SUPABASE_CLIENT_SECRET = 'csecret';
    await store.seedDefaultCatalogs();
    const row = await store.getMcpCatalog('supabase');
    assert.ok(row);
    assert.equal(row.provider, 'supabase');
    assert.equal(row.oauthAuthorizationUrl, SUPABASE_AUTHORIZE_URL);
    assert.equal(row.oauthTokenUrl, SUPABASE_TOKEN_URL);
    // Scopes live on the Supabase OAuth app, so the authorize request sends none.
    assert.deepEqual(row.oauthScopes, []);
    assert.equal(row.googleClientId, 'cid');
    assert.equal(row.mcpUrl, '/supabase');
  });

  it('without them, leaves the OAuth URL empty so the dashboard shows the token form', async () => {
    process.env.SUPABASE_ENABLED = 'true';
    delete process.env.SUPABASE_CLIENT_ID;
    delete process.env.SUPABASE_CLIENT_SECRET;
    await store.seedDefaultCatalogs();
    const row = await store.getMcpCatalog('supabase');
    assert.equal(row?.oauthAuthorizationUrl, '');
  });
});
