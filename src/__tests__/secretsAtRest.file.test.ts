// File-mode stores (no DATABASE_URL) with TOKEN_ENCRYPTION_KEYS set: data
// already on disk, sealed or still plaintext, must read; everything written
// back must be sealed. The Postgres paths seal at the same seams
// (tokensParam / mapDbRowToConnection, apiKeyColumns / rowToUserRecord).

import assert from 'node:assert/strict';
import { describe, it, after } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-at-rest-'));
process.env.DATA_DIR = dataDir;
const savedKeys = process.env.TOKEN_ENCRYPTION_KEYS;

const box = await import('../util/secretBox.js');
process.env.TOKEN_ENCRYPTION_KEYS = box.generateKeyEntry('t1');

const LEGACY_KEY = 'a'.repeat(64);
const SEALED_KEY = 'b'.repeat(64);
const googleTokens = { access_token: 'ya29.legacy', refresh_token: '1//legacy', scope: 's', token_type: 'Bearer', expiry_date: 1 };

// Before the stores load: one plaintext record and one sealed record each.
fs.writeFileSync(path.join(dataDir, 'mcp-connections.json'), JSON.stringify([
  { id: 1, userId: 1, mcpSlug: 'google-docs', instanceId: 'plain1', instanceName: 'Plain', googleEmail: null,
    googleTokens, connectedAt: '', updatedAt: '', provider: 'google' },
  { id: 2, userId: 1, mcpSlug: 'slack', instanceId: 'sealed1', instanceName: 'Sealed', googleEmail: null,
    googleTokens: box.sealJson({}), connectedAt: '', updatedAt: '', provider: 'slack',
    providerTokens: box.sealJson({ access_token: 'xoxp-sealed', accessRules: { allowedOrgs: ['T1'] } }) },
]));
fs.writeFileSync(path.join(dataDir, 'users.json'), JSON.stringify({
  [LEGACY_KEY]: { id: 1, apiKey: LEGACY_KEY, email: 'legacy@x.test', googleId: 'g1', name: 'L', authMethod: 'google',
    createdAt: '', updatedAt: '', tokens: googleTokens },
  [box.lookupHash(SEALED_KEY)]: { id: 2, apiKey: box.sealString(SEALED_KEY), email: 'sealed@x.test', googleId: null,
    name: 'S', authMethod: 'password', createdAt: '', updatedAt: '' },
}));

const connections = await import('../mcpConnectionStore.js');
const users = await import('../userStore.js');
const catalog = await import('../mcpCatalogStore.js');

const raw = (file: string) => fs.readFileSync(path.join(dataDir, file), 'utf8');

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (savedKeys === undefined) delete process.env.TOKEN_ENCRYPTION_KEYS;
  else process.env.TOKEN_ENCRYPTION_KEYS = savedKeys;
});

describe('secrets at rest, file mode', () => {
  it('reads connections stored plaintext and sealed', async () => {
    const plain = await connections.getMcpConnectionByInstanceId('plain1');
    assert.equal(plain?.googleTokens.refresh_token, '1//legacy');
    const sealed = await connections.getMcpConnectionByInstanceId('sealed1');
    assert.equal((sealed?.providerTokens as any).access_token, 'xoxp-sealed');
  });

  it('seals every connection on the next write, and the data still reads back', async () => {
    await connections.patchMcpInstanceProviderTokens('sealed1', { accessRules: { allowedOrgs: ['T2'] } });
    const created = await connections.createMcpInstance(1, 'google-sheets', 'New', { ...googleTokens, refresh_token: '1//new' }, null);

    const disk = raw('mcp-connections.json');
    for (const secret of ['ya29.legacy', '1//legacy', '1//new', 'xoxp-sealed', 'allowedOrgs']) {
      assert.ok(!disk.includes(secret), `"${secret}" is on disk in the clear`);
    }
    const again = await connections.getMcpConnectionByInstanceId(created.instanceId);
    assert.equal(again?.googleTokens.refresh_token, '1//new');
    const patched = await connections.getMcpConnectionByInstanceId('sealed1');
    assert.deepEqual((patched?.providerTokens as any).accessRules, { allowedOrgs: ['T2'] });
    assert.equal((patched?.providerTokens as any).access_token, 'xoxp-sealed', 'the patch kept the token');
  });

  it('finds users by API key whether stored plaintext or sealed', async () => {
    await users.loadUsers(); // the file store loads on demand, as every caller does first
    assert.equal((await users.getUserByApiKey(LEGACY_KEY))?.email, 'legacy@x.test');
    assert.equal((await users.getUserByApiKey(SEALED_KEY))?.email, 'sealed@x.test');
    assert.equal((await users.getUserByApiKey(LEGACY_KEY))?.tokens?.refresh_token, '1//legacy');
  });

  it('writes users with no API key or token in the clear, and they still sign in', async () => {
    const created = await users.createPasswordUser({ email: 'new@x.test', name: 'N', passwordHash: 'h' });
    const disk = raw('users.json');
    for (const secret of [LEGACY_KEY, SEALED_KEY, created.apiKey, '1//legacy']) {
      assert.ok(!disk.includes(secret), 'an API key or token is on disk in the clear');
    }
    assert.ok(disk.includes(box.lookupHash(created.apiKey)), 'keyed by the hash');
    assert.equal((await users.getUserByApiKey(created.apiKey))?.email, 'new@x.test');

    const oldKey = created.apiKey; // `created` is the stored object, which rotation mutates
    const rotated = await users.regenerateApiKeyByUserId(created.id!);
    assert.equal(await users.getUserByApiKey(oldKey), undefined);
    assert.equal((await users.getUserByApiKey(rotated!.apiKey))?.email, 'new@x.test');
  });

  it('seals catalog client secrets on disk and returns them opened', async () => {
    await catalog.createMcpCatalog({
      slug: 'secret-test', name: 'T', description: '', iconUrl: null, mcpUrl: 'http://x', scopes: [],
      googleClientId: 'cid', googleClientSecret: 'GOCSPX-very-secret', oauthScopes: [], isLocal: true, isActive: true,
    });
    assert.ok(!raw('mcp-catalog.json').includes('GOCSPX-very-secret'));
    assert.equal((await catalog.getMcpCatalog('secret-test'))?.googleClientSecret, 'GOCSPX-very-secret');
  });
});
